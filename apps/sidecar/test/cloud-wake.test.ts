import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEVER_CONNECTED_ATTEMPTS, WAKE_HEALTHY_STREAM_MS, startCloudWake } from "../src/cloud-wake.js";

/**
 * THE CLOUD DOOR'S WAKE SUBSCRIPTION, at its own seam.
 *
 * The properties under test are the slice's guards, sidecar edition:
 *
 *   · a `sync` frame kicks the mirror — and ONLY a `sync` frame: heartbeats, retry hints and
 *     unknown events kick nothing;
 *   · a refusal (a host with streaming off answers 503) is PERMANENT for the process: one request,
 *     zero retries, no reconnect storm against a deployment that said no;
 *   · a clean server close (the stream cycles on a lifetime by design) reconnects;
 *   · a connect that never once succeeded gives up after a bounded number of dials;
 *   · `stop()` ends everything, including a reader parked mid-stream.
 *
 * The fetch is faked at the `authedFetch` seam with real `ReadableStream`s, so the SSE parser
 * runs against the same shapes the wire carries — including frames split across chunks.
 */

/** An SSE body the test writes into by hand. */
function sseBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    send(text: string): void {
      controller.enqueue(enc.encode(text));
    },
    end(): void {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const flush = async (): Promise<void> => {
  // The parser hops the microtask queue per chunk; a couple of turns settles it.
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  // The defaults plus `performance`: the stream's lifetime and the walled redial floor read it.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startCloudWake", () => {
  it("kicks on `event: sync` frames — and on nothing else in the stream", async () => {
    const body = sseBody();
    let wakes = 0;
    const wake = startCloudWake({
      auth: { authedFetch: async () => new Response(body.stream, { status: 200 }) },
      onWake: () => { wakes += 1; },
    });
    await flush();

    body.send("retry: 3000\n\n");
    body.send(": ping\n\n");
    body.send("event: ready\ndata: {}\n\n");
    body.send("event: ping\ndata: {}\n\n");
    await flush();
    expect(wakes, "a heartbeat, ready frame or retry hint kicked the mirror").toBe(0);

    body.send('event: sync\ndata: {"seq":7}\n\n');
    await flush();
    expect(wakes).toBe(1);

    // Split across chunks mid-line — the wire's privilege, the parser's problem.
    body.send("event: sy");
    await flush();
    body.send('nc\ndata: {"seq":9}\n\n');
    await flush();
    expect(wakes).toBe(2);

    body.send("event: something_else\ndata: {}\n\n");
    await flush();
    expect(wakes, "an unknown event kicked the mirror").toBe(2);

    wake.stop();
    body.end();
  });

  it("a NON-200 is permanent: one request, zero retries — what a host with streaming off answers", async () => {
    let dials = 0;
    const logs: string[] = [];
    const wake = startCloudWake({
      auth: {
        authedFetch: async () => {
          dials += 1;
          return new Response(JSON.stringify({ error: { code: "sse_disabled" } }), { status: 503 });
        },
      },
      onWake: () => {},
      log: (event) => { logs.push(event); },
    });
    await flush();
    expect(dials).toBe(1);

    // An hour of timers: a subscriber that redials a refusing endpoint is a reconnect storm
    // against the exact deployment that asked it to stop.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(dials, "the refused stream was redialed").toBe(1);
    expect(logs).toContain("cloud_wake_off");

    wake.stop();
  });

  it("a 429 means LATER, not never: the throttled dial repeats on a slow cadence and connects", async () => {
    // MEASURED LIVE on a fresh install: the launch bootstrap's own /sync paging tripped the
    // rate limiter over the /events dial beside it, and the permanent-off doctrine turned one
    // crowded second into a push channel dead for the process's lifetime — the poll carried
    // the door, silently, forever. A throttle is the server saying "ask me later"; asking
    // later, at most once a minute, is not the storm the doctrine guards against.
    let dials = 0;
    const logs: string[] = [];
    const body = sseBody();
    const kicks: number[] = [];
    const wake = startCloudWake({
      auth: {
        authedFetch: async () => {
          dials += 1;
          if (dials < 3) return new Response("slow down", { status: 429, headers: { "retry-after": "90" } });
          return new Response(body.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      },
      onWake: () => { kicks.push(dials); },
      log: (event) => { logs.push(event); },
    });
    await flush();
    expect(dials).toBe(1);
    expect(logs).toContain("cloud_wake_throttled");
    expect(logs, "a throttle is not the permanent refusal").not.toContain("cloud_wake_off");

    // Retry-After says 90s; the dial repeats there, not on the fast never-connected ladder.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials, "the throttled dial redialed faster than the server asked").toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(dials).toBe(2);

    // The second 429, then the third dial connects and the stream is live end-to-end.
    await vi.advanceTimersByTimeAsync(91_000);
    expect(dials).toBe(3);
    expect(logs).toContain("cloud_wake_connected");
    body.send("event: sync\n\n");
    await flush();
    expect(kicks.length).toBe(1);

    wake.stop();
    body.end();
  });

  it("a CLEAN server close reconnects — the stream cycles on a lifetime by design", async () => {
    const bodies = [sseBody(), sseBody()];
    const paths: string[] = [];
    let dials = 0;
    let wakes = 0;
    const wake = startCloudWake({
      auth: {
        authedFetch: async (p) => { paths.push(p); return new Response(bodies[dials++]!.stream, { status: 200 }); },
      },
      onWake: () => { wakes += 1; },
      recycleDelayMs: 100,
    });
    await flush();
    bodies[0]!.send("event: sync\n\n");
    await flush();
    expect(wakes).toBe(1);

    bodies[0]!.end();                              // the server's lifetime close
    await vi.advanceTimersByTimeAsync(150);        // …and the recycle delay
    await flush();
    expect(dials, "the cycled stream never reconnected").toBe(2);
    // The redial names the stream it left, so the server ends that one and frees its slot.
    expect(paths).toEqual(["/events?stream=cloud-door", "/events?stream=cloud-door"]);

    bodies[1]!.send("event: sync\n\n");
    await flush();
    expect(wakes, "the reconnected stream is not delivering").toBe(2);

    wake.stop();
    bodies[1]!.end();
  });

  it("a connect that NEVER succeeded gives up after a bounded number of dials", async () => {
    let dials = 0;
    const logs: string[] = [];
    const wake = startCloudWake({
      auth: {
        authedFetch: async () => {
          dials += 1;
          throw new Error("ECONNREFUSED");
        },
      },
      onWake: () => {},
      log: (event) => { logs.push(event); },
      backoffBaseMs: 10,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials, "an unreachable endpoint was dialed without bound").toBe(NEVER_CONNECTED_ATTEMPTS);
    expect(logs).toContain("cloud_wake_off");

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(dials).toBe(NEVER_CONNECTED_ATTEMPTS);
    wake.stop();
  });

  it("a drop AFTER a successful connect retries on backoff — a proven channel is worth redialing", async () => {
    let dials = 0;
    let live = sseBody();
    const wake = startCloudWake({
      auth: {
        authedFetch: async () => {
          dials += 1;
          if (dials === 2) throw new Error("ECONNRESET");
          live = sseBody();
          return new Response(live.stream, { status: 200 });
        },
      },
      onWake: () => {},
      recycleDelayMs: 10,
      backoffBaseMs: 10,
    });
    await flush();
    expect(dials).toBe(1);
    live.end();                                    // cycle → reconnect (dial 2) → throws
    await vi.advanceTimersByTimeAsync(12);
    await flush();
    expect(dials).toBe(2);
    await vi.advanceTimersByTimeAsync(100);        // the backoff redial (dial 3) succeeds
    await flush();
    expect(dials).toBe(3);

    wake.stop();
    live.end();
  });

  it("stop() ends a reader parked on an idle stream, and nothing reconnects after", async () => {
    const body = sseBody();
    let dials = 0;
    const wake = startCloudWake({
      auth: {
        authedFetch: async (_p, init) => {
          dials += 1;
          // Honour the abort the way fetch does: the body errors when the signal fires.
          init?.signal?.addEventListener("abort", () => { body.end(); });
          return new Response(body.stream, { status: 200 });
        },
      },
      onWake: () => {},
      recycleDelayMs: 10,
    });
    await flush();
    expect(dials).toBe(1);

    wake.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(dials, "a stopped subscription reconnected").toBe(1);
  });
});

/** A body that writes `text` and ends at once: the server answers 200 and closes. */
function closingBody(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      if (text !== "") c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

/** The gaps between consecutive dial times. */
const gaps = (at: number[]): number[] => at.slice(1).map((t, i) => t - at[i]!);

/** A wake whose every dial answers 200 with `text` and closes at once; `at` records each dial's time. */
function closingServer(text: string): { at: number[]; stop: () => void } {
  const at: number[] = [];
  const wake = startCloudWake({
    auth: { authedFetch: async () => { at.push(Date.now()); return new Response(closingBody(text), { status: 200 }); } },
    onWake: () => {},
  });
  return { at, stop: () => wake.stop() };
}

/*
 * THE SERVER'S `retry:` AND THE BACKOFF, a precondition of turning streaming on for the managed
 * service: a desktop holds its stream around the clock, so a redial every second against a server
 * whose reads fail is the reconnect storm the 30 s hint exists to stop. The hint is the floor of
 * every redial; only a healthy stream (open 60 s, or a frame delivered) resets the backoff.
 */
describe("the server's retry: hint and the backoff", () => {
  it("a server that answers 200 and closes at once, sending retry: 5000: never two dials inside 5 s", async () => {
    const srv = closingServer("retry: 5000\n\n");
    await vi.advanceTimersByTimeAsync(120_000);
    srv.stop();
    expect(srv.at.length).toBeGreaterThan(3);
    expect(Math.min(...gaps(srv.at)), "a dial came inside the interval the server asked for").toBeGreaterThanOrEqual(5_000);
  });

  it("the same server sending no retry: the backoff grows at every close, and a bare 200 resets nothing", async () => {
    const srv = closingServer("");
    await vi.advanceTimersByTimeAsync(40_000);
    srv.stop();
    expect(gaps(srv.at).slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("a failed read's retry: 30000 holds the next dial off for 30 s", async () => {
    const srv = closingServer("retry: 3000\n\nretry: 30000\n\nevent: sync_failed\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(srv.at, "the desktop redialled inside the 30 s the failed read asked for").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(srv.at).toHaveLength(2);
    srv.stop();
  });

  it("a stream that delivered frames and then failed a read still waits the 30 s", async () => {
    const srv = closingServer("retry: 3000\n\nevent: sync\n\nretry: 30000\n\nevent: sync_failed\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(srv.at).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(srv.at).toHaveLength(2);
    srv.stop();
  });

  it("a normal 270 s lifetime close redials on the honoured retry, and resets the backoff the short closes grew", async () => {
    const at: number[] = [];
    const held: { body?: ReturnType<typeof sseBody> } = {};
    let dials = 0;
    const wake = startCloudWake({
      auth: {
        authedFetch: async () => {
          dials += 1;
          at.push(Date.now());
          if (dials !== 4) return new Response(closingBody(""), { status: 200 });
          held.body = sseBody();
          held.body.send("retry: 3000\n\n");
          return new Response(held.body.stream, { status: 200 });
        },
      },
      onWake: () => {},
    });
    await vi.advanceTimersByTimeAsync(7_500);
    expect(gaps(at), "three short closes, three growing waits").toEqual([1_000, 2_000, 4_000]);
    await vi.advanceTimersByTimeAsync(270_000 - 500);
    expect(Date.now() - at[3]!).toBeGreaterThanOrEqual(WAKE_HEALTHY_STREAM_MS);
    const closedAt = Date.now();
    held.body!.end();
    await vi.advanceTimersByTimeAsync(3_010);
    expect(at).toHaveLength(5);
    expect(at[4]! - closedAt, "the lifetime close waited a grown backoff").toBe(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(at).toHaveLength(6);
    expect(at[5]! - at[4]!, "the healthy stream did not reset the backoff").toBe(3_000);
    wake.stop();
  });

  it("the hint is honoured within 1 s and 60 s: retry: 0 waits 1 s, retry: 600000 waits 60 s", async () => {
    for (const [hint, waitMs] of [["0", 1_000], ["600000", 60_000]] as const) {
      const srv = closingServer(`retry: ${hint}\n\nevent: sync\n\n`);
      await vi.advanceTimersByTimeAsync(waitMs - 10);
      expect(srv.at, `retry: ${hint} redialled before ${waitMs} ms`).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(srv.at, `retry: ${hint} did not redial at ${waitMs} ms`).toHaveLength(2);
      srv.stop();
    }
  });
});
