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
  HIDDEN_POLL_MS,
  POLL_MS,
  WAKE_SAFETY_POLL_MS,
  WAKE_STREAM_CLOSED,
  WAKE_STREAM_REASK_MS,
  startSyncScheduler,
  type WakeStreamLike,
} from "../app/shell/sync-scheduler.js";

/**
 * THE WAKE STREAM AT THE SCHEDULER SEAM — the client half of the realtime wake slice.
 *
 * `sync-liveness.test.ts` proves the loop (cadences, backoff, refusals); this file proves the
 * PUSH layered onto it, and above all the property the slice was allowed to ship under:
 *
 *   **push is a hint, never a dependency** — with the stream dead, the scheduler's request
 *   pattern is IDENTICAL to a scheduler that never had a stream, measured to the millisecond
 *   over the same script of events. Everything else here is the three-state model: a healthy
 *   stream relaxes the poll to the safety cadence and its `sync` frames drain immediately; a
 *   hidden tab holds NO stream; a terminal refusal (the server's flag off — the production
 *   default until the deploy flips it) falls back to polling permanently for the session with
 *   zero reconnect attempts.
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

/** The server's heartbeat (`DEFAULT_SSE.heartbeatMs`): a live stream's `ping` cadence. */
const SERVER_HEARTBEAT_MS = 15_000;

/**
 * A hand-driven wake stream — the EventSource protocol reduced to what the scheduler reads. It
 * plays a LIVE server: `ready` on open and a `ping` every heartbeat while open. A stream that
 * opens and says nothing is `sync-silent-stream.test.ts`'s subject.
 */
class FakeWakeStream implements WakeStreamLike {
  readyState = 0; // CONNECTING
  closed = 0;
  private readonly listeners = new Map<string, Set<() => void>>();
  private beat: ReturnType<typeof setInterval> | null = null;

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
    this.stopBeat();
  }

  private fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }

  private stopBeat(): void {
    if (this.beat !== null) clearInterval(this.beat);
    this.beat = null;
  }

  /** The server accepted the stream (or a native reconnect landed): headers, then `ready`. */
  open(): void {
    this.readyState = 1;
    this.fire("open");
    this.fire("ready");
    this.stopBeat();
    this.beat = setInterval(() => { if (this.readyState === 1) this.fire("ping"); }, SERVER_HEARTBEAT_MS);
  }

  /** The server's content-free wake frame: something committed, drain now. */
  wake(): void {
    this.fire("sync");
  }

  /** A network blip: the browser is reconnecting natively (readyState CONNECTING). */
  errorTransient(): void {
    this.readyState = 0;
    this.stopBeat();
    this.fire("error");
  }

  /** A non-200: flag off, capacity, auth. EventSource stops reconnecting for good. */
  errorTerminal(): void {
    this.readyState = WAKE_STREAM_CLOSED;
    this.stopBeat();
    this.fire("error");
  }
}

/**
 * The retry hint `GET /events` sends (`packages/api/src/routes/events.ts`), and the number that
 * makes the blackout below a REPRODUCTION rather than a scenario: it is SHORTER than
 * {@link POLL_MS}, so a browser reconnecting on it fires `error` more often than the fast poll
 * period — which is exactly the condition a re-arm-on-every-error cannot survive.
 */
const RECONNECT_HINT_MS = 3_000;

/**
 * A stream killed at the TRANSPORT layer, played for `ms` of wall clock.
 *
 * This is what `EventSource` does when the connection cannot be made at all (a proxy killing
 * SSE, a dead network, a blocked request): the attempt fails, `error` fires with `readyState`
 * CONNECTING, the browser waits the server's hint and tries again — forever, and none of it
 * reaches the server. Nothing in the script touches the poll: whatever the scheduler does with
 * `/sync` during it is the scheduler's own doing.
 */
