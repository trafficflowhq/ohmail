/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type MessageBodyWire,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import {
  POLL_MS,
  WAKE_SAFETY_POLL_MS,
  WAKE_STREAM_CLOSED,
  WAKE_STREAM_SILENCE_MS,
  startSyncScheduler,
  type SyncGate,
  type SyncIdentity,
  type WakeStreamLike,
} from "@ohmail/app-logic/session/sync-scheduler";

/**
 * A STREAM IS LIVE WHEN IT DELIVERS, NOT WHEN IT OPENS. A compressing or buffering hop sends the
 * headers and holds every frame; a half-open TCP after a Wi-Fi drop delivers nothing and never
 * errors. Neither may hold the tab at the 90 s safety cadence: the poll relaxes on the first
 * frame, an OPEN stream silent for {@link WAKE_STREAM_SILENCE_MS} is closed and the floor comes
 * back, and the watchdog re-dials once before the next visibility flip or `online`, whether or not
 * the stream delivered, so a proxy that holds frames never becomes a dial loop.
 */
interface Page {
  ids: string[];
  cursor: string;
  hasMore: boolean;
}

const page = (cursor: string, ids: string[], hasMore = false): Page => ({ ids, cursor, hasMore });

function responseOf(p: Page): SyncResponse {
  return {
    changes: {
      creates: p.ids.map((id, i) => ({
        type: "message" as const,
        op: "create" as const,
        id,
        seq: Number(id.replace(/\D/g, "")) || i + 1,
        updatedAt: "2026-08-02T00:00:00.000Z",
        entity: { id, subject: id },
      })),
      updates: [],
      moves: [],
      deletes: [],
    },
    cursor: p.cursor,
    hasMore: p.hasMore,
    serverTime: "2026-08-02T00:00:00.000Z",
  };
}

class ScriptedAdapter implements EngineAdapter {
  readonly since: string[] = [];
  readonly startedAt: number[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  latencyMs = 0;

  constructor(private readonly answer: (params: SyncParams, n: number) => Page | Error) {}

  get calls(): number {
    return this.since.length;
  }

  async sync(params: SyncParams): Promise<SyncResponse> {
    const n = this.since.length;
    this.since.push(params.since);
    this.startedAt.push(Date.now());
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      if (this.latencyMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
      }
      const out = this.answer(params, n);
      if (out instanceof Error) throw out;
      return responseOf(out);
    } finally {
      this.concurrent -= 1;
    }
  }

  async mutate(): Promise<MutationOutcome> {
    throw new Error("this test never mutates");
  }

  async withdrawSend() { return { outcome: "unsupported" as const }; }
  async fetchBody(): Promise<MessageBodyWire> {
    throw new Error("this test never opens a body");
  }
}

const engineWith = (adapter: EngineAdapter): OhmailEngine =>
  new OhmailEngine({ adapter, store: new MemoryMirrorStore() });

function fakeVisibility(initial: DocumentVisibilityState = "visible") {
  const listeners = new Set<() => void>();
  let state = initial;
  return {
    get visibilityState(): DocumentVisibilityState {
      return state;
    },
    addEventListener(_t: "visibilitychange", l: () => void): void {
      listeners.add(l);
    },
    removeEventListener(_t: "visibilitychange", l: () => void): void {
      listeners.delete(l);
    },
    set(next: DocumentVisibilityState): void {
      state = next;
      for (const l of [...listeners]) l();
    },
  };
}

function fakeOnline() {
  const listeners = new Set<() => void>();
  return {
    addEventListener(_t: "online", l: () => void): void {
      listeners.add(l);
    },
    removeEventListener(_t: "online", l: () => void): void {
      listeners.delete(l);
    },
    fire(): void {
      for (const l of [...listeners]) l();
    },
  };
}

