/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentUpdateOffer,
  resetUpdateStoreForTests,
  UPDATE_PERIOD_MS,
} from "../../webapp/app/shell/app-update.js";
import {
  checkDue,
  CHECK_EVERY_MS,
  offerOf,
  POLL_EVERY_MS,
  startUpdateCadence,
} from "../src/update-cadence.js";
import type { UpdateReport } from "../src/update.js";

/**
 * ═══ THE APP LOOKS FOR ITS OWN UPDATE AT LEAST ONCE A DAY ════════════════════════════════════
 *
 * The native process checks the signed release feed shortly after the window opens and whenever
 * somebody asks it to. That is the right shape and it had one gap: a window that is never closed
 * never asked again — and this is a mail client, the archetype of a window nobody closes. So
 * "checks at launch" was, for the people who use it most, "checked once, in March".
 *
 * What is driven here is the cadence and nothing else. The check itself does not move: the one
 * pinned endpoint, the signature verification, the version guard read out of signed material and
 * the install all stay in the native process, and this file cannot reach any of them. The
 * cadence presses the same button a person presses, on a schedule, and only where the shell's
 * own state says a press WOULD start a check.
 *
 * The clock is the subject, so the clock is a seam: no real timers, no real shell.
 */

const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-09-03T09:00:00Z");
const VERSION = "0.15.0";
const NEXT = "0.15.1";

const report = (over: Partial<UpdateReport> = {}): UpdateReport => ({
  version: VERSION,
  state: "idle",
  offered: null,
  canCheck: true,
  canInstall: false,
  lastCheckedAt: START,
  lastResult: "upToDate",
  ...over,
});