async function transportBlackout(stream: FakeWakeStream, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += RECONNECT_HINT_MS) {
    stream.errorTransient();
    await vi.advanceTimersByTimeAsync(RECONNECT_HINT_MS);
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── GUARD · a wake drains NOW, exactly once, through the serialized path ───────────────

describe("a `sync` frame is an immediate drain, and a burst coalesces", () => {
  it("drains within the same tick of the frame — not at the next poll period", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    const afterOpen = adapter.calls;             // the open itself drains once (catch-up)

    await vi.advanceTimersByTimeAsync(5_000);    // deep inside the safety period
    streams[0]!.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "the wake frame did not drain immediately").toBe(afterOpen + 1);

    stop();
  });

  it("a BARRAGE of frames during a drain in flight buys exactly ONE follow-up, at concurrency 1", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;

    // A slow drain, and five frames land while it is on the wire — a busy mailbox mid-import.
    adapter.latencyMs = 5_000;
    streams[0]!.wake();
    await vi.advanceTimersByTimeAsync(1_000);    // the wake's drain is now in flight
    for (let i = 0; i < 5; i++) streams[0]!.wake();
    await vi.advanceTimersByTimeAsync(4_000);    // …it settles at t+5s
    adapter.latencyMs = 0;
    await vi.advanceTimersByTimeAsync(1_000);    // the single queued follow-up fires

    // settled +1 (the first wake) +1 (ONE follow-up for five frames): a commit that landed
    // after the in-flight drain's read is picked up, and a burst cannot multiply drains.
    expect(adapter.calls, "five mid-drain frames must coalesce into one follow-up").toBe(settled + 2);
    expect(adapter.maxConcurrent, "two /sync drains ran against one cursor").toBe(1);

    // …and nothing else was armed early: the next drain is the safety poll, a full period on.
    const before = adapter.calls;
    await vi.advanceTimersByTimeAsync(WAKE_SAFETY_POLL_MS - 2_000);
    expect(adapter.calls).toBe(before);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(adapter.calls).toBe(before + 1);

    stop();
  });
});

// ── GUARD · the three cadences ──────────────────────────────────────────────────────────

describe("the poll stands down under a healthy stream, and no further", () => {
  it("open stream ⇒ safety cadence; no 8 s polls underneath it", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;

    // Five fast periods pass in silence — the stream carries the tab…
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(adapter.calls, "the fast poll kept running under a healthy stream").toBe(settled);
    // …but the SAFETY poll still exists: push is a hint, and a silently dead stream may cost
    // at most this much staleness.
    await vi.advanceTimersByTimeAsync(WAKE_SAFETY_POLL_MS - POLL_MS * 5 + 100);
    expect(adapter.calls, "the safety poll is gone — push became a dependency").toBe(settled + 1);

    stop();
  });

  it("a TRANSIENT stream error falls back to the fast poll until the reconnect lands", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;

    // The stream drops; the browser is reconnecting natively. The scheduler must not sit out
    // the rest of a 90 s safety period against a stream that is not listening.
    streams[0]!.errorTransient();
    await vi.advanceTimersByTimeAsync(POLL_MS + 100);
    expect(adapter.calls, "a disconnected stream left the slow cadence in charge").toBe(settled + 1);

    // The native reconnect lands: one catch-up drain (the disconnected window may have eaten
    // frames), and the slow cadence resumes.
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(settled + 2);
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(adapter.calls, "the fast poll survived the reconnect").toBe(settled + 2);

    stop();
  });
});

// ── GUARD · hidden holds no stream ──────────────────────────────────────────────────────

describe("a hidden tab holds NO stream", () => {
  it("hide closes the stream, return reopens it — and the hidden cadence rules in between", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const doc = fakeVisibility("visible");
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: doc, online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toHaveLength(1);

    doc.set("hidden");
    expect(streams[0]!.closed, "the hidden tab is still holding a server connection").toBeGreaterThan(0);

    // While hidden: the minute cadence, and no new stream.
    const atHide = adapter.calls;
    await vi.advanceTimersByTimeAsync(HIDDEN_POLL_MS + 100);
    expect(adapter.calls).toBe(atHide + 1);
    expect(streams, "a hidden tab reopened its stream").toHaveLength(1);

    // Return: a fresh stream, and an immediate drain.
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toHaveLength(2);
    expect(adapter.calls).toBe(atHide + 2);

    stop();
  });

  it("a tab that mounts HIDDEN opens no stream at all until it is looked at", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const doc = fakeVisibility("hidden");
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: doc, online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(HIDDEN_POLL_MS * 2);
    expect(streams, "a background tab dialed the wake stream").toHaveLength(0);

    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toHaveLength(1);

    stop();
  });
});

// ── GUARD · SSE dead ⇒ byte-identical to the poll-only module ───────────────────────────

