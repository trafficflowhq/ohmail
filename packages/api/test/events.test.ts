import { describe, it, expect, vi } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
// Reset the per-request mutable fields AND inject tiny SSE durations for determinism.
const H = (r: Request, d: ApiDeps, sse?: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, ...(sse ? { sse } : {}) });

/**
 * Read a stream as it arrives. `until` waits out real I/O (the database behind a frame) in real
 * turns of the event loop — `setImmediate`, which the test's faked timers leave alone — and never
 * moves the faked clock: only the test does that.
 */
function read(res: Response): { readonly text: string; readonly ended: boolean; until: (p: (text: string) => boolean, what: string) => Promise<void> } {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const state = { text: "", ended: false };
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { state.ended = true; return; }
      state.text += dec.decode(value, { stream: true });
    }
  })();
  return {
    get text() { return state.text; },
    get ended() { return state.ended; },
    async until(p, what) {
      const deadline = performance.now() + 10_000;
      while (!p(state.text)) {
        if (performance.now() > deadline) throw new Error(`no ${what} after 10 s; the stream read ${JSON.stringify(state.text)}`);
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

describe("GET /events (bounded SSE)", () => {
  /* THE STREAM'S CLOCK IS THE TEST'S. With real timers this case raced its own lifetime: a write
     fired 40 ms in on PGlite (in-process, so it holds the event loop) and a poll after it had to
     land inside 200 ms of wall time. On a loaded runner the lifetime won — a stream of `ready` and
     two pings, no sync — and the write itself could finish after the close. The timers and
     `Date` are faked from the request on, so each step happens because the test moved the clock
     past it; the database work between steps is real I/O, waited out by its frames. */
  it("emits a heartbeat + a sync frame for a mid-stream change, then server-closes by the lifetime; a concurrent write proceeds", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const sse: SseConfig = { heartbeatMs: 15, pollMs: 10, lifetimeMs: 200 };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const res = await H(req("GET", "/events", { bearer: s.token }), deps, sse);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
      const stream = read(res);

      await stream.until((t) => t.includes("event: ready\n"), "the ready frame");

      // Mid-stream: create a rule over HTTP. If the SSE poll held a DB connection/tx open
      // (violating), this write would block on PGlite's single connection. It doesn't.
      const write = await H(req("POST", "/rules", { bearer: s.token, body: JSON.stringify({ kind: "sender", match: "x@y.example", destination: "INBOX" }) }), deps);
      expect(write.status).toBe(201);
      expect(stream.ended, "the stream closed before the write completed").toBe(false);

      await vi.advanceTimersByTimeAsync(sse.pollMs);   // the next poll reads the advanced seq
      await stream.until((t) => t.includes("event: sync"), "the sync frame");
      await vi.advanceTimersByTimeAsync(sse.heartbeatMs);
      await stream.until((t) => t.includes("event: ping\ndata: {}\n\n"), "a heartbeat");
      expect(stream.ended, "the stream closed before its lifetime").toBe(false);

      await vi.advanceTimersByTimeAsync(sse.lifetimeMs);
      await stream.until(() => stream.ended, "the server's close at the lifetime");

      expect(stream.text).toContain("event: ping\ndata: {}\n\n");   // heartbeat, a named frame
      expect(stream.text).toContain("event: sync");   // wake frame
      expect(stream.text).toMatch(/data: \{"seq":\d+\}/);  // carries the advancing seq
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);   // above `until`'s own 10 s bounds, so a missing frame fails by its name

  it("requires a session (401)", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/events"), deps, { heartbeatMs: 15, pollMs: 10, lifetimeMs: 50 });
    expect(res.status).toBe(401);
  });
});
