import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_KICK_SIGNAL_GAP_MS, startSyncKickBell, type SyncKickBell } from "../src/sync-kick.js";

/**
 * THE DOORBELL'S TWO TRIGGERS. The scan itself is `sync-kick.pg.test.ts`'s; here it is a counted
 * stand-in, and what is held is when it starts: on the change log's signal, on the floor, one at a
 * time, and never for an account this process does not serve.
 */

const FLOOR = 3_000;
const GAP = SYNC_KICK_SIGNAL_GAP_MS;
const MINE = "account-served";
const THEIRS = "account-of-another-worker";

/** A stand-in for the change log's signal: what the hub hands a subscriber. */
function signals() {
  const subs = new Set<(accountId: string, seq: bigint) => void>();
  return {
    subscribeAll(cb: (accountId: string, seq: bigint) => void): () => void {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
    send(accountId: string): void { for (const cb of [...subs]) cb(accountId, 1n); },
    listeners: () => subs.size,
  };
}

/** A scan that takes `takesMs` and records when it started, what started it and how many ran at once. */
function scans(takesMs = 0) {
  const started: Array<{ at: number; by: string }> = [];
  let running = 0;
  let most = 0;
  return {
    started,
    most: () => most,
    pass: async (by: "signal" | "floor"): Promise<void> => {
      started.push({ at: Date.now(), by });
      running += 1;
      most = Math.max(most, running);
      if (takesMs > 0) await new Promise((r) => { setTimeout(r, takesMs); });
      running -= 1;
    },
  };
}

describe("the kick scan's doorbell", () => {
  let bell: SyncKickBell | null = null;
  beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }); });
  afterEach(() => { bell?.stop(); bell = null; vi.useRealTimers(); });

  const start = (s: ReturnType<typeof scans>, source: ReturnType<typeof signals> | undefined, stopped = () => false): SyncKickBell => {
    bell = startSyncKickBell({
      pass: s.pass, floorMs: FLOOR, gapMs: GAP, isStopped: stopped,
      owns: (accountId) => accountId === MINE,
      ...(source ? { source } : {}),
    });
    return bell;
  };

  it("a signal for a served account starts the scan at once, with no timer run", async () => {
    const s = scans(); const src = signals();
    start(s, src);
    src.send(MINE);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.started).toEqual([{ at: 1_000_000, by: "signal" }]);
  });

  it("with no signal heard the floor scans, every floor", async () => {
    const s = scans(); const src = signals();
    start(s, src);
    await vi.advanceTimersByTimeAsync(FLOOR - 1);
    expect(s.started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + FLOOR);
    expect(s.started.map((x) => [x.at - 1_000_000, x.by])).toEqual([[FLOOR, "floor"], [2 * FLOOR, "floor"]]);
  });

  it("without a signal source it is the floor alone", async () => {
    const s = scans();
    start(s, undefined).ring(MINE);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.started.map((x) => x.by), "a ring by hand still rings").toEqual(["signal"]);
    await vi.advanceTimersByTimeAsync(FLOOR);
    expect(s.started.map((x) => x.by)).toEqual(["signal", "floor"]);
  });

  it("fifty signals during a scan owe one more scan, a gap after the first, and never two at once", async () => {
    const s = scans(40); const src = signals();
    start(s, src);
    src.send(MINE);
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 50; i += 1) src.send(MINE);
    await vi.advanceTimersByTimeAsync(GAP - 11);
    expect(s.started, "the owed scan started inside the gap").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.started.map((x) => [x.at - 1_000_000, x.by])).toEqual([[0, "signal"], [GAP, "signal"]]);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(s.started, "the burst cost a third scan").toHaveLength(2);
    expect(s.most()).toBe(1);
  });

  it("a storm of signals costs one scan a gap, plus the floor", async () => {
    const s = scans(5); const src = signals();
    start(s, src);
    for (let ms = 0; ms < 3 * FLOOR; ms += 50) {
      src.send(MINE);
      await vi.advanceTimersByTimeAsync(50);
    }
    const bySignal = s.started.filter((x) => x.by === "signal").map((x) => x.at);
    expect(bySignal.length).toBeLessThanOrEqual((3 * FLOOR) / GAP + 1);
    for (let i = 1; i < bySignal.length; i += 1) expect(bySignal[i]! - bySignal[i - 1]!).toBeGreaterThanOrEqual(GAP);
    expect(s.started.length).toBeLessThanOrEqual((3 * FLOOR) / GAP + 1 + 3);
    expect(s.most()).toBe(1);
  });

  it("a floor tick that finds a scan running is skipped, and a scan started after a signal pays its debt", async () => {
    const slow = scans(FLOOR + 500); const src = signals();
    start(slow, src);
    src.send(MINE);                                   // the scan at 0, running past the first floor tick
    await vi.advanceTimersByTimeAsync(FLOOR + 400);
    expect(slow.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);           // it ends; nothing is owed
    await vi.advanceTimersByTimeAsync(GAP);
    expect(slow.started).toHaveLength(1);

    const quick = scans(); const src2 = signals();
    bell?.stop();
    vi.setSystemTime(1_000_000);
    start(quick, src2);
    await vi.advanceTimersByTimeAsync(FLOOR - 500);
    src2.send(MINE);                                  // a signal scan, 500 ms before the floor
    await vi.advanceTimersByTimeAsync(100);
    src2.send(MINE);                                  // inside the gap: owed, due 500 ms after the floor
    await vi.advanceTimersByTimeAsync(400);           // the floor's scan starts after that signal
    expect(quick.started.map((x) => [x.at - 1_000_000, x.by])).toEqual([[FLOOR - 500, "signal"], [FLOOR, "floor"]]);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(quick.started, "the floor's scan read what the signal announced, and it was scanned again").toHaveLength(2);
  });

  it("a signal for an account this process serves no mailbox of starts nothing", async () => {
    const s = scans(); const src = signals();
    start(s, src);
    for (let i = 0; i < 20; i += 1) src.send(THEIRS);
    await vi.advanceTimersByTimeAsync(FLOOR - 1);
    expect(s.started).toEqual([]);
  });

  it("a scan that throws is said once and the bell rings on", async () => {
    const lines: string[] = [];
    let fail = true;
    const src = signals();
    const noop = (): void => { /* not read here */ };
    const log = { debug: noop, info: noop, error: noop, warn: (event: string) => { lines.push(event); }, child() { return log; } };
    let ran = 0;
    bell = startSyncKickBell({
      pass: async () => { ran += 1; if (fail) { fail = false; throw new Error("the database is away"); } },
      floorMs: FLOOR, gapMs: GAP, source: src, isStopped: () => false, log: log as never,
    });
    src.send(MINE);
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual(["sync_kick_failed"]);
    await vi.advanceTimersByTimeAsync(FLOOR);
    expect(ran).toBe(2);
  });

  it("stopped, by its own stop or the worker's, it scans nothing and listens to nothing", async () => {
    const s = scans(); const src = signals();
    let workerStopped = false;
    const b = start(s, src, () => workerStopped);
    workerStopped = true;
    src.send(MINE);
    await vi.advanceTimersByTimeAsync(2 * FLOOR);
    expect(s.started).toEqual([]);
    workerStopped = false;
    b.stop();
    expect(src.listeners()).toBe(0);
    b.ring(MINE);
    await vi.advanceTimersByTimeAsync(2 * FLOOR);
    expect(s.started).toEqual([]);
  });
});