describe("with the stream dead, behaviour is byte-identical to a scheduler that never had one", () => {
  /**
   * The same script of events, twice — once with no wake factory (the module as it always
   * was), once with a stream that is refused terminally on its first breath (the production
   * default until the deploy flips `TF_SSE`) — and the request timeline must be EQUAL, not
   * merely similar. This is the assertion that makes "push is a hint, never a dependency" a
   * measured property instead of a sentence in a header.
   */
  async function timeline(deadStream: boolean): Promise<number[]> {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const doc = fakeVisibility("visible");
    const net = fakeOnline();
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: doc, online: net,
      ...(deadStream ? { wake: factory } : {}),
    });

    await vi.advanceTimersByTimeAsync(0);
    if (deadStream) {
      streams[0]!.errorTerminal();               // the server refused: flag off / capacity / auth
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(20_000);
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(90_000);
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(15_000);
    net.fire();
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    if (deadStream) {
      // The storm bound rides along: the refusal is asked again once, at the return a minute
      // on, however many flips and flaps followed — and the re-ask buys no drain of its own.
      expect(streams, "the refused stream was asked again more than once a minute").toHaveLength(2);
    }
    const t0 = adapter.startedAt[0]!;
    return adapter.startedAt.map((t) => t - t0);
  }

  it("the request timeline is EQUAL through polls, a hide, a return and an online flap", async () => {
    const bare = await timeline(false);
    const dead = await timeline(true);
    expect(bare.length, "the premise: the script must produce a real timeline").toBeGreaterThan(6);
    expect(dead).toEqual(bare);
  });
});

// ── GUARD · the refusal cannot storm ────────────────────────────────────────────────────

describe("a refused stream is not redialed inside the minute", () => {
  it("flag-off server ⇒ one construction and zero retries for a minute, whatever wakes arrive", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const doc = fakeVisibility("visible");
    const net = fakeOnline();
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: doc, online: net, wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.errorTerminal();

    // Every wake source fires, repeatedly. None of them may buy a reconnect: `EventSource`
    // treats a non-200 as terminal precisely so a flag-off deployment is not hammered, and a
    // scheduler that redialed on visibility flips would undo that on every alt-tab.
    for (let i = 0; i < 3; i++) {
      doc.set("hidden");
      doc.set("visible");
      net.fire();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(streams, "the refused stream was redialed — a reconnect storm against a flag-off server").toHaveLength(1);

    // …and the tab is fine: it is a poll-only tab now, draining on the fast cadence.
    const before = adapter.calls;
    await vi.advanceTimersByTimeAsync(POLL_MS + 100);
    expect(adapter.calls).toBeGreaterThan(before);

    stop();
  });
});

// ── GUARD · THE POLL FLOOR IS NOT THE STREAM'S DEPENDENT ────────────────────────────────

/**
 * THE HOLE THE FIRST WAKE SLICE SHIPPED, MEASURED IN PRODUCTION AND REPRODUCED HERE.
 *
 * The earlier case proves the CODED refusal path (a non-200: the server said no, in a status, once) and it
 * was always sound. The refusal a stream can suffer without any status at all was not: with
 * `/api/events` blocked at the transport layer on a live tab, the page issued **exactly one**
 * `/api/sync` over minutes and then none, while the browser retried again and again at the
 * server's hint; a mutation made minutes earlier was still not on screen, with no
 * warning anywhere in the UI.
 *
 * The mechanism is the arithmetic between two constants that were never compared. Every failed
 * reconnect fires `error`, the handler re-armed the fast poll, and `arm()` DISARMS before it
 * sets: at a 3 s retry hint against an 8 s poll the countdown was thrown away and restarted two
 * seconds before it could ever fire. The floor was not slow — it was starved, and starved
 * *harder* the sicker the stream got, which is precisely backwards.
 *
 * So the property under test is not "an error re-arms the poll" (it did, ~70 times, uselessly)
 * but the one the header now states: **a floor is a bound on staleness, and a bound may only
 * ever be pulled EARLIER, never pushed out.**
 */
