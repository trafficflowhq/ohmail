/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  currentUpdateOffer,
  resetUpdateStoreForTests,
  UPDATE_PERIOD_MS,
} from "../../webapp/app/shell/app-update.js";
import {
  cannotSelfInstall,
  checkDue,
  CHECK_EVERY_MS,
  installRefused,
  offerOf,
  POLL_EVERY_MS,
  REQUEST_RETRIES,
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
 * cadence asks for the LAUNCH check on a schedule — not the menu press, which is a person
 * asking and is therefore answered out loud — and only where the shell's own state says a check
 * would start at all.
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
  const polls: number[] = [];
  let push: ((r: UpdateReport) => void) | null = null;
  return {
    polls,
    tell: (r: UpdateReport) => push?.(r),
    options: {
      read: async () => answer(),
      poll: async () => {
        polls.push(polls.length);
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

/**
 * THE MODULE'S OWN CODE, with its prose removed — the input every source assertion below reads.
 *
 * ── WHY THE SOURCE AT ALL ────────────────────────────────────────────────────────────────────
 *
 * Two of the things this file pins cannot be seen from outside the module: which of two opaque
 * command names the schedule invokes, and whether a rule is written once or twice. Both are
 * decisions about the shape of the code, so the code is what is read.
 *
 * ── WHY THE PROSE COMES OUT ──────────────────────────────────────────────────────────────────
 *
 * This is the most comment-dense module in the app and its notes name the very identifiers these
 * assertions count. Counting over the raw text fails on the next paragraph that mentions one —
 * a red over a defect that is not there, which is how a guard ends up switched off.
 *
 * ONE PASS WITH AN ALTERNATION, not two passes in some order. Stripping block comments first
 * leaves a line comment containing an unpaired block opener able to start a block that closes at
 * the next terminator; stripping line comments first breaks every doc comment whose terminator
 * shares a line with a `//` — the prevailing style for a one-line note carrying a URL, present in
 * two dozen files here. Both orders therefore delete real code, which BOTH hides an added call and fails the
 * count over nothing. Alternating leaves whichever opener comes first to consume its own body.
 *
 * ── AND WHAT IT STILL CANNOT DO ──────────────────────────────────────────────────────────────
 *
 * It is a stripper, not a lexer: a `//` inside a string or a regex literal is removed with the
 * rest of that line, so a call written after one on the same line is invisible to the counts.
 * The guard raises the floor; it is not a proof, and saying so here is cheaper than a claim that
 * would be wrong.
 *
 * Resolved from the run's own directory rather than from `import.meta.url`, because this file
 * runs under jsdom where that is not a file URL. The suite runs from the repository root, and the
 * length assertion is what makes a wrong root fail loudly instead of matching nothing and passing.
 */
function cadenceSource(): { src: string; code: string } {
  const src = readFileSync(resolve(process.cwd(), "apps/desktop/src/update-cadence.ts"), "utf8");
  expect(src.length, "the module under assertion was not found").toBeGreaterThan(2000);
  return { src, code: src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "") };
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

  it("THE REFUSED-INSTALL STATE IS CLASSIFIED, and it is Linux's alone", () => {
    // The state the strip calls "ohmail could not replace its own files". `canCheck` is TRUE
    // there — a refused install leaves the flow somewhere a press would check from — so the
    // period alone would send this install round the whole loop every twenty-four hours: fetch
    // the release again, verify it, raise the shell's own "ready to install" dialog (which is
    // not gated on anybody having asked for the check), fail the install again, repeat for the
    // life of the install. That is the nag the strip exists to replace, made DAILY on exactly
    // the machines it names, and it is why the predicate is shared with `offerOf` rather than
    // written twice.
    const refused = report({ state: "failed", lastResult: "offered", offered: null });
    expect(installRefused(refused), "the bound's condition, on every platform").toBe(true);
    expect(cannotSelfInstall(refused, true), "the sentence's condition, on Linux").toBe(true);

    // Everywhere else the same pair is a refusal that may not repeat — a file held open, a
    // half-written temporary directory — and giving up on checking would be the wrong lesson.
    expect(cannotSelfInstall(refused, false)).toBe(false);
    expect(checkDue(refused, START + CHECK_EVERY_MS, START)).toBe(true);

    // And a check that could not reach the feed is not that state at all, on any platform —
    // neither for the sentence nor for the bound. "Update it through your package manager" is a
    // false claim about a network failure, and giving up on checking would be the wrong lesson
    // from one.
    const offline = report({ state: "failed", lastResult: "failed" });
    expect(cannotSelfInstall(offline, true)).toBe(false);
    expect(installRefused(offline)).toBe(false);

    // The TIME rule knows nothing about any of it. Whether to give up is a question about how
    // many attempts have been spent, so it lives in the driver beside the counter that answers
    // it — and the driver allows exactly one more, because the same state is reachable on a
    // repairable machine (a full disk, a read-only mount) where giving up at once would leave a
    // window that never checks again.
    expect(checkDue(refused, START + CHECK_EVERY_MS, START)).toBe(true);
  });

  it("counts from when this window opened when the shell reports no check at all", () => {
    // An older shell, or one whose launch check has not finished. Counting from the moment the
    // window opened is the honest reading of "it has not been checked since then".
    const never = report({ lastCheckedAt: null });
    expect(checkDue(never, START + 23 * HOUR, START)).toBe(false);
    expect(checkDue(never, START + CHECK_EVERY_MS, START)).toBe(true);
  });
});

describe("which request the schedule makes", () => {
  it("THE SCHEDULE ASKS FOR THE SILENT CHECK, and the press stays the person's", () => {
    /* A SOURCE ASSERTION, and it has to be: both requests are opaque invokes of a command name,
       so nothing this side of the boundary can tell them apart by behaviour. What the difference
       IS lives in the shell — a press is a person asking, so a press that finds nothing raises
       "ohmail is up to date", a press that cannot reach the feed raises an error, and a press
       that finds a release opens the progress window. Right for somebody who just pressed a
       button; wrong once a day forever. Routing this cadence through the press would put a modal
       over a person's mail every twenty-four hours for as long as the app stayed open and
       current, which is the nag the whole file exists to replace. */
    /* Read over the CODE, not the file: a negative assertion satisfied by a comment is a guard
       that passes after the code stopped doing the thing — a note quoting the old seam beside a
       new one that presses would keep both of these green while the timer pressed. */
    const { code } = cadenceSource();
    expect(code).toMatch(/options\.poll \?\? updatePoll/);
    expect(code, "the timer must not make the request a person makes")
      .not.toMatch(/options\.poll \?\? updatePress/);
    /* `updatePress` is still imported and still used — it is what the STRIP's button calls, and
       that press IS a person asking. The distinction is which of the two the timer takes. */
    expect(code).toMatch(/act: \(\) => void updatePress\(\)/);
    expect(code.match(/\bupdatePress\s*\(/g), "one press, and it is the strip's button")
      .toHaveLength(1);
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
    expect(s.polls, "half a day in, nothing is owed").toHaveLength(0);

    await run(clock, 12 * HOUR);
    expect(s.polls).toHaveLength(1);

    await run(clock, 23 * HOUR);
    expect(s.polls, "the day after the press is still that day").toHaveLength(1);

    await run(clock, HOUR);
    expect(s.polls).toHaveLength(2);
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
    expect(s.polls).toHaveLength(1);
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

  it("A PACKAGE-MANAGED INSTALL IS TOLD ONCE AND THEN LEFT ALONE — no daily re-download", async () => {
    vi.useFakeTimers();
    const clock = { at: START };
    const s = shell(() => report({ state: "failed", lastResult: "offered", offered: null }));
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: true });

    await run(clock, POLL_EVERY_MS);
    expect(currentUpdateOffer()?.kind, "the strip says it once").toBe("package");

    // ONE more attempt, a day later, and never again. The retry is for the machines this state
    // is also reachable on and CAN be repaired while the app is open — a full disk since freed,
    // a mount since made writable. After it, the window stops: every further check would fetch
    // the whole release again and raise a native install dialog over somebody's mail, for an
    // install that will refuse it every time.
    await run(clock, CHECK_EVERY_MS);
    expect(s.polls, "one retry, spent").toHaveLength(1);

    await run(clock, 7 * CHECK_EVERY_MS);
    expect(s.polls, "a week later, still one — the window has given up on its own").toHaveLength(1);
    stop();
  });

  it("…AND THE BOUND SURVIVES THE STATES THE CHECK ITSELF PRODUCES", async () => {
    /* THE TEST THE FIRST VERSION OF THIS BOUND WOULD HAVE PASSED WHILE BEING USELESS. A counter
       reset on any report that is not a refused install resets on every cycle it is meant to be
       counting, because the request it bounds is precisely what moves the report along: the check
       starts, the flow goes checking → downloading → ready, and only then does an install refuse
       again. Holding `read()` at one constant refused report never exercises that. This walks the
       real ladder, twice, and the bound has to survive it. */
    vi.useFakeTimers();
    const clock = { at: START };
    const REFUSED = report({ state: "failed", lastResult: "offered", offered: null });
    let now = REFUSED;
    const s = shell(() => now);
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: true });

    await run(clock, CHECK_EVERY_MS);
    expect(s.polls, "the one retry").toHaveLength(1);

    // …and the cycle that retry starts, exactly as the shell drives it.
    for (const stage of [
      report({ state: "checking", canCheck: false }),
      report({ state: "downloading", offered: NEXT, canCheck: false }),
      report({ state: "ready", offered: NEXT, canCheck: false, canInstall: true }),
    ]) {
      now = stage;
      await run(clock, POLL_EVERY_MS);
    }
    // The person presses Restart, the install refuses again, and a day goes by.
    now = REFUSED;
    await run(clock, 7 * CHECK_EVERY_MS);
    expect(s.polls, "the allowance was spent, and the ladder did not hand it back").toHaveLength(1);
    stop();
  });

  it("…AND IT LETS GO ONCE A CYCLE HAS ENDED SOMEWHERE ELSE", async () => {
    /* THE ONE THING THAT ENDS THE EPISODE: the release this window kept failing on stops being
       offered. Withdrawn, or refused by the version guard — both end a check at `idle`, and once
       the flow has left `idle` a completed check finding nothing is the only way back to it. A
       latch that did not clear even there would leave a window refusing to look for releases it
       had never had any trouble with. What does NOT end it is a failed check; the case below
       says why. */
    vi.useFakeTimers();
    const clock = { at: START };
    let now = report({ state: "failed", lastResult: "offered", offered: null });
    const s = shell(() => now);
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });

    await run(clock, CHECK_EVERY_MS);
    expect(s.polls, "the one retry").toHaveLength(1);
    await run(clock, CHECK_EVERY_MS);
    expect(s.polls, "spent").toHaveLength(1);

    // The retry's own cycle ended with no install to refuse — the release was withdrawn.
    now = report({ state: "idle", lastResult: "upToDate", lastCheckedAt: clock.at });
    await run(clock, POLL_EVERY_MS);
    now = report({ lastCheckedAt: null });
    await run(clock, CHECK_EVERY_MS);
    expect(s.polls, "the episode is over, so the day is the only rule again").toHaveLength(2);
    stop();
  });

  it("…and a FAILED check does not hand the allowance back, because it cannot be told apart", async () => {
    /* THE ONE AMBIGUOUS REPORT, and the reason the clearing rule names `idle` alone. A check that
       could not reach the feed and a DOWNLOAD that died inside a cycle heading straight back to
       the same refused install both land on `failed` with `failed` as the last check's result;
       the report carries nothing that separates them. Read as recovery, a package-managed copy on
       flaky wifi gets a fresh retry — and so a fresh install dialog — every couple of days, for
       ever. Read as "still refused", the cost falls on the rarer person whose install failed once
       and whose retry then could not reach the feed, and it ends when they restart or press Check
       now. The certain harm is the one worth refusing. */
    vi.useFakeTimers();
    const clock = { at: START };
    let now = report({ state: "failed", lastResult: "offered", offered: null });
    const s = shell(() => now);
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: true });

    await run(clock, CHECK_EVERY_MS);
    expect(s.polls, "the one retry").toHaveLength(1);

    // The retry's own download died. Same stage, same last result as a feed nobody could reach.
    now = report({ state: "failed", lastResult: "failed" });
    await run(clock, 7 * CHECK_EVERY_MS);
    expect(s.polls, "a week of it, and the allowance stays spent").toHaveLength(1);
    stop();
  });

  it("…and the subscription feeds the same observation the poll does", async () => {
    /* THE POLL IS A QUARTER-HOUR SAMPLE OF A STATE MACHINE THAT MOVES ON EVENTS. The failure
       dialog offers "Try again"; somebody presses it, and the flow leaves `failed` for `checking`
       long before any tick looks. With the clear rule above, a sample-only latch still reaches
       the right answer — every path out of a refusal either returns to it (the tick sees it) or
       settles somewhere else (the episode is genuinely over) — so this is promptness rather than
       correctness, and it is asserted as what it is: ONE observation, two feeders. A second copy
       of the rule in the listener is what this exists to prevent.

       A source assertion, like the one for which request the schedule makes, and for the same
       reason: nothing rendered can tell "the listener updated the latch" from "the next tick
       did". */
    const { code } = cadenceSource();

    /* Exactly one place decides what a report means for the latch — and the WRITE is matched, not
       one spelling of it. `installWasRefused ||= true` and a write folded into an expression are
       both second writers that an exact-literal match would miss while reporting that there was
       only one. */
    expect(code.match(/const note = \(report: UpdateReport\): void =>/g)).toHaveLength(1);
    expect(code.match(/installWasRefused\s*(?:\|\|)?=\s*true/g), "the latch is set in one place")
      .toHaveLength(1);

    /* …and both feeders go through it. COUNTED ON THE CALL AND NOT ON ITS ARGUMENT: keying on
       the parameter's name — or on indentation, or on a whole statement line — narrows the match
       until a third feeder spelled any other way matches nothing and leaves this green while its
       own message is false. A renamed callback parameter is the likeliest of those, because the
       subscription this pins is already an arrow callback; the whitespace is tolerated for the
       same reason the indentation is. The declaration does not match, being `const note = (`. */
    expect(code.match(/\bnote\s*\(/g), "the poll and the subscription, and no third")
      .toHaveLength(2);
  });

  it("…and the bound is not Linux's alone — a daily dialog is a nag anywhere", async () => {
    // The SENTENCE is Linux's, because only there can the files belong to something else. The
    // BOUND is not: an install that keeps refusing on any platform would otherwise raise the
    // shell's "ready to install" dialog once a day for the life of the window.
    vi.useFakeTimers();
    const clock = { at: START };
    const s = shell(() => report({ state: "failed", lastResult: "offered", offered: null }));
    const stop = startUpdateCadence({ ...s.options, now: () => clock.at, linux: false });

    expect(currentUpdateOffer(), "and it says nothing, because there is nowhere else to go")
      .toBeNull();
    await run(clock, 7 * CHECK_EVERY_MS);
    expect(s.polls).toHaveLength(1);
    stop();
  });

  it("A REFUSED REQUEST IS RETRIED AT ONCE — a few times, then the day applies again", async () => {
    // An older shell, or a grant that dropped the command. Stamping the attempt before it landed
    // would spend the whole period on a request that never reached the shell — a day of not
    // checking, on precisely the build where the command is unreliable. But the refusal this
    // will actually meet is PERMANENT for the life of the window, and nothing that could arrive
    // would stop the retries, so they are counted: a few quick ones, then once a day.
    vi.useFakeTimers();
    const clock = { at: START };
    let refuse = true;
    let tried = 0;
    const stop = startUpdateCadence({
      now: () => clock.at,
      linux: false,
      read: async () => report({ lastCheckedAt: null }),
      poll: async () => {
        tried += 1;
        if (refuse) throw new Error("no such command");
      },
      listen: async () => () => {},
    });

    await run(clock, CHECK_EVERY_MS);
    expect(tried, "one refused attempt, at the first tick a period after arming").toBe(1);

    await run(clock, POLL_EVERY_MS);
    expect(tried, "and again on the very next poll, not tomorrow").toBe(2);

    await run(clock, POLL_EVERY_MS);
    expect(tried, "the third spends the allowance").toBe(REQUEST_RETRIES);
    await run(clock, 23 * HOUR);
    expect(tried, "…and the day applies again rather than a call every quarter hour for ever")
      .toBe(REQUEST_RETRIES);

    // Once one lands, the counter clears and the period is the only rule left.
    refuse = false;
    await run(clock, HOUR);
    expect(tried).toBe(REQUEST_RETRIES + 1);
    await run(clock, 23 * HOUR);
    expect(tried, "a request that landed spends the day").toBe(REQUEST_RETRIES + 1);
    stop();
  });

  it("A REQUEST THE SHELL NEVER TOOK SPENDS NOTHING — neither the day nor the install retry", async () => {
    // Both counters are advanced where the request LANDED. A build whose window lacks the
    // command would otherwise give up its one install retry having made no check at all, and
    // would spend a day it never used.
    vi.useFakeTimers();
    const clock = { at: START };
    let refuse = true;
    let tried = 0;
    const stop = startUpdateCadence({
      now: () => clock.at,
      linux: true,
      read: async () => report({ state: "failed", lastResult: "offered", offered: null }),
      poll: async () => {
        tried += 1;
        if (refuse) throw new Error("no such command");
      },
      listen: async () => () => {},
    });

    await run(clock, CHECK_EVERY_MS);
    expect(tried, "refused, so nothing is spent").toBe(1);

    // The command starts working — an unreachable case in practice, and exactly the one that
    // shows the allowance was still there to be spent.
    refuse = false;
    await run(clock, POLL_EVERY_MS);
    expect(tried, "the retry the refusals had not consumed").toBe(2);
    await run(clock, 7 * CHECK_EVERY_MS);
    expect(tried, "…and now it is spent").toBe(2);
    stop();
  });

  it("…and a part-spent run of refusals is not carried into a later day", async () => {
    // Two refusals on one day, then the day stops being due — the person pressed Check now in
    // Settings and the shell recorded a fresh stamp. Carrying the count forward would give the
    // next day one attempt instead of the three the constant documents.
    vi.useFakeTimers();
    const clock = { at: START };
    let stamp: number | null = null;
    let tried = 0;
    const stop = startUpdateCadence({
      now: () => clock.at,
      linux: false,
      read: async () => report({ lastCheckedAt: stamp }),
      poll: async () => {
        tried += 1;
        throw new Error("no such command");
      },
      listen: async () => () => {},
    });

    await run(clock, CHECK_EVERY_MS);
    await run(clock, POLL_EVERY_MS);
    expect(tried, "two refusals, one short of the allowance").toBe(2);

    // Somebody checks by hand; the shell records it, so nothing is due for a day.
    stamp = clock.at;
    await run(clock, 23 * HOUR);
    expect(tried, "nothing was due, so nothing was tried").toBe(2);

    /* Exactly three polls' worth of time, so the count is unambiguous: a fresh allowance spends
       three attempts here, a carried-over one spends a single attempt and then stamps the day. */
    stamp = null;
    await run(clock, REQUEST_RETRIES * POLL_EVERY_MS);
    expect(tried, "a fresh allowance, not the remainder of an old one")
      .toBe(2 + REQUEST_RETRIES);
    stop();
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
    expect(s.polls).toEqual([]);
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
    expect(s.polls).toEqual([]);
  });
});
