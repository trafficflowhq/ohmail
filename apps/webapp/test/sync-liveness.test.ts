/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CursorExpiredError,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  type EngineAdapter,
  type MessageBodyWire,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import {
  BACKOFF_MIN_MS,
  POLL_MS,
  REFUSAL_CONFIRM_MS,
  REFUSAL_SUSTAIN_MS,
  backoffDelay,
  createSyncGate,
  sameSyncStatus,
  startSyncScheduler,
  SYNC_BOOTSTRAPPING,
  type SyncStatus,
} from "@ohmail/app-logic/session/sync-scheduler";

/**
 * SYNC LIVENESS, as behaviour.
 *
 * Before this slice `EngineProvider` called `engine.start()` once and that was every drain a
 * tab would ever do. Nothing here asserts the ABSENCE of that bug in the abstract; each test
 * drives the real loop against a real `OhmailEngine` and counts what reached the adapter.
 *
 * The engine is real on purpose. A hand-written double would let the tests agree with a
 * scheduler that bypasses `syncOnce()`'s single-flight, mishandles the 410 re-bootstrap, or
 * loses the cursor — which are precisely the three things worth proving.
 */

interface Page {
  /** Entities this page carries, as `id`s. */
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

/**
 * An adapter that answers from a script and records HOW its calls overlapped.
 *
 * `maxConcurrent` is the point of the class: a delta-sync client that lets two `/sync`
 * requests run at once against one cursor is the shape of every convergence bug in this
 * package, so the number is measured rather than reasoned about.
 */
class ScriptedAdapter implements EngineAdapter {
  readonly since: string[] = [];
  /** `Date.now()` at each call, so cadence can be asserted against the fake clock. */
  readonly startedAt: number[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  /** Milliseconds each call takes, on the fake clock. */
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

  /** Body fetches, so the gate's forwarding of them can be counted. */
  readonly bodyCalls: string[] = [];

  async withdrawSend() { return { outcome: "unsupported" as const }; }
  async fetchBody(messageId: string): Promise<MessageBodyWire> {
    this.bodyCalls.push(messageId);
    return { text: `body of ${messageId}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
  }
}

function engineWith(adapter: EngineAdapter): OhmailEngine {
  return new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
}

/**
 * A mirror whose hydration the TEST releases.
 *
 * `store.load()` is the one await the loop makes before its first `/sync`, and in a real tab it
 * is an IndexedDB open plus the whole persisted mirror — hundreds of milliseconds, seconds on a
 * large cold account. Everything in the "mid-hydration" block below stands inside that window,
 * which is only reachable if the test can hold it open.
 */
class GatedStore extends MemoryMirrorStore {
  private release: (() => void) | null = null;
  readonly loaded: Promise<void>;
  private settle!: () => void;
  private readonly gate: Promise<void>;

  constructor() {
    super();
    this.gate = new Promise<void>((r) => { this.release = r; });
    this.loaded = new Promise<void>((r) => { this.settle = r; });
  }

  override async load(): Promise<void> {
    await this.gate;
    await super.load();
    this.settle();
  }

  finishHydrating(): void {
    this.release?.();
  }
}

/**
 * The live wiring, in one line: a gate, an adapter it guards, and the engine built around them.
 *
 * `createEngine` (`app/shell/engine-config.ts`) does exactly this for the Cloud client, so the
 * per-page abort the tests below drive is the same object production runs, not a stand-in.
 */
function gatedEngine(adapter: EngineAdapter, store?: MemoryMirrorStore) {
  const gate = createSyncGate(null);
  const engine = new OhmailEngine({
    adapter: gate.guard(adapter),
    store: store ?? new MemoryMirrorStore(),
  });
  return { engine, gate };
}

/** A `document` whose visibility the test owns outright. */
function fakeVisibility(initial: DocumentVisibilityState = "visible") {
  const listeners = new Set<() => void>();
  let state = initial;
  return {
    get visibilityState(): DocumentVisibilityState {
      return state;
    },
    /** How many listeners are still attached — the leak check. */
    get attached(): number {
      return listeners.size;
    },
    addEventListener(_type: "visibilitychange", l: () => void): void {
      listeners.add(l);
    },
    removeEventListener(_type: "visibilitychange", l: () => void): void {
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
    get attached(): number {
      return listeners.size;
    },
    addEventListener(_type: "online", l: () => void): void {
      listeners.add(l);
    },
    removeEventListener(_type: "online", l: () => void): void {
      listeners.delete(l);
    },
    fire(): void {
      for (const l of [...listeners]) l();
    },
  };
}

/** Silence the scheduler's console reporting; failures are asserted, not read. */
const quiet = { report: (): void => {} };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── GUARD 1 · the hidden cadence ──────────────────────────────────────────────────────────
//
// REWRITTEN BY THE REALTIME-WAKE SLICE, openly: this describe used to be "a hidden tab
// performs ZERO syncs", and every assertion in it said so. The contract changed — a hidden
// tab now drains once a minute (HIDDEN_POLL_MS) so the mailbox is at most a minute stale at
// the moment of return — so the assertions changed with it. What survives unchanged is the
// SHAPE of the discipline: the cadence is a hard bound (nothing accelerates a hidden tab, not
// `online`, not a wake burst), and coming back still drains at once.

describe("a hidden tab drains once a minute, and nothing accelerates it", () => {
  it("a tab that mounts hidden drains once, then holds the hidden cadence", async () => {
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const doc = fakeVisibility("hidden");
    const net = fakeOnline();

    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      visibility: doc,
      online: net,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "the mount drain hydrates and warms the mirror").toBe(1);

    // Five FAST poll periods: nothing. The 8 s cadence belongs to a visible tab.
    await vi.advanceTimersByTimeAsync(8_000 * 5 + 1_000);
    expect(adapter.calls, "a hidden tab polled at the visible cadence").toBe(1);
    // …but a timer IS armed — the once-a-minute one. (This assertion used to be `toBe(0)`.)
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.calls, "the hidden cadence never fired").toBe(2);

    // THE CONTROL. One visibility flip and it drains at once — the minute is a cadence for
    // tabs nobody is looking at, never a delay charged to somebody who just came back.
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(3);

    stop();
  });

  it("going hidden mid-flight slows the pending poll to the hidden cadence", async () => {
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const doc = fakeVisibility("visible");
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      visibility: doc,
      online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);

    doc.set("hidden");
    // The 8 s timer is REPLACED by the minute one, not left to fire: four fast periods pass
    // in silence, and the drain lands on the hidden cadence.
    await vi.advanceTimersByTimeAsync(8_000 * 4);
    expect(adapter.calls, "a backgrounded tab kept the visible cadence").toBe(1);
    await vi.advanceTimersByTimeAsync(60_000 - 8_000 * 4);
    expect(adapter.calls, "the hidden cadence never fired").toBe(2);

    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "returning to the tab did not drain at once").toBe(3);

    stop();
  });

  it("`online` wakes a visible tab without waiting out the period", async () => {
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const net = fakeOnline();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      visibility: fakeVisibility("visible"),
      online: net,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    net.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(2);

    stop();
  });

  it("`online` on a HIDDEN tab buys nothing early — the cadence outranks the wake", async () => {
    // A laptop rejoining wifi in a bag must not drain a tab nobody is there for. The next
    // drain arrives when the minute does, not when the network flaps.
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const net = fakeOnline();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      visibility: fakeVisibility("hidden"),
      online: net,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);              // the mount drain

    net.fire();
    net.fire();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(adapter.calls, "an `online` flap drained a hidden tab early").toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(adapter.calls).toBe(2);              // the cadence, on schedule

    stop();
  });
});

// ── GUARD 3 · one drain at a time, whatever fires ────────────────────────────────────────

describe("overlapping wakes never produce two concurrent /sync calls", () => {
  it("a barrage of wakes plus an app-driven drain stays at concurrency 1", async () => {
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`], false));
    adapter.latencyMs = 5_000; // a drain that outlives several wake events
    const engine = engineWith(adapter);
    const doc = fakeVisibility("visible");
    const net = fakeOnline();
    const stop = startSyncScheduler(engine, { ...quiet, visibility: doc, online: net });