describe("the poll floor survives a stream that fails at the transport layer", () => {
  it("a blocked reconnect storm ⇒ the 8 s floor keeps running, not one drain then silence", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;
    const from = Date.now();

    // The exact live falsification: 210 s with `/api/events` unreachable, tab visible.
    await transportBlackout(streams[0]!, 210_000);

    const drains = adapter.calls - settled;
    expect(drains, "the tab went quiet behind a dead stream — the production shape").toBeGreaterThanOrEqual(24);
    expect(
      longestGap(adapter.startedAt, from, Date.now()),
      "a silent window longer than one poll period plus a retry beat",
    ).toBeLessThanOrEqual(POLL_MS + RECONNECT_HINT_MS);

    stop();
  });

  it("the server's own 270 s close, with the reconnect blocked, is the same shape and the same floor", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    // A healthy stream for its whole server-side life: the route cycles the connection before
    // the platform ceiling, so EVERY tab reaches this moment eventually — the reconnect is
    // ordinary, and the blackout that follows it is what makes it dangerous.
    await vi.advanceTimersByTimeAsync(270_000);
    const settled = adapter.calls;
    const from = Date.now();

    await transportBlackout(streams[0]!, 330_000);   // 5.5 min, the second live measurement

    expect(
      adapter.calls - settled,
      "the tab that was healthiest longest went the quietest",
    ).toBeGreaterThanOrEqual(38);
    expect(
      longestGap(adapter.startedAt, from, Date.now()),
      "a silent window longer than one poll period plus a retry beat",
    ).toBeLessThanOrEqual(POLL_MS + RECONNECT_HINT_MS);

    stop();
  });

  it("a CODED refusal is unchanged: one construction, the fast floor, no starvation", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;
    const from = Date.now();
    streams[0]!.errorTerminal();

    // Every re-ask is refused as well: the floor must hold through each of them.
    for (let t = 0; t < 210_000; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      for (const s of streams) if (s.readyState === 0) s.errorTerminal();
    }
    expect(streams.length, "the refused stream was asked again more than once a minute")
      .toBeLessThanOrEqual(1 + Math.floor(210_000 / WAKE_STREAM_REASK_MS));
    expect(adapter.calls - settled, "the permanent fallback is the 8 s poll").toBeGreaterThanOrEqual(24);
    expect(longestGap(adapter.startedAt, from, Date.now())).toBeLessThanOrEqual(POLL_MS + 100);

    stop();
  });

  it("the floor is TEMPORARY: a reconnect that lands restores the safety cadence", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);

    await transportBlackout(streams[0]!, 30_000);
    streams[0]!.open();                              // the native reconnect finally lands
    await vi.advanceTimersByTimeAsync(0);
    const settled = adapter.calls;

    // Back to the safety cadence: the blackout must not leave a permanent 8 s poll behind, or
    // the ~450 req/hr the stream exists to avoid comes back and never leaves.
    await vi.advanceTimersByTimeAsync(WAKE_SAFETY_POLL_MS - 1_000);
    expect(adapter.calls, "the fast floor outlived the outage that justified it").toBe(settled);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(adapter.calls).toBe(settled + 1);

    stop();
  });

  it("a mid-drain death arms the floor from the settle, not from the error", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);

    // A wake's drain is on the wire when the stream dies underneath it — the race the error
    // handler cannot arm anything for, because a running drain owns the next timer.
    adapter.latencyMs = 5_000;
    streams[0]!.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    const from = Date.now();
    await transportBlackout(streams[0]!, 60_000);
    adapter.latencyMs = 0;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      longestGap(adapter.startedAt, from, Date.now()),
      "the drain in flight swallowed the floor: nothing re-armed after it settled",
    ).toBeLessThanOrEqual(POLL_MS + RECONNECT_HINT_MS + 5_000);

    stop();
  });

  it("a HIDDEN tab keeps its minute, and a late error from the closed stream cannot speed it up", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    const { streams, factory } = wakeFactory();
    const doc = fakeVisibility("visible");
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, visibility: doc, online: fakeOnline(), wake: factory,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.open();
    await vi.advanceTimersByTimeAsync(0);

    doc.set("hidden");
    const atHide = adapter.calls;
    // The stream the scheduler just closed still has a socket to lose; its `error` must not
    // reach a tab nobody is looking at and buy it the visible cadence.
    streams[0]!.errorTransient();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(adapter.calls, "a hidden tab was pulled onto the 8 s cadence by a dead stream").toBe(atHide);
    await vi.advanceTimersByTimeAsync(HIDDEN_POLL_MS - POLL_MS * 5 + 200);
    expect(adapter.calls, "the hidden minute was lost").toBe(atHide + 1);

    stop();
  });
});

// ── GUARD · the structural sweep: no live state without a timer ─────────────────────────