/** A hand-driven wake stream — the EventSource protocol reduced to what the scheduler reads. */
class FakeWakeStream implements WakeStreamLike {
  readyState = 0; // CONNECTING
  closed = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: "open" | "ready" | "ping" | "sync" | "error", l: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(l);
  }

  close(): void {
    this.closed += 1;
    this.readyState = WAKE_STREAM_CLOSED;
  }

  private fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }

  /** Headers arrived (or a native reconnect landed). Nothing else: a held stream stops here. */
  open(): void {
    this.readyState = 1;
    this.fire("open");
  }

  /** The server's first frame once subscribed. */
  ready(): void {
    this.fire("ready");
  }

  /** The server's heartbeat frame. */
  ping(): void {
    this.fire("ping");
  }

  /** The server's content-free wake frame: something committed, drain now. */
  wake(): void {
    this.fire("sync");
  }

  /** A network blip: the browser is reconnecting natively (readyState CONNECTING). */
  errorTransient(): void {
    this.readyState = 0;
    this.fire("error");
  }

  /** A non-200: flag off, capacity, auth. EventSource stops reconnecting for good. */
  errorTerminal(): void {
    this.readyState = WAKE_STREAM_CLOSED;
    this.fire("error");
  }
}

/** The longest silence in a run of drains — the number a stale mailbox is measured in. */
function longestGap(startedAt: readonly number[], from: number, until: number): number {
  let worst = 0;
  let prev = from;
  for (const t of startedAt) {
    if (t < from) continue;
    worst = Math.max(worst, t - prev);
    prev = t;
  }
  return Math.max(worst, until - prev);
}

/** A counting factory, so reconnect-storm bounds are a number rather than an impression. */
function wakeFactory() {
  const streams: FakeWakeStream[] = [];
  return {
    streams,
    factory: (): WakeStreamLike => {
      const s = new FakeWakeStream();
      streams.push(s);
      return s;
    },
  };
}

const quiet = { report: (): void => {} };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const SERVER_HEARTBEAT_MS = 15_000;

/** The three calls the scheduler makes of a gate, with an identity the test turns. */
function fakeGate() {
  let who: SyncIdentity = "holds";
  const gate = { identity: () => who, claim: () => {}, onOpen: () => {} } as unknown as SyncGate;
  return { gate, set(next: SyncIdentity): void { who = next; } };
}

function start(opts: { visibility?: ReturnType<typeof fakeVisibility>; online?: ReturnType<typeof fakeOnline>; gate?: SyncGate } = {}) {
  const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
  const { streams, factory } = wakeFactory();
  const doc = opts.visibility ?? fakeVisibility("visible");
  const net = opts.online ?? fakeOnline();
  const stop = startSyncScheduler(engineWith(adapter), {
    ...quiet, visibility: doc, online: net, wake: factory, ...(opts.gate ? { gate: opts.gate } : {}),
  });
  return { adapter, streams, doc, net, stop };
}