    // Mid-flight: the network flaps, the tab is re-focused, and a mutation pulls its own
    // authoritative delta — the three callers the ruling says must never stack.
    await vi.advanceTimersByTimeAsync(1_000);
    net.fire();
    doc.set("visible");
    void engine.syncOnce();
    net.fire();
    await vi.advanceTimersByTimeAsync(1_000);
    net.fire();
    void engine.syncOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(adapter.maxConcurrent, "two /sync requests ran against one cursor").toBe(1);

    stop();
  });

  it("the next poll is timed from when the drain SETTLED, not from when it began", async () => {
    // This is what `setInterval` gets wrong. With a 5 s drain and an 8 s cadence, a
    // serialized loop starts drains at 0 and 13 s; an interval would start one at 8 s.
    const adapter = new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`]));
    adapter.latencyMs = 5_000;
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      visibility: fakeVisibility("visible"),
      online: fakeOnline(),
    });

    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(30_000);
    const offsets = adapter.startedAt.map((t) => t - t0);
    expect(offsets).toEqual([0, 13_000, 26_000]);

    stop();
  });
});

// ── GUARD 4 · cursor integrity (the "Delta-first client contract" invariant) ────────────────────────────────────────────

describe("a failed drain costs nothing the next one cannot recover", () => {
  it("reject-once-then-succeed lands on exactly the cursor a clean run would", async () => {
    const script: Array<Page | Error> = [
      page("c1", ["m1"], true),
      new Error("transient"),
      page("c2", ["m2"], false),
    ];
    const adapter = new ScriptedAdapter((_p, n) => script[n] ?? page("c2", [], false));
    const engine = engineWith(adapter);
    const stop = startSyncScheduler(engine, {
      ...quiet,
      random: () => 1,
      visibility: fakeVisibility("visible"),
      online: fakeOnline(),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    stop();

    // The CONTROL: the same two pages with no failure between them.
    const clean = new ScriptedAdapter((_p, n) =>
      [page("c1", ["m1"], true), page("c2", ["m2"], false)][n] ?? page("c2", [], false),
    );
    const control = engineWith(clean);
    await control.start();

    expect(engine.store.getCursor()).toBe(control.store.getCursor());
    expect(engine.read().list("message").length).toBe(control.read().list("message").length);
    expect(engine.store.maxSeq()).toBe(control.store.maxSeq());
    // And the retry resumed from the persisted cursor rather than re-bootstrapping.
    // (Later entries are the healthy 8 s poll, which is the point of the slice.)
    expect(adapter.since.slice(0, 3)).toEqual(["0", "c1", "c1"]);
  });

  it("a permanently expired cursor backs off instead of hammering", async () => {
    // `drain()` answers a 410 by resetting to `since=0` ONCE per drain and surfacing the
    // second, so every scheduler tick here costs exactly two requests. The question is how
    // many ticks ten minutes buys.
    const adapter = new ScriptedAdapter(() => new CursorExpiredError());
    const engine = engineWith(adapter);
    const stop = startSyncScheduler(engine, {
      ...quiet,
      random: () => 1, // worst case for this assertion: the LONGEST jittered delay
      visibility: fakeVisibility("visible"),
      online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stop();

    // Backoff reaches the 60 s cap after seven failures, so ten minutes is ~15 drains.
    // A loop with no backoff would be 75 drains / 150 requests; one with no delay at all
    // would be unbounded.
    expect(adapter.calls / 2).toBeGreaterThan(8);
    expect(adapter.calls / 2).toBeLessThan(20);
    // Every attempt re-bootstrapped from zero and none of them advanced the cursor.
    expect(new Set(adapter.since)).toEqual(new Set(["0"]));
    expect(engine.store.getCursor()).toBe("0");
  });

  it("the loop never gives up while the tab is visible", async () => {
    const adapter = new ScriptedAdapter((_p, n) =>
      n < 12 ? new Error("down") : page("c1", ["m1"]),
    );
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      random: () => 1,
      visibility: fakeVisibility("visible"),
      online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // The twelfth failure is well past the 60 s cap; a retry budget would have stopped here.
    expect(adapter.calls).toBeGreaterThan(12);
    stop();
  });

  it("failures are reported and counted, and one success clears the count", async () => {
    const status: Array<{ bootstrapping: boolean; failures: number }> = [];
    const reported: string[] = [];
    const adapter = new ScriptedAdapter((_p, n) =>
      n < 3 ? new Error("down") : page("c1", ["m1"]),
    );
    const stop = startSyncScheduler(engineWith(adapter), {
      onStatus: (s) => status.push(s),
      report: (m) => reported.push(m),
      random: () => 1,
      visibility: fakeVisibility("visible"),
      online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    expect(reported).toHaveLength(3);
    expect(reported[2]).toContain("attempt 3");
    // Published: the pre-tick value, then one per settled drain.
    expect(status.slice(0, 5).map((s) => s.failures)).toEqual([0, 1, 2, 3, 0]);
    // `bootstrapping` only clears on a drain that actually landed.
    expect(status.slice(0, 5).map((s) => s.bootstrapping))
      .toEqual([true, true, true, true, false]);
    // Everything after the recovery is the steady state, published unchanged. `refused: false`
    // was added by that change and `ownerLost: false` by the account-marker slice — this is a deep
    // `toEqual`, so it is the one assertion in the file that notices a new field at all, which
    // is exactly what it is for, and both fields were added here by it going red — as was
    // `standingDown: false`, the 402 stand-down's, published on every tick.
    expect(status.slice(5))
      .toEqual(status.slice(5).map(() => (
        { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false, standingDown: false }
      )));
  });
});

describe("backoffDelay", () => {
  it("is jittered under a doubling ceiling, capped at 60 s", () => {
    const max = (n: number): number => backoffDelay(n, { random: () => 0.999999 });
    expect(max(1)).toBe(999);
    expect(max(2)).toBe(1_999);
    expect(max(3)).toBe(3_999);
    expect(max(7)).toBe(59_999);
    expect(max(8)).toBe(59_999);
    expect(max(40)).toBe(59_999); // 2**39 ms would overflow into nonsense without the cap
  });

  /**
   * THIS ASSERTION USED TO SAY THE OPPOSITE, AND IT WAS ASSERTING A DEFECT.
   *
   * It read `expect(backoffDelay(5, { random: () => 0 })).toBe(0)` under the heading "FULL
   * jitter — the floor is zero, so retries scatter instead of stampeding", and the module
   * comment claimed the doubling ceiling made a tight loop impossible. An external `max`-effort
   * review showed the claim is false at the end that matters: the floor was
   * zero at EVERY ceiling, so a permanently failing drain parked at the 60-second cap could
   * still draw 0 ms — repeatedly, since nothing bounds a run of small draws. With a permanent
   * `410 CursorExpired` each drain is two requests, so the "degraded steady state a mail client
   * can sit in forever" could spin at network speed against the "No API cost without revenue behind it" invariant.
   *
   * The contract is now `max(250 ms, ceiling / 4)` as a floor. This is not a weakened
   * assertion — it is the same property (scatter) with the missing half (a lower bound) added,
   * and the scatter is still asserted below.
   */
  it("has a FLOOR that grows with the ceiling, so it cannot tight-loop", () => {
    expect(backoffDelay(1, { random: () => 0 })).toBe(BACKOFF_MIN_MS);
    expect(backoffDelay(5, { random: () => 0 })).toBe(4_000);   // ceiling 16 s ⇒ floor 4 s
    expect(backoffDelay(40, { random: () => 0 })).toBe(15_000); // at the cap ⇒ floor 15 s
    // Every draw, at every failure count, clears the absolute minimum.
    for (let n = 1; n <= 12; n++) {
      for (const r of [0, 0.001, 0.5, 0.999]) {
        expect(backoffDelay(n, { random: () => r }), `n=${n} r=${r}`).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
      }
    }
  });

  it("still SCATTERS — the anti-stampede property the floor must not cost", () => {
    const draws = [0.1, 0.4, 0.9].map((r) => backoffDelay(5, { random: () => r }));
    expect(new Set(draws).size).toBe(3);
    // Three quarters of the ceiling is still available to the draw, so N tabs knocked offline
    // by one upstream blip do not return in a wave.
    expect(Math.max(...draws) - Math.min(...draws)).toBeGreaterThan(8_000);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   GUARD 6 · THE AWAIT BOUNDARIES — every place the answer can change mid-flight
   ══════════════════════════════════════════════════════════════════════════════════════════

   The abort predicate is asked before a drain starts, again after hydration's await (as long
   as an IndexedDB open), and — via the gate — before every page of a drain in flight; an
   external `max`-effort review found all three holes. The realtime-wake slice
   narrowed WHAT the predicate refuses — teardown and terminal, no longer visibility, because a
   hidden tab is now entitled to its once-a-minute drain — so the cases below assert the
   NEW contract openly where they used to assert zero. (teardown) is unchanged and remains
   the reason the machinery exists.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("hydration's await boundary", () => {
  it("a tab hidden MID-HYDRATION still gets its drain, on the hidden cadence thereafter", async () => {
    // REVERSED by the realtime-wake slice: this used to assert zero /sync for ever. A
    // hidden tab now syncs once a minute, so the drain that was waiting on hydration goes out
    // — what the hide changes is the cadence it leaves behind.
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const store = new GatedStore();
    const doc = fakeVisibility("visible");
    const engine = new OhmailEngine({ adapter, store });
    const stop = startSyncScheduler(engine, { ...quiet, visibility: doc, online: fakeOnline() });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "the drain must be waiting on hydration").toBe(0);

    doc.set("hidden");
    store.finishHydrating();
    await store.loaded;
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "the hydrated drain was withheld from a hidden tab").toBe(1);

    // …and what follows is the minute, not the visible cadence.
    await vi.advanceTimersByTimeAsync(8_000 * 4);
    expect(adapter.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.calls).toBe(2);

    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(3);

    stop();
  });

  it("TEARDOWN during hydration cancels the drain — a live→demo swap issues no live request", async () => {
    // It is the demo-content and testing-bar invariants as well as the API-cost one. `engine.tsx` replaces the engine on a
    // mode change and React runs this cleanup first; the discarded LIVE engine was still inside
    // `store.load()`, and when that resolved it called `/sync` from behind a page whose whole
    // promise is that nothing leaves the tab.
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const store = new GatedStore();
    const engine = new OhmailEngine({ adapter, store });
    const stop = startSyncScheduler(engine, {
      ...quiet, visibility: fakeVisibility("visible"), online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(0);

    stop();                       // the mode change
    store.finishHydrating();
    await store.loaded;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(adapter.calls, "the discarded live engine reached the network").toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("an IN-FLIGHT drain stops paging when its SCHEDULER does", () => {
  /** A 37-page bootstrap, one second per page — the shape the gate was written for. */
  const bootstrap = (pages: number) =>
    new ScriptedAdapter((_p, n) => page(`c${n + 1}`, [`m${n + 1}`], n + 1 < pages));

  it("hiding mid-bootstrap no longer aborts it — the drain completes, quietly (wake-slice reversal)", async () => {
    // REVERSED OPENLY. The gate used to refuse the next page the moment the tab hid, and
    // the old assertion here — "at most ONE more page" — was the proof. A hidden tab is now
    // entitled to drains (the once-a-minute cadence), and a gate that still read visibility
    // would cancel page 2 of the very drain the hidden tick just started. So the in-flight
    // bootstrap runs to completion, it is not a failure, and nothing is reported; what the
    // hide governs is the CADENCE of the drains that follow.
    const adapter = bootstrap(37);
    adapter.latencyMs = 1_000;
    const doc = fakeVisibility("visible");
    const reported: string[] = [];
    const status: SyncStatus[] = [];
    const { engine, gate } = gatedEngine(adapter);
    const stop = startSyncScheduler(engine, {
      gate, visibility: doc, online: fakeOnline(),
      report: (m) => reported.push(m),
      onStatus: (s) => status.push(s),
    });

    await vi.advanceTimersByTimeAsync(4_500);
    const atHide = adapter.calls;
    expect(atHide, "the bootstrap should be several pages in").toBeGreaterThanOrEqual(4);
    expect(atHide).toBeLessThan(37);

    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(37_000);
    expect(adapter.calls, "the hide cancelled a drain hidden tabs are entitled to").toBe(37);
    expect(reported).toEqual([]);
    expect(status.every((s) => s.failures === 0)).toBe(true);

    // The completed bootstrap settles onto the HIDDEN cadence: one more drain a minute later,
    // resuming from the cursor the pages advanced, never from zero.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.calls).toBe(38);
    expect(adapter.since[37]).toBe("c37");

    stop();
  });

  it("teardown mid-bootstrap stops it — `stopped` cancels, it does not merely stop caring", async () => {
    const adapter = bootstrap(37);
    adapter.latencyMs = 1_000;
    const { engine, gate } = gatedEngine(adapter);
    const stop = startSyncScheduler(engine, {
      ...quiet, gate, visibility: fakeVisibility("visible"), online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(4_500);
    const atStop = adapter.calls;
    stop();
    // At most ONE more: the page already on the wire when the teardown ran finishes; the next
    // is refused. Cancelling a request already in flight is not what the gate fixes, and
    // pretending otherwise would be the weaker claim.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(adapter.calls).toBeLessThanOrEqual(atStop + 1);
  });

  it("MUTATIONS ARE NOT GATED — the user's own intent still reaches the server", async () => {
    // The gate is about polling cost, not about refusing a click. A hidden tab that is asked to
    // move a message must still move it.
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    let mutations = 0;
    const guarded = createSyncGate(null);
    const wrapped = guarded.guard({
      sync: (p) => adapter.sync(p),
      mutate: async (): Promise<MutationOutcome> => { mutations += 1; return { changes: [], seq: null }; },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: (id) => adapter.fetchBody(id),
    });
    guarded.claim(() => false);   // as closed as it ever gets

    await wrapped.mutate({ kind: "move", messageId: "m1", folder: "INBOX" }, { idempotencyKey: "k1" });
    expect(mutations).toBe(1);
    await expect(wrapped.sync({ since: "0" })).rejects.toThrow(/sync aborted/);
  });

  it("BODY FETCHES ARE FORWARDED, and not gated either", async () => {
    /**
     * THE WIRING BUG THIS EXISTS TO CATCH.
     *
     * `createSyncGate(null).guard()` re-implements the adapter surface by hand, one method at a
     * time. A method it forgets does not fail to compile in a bundle — `EngineAdapter`
     * requires `fetchBody`, but `guard()` is where the requirement is satisfied, so dropping
     * the forwarder is a change to THIS file's own shape. What it produces is the LIVE path
     * losing bodies while the demo keeps them (the demo engine is never wrapped), i.e. every
     * paying account back to one-line snippets with the whole suite green.
     *
     * Two claims, and both are load-bearing:
     *   1. the call REACHES the transport — the mutation-style pass-through, not a stub;
     *   2. it reaches it through a gate that is as CLOSED as it can be, because a body fetch
     *      is the user's own intent (they opened a message) and is bounded by that act. The
     *      gate exists to stop a hidden tab paging a bootstrap nobody asked for, which is a
     *      different cost shape entirely.
     *
     * Red by deleting the `fetchBody:` line from `createSyncGate(null).guard()`.
     */
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const guarded = createSyncGate(null);
    const wrapped = guarded.guard(adapter);
    guarded.claim(() => false);

    await expect(wrapped.fetchBody("m1")).resolves.toEqual({
      text: "body of m1", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    });
    expect(adapter.bodyCalls).toEqual(["m1"]);
    // The control: the same gate, in the same state, still refuses a poll.
    await expect(wrapped.sync({ since: "0" })).rejects.toThrow(/sync aborted/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   GUARD 7 · A REFUSAL NO RETRY CAN FIX
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("a permanently refused session stops, instead of buying invocations forever", () => {
  const revoked = (): MutationRejectedError =>
    new MutationRejectedError("unauthorized", { status: 401, code: "unauthorized", retryable: false });

  it("a genuinely revoked session stops — after a SUSTAINED refusal, and then holds no timer", async () => {
    // The scheduler read `retryable` nowhere, so a session revoked in another tab (or an account
    // deleted outright) left this tab retrying under the jitter cap for as long as it stayed
    // open: continuous serverless invocations for an account that can no longer be served.
    //
    // ── REWRITTEN BY RULING, 2026-08-04; REWRITTEN AGAIN BY RULING, 2026-08-21 ──────
    //
    // The title used to be "a 401 stops the loop for good — no timer, no wake, no further
    // requests"; a later change moved the latch behind ONE confirm at 60 s. That single confirm was itself
    // the next defect: a ~6-minute deploy window of coded 401s spans the 60 s ask, so the
    // second refusal read as the server "re-making" a revocation and a live subscriber sat
    // behind the quit-and-reopen banner for a valid session. The latch now requires the refusal
    // to be SUSTAINED across `REFUSAL_SUSTAIN_MS`, on the `REFUSAL_CONFIRM_MS` cadence.
    // Rewritten openly rather than retimed: what the loop promises changed, twice, each time
    // by ruling.
    //
    // What did NOT change is the bound this test exists for. A revoked account costs
    // 1 + sustain/confirm requests over ten minutes — once — then zero for ever, and holds no
    // timer once the claim latches.
    const adapter = new ScriptedAdapter(() => revoked());
    const doc = fakeVisibility("visible");
    const net = fakeOnline();
    const status: SyncStatus[] = [];
    const reported: string[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      onStatus: (s) => status.push(s),
      report: (m) => reported.push(m),
      random: () => 1,
      visibility: doc,
      online: net,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);
    // UNCONFIRMED: the fact is published, the STRONGER claim is not, and there IS a timer —
    // which is what makes the strip's "Retrying." true rather than decorative.
    expect(status.at(-1)!.refused, "the first refusal must be published as SOMETHING").toBe(true);
    expect(status.at(-1)!.terminal, "one request may not announce a revoked session").toBe(false);
    expect(vi.getTimerCount(), "the confirm drain was never armed — 'Retrying.' would be a lie").toBe(1);

    // Nothing in between. Each confirm is one ask per `REFUSAL_CONFIRM_MS`, not a backoff
    // ladder — a sub-minute ladder here is the "buys N−1 invocations" shape the latch design
    // rejected. The cadence itself is bounded by the sustain window.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(adapter.calls, "the confirm window issued extra drains").toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.calls, "the confirm drain never fired").toBe(2);
    // RE-MADE but not yet SUSTAINED: a minute cannot tell "revoked" from "mid-deploy", so the
    // strong claim still may not latch here — this exact instant is where the subscriber's
    // quit-and-reopen banner used to appear.
    expect(status.at(-1)!.terminal, "one minute of refusal announced a revoked session").toBe(false);
    expect(status.at(-1)!.refused, "the episode must stay SAID while it is confirmed").toBe(true);

    // The refusal is re-made on every confirm across the whole sustain window ⇒ believed.
    await vi.advanceTimersByTimeAsync(REFUSAL_SUSTAIN_MS - REFUSAL_CONFIRM_MS);
    expect(status.at(-1)!.terminal, "a refusal sustained past the window must latch").toBe(true);
    expect(status.at(-1)!.refused, "confirmation moves the fact, it does not duplicate it").toBe(false);
    const askedBeforeLatch = 1 + REFUSAL_SUSTAIN_MS / REFUSAL_CONFIRM_MS;
    expect(adapter.calls, "the episode's cost must be the priced bound").toBe(askedBeforeLatch);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(adapter.calls, "a revoked session kept polling for an hour").toBe(askedBeforeLatch);
    expect(vi.getTimerCount()).toBe(0);

    // ── REWRITTEN BY RULING, 2026-08-04 ──────────────────────────────────────
    //
    // This block used to assert "Not even a wake restarts it". THAT ASSERTION WAS THE DEFECT: it
    // locked in permanent sync death for a merely TRANSIENT refusal. Observed live — `ohmail.app`
    // told a signed-in user "Sign in" while `/api/auth/session`, `/api/sync` and `/api/mailboxes`
    // all answered 200, and only a reload recovered. Rewritten openly rather than weakened: the
    // contract changed, so the assertion changed with it.
    //
    // A wake now asks EXACTLY ONCE more. A deleted account still cannot be made to exist — the
    // probe is refused and the latch holds — but a transient one recovers.
    doc.set("hidden");
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "a wake must ask exactly once more").toBe(askedBeforeLatch + 1);

    // ...and the floor holds. A second wake inside `BACKOFF_CAP_MS` buys NOTHING: that is
    // The "No API cost without revenue behind it" invariant, and it is the reason the bound is a duration rather than a per-event probe.
    net.fire();
    doc.set("hidden");
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "wakes inside the floor must not buy invocations").toBe(askedBeforeLatch + 1);

    // Refused again ⇒ still terminal, and STILL NO TIMER. A terminal-mode timer would re-open the
    // abandoned-visible-tab hole this latch exists to close.
    expect(vi.getTimerCount()).toBe(0);
    expect(status.at(-1)!.terminal, "the claim was re-made by the server").toBe(true);

    // SURFACED, not silent. "gave up quietly" is the failure mode a mail client must never have.
    // Three reports: the episode's opening refusal, the sustained latch, and the probe's
    // re-latch. Intermediate confirms are deliberately quiet — they are the same episode the
    // first report named, and a line per confirm would be ten copies of one fact. The first one
    // is deliberately NOT the sign-in sentence — the loop had not stopped when it was written.
    expect(reported).toHaveLength(3);
    expect(reported[0], "the first refusal was reported as revocation").toMatch(/asking again/);
    expect(reported.slice(1).every((m) => /sign in again/.test(m))).toBe(true);

    stop();
  });

  it("a DEPLOY-WINDOW refusal burst recovers by itself — never terminal, no relaunch", async () => {
    /**
     * THE SUBSCRIBER'S SCREENSHOT, AS A TEST (owner report 2026-08-21). During a ~6-minute
     * deploy window the API answered coded 401s; the one confirm ask at 60 s landed INSIDE the
     * window, so the second refusal was read as the server "re-making" a revocation claim and
     * `terminal` latched — "Sync stopped. Quit and reopen ohmail to reconnect.", over a session
     * that was fine five minutes later. No timer runs while terminal, the wake stream was
     * already dead, and a window nobody hides/shows never emits a wake — so the banner stood
     * until a relaunch, which is exactly what the copy told the user to do.
     *
     * The ruled contract (supersedes the earlier single-confirm shape, same cost logic): a
     * coded refusal must be RE-MADE FOR {@link REFUSAL_SUSTAIN_MS} before it is believed to be a
     * revocation. Confirm asks stay on the {@link REFUSAL_CONFIRM_MS} cadence — bounded at
     * 1 + ceil(sustain/confirm) requests per episode, then zero for ever — and the strip says
     * "Sync failed. Retrying." throughout, which is true of every one of those asks.
     */
    const start = Date.now();
    const adapter = new ScriptedAdapter(() =>
      (Date.now() - start < 6 * 60_000 ? revoked() : page("c1", ["m1"])));
    const doc = fakeVisibility("visible");
    const status: SyncStatus[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, onStatus: (s) => status.push(s), random: () => 1,
      visibility: doc, online: fakeOnline(),
    });

    // Mid-burst: the first ask plus one confirm per REFUSAL_CONFIRM_MS, refused every time —
    // the fact is SAID (`refused`), and at no instant does the strong claim latch.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(status.some((s) => s.terminal), "a transient burst latched the quit-and-reopen banner").toBe(false);
    expect(status.at(-1)!.refused, "the burst must be SAID while it lasts").toBe(true);

    // The next confirm lands after the deploy settled and succeeds: everything clears, the
    // ordinary poll resumes, and nobody was ever told to sign in or relaunch.
    await vi.advanceTimersByTimeAsync(REFUSAL_CONFIRM_MS);
    expect(status.at(-1)!.refused, "recovery must withdraw the refusal").toBe(false);
    expect(status.at(-1)!.failures).toBe(0);
    expect(status.some((s) => s.terminal), "the banner appeared during a deploy blip").toBe(false);
    expect(vi.getTimerCount(), "the poll must be re-armed after recovery").toBe(1);

    // Bounded: inside the burst, 1 first ask + one confirm per REFUSAL_CONFIRM_MS — never a
    // sub-minute ladder. (Calls after recovery are the ordinary poll and are not the episode's.)
    const inBurst = adapter.startedAt.filter((t) => t - start < 6 * 60_000).length;
    expect(inBurst).toBeLessThanOrEqual(1 + (6 * 60_000) / REFUSAL_CONFIRM_MS);

    stop();
  });

  it("a refusal SUSTAINED past the window still latches terminal — bounded, then zero", async () => {
    // The genuine revocation keeps its guarantee: the claim is believed once the server has
    // re-made it for the whole sustain window, the tab then holds NO timer, and an hour buys
    // nothing further. Cost per genuine revocation: 1 + sustain/confirm asks, once.
    const adapter = new ScriptedAdapter(() => revoked());
    const status: SyncStatus[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, onStatus: (s) => status.push(s), random: () => 1,
      visibility: fakeVisibility("visible"), online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(REFUSAL_SUSTAIN_MS);
    expect(status.at(-1)!.terminal, "a sustained refusal must still latch").toBe(true);
    const atLatch = adapter.calls;
    expect(atLatch).toBe(1 + REFUSAL_SUSTAIN_MS / REFUSAL_CONFIRM_MS);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(adapter.calls, "a latched session kept polling").toBe(atLatch);
    expect(vi.getTimerCount(), "terminal must hold no timer").toBe(0);

    stop();
  });

  it("a TRANSIENT coded 401 is never announced at all: the confirm finds it gone", async () => {
    // THE OWNER'S REPORT, AS A TEST. "Sync stopped — this session is no longer authorized"
    // appeared and cleared by itself. It appeared because ONE coded 401 latched `terminal`.
    //
    // This case used to assert `terminal === true` immediately, citing the "say so rather than go
    // quiet". The half that survives is "rather than go quiet" — `refused` is published in the
    // same tick and the strip says "Sync failed. Retrying.". What no longer happens is the
    // `role="alert"` telling a signed-in user to sign in on one request's evidence.
    const adapter = new ScriptedAdapter((_p, n) =>
      n === 0 ? revoked() : page("c1", ["m1"]));
    const doc = fakeVisibility("visible");
    const status: SyncStatus[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, onStatus: (s) => status.push(s), random: () => 1,
      visibility: doc, online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);
    expect(status.at(-1)!.refused, "the refusal must still be SAID — its surviving half").toBe(true);
    expect(status.at(-1)!.terminal, "one coded 401 announced a revoked session").toBe(false);

    // No wake, no reload, no user action: the confirm drain the refusal itself armed.
    await vi.advanceTimersByTimeAsync(REFUSAL_CONFIRM_MS);
    expect(adapter.calls, "the confirm must actually be issued").toBe(2);
    expect(status.at(-1)!.refused, "a drain that SUCCEEDED must withdraw the unconfirmed claim").toBe(false);
    expect(status.at(-1)!.failures).toBe(0);
    expect(vi.getTimerCount(), "the poll must be re-armed, not left dead").toBe(1);

    // THE WHOLE POINT: at no instant was the user told they were signed out.
    expect(status.some((s) => s.terminal), "the banner appeared and cleared — verbatim").toBe(false);

    stop();
  });

  it("a wake may not shorten the confirmation window, and a hide may not disturb it", async () => {
    // A tab somebody flips away from and back must not be able to buy an early ask (a
    // two-second transient would latch whenever the user happened to switch windows, and each
    // flip is an invocation — #10). The hide half CHANGED with the wake slice: hidden tabs
    // hold timers now, so the confirm timer simply survives the hide instead of being
    // disarmed-and-restored — and the window's END must not move in either direction.
    const adapter = new ScriptedAdapter(() => revoked());
    const doc = fakeVisibility("visible");
    const net = fakeOnline();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, random: () => 1, visibility: doc, online: net,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(adapter.calls).toBe(1);

    doc.set("hidden");
    // The confirm timer SURVIVES the hide (this assertion used to be `toBe(0)`): its timing is
    // a contract with the server's claim, and the hidden cadence has no business rewriting it.
    expect(vi.getTimerCount(), "the hide dropped the confirm window on the floor").toBe(1);
    doc.set("visible");
    net.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "a wake shortened the confirmation window").toBe(1);
    expect(vi.getTimerCount(), "coming back left the tab with nothing armed").toBe(1);

    // …and the confirm still lands at its original 60 s, not 60 s after the wake.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(adapter.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.calls, "the confirm was pushed back by the wake").toBe(2);

    stop();
  });

  it("the confirm fires ON SCHEDULE behind a hidden tab, and a wake probe still works after", async () => {
    // REWRITTEN with the wake slice: this used to be "a tab hidden past the window asks the
    // moment it comes back", because hiding disarmed every timer. The confirm now runs where
    // it was armed — one ask, sixty seconds after the refusal, hidden or not — so a revoked
    // session is CONFIRMED (and stops costing anything) even if nobody ever returns to the
    // tab, instead of sitting unconfirmed with the strip saying "Retrying." for ever.
    const adapter = new ScriptedAdapter(() => revoked());
    const doc = fakeVisibility("visible");
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, random: () => 1, visibility: doc, online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(REFUSAL_SUSTAIN_MS + 60_000);
    // The confirm cadence runs where it was armed, hidden or not, and the sustained refusal
    // latches behind the hidden tab with no timer left — the sustain window buys
    // 1 + sustain/confirm requests total, exactly what a visible tab pays, and then zero.
    const askedBeforeLatch = 1 + REFUSAL_SUSTAIN_MS / REFUSAL_CONFIRM_MS;
    expect(adapter.calls, "the confirm cadence stopped early, or overran the latch").toBe(askedBeforeLatch);
    expect(vi.getTimerCount()).toBe(0);

    // Coming back is a wake on a terminal tab: one bounded probe, unchanged.
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls, "the return probe never fired").toBe(askedBeforeLatch + 1);

    stop();
  });

  it("a SECOND transient refusal is unconfirmed too: `refusedAt` clears on success", async () => {
    // The bug a single-episode test cannot see. If the success path does not clear `refusedAt`,
    // the next transient 401 — an hour later, a different incident — finds the flag still set,
    // reads itself as its own confirmation, and latches on the first request. The defect,
    // resurrected on the second occurrence.
    const refuseOn = new Set([0, 2]);
    const adapter = new ScriptedAdapter((_p, n) => (refuseOn.has(n) ? revoked() : page(`c${n}`, [`m${n}`])));
    const status: SyncStatus[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, onStatus: (s) => status.push(s), random: () => 1,
      visibility: fakeVisibility("visible"), online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(0);              // 0: refused ⇒ unconfirmed
    await vi.advanceTimersByTimeAsync(REFUSAL_CONFIRM_MS); // 1: confirm succeeds ⇒ all clear
    expect(status.at(-1)!.refused).toBe(false);
    expect(adapter.calls).toBe(2);

    await vi.advanceTimersByTimeAsync(POLL_MS);        // 2: the SECOND refusal, a fresh incident
    expect(adapter.calls).toBe(3);
    expect(status.at(-1)!.refused, "the second refusal was not recorded at all").toBe(true);
    expect(status.at(-1)!.terminal, "a stale `refusedAt` confirmed the second refusal on sight").toBe(false);

    stop();
  });

  it("a settled drain kicks the engine's eager body pass — and a failed one does not", async () => {
    /**
     * THE WIRING GUARD for the eager recent-window hydration. The engine deliberately never
     * fires its own pass (`prefetchRecentBodies` — a drain-fired pass issued requests from
     * behind every bare `syncOnce()` caller's back), so this scheduler line is the ONLY thing
     * that makes the prefetch happen in the live app. Dropping it re-fetches nothing anywhere,
     * every engine test stays green, and "opening recent mail is instant" quietly stops being
     * true — the exact shape of wiring bug the gate's `transport` field exists to keep visible.
     * The kick must follow a SETTLED drain only: a failing drain's backoff owns its retry, and
     * background fetches against a failing server would be cost with nobody behind it.
     */
    const adapter = new ScriptedAdapter((_p, n) => (n < 2 ? page(`c${n}`, [`m${n}`]) : new Error("down")));
    const engine = engineWith(adapter);
    const kicked: number[] = [];
    engine.prefetchRecentBodies = () => { kicked.push(adapter.calls); return Promise.resolve(); };
    const stop = startSyncScheduler(engine, {
      ...quiet, random: () => 1, visibility: fakeVisibility("visible"), online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(kicked, "the settled drain never kicked the pass").toEqual([1]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(kicked, "the second settled drain never kicked").toEqual([1, 2]);

    // From here every drain fails: backoff retries run, and none of them kicks.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(adapter.calls, "the failing drains stopped retrying").toBeGreaterThan(3);
    expect(kicked, "a FAILED drain kicked the background pass").toEqual([1, 2]);

    stop();
  });

  it("the comparator sees `refused` — a refused-only transition is NOT deduped away", () => {
    /**
     * THE WIDENED DEDUP, GUARDED DIRECTLY.
     *
     * `engine.tsx`'s status dedup once compared `bootstrapping`, `failures` and `terminal` only,
     * so a publish that moved ONLY `refused` was invisible to it and the strip would never appear.
     * The comparison now lives in {@link sameSyncStatus} and names all four fields. This asserts
     * the field that was blind: two statuses that differ only in `refused` must read as DIFFERENT.
     * Delete the `refused` clause from `sameSyncStatus` and this goes red — the whole point.
     */
    const base = SYNC_BOOTSTRAPPING;
    expect(sameSyncStatus(base, base), "identical statuses must dedup").toBe(true);
    expect(
      sameSyncStatus(base, { ...base, refused: true }),
      "a `refused`-only transition was swallowed — the strip would never appear",
    ).toBe(false);
    // The three fields it always saw, for completeness — each flip must read as a change.
    expect(sameSyncStatus(base, { ...base, bootstrapping: false })).toBe(false);
    expect(sameSyncStatus(base, { ...base, failures: 1 })).toBe(false);
    expect(sameSyncStatus(base, { ...base, terminal: true })).toBe(false);
  });

  it("every publish that moves `refused` moves `failures` or `terminal` too", async () => {
    /**
     * THE SCHEDULER-SIDE HALF OF THE SAME INVARIANT.
     *
     * The comparator above makes `engine.tsx`'s dedup see `refused`, so this no longer guards
     * against a swallowed strip. It stays because the coupling it measures is real and useful on
     * its own terms: `refused` is only ever set in the publish that increments `failures`, and only
     * ever cleared in one that zeroes `failures` or sets `terminal`. Asserting that over a real
     * refusal → confirm → recovery script keeps the scheduler's own behaviour honest.
     */
    const adapter = new ScriptedAdapter((_p, n) => (n < 2 ? revoked() : page("c1", ["m1"])));
    const doc = fakeVisibility("visible");
    const status: SyncStatus[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, onStatus: (s) => status.push(s), random: () => 1,
      visibility: doc, online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(0);                   // refused, unconfirmed
    await vi.advanceTimersByTimeAsync(REFUSAL_CONFIRM_MS);  // refused again ⇒ terminal
    doc.set("hidden");
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);                   // the wake probe succeeds ⇒ clear
    expect(status.at(-1)!.terminal, "the premise: the script must reach and leave terminal").toBe(false);
    expect(status.some((s) => s.refused), "the premise: `refused` must actually move").toBe(true);

    for (let i = 1; i < status.length; i++) {
      const a = status[i - 1]!;
      const b = status[i]!;
      if (a.refused === b.refused) continue;
      expect(
        a.failures !== b.failures || a.terminal !== b.terminal,
        `publish ${i} moved ONLY \`refused\` (${String(a.refused)} → ${String(b.refused)}), which `
          + "`engine.tsx`'s dedup cannot see — the strip would never have appeared",
      ).toBe(true);
    }

    stop();
  });

  it("a PLATFORM refusal with no envelope never latches at all", async () => {
    // Vercel deployment protection answers 401 with an HTML body, and `DEPLOYMENT_NOT_FOUND` answers
    // 404 mid-alias: neither carries our envelope, so `code` is null. Those are the deploy-window
    // killers, and they must stay retryable — `terminal` is a claim only OUR api may make.
    const adapter = new ScriptedAdapter(() =>
      new MutationRejectedError("HTTP 401", { status: 401, retryable: false }));
    const status: SyncStatus[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, onStatus: (s) => status.push(s), random: () => 1,
      visibility: fakeVisibility("visible"), online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(adapter.calls, "a platform 401 must keep retrying").toBeGreaterThan(3);
    expect(status.some((x) => x.terminal), "a bodyless 401 must never latch").toBe(false);

    stop();
  });

  it("a RETRYABLE refusal is still retried — terminal is a positive claim, not a default", async () => {
    // The control that keeps the rule honest. A 503 and a plain network throw must both keep
    // the loop alive: "never gives up while the tab is visible" is still the rule for
    // everything except a refusal the server marked permanent.
    const script: Array<Error> = [
      new MutationRejectedError("upstream", { status: 503, retryable: true }),
      new MutationRejectedError("network failure", { code: "network", retryable: true }),
      new Error("some untyped throw"),
    ];
    const adapter = new ScriptedAdapter((_p, n) => script[n] ?? script[2]!);
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet, random: () => 1,
      visibility: fakeVisibility("visible"),
      online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(adapter.calls).toBeGreaterThan(5);
    stop();
  });
});

