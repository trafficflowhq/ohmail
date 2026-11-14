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
  WAKE_STREAM_REASK_MS,
  WAKE_STREAM_SILENCE_MS,
  startSyncScheduler,
  type WakeStreamLike,
} from "@ohmail/app-logic/session/sync-scheduler";

/**
 * A REFUSED STREAM IS ASKED FOR AGAIN, ONCE A MINUTE. The per-account cap refuses a tab while dead
 * connections hold its slots, and those free within the server's bounds; a tab that never asked
 * again polled every 8 s for the rest of its life. The re-ask rides a settled drain,
 * at most once per {@link WAKE_STREAM_REASK_MS} whatever wakes arrive, and stops once the tab holds
 * a stream.
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
  refused = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly at: number) {}

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

  open(): void {
    this.readyState = 1;
    this.fire("open");
  }

  ready(): void {
    this.fire("ready");
  }

  ping(): void {
    this.fire("ping");
  }

  /** A non-200 — here the per-account cap's 429. EventSource stops reconnecting for good. */
  refuse(): void {
    this.refused = true;
    this.readyState = WAKE_STREAM_CLOSED;
    this.fire("error");
  }
}

function wakeFactory() {
  const streams: FakeWakeStream[] = [];
  return {
    streams,
    factory: (): WakeStreamLike => {
      const s = new FakeWakeStream(Date.now());
      streams.push(s);
      return s;
    },
  };
}

const quiet = { report: (): void => {} };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const SERVER_HEARTBEAT_MS = 15_000;

function start() {
  const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
  const { streams, factory } = wakeFactory();
  const doc = fakeVisibility("visible");
  const net = fakeOnline();
  const stop = startSyncScheduler(engineWith(adapter), { ...quiet, visibility: doc, online: net, wake: factory });
  return { adapter, streams, doc, net, stop };
}

describe("a stream refused at the cap", () => {
  it("is asked for again after a minute, and a freed slot relaxes the poll", async () => {
    const { adapter, streams, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.refuse();
    await vi.advanceTimersByTimeAsync(WAKE_STREAM_REASK_MS - 1_000);
    expect(streams.length, "asked again inside the minute").toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS + 1_000);
    expect(streams.length, "a refused tab never asked for the stream again").toBe(2);

    streams[1]!.open();                         // a slot freed: the server answers 200
    streams[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;
    for (let t = 0; t < 600_000; t += SERVER_HEARTBEAT_MS) {
      await vi.advanceTimersByTimeAsync(SERVER_HEARTBEAT_MS);
      streams[1]!.ping();
    }
    expect(streams.length, "a tab holding a stream asked for another").toBe(2);
    expect(adapter.calls - settled, "the poll did not relax to the safety cadence")
      .toBeLessThanOrEqual(Math.ceil(600_000 / WAKE_SAFETY_POLL_MS));
    stop();
  });

  it("is asked for at most once a minute, whatever wakes arrive", async () => {
    const { streams, doc, net, stop } = start();
    const refuseNew = (): void => { for (const s of streams) if (!s.refused && s.closed === 0) s.refuse(); };
    await vi.advanceTimersByTimeAsync(0);
    refuseNew();
    const RUN_MS = 600_000;
    for (let t = 0; t < RUN_MS; t += 5_000) {
      doc.set("hidden");
      doc.set("visible");
      net.fire();
      refuseNew();
      await vi.advanceTimersByTimeAsync(5_000);
      refuseNew();
    }
    const REASKS = streams.length - 1;
    const gaps = streams.slice(1).map((s, i) => s.at - streams[i]!.at);
    stop();
    expect(Math.min(...gaps), `re-asks ${REASKS}, gaps ${gaps.join(",")} ms`).toBeGreaterThanOrEqual(WAKE_STREAM_REASK_MS);
    expect(REASKS, `re-asks in ${RUN_MS} ms`).toBeGreaterThanOrEqual(8);
    expect(REASKS, `re-asks in ${RUN_MS} ms`).toBeLessThanOrEqual(RUN_MS / WAKE_STREAM_REASK_MS);
  });

  it("a re-asked stream that opens and then goes silent is the watchdog's, and the minute asks no more", async () => {
    const { streams, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.refuse();
    await vi.advanceTimersByTimeAsync(WAKE_STREAM_REASK_MS + POLL_MS + 1_000);
    expect(streams.length, "the premise: the refusal was asked again").toBe(2);
    streams[1]!.open();                         // admitted, then silent: closed, re-dialled once
    await vi.advanceTimersByTimeAsync(WAKE_STREAM_SILENCE_MS + 100);
    streams[2]!.open();
    await vi.advanceTimersByTimeAsync(600_000);
    stop();
    expect(streams.length, "an answered refusal went on asking every minute").toBe(3);
  });

  it("CONTROL: a healthy stream is never re-dialled", async () => {
    const { streams, net, stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    streams[0]!.ready();
    for (let t = 0; t < 600_000; t += SERVER_HEARTBEAT_MS) {
      await vi.advanceTimersByTimeAsync(SERVER_HEARTBEAT_MS);
      streams[0]!.ping();
      net.fire();
    }
    expect(streams.length).toBe(1);
    expect(streams[0]!.closed).toBe(0);
    stop();
  });
});