describe("a stream that opened and then went silent", () => {
  it("keeps the 8 s floor until the stream has delivered something", async () => {
    const { adapter, streams, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();                       // headers arrived; not one frame follows
    await vi.advanceTimersByTimeAsync(0);
    const from = Date.now();
    await vi.advanceTimersByTimeAsync(120_000);
    const gap = longestGap(adapter.startedAt, from, Date.now());
    stop();
    expect(gap, `longest drain gap with a silent open stream: ${gap} ms`).toBeLessThanOrEqual(POLL_MS + 1_000);
  });

  it("CONTROL: silent, then a transient error — the error arm restores the 8 s floor", async () => {
    const { adapter, streams, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(30_000);
    streams[0]!.errorTransient();
    const from = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    const gap = longestGap(adapter.startedAt, from, Date.now());
    stop();
    expect(gap, `longest drain gap after the error: ${gap} ms`).toBeLessThanOrEqual(POLL_MS + 1_000);
  });

  it("CONTROL: a stream that delivers relaxes to the safety cadence, and its pings keep it there", async () => {
    const { adapter, streams, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    streams[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;
    for (let t = 0; t < 75_000; t += SERVER_HEARTBEAT_MS) {
      await vi.advanceTimersByTimeAsync(SERVER_HEARTBEAT_MS);
      streams[0]!.ping();
    }
    expect(adapter.calls, "a stream that delivers left the fast poll running").toBe(settled);
    expect(streams[0]!.closed, "a stream that pings was closed as silent").toBe(0);
    await vi.advanceTimersByTimeAsync(WAKE_SAFETY_POLL_MS - 75_000 + 100);
    expect(adapter.calls).toBe(settled + 1);
    stop();
  });

  it("delivers ready, then goes silent: the watchdog closes it, brings back the floor and re-dials", async () => {
    const { adapter, streams, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    streams[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    const from = Date.now();
    await vi.advanceTimersByTimeAsync(120_000);
    const gap = longestGap(adapter.startedAt, from, Date.now());
    stop();
    expect(gap, `longest drain gap after ready then silence: ${gap} ms`)
      .toBeLessThanOrEqual(WAKE_STREAM_SILENCE_MS + POLL_MS + 1_000);
    expect(streams[0]!.closed, "the silent stream was never closed").toBe(1);
    expect(streams.length, "a stream that had delivered was not re-dialled").toBe(2);
  });

  it("a stream that delivers nothing is re-dialled ONCE until a visibility flip or online", async () => {
    const { streams, doc, net, stop } = start();
    const openSilently = async (): Promise<void> => {
      streams[streams.length - 1]!.open();
      await vi.advanceTimersByTimeAsync(WAKE_STREAM_SILENCE_MS + 100);
    };
    await vi.advanceTimersByTimeAsync(0);
    await openSilently();                      // the first: closed, re-dialled once
    expect(streams.length).toBe(2);
    await openSilently();                      // the re-dial: closed, and that is all
    await vi.advanceTimersByTimeAsync(600_000);
    expect(streams.length, "a stream that never delivers was re-dialled in a loop").toBe(2);
    expect(streams[1]!.closed).toBe(1);

    net.fire();                                // back online: one dial, and one re-dial again
    expect(streams.length).toBe(3);
    await openSilently();
    await openSilently();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(streams.length).toBe(4);

    doc.set("hidden");                         // a flip: the same again
    doc.set("visible");
    expect(streams.length).toBe(5);
    await openSilently();
    await openSilently();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(streams.length).toBe(6);
    stop();
  });

  it("a stream that delivers ready and then stalls, every time, is dialled at most twice per visible period", async () => {
    const { streams, doc, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    const readyThenStall = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 1_000) {
        const s = streams[streams.length - 1]!;
        if (s.readyState === 0) { s.open(); s.ready(); }
        await vi.advanceTimersByTimeAsync(1_000);
      }
    };
    await readyThenStall(600_000);
    expect(streams.length, "a stream that delivered once was re-dialled on every stall").toBeLessThanOrEqual(2);
    const before = streams.length;           // the flip's own dial is the period's first
    doc.set("hidden");
    doc.set("visible");
    await readyThenStall(600_000);
    expect(streams.length - before, "the bound did not come back with the visible period").toBeLessThanOrEqual(2);
    expect(streams.length - before).toBe(2);
    stop();
  });

  it("a ready or ping from a stream the scheduler has replaced sets nothing", async () => {
    for (const frame of ["ready", "ping"] as const) {
      const { adapter, streams, doc, stop } = start();
      await vi.advanceTimersByTimeAsync(0);
      streams[0]!.open();
      doc.set("hidden");
      doc.set("visible");
      await vi.advanceTimersByTimeAsync(0);
      streams[1]!.open();                      // the current stream: open, no frame yet
      await vi.advanceTimersByTimeAsync(0);
      const before = adapter.calls;
      streams[0]!.readyState = 1;              // a late dispatch on the replaced object
      streams[0]![frame]();
      await vi.advanceTimersByTimeAsync(POLL_MS * 2 + 200);
      expect(adapter.calls - before, `a ${frame} from a replaced stream relaxed the poll`).toBeGreaterThanOrEqual(2);
      stop();
    }
  });

  it("a ready or ping after the jar changed hands closes the stream and relaxes nothing", async () => {
    for (const frame of ["ready", "ping"] as const) {
      const g = fakeGate();
      const { streams, stop } = start({ gate: g.gate });
      await vi.advanceTimersByTimeAsync(0);
      streams[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(streams[0]!.closed).toBe(0);
      g.set("contradicted");
      streams[0]![frame]();
      expect(streams[0]!.closed, `a ${frame} under another account's jar kept its stream`).toBe(1);
      stop();
    }
  });

  // The server half, `DEFAULT_SSE.heartbeatMs` at 15 s, is pinned by `events-liveness-frames.test.ts`.
  it("the silence bound is twice the server's heartbeat", () => {
    expect(WAKE_STREAM_SILENCE_MS).toBe(2 * SERVER_HEARTBEAT_MS);
  });
});
