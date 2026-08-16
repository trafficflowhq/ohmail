import type { Readable, Writable } from "node:stream";
import { FrameDecoder, FrameWriter, MAX_BODY_BYTES, PROTOCOL_VERSION, type FrameLimits } from "./frame.js";
import { decodeResponse, encodeRequest, type ReadyHeader, type ResponseHeader } from "./protocol.js";

/**
 * THE UI SIDE OF THE BRIDGE — a `fetch` that goes down a pipe.
 *
 * The dual-mode design's rule for the UI: it keeps `HttpAdapter`, given a `fetch` that marshals
 * `Request`/`Response` over the sidecar's stdin/stdout. This is that `fetch`. The client engine
 * is unchanged and unaware: `new HttpAdapter({ baseUrl, fetch: client.fetch })` is the whole
 * integration — the same seam the client engine's contract suite already proves against an
 * in-process `app.handle`.
 *
 * Same rule as the host: the read loop never awaits anything. It resolves pending promises and
 * returns to the stream.
 *
 * ── WHAT HAPPENS WHEN THE SIDECAR DIES ────────────────────────────────────────────────────
 *
 * Every in-flight request rejects with a clear error, and so does every later call. A promise that
 * silently never settles is the worst failure a bridge can have — the UI shows a spinner forever
 * and no log says why. `HttpAdapter` turns a thrown fetch into a retryable
 * `MutationRejectedError`, which is exactly the right shape here.
 */

export interface StdioClientOptions {
  input: Readable;
  output: Writable;
  /** Base for relative paths; also what `HttpAdapter` should be given. Default `http://sidecar`. */
  baseUrl?: string;
  limits?: Partial<FrameLimits>;
}

export type BridgeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface StdioClient {
  /** Hand this to `new HttpAdapter({ baseUrl, fetch })`. */
  readonly fetch: BridgeFetch;
  /** The sidecar's hello — resolves once it announces its per-launch session. */
  ready(): Promise<ReadyHeader>;
  /** Requests sent and not yet answered. */
  readonly pending: number;
  /** Fail everything outstanding and stop reading. */
  close(reason?: Error): void;
}

class SidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarUnavailableError";
  }
}

export function connectOverStdio(opts: StdioClientOptions): StdioClient {
  const baseUrl = (opts.baseUrl ?? "http://sidecar").replace(/\/$/, "");
  const maxBody = opts.limits?.maxBodyBytes ?? MAX_BODY_BYTES;
  const decoder = new FrameDecoder(opts.limits ?? {});
  const writer = new FrameWriter(opts.output, opts.limits ?? {});

  const waiting = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let closedWith: Error | null = null;

  let resolveReady!: (h: ReadyHeader) => void;
  let rejectReady!: (e: Error) => void;
  const readyPromise = new Promise<ReadyHeader>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // Nothing may observe this rejection until someone awaits `ready()`; without a no-op catch a
  // close before the hello is an unhandled rejection that takes the process down.
  readyPromise.catch(() => undefined);

  const close = (reason?: Error): void => {
    if (closedWith) return;
    closedWith = reason ?? new SidecarUnavailableError("the sidecar connection was closed");
    opts.input.removeListener("data", onData);
    opts.input.removeListener("end", onEnd);
    opts.input.removeListener("close", onEnd);
    opts.input.removeListener("error", onStreamError);
    for (const [, p] of waiting) p.reject(closedWith);
    waiting.clear();
    rejectReady(closedWith);
  };

  function onData(chunk: Buffer): void {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (err) {
      close(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const f of frames) {
      // Read the discriminant off a loose shape rather than an intersection of the three header
      // types: `t: "res" & "err" & "ready"` is `never`, so an intersection makes every field
      // unreachable. The concrete type is asserted once the discriminant has been checked.
      const header = f.header as { v?: number; t?: string; id?: number; code?: string; message?: string };
      // Checked on BOTH sides, so a version skew — a shell updated ahead of its sidecar, or the
      // reverse — is one clear error instead of two ends quietly misreading each other's fields.
      if (header.v !== PROTOCOL_VERSION) {
        close(new Error(`sidecar frame protocol version ${String(header.v)}, expected ${PROTOCOL_VERSION}`));
        return;
      }
      if (header.t === "ready") {
        resolveReady(f.header as unknown as ReadyHeader);
        continue;
      }
      // The boot's narration — what a still-starting engine says it is doing, strictly before
      // `ready`. Informational and uncorrelated by design, so it is skipped here the way the
      // desktop shell's reader skips it: this client's consumers wait on `ready()`, and a phase
      // is never an answer to anything.
      if (header.t === "phase") continue;
      if (typeof header.id !== "number") {
        close(new Error(`frame with no correlation id: ${JSON.stringify(f.header).slice(0, 200)}`));
        return;
      }
      const pending = waiting.get(header.id);
      if (!pending) continue; // a late answer to something already failed; harmless
      waiting.delete(header.id);
      if (header.t === "err") {
        pending.reject(new SidecarUnavailableError(`${header.code ?? "sidecar_failed"}: ${header.message ?? ""}`));
      } else if (header.t === "res") {
        pending.resolve(decodeResponse(f.header as unknown as ResponseHeader, f.body));
      } else {
        pending.reject(new Error(`unexpected frame type ${String(header.t)}`));
      }
    }
  }

  function onEnd(): void {
    close(new SidecarUnavailableError("the sidecar closed its output stream"));
  }
  function onStreamError(err: Error): void {
    close(err);
  }

  opts.input.on("data", onData);
  opts.input.on("end", onEnd);
  opts.input.on("close", onEnd);
  opts.input.on("error", onStreamError);

  const bridgeFetch: BridgeFetch = async (url, init) => {
    if (closedWith) throw closedWith;
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
    const req = new Request(absolute, init);
    const id = nextId++;
    const framed = await encodeRequest(id, req, maxBody);
    const answer = new Promise<Response>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
    });
    try {
      await writer.write(framed.header, framed.body);
    } catch (err) {
      waiting.delete(id);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return answer;
  };

  return {
    fetch: bridgeFetch,
    ready: () => readyPromise,
    get pending() {
      return waiting.size;
    },
    close,
  };
}