// ── GUARD 5 (pure half) · one engine yields at most one scheduler ────────────────────────

describe("teardown", () => {
  it("removes both listeners and disarms the timer", async () => {
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const doc = fakeVisibility("visible");
    const net = fakeOnline();
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      visibility: doc,
      online: net,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(doc.attached).toBe(1);
    expect(net.attached).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(doc.attached).toBe(0);
    expect(net.attached).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const after = adapter.calls;
    doc.set("visible");
    net.fire();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.calls, "a stopped scheduler still answered a wake").toBe(after);
  });

  it("mount → unmount → mount (StrictMode's shape) leaves exactly one loop", async () => {
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    const engine = engineWith(adapter);
    const doc = fakeVisibility("visible");
    const net = fakeOnline();
    const opts = { ...quiet, visibility: doc, online: net };

    const first = startSyncScheduler(engine, opts);
    first();
    const second = startSyncScheduler(engine, opts);

    expect(doc.attached).toBe(1);
    expect(net.attached).toBe(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount(), "two schedulers armed two timers").toBe(1);

    // One loop ⇒ one drain per period, not two.
    const before = adapter.calls;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(adapter.calls - before).toBe(1);

    second();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a drain that settles after teardown neither re-arms nor publishes", async () => {
    const adapter = new ScriptedAdapter(() => page("c1", ["m1"]));
    adapter.latencyMs = 4_000;
    const status: unknown[] = [];
    const stop = startSyncScheduler(engineWith(adapter), {
      ...quiet,
      onStatus: (s) => status.push(s),
      visibility: fakeVisibility("visible"),
      online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const published = status.length;
    stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(adapter.calls).toBe(1);
    expect(status.length, "a torn-down scheduler pushed state into a dead provider")
      .toBe(published);
  });
});
