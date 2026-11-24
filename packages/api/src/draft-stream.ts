import type { DraftStreamFrame } from "@ohmail/wire";
import type { ApiDeps } from "./deps.js";

/**
 * Let normal HTTP answers (including replays and early refusals) leave through the existing
 * pipeline. Once authorized model output arrives, send it and the pipeline's final answer on
 * the same response. A disconnected reader does not cancel the purchase or its cleanup.
 */
export async function draftStream(deps: ApiDeps, run: () => Promise<Response>): Promise<Response> {
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const send = (frame: DraftStreamFrame) => {
    stream?.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
  };
  let started = false;
  deps.onDraftPreview = (text) => {
    if (!started) {
      started = true;
      resolveFirst(new Response(new ReadableStream<Uint8Array>({
        start(controller) { stream = controller; },
        cancel() { stream = undefined; },
      }), {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store, no-transform",
          "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no",
        },
      }));
    }
    send({ type: "preview", text });
  };
  const completed = run().then(async (res) => {
    if (stream !== undefined) {
      const body: unknown = await res.json();
      const retryAfter = res.headers.get("Retry-After") ?? undefined;
      const syncSeq = res.headers.get("X-Sync-Seq") ?? undefined;
      send({ type: "result", status: res.status, body, retryAfter, syncSeq });
      stream?.close();
    }
    return res;
  }).catch((err: unknown) => {
    stream?.error(new Error("Draft response ended unexpectedly"));
    throw err;
  }).finally(() => {
    deps.onDraftPreview = undefined;
  });
  return Promise.race([first, completed]);
}