/**
 * ENUMERATED, NOT ARGUED.
 *
 * The defect above was one unreachable-looking corner of a machine with four inputs (visibility,
 * the stream's three events, the network, the clock), and the reason it shipped is that every
 * individual path READ correctly. So this walks every script of up to three events over that
 * alphabet — 155 schedulers — and asserts the one property the whole module exists to provide:
 *
 *   **whatever happened, a tab that is visible and not terminally refused drains again within
 *   the cadence its state calls for** — and a tab whose stream is genuinely healthy is NOT on
 *   the fast cadence, which is the half a "re-arm harder" fix would quietly destroy.
 */
describe("every reachable state of the machine leaves a drain armed", () => {
  const STEPS = ["open", "frame", "error", "refuse", "hide", "show", "online"] as const;
  type Step = typeof STEPS[number];

  it("155 event scripts, each followed by the cadence its end state promises", async () => {
    const scripts: Step[][] = [[]];
    for (const a of STEPS) {
      scripts.push([a]);
      for (const b of STEPS) scripts.push([a, b]);
    }

    for (const script of scripts) {
      const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
      const doc = fakeVisibility("visible");
      const net = fakeOnline();
      const { streams, factory } = wakeFactory();
      const stop = startSyncScheduler(engineWith(adapter), {
        ...quiet, visibility: doc, online: net, wake: factory,
      });
      await vi.advanceTimersByTimeAsync(0);

      // The test's own model of what the script did. It is deliberately written from the
      // PROTOCOL (a closed stream delivers nothing; a refused one is never redialed), never
      // from the scheduler's internals, so agreement means something.
      let dead = false;
      let healthy = false;
      let hidden = false;

      for (const step of script) {
        const s = streams[streams.length - 1];
        const reachable = !dead && !hidden && s !== undefined;
        if (step === "open" && reachable) { s!.open(); healthy = true; }
        if (step === "frame" && reachable) s!.wake();
        if (step === "error" && reachable) { s!.errorTransient(); healthy = false; }
        if (step === "refuse" && reachable) { s!.errorTerminal(); healthy = false; dead = true; }
        // A `visibilitychange` that does not CHANGE anything still fires, and it must not be
        // modelled as a reconnect: only going hidden closes the stream, so a redundant "show"
        // on a visible tab leaves a healthy stream exactly as healthy as it was.
        if (step === "hide") { doc.set("hidden"); hidden = true; healthy = false; }
        if (step === "show") { doc.set("visible"); if (hidden) healthy = false; hidden = false; }
        if (step === "online") net.fire();
        await vi.advanceTimersByTimeAsync(0);
      }

      const label = `[${script.join(",")}]`;
      const expected = hidden ? HIDDEN_POLL_MS : (healthy ? WAKE_SAFETY_POLL_MS : POLL_MS);
      const before = adapter.calls;

      if (expected > POLL_MS * 2) {
        await vi.advanceTimersByTimeAsync(POLL_MS * 2);
        expect(adapter.calls, `${label}: drained on the fast cadence in a ${expected} ms state`).toBe(before);
        await vi.advanceTimersByTimeAsync(expected - POLL_MS * 2 + 200);
      } else {
        await vi.advanceTimersByTimeAsync(expected + 200);
      }
      expect(
        adapter.calls,
        `${label}: NOTHING was armed — this tab is live and silently stale`,
      ).toBeGreaterThan(before);

      stop();
    }
  });
});

// ── WEB-RESUME-BURST · a return's stream and drain, with and without the resume lane ────────

describe("a return dials its stream before the drain without a lane, after the delta's lead with one", () => {
  for (const withLane of [false, true]) {
    it(withLane ? "with the lane: the drain first, then the stream once its lead is over" : "no lane (the desktop): the stream first, then the drain, as before", async () => {
      const { createResumeLane } = await import("../app/shell/resume-lane.js");
      const order: string[] = [];
      const adapter = new ScriptedAdapter((_p, n) => { order.push("drain"); return page(`c${n + 1}`, []); });
      const { streams, factory } = wakeFactory();
      const doc = fakeVisibility("visible");
      const stop = startSyncScheduler(engineWith(adapter), {
        ...quiet, visibility: doc, online: fakeOnline(),
        wake: () => { order.push("dial"); return factory(); },
        ...(withLane ? { lane: createResumeLane() } : {}),
      });
      await vi.advanceTimersByTimeAsync(0);
      streams[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      doc.set("hidden");
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      order.length = 0;
      doc.set("visible");
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(withLane ? ["drain", "dial"] : ["dial", "drain"]);
      stop();
    });
  }
});