/** The shell, as a value: what it answers, and what it was asked to do. */
function shell(answer: () => UpdateReport | null) {
  const presses: number[] = [];
  let push: ((r: UpdateReport) => void) | null = null;
  return {
    presses,
    tell: (r: UpdateReport) => push?.(r),
    options: {
      read: async () => answer(),
      press: async () => {
        presses.push(presses.length);
      },
      listen: async (show: (r: UpdateReport) => void) => {
        push = show;
        return () => {
          push = null;
        };
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetUpdateStoreForTests();
  window.localStorage.clear();
});

/**
 * Move the wall clock and the timers TOGETHER, in poll-sized steps.
 *
 * Advancing the clock in one jump and the timers afterwards is not the same experiment: every
 * tick in the jump would then see the same far-future instant, which is a machine that woke up
 * once, not a day of quarter-hours passing. Only the suspend test does that deliberately.
 */
async function run(clock: { at: number }, by: number): Promise<void> {
  for (let left = by; left > 0; left -= POLL_EVERY_MS) {
    const step = Math.min(POLL_EVERY_MS, left);
    clock.at += step;
    await vi.advanceTimersByTimeAsync(step);
  }
}

describe("when a periodic check is due", () => {
  it("IS A FULL DAY, NOT ALMOST ONE — 23 hours after the last check is not due", () => {
    // Both ends, deliberately. A rule that fired at twenty-three hours would satisfy "checks
    // daily" and would also be a rule nobody wrote: the promise is one check a day, and the
    // cheapest way to break it is an interval that is nearly right.
    const r = report({ lastCheckedAt: START });
    expect(checkDue(r, START + 23 * HOUR, START)).toBe(false);
    expect(checkDue(r, START + CHECK_EVERY_MS - 1, START)).toBe(false);
    expect(checkDue(r, START + CHECK_EVERY_MS, START)).toBe(true);
  });

  it("SURVIVES A SUSPENDED MACHINE, because it compares instants and never counts firings", () => {
    // A laptop shut on Thursday evening and opened on Saturday morning fires no timer in
    // between: every monotonic clock the platforms offer stops with the machine. A cadence
    // built on elapsed ticks would answer "not yet" here and wait another whole day — a person
    // who closes the lid every evening checked every three or four days.
    expect(checkDue(report({ lastCheckedAt: START }), START + 40 * HOUR, START)).toBe(true);
  });

  it("NEVER PRESSES WHERE A PRESS WOULD INSTALL, or where one is already running", () => {
    // This is the load-bearing half. A press means "check" in some states and "restart into a
    // verified payload" in one — so a cadence that pressed on a schedule without asking would
    // be an updater that installs by itself, which is the one thing this flow refuses to be.
    const waiting = report({ state: "ready", offered: NEXT, canCheck: false, canInstall: true });
    expect(checkDue(waiting, START + 10 * CHECK_EVERY_MS, START)).toBe(false);

    const running = report({ state: "checking", canCheck: false });
    expect(checkDue(running, START + 10 * CHECK_EVERY_MS, START)).toBe(false);
  });

  it("counts from when this window opened when the shell reports no check at all", () => {
    // An older shell, or one whose launch check has not finished. Counting from the moment the
    // window opened is the honest reading of "it has not been checked since then".
    const never = report({ lastCheckedAt: null });
    expect(checkDue(never, START + 23 * HOUR, START)).toBe(false);
    expect(checkDue(never, START + CHECK_EVERY_MS, START)).toBe(true);
  });
});

describe("what the window says about a report", () => {
  it("a verified payload waiting is the ask, and it names the release", () => {
    const offer = offerOf(report({ state: "ready", offered: NEXT, canCheck: false, canInstall: true }), false);
    expect(offer?.kind).toBe("restart");
    expect(offer?.version).toBe(NEXT);
  });

  it("A FAILED INSTALL ON LINUX IS A DIFFERENT SENTENCE, told apart by the last check", () => {
    // The stage collapses two facts a person would want separated: a check that could not reach
    // the feed and an install that refused are both `failed`. The last CHECK result separates
    // them exactly — every path that ends a check writes its result, and an install writes
    // none, so `failed` beside `offered` can only mean the install itself refused.
    const installFailed = report({ state: "failed", lastResult: "offered", offered: null });
    expect(offerOf(installFailed, true)?.kind).toBe("package");

    // A check that could not reach the feed is not that, and must not borrow the sentence:
    // "update it through your package manager" is a false claim about a network failure.
    const checkFailed = report({ state: "failed", lastResult: "failed" });
    expect(offerOf(checkFailed, true)).toBeNull();

    // And it is a Linux sentence. Everywhere else this app does install its own updates, so a
    // failed install is a failure rather than a signpost.
    expect(offerOf(installFailed, false)).toBeNull();
  });

  it("nothing in flight is nothing to say", () => {
    expect(offerOf(report(), true)).toBeNull();
    expect(offerOf(report({ state: "downloading", offered: NEXT, canCheck: false }), true)).toBeNull();
  });
});

describe("the cadence, running", () => {
  it("presses the shell's own button ONCE a day — not before it, and not again within it", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    // A shell that takes the press and never records a check: an older one, or one whose
    // answer to this window is a cached value. The cadence must still press exactly once a
    // day, because the alternative — pressing at every tick because the stamp never moved —
    // is a check every quarter of an hour wearing a daily check's name.
    const s = shell(() => report({ lastCheckedAt: START }));
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });

    await run(clock, 12 * HOUR);
    expect(s.presses, "half a day in, nothing is owed").toHaveLength(0);

    await run(clock, 12 * HOUR);
    expect(s.presses).toHaveLength(1);

    await run(clock, 23 * HOUR);
    expect(s.presses, "the day after the press is still that day").toHaveLength(1);

    await run(clock, HOUR);
    expect(s.presses).toHaveLength(2);
    stop();
  });

  it("A SUSPENDED INTERVAL STILL FIRES, on the first tick after the machine wakes", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const s = shell(() => report({ lastCheckedAt: START }));
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });

    // The machine slept for thirty hours: the wall clock moved, the interval did not run. One
    // tick after it wakes is all it takes, because the decision is arithmetic on two instants.
    clock.at += 30 * HOUR;
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(s.presses).toHaveLength(1);
    stop();
  });

  it("THE SHELL'S OWN DIALOG IS THE FIRST ASK — the strip does not double it", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const ready = report({ state: "ready", offered: NEXT, canCheck: false, canInstall: true });
    const s = shell(() => ready);
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });

    // The native dialog is raised the moment the payload becomes ready, so a strip beside it
    // would be the same question asked twice in one second.
    await vi.advanceTimersByTimeAsync(0);
    s.tell(ready);
    expect(currentUpdateOffer()).toBeNull();

    // …and it stays quiet for the rest of the day, however many transitions arrive.
    clock.at += 6 * HOUR;
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(currentUpdateOffer()).toBeNull();

    // A day later the payload is still sitting there unmentioned, which is the gap "Later"
    // leaves on a window nobody closes. This is where it is raised again — once.
    clock.at += UPDATE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    const offer = currentUpdateOffer();
    expect(offer?.kind).toBe("restart");
    expect(offer?.version).toBe(NEXT);

    // Put away, and not raised again today.
    resetUpdateStoreForTests();
    clock.at += 6 * HOUR;
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(currentUpdateOffer()).toBeNull();
    stop();
  });

  it("ONCE A DAY SURVIVES QUITTING THE APP — a relaunch is not a fresh licence to ask", async () => {
    // The shell's own "Later" is spent for the RUN: quit and reopen, and the payload is found
    // and the dialog is raised again. That is the shell's business and it is correct for a
    // dialog somebody asked to see. What must not happen is the strip joining in — somebody who
    // restarts the app four times in an afternoon would then meet the same sentence four times.
    // The memory is on the device, so it outlives the process.
    vi.useFakeTimers();
    const clock = { at: START };
    const ready = report({ state: "ready", offered: NEXT, canCheck: false, canInstall: true });
    const s = shell(() => ready);

    const first = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(currentUpdateOffer()).toBeNull();
    first();

    clock.at += 6 * HOUR;
    const second = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(currentUpdateOffer(), "same day, second run — still nothing to add").toBeNull();
    second();

    clock.at += 19 * HOUR;
    const third = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(currentUpdateOffer()?.version).toBe(NEXT);
    third();
  });

  it("withdraws a standing strip once there is nothing to install", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    let now = report({ state: "failed", lastResult: "offered", offered: null });
    const s = shell(() => now);
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: true });

    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(currentUpdateOffer()?.kind).toBe("package");

    now = report();
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(currentUpdateOffer()).toBeNull();
    stop();
  });

  it("is inert where the shell answers nothing — a build whose window holds no update command", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const s = shell(() => null);
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });
    clock.at += 3 * CHECK_EVERY_MS;
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS);
    expect(s.presses).toEqual([]);
    expect(currentUpdateOffer()).toBeNull();
    stop();
  });

  it("STOPS when it is stopped", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const s = shell(() => report({ lastCheckedAt: START }));
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });
    stop();
    clock.at += 3 * CHECK_EVERY_MS;
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS);
    expect(s.presses).toEqual([]);
  });
});
