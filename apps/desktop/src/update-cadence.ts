/**
 * THE APP LOOKS FOR ITS OWN UPDATE AT LEAST ONCE A DAY — from the window, on a wall clock.
 * The shell (`src-tauri/src/updater.rs`) checks the signed feed at launch and on a press; a
 * window never closed never asks again, and a mail client is left running for weeks. The
 * cadence lives HERE because the check is not moving: the pinned endpoint, minisign
 * verification, version guard and install stay native — `update_poll` takes no argument and
 * makes the same request `on_launch` makes. NOT `update_press`: a press answers a person out
 * loud (dialog, error, progress window), each wrong once a day forever; the poll is silent
 * unless it finds something and starts only where a press WOULD — never a silent install.
 */

/*
 * WALL CLOCK, NEVER TICKS: a 24 h timer fires after 24 h of the machine being AWAKE — suspend
 * stops every monotonic clock, so a lid closed nightly would be checked every three or four
 * days. Nothing counts firings: a short interval wakes, asks the shell when its last check
 * finished (a wall-clock instant it already keeps) and compares two instants; the arithmetic
 * is `periodElapsed` in the shared `app-update.ts`, backwards-clock guard included. It ASKS
 * rather than installs: a found release is verified and asked about once, natively; "Later"
 * leaves the payload ready, and this re-raises it ONCE A DAY as the quiet strip
 * (`app/shell/UpdateNotice.tsx`) — never at first sight, when the shell's dialog is on screen.
 */
import {
  announceUpdate,
  askDue,
  offerKey,
  periodElapsed,
  readAskMemory,
  rememberAsk,
  UPDATE_PERIOD_MS,
  writeAskMemory,
  type UpdateOffer,
} from "../../webapp/app/shell/app-update.js";
import { BUILD_PLATFORM } from "./platform.js";
import { onUpdateState, updatePoll, updatePress, updateState, type UpdateReport } from "./update.js";

/** How long the app may go without asking the feed. */
export const CHECK_EVERY_MS = UPDATE_PERIOD_MS;

/**
 * How often the question "is a check due?" is re-asked.
 *
 * The interval is short and the DECISION is not: this is the resolution at which a resumed
 * machine notices that a day has passed, not the rate at which anything is checked. Fifteen
 * minutes costs one comparison of two numbers per quarter hour and bounds how long after a lid
 * is opened the app is still working from yesterday's answer.
 */
export const POLL_EVERY_MS = 15 * 60 * 1000;

/**
 * How many further scheduled checks a window will spend on an install the app has already been
 * refused once — see the driver, which carries the whole argument.
 *
 * One. Enough to recover the cases that can recover (a full disk since freed, a mount since made
 * writable); not enough for "checked once a day" to become "asked to restart once a day, for
 * ever" on a copy whose files belong to a package manager.
 */
export const INSTALL_RETRIES = 1;

/**
 * How many consecutive REFUSED requests are retried at the poll interval before the day applies
 * again.
 *
 * A refusal is normally transient, and retrying at once is right for it. But the refusal this
 * cadence will actually meet — a shell too old to have the command, or a grant that dropped it —
 * is permanent for the life of the window, and nothing that could ever arrive would stop the
 * retries. Three quick attempts, then back to once a day, so a build without the command costs a
 * handful of refused calls rather than a hundred a day.
 */
export const REQUEST_RETRIES = 3;

/**
 * Did an INSTALL refuse — as opposed to a check failing to reach the feed? The shell reports a
 * stage and, separately, what the last completed CHECK found, and the pair separates them
 * exactly: every path that ENDS A CHECK writes the check's result (`failed` for an unreachable
 * feed or a dead download), while an install's failure path writes none — it was not a check —
 * so the last result still reads `offered` from the check that produced the payload. `failed`
 * beside `offered` is the one combination that can only mean the install itself refused.
 */
export function installRefused(report: UpdateReport): boolean {
  return report.state === "failed" && report.lastResult === "offered";
}

/**
 * …and the case where that refusal is a FACT ABOUT THE INSTALL rather than an accident.
 *
 * Linux only, because that is where a copy's files can belong to something else. Everywhere else
 * a refused install is a mishap — a file held open, a half-written temporary directory — and
 * telling somebody to go to a package manager would be a sentence about a machine they are not
 * using. This is the SENTENCE's condition; the CADENCE's bound is [`installRefused`] and applies
 * on every platform, because a daily dialog about an install that keeps failing is a nag whatever
 * the reason for the failing.
 */
export function cannotSelfInstall(report: UpdateReport, linux: boolean): boolean {
  return linux && installRefused(report);
}

/**
 * Is a periodic check due? `canCheck` is the shell's own `Flow::press` answer, carried over
 * rather than re-derived: this cannot start a check the menu item has disabled, and cannot
 * press in the one state where a press INSTALLS. Giving up is NOT here — a refused install
 * leaves a state a press would check from, so the stop lives in the driver beside its counter
 * (`cannotSelfInstall` is the classifier both use). `floor` is the earliest instant a check
 * may be counted from: the WINDOW OPENING for a shell with no last check to report, and the
 * LAST PRESS, which stops a press that produced neither `checking` nor a stamp from being
 * re-pressed every tick. The instant compared is the LATER of the two.
 */
export function checkDue(report: UpdateReport, now: number, floor: number): boolean {
  if (!report.canCheck) return false;
  return periodElapsed(Math.max(report.lastCheckedAt ?? floor, floor), now, CHECK_EVERY_MS);
}

/**
 * What, if anything, the window should say about this report. A verified payload waiting is
 * the ask: one press restarts into it. An install this app could not perform is a different
 * sentence, not a louder one — `cannotSelfInstall` carries which state that is. THE SENTENCE
 * HEDGES ITS PROVENANCE ON PURPOSE: the state establishes that the replacement failed, not
 * HOW the copy was installed — an AppImage on a read-only mount reaches it too — so the copy
 * says the app could not replace its own files and names the package manager as a condition,
 * not a diagnosis. Asserting "this copy came from your package manager" would be false for
 * that person and send them somewhere the release is not.
 */
export function offerOf(report: UpdateReport, linux: boolean): UpdateOffer | null {
  if (report.state === "ready" && report.canInstall) {
    return { kind: "restart", version: report.offered ?? report.version, act: () => void updatePress() };
  }
  if (cannotSelfInstall(report, linux)) return { kind: "package" };
  return null;
}

export interface UpdateCadenceOptions {
  /** Seams, so the whole cadence is drivable from a test with no clock, no shell and no timers. */
  now?: () => number;
  every?: number;
  linux?: boolean;
  read?: () => Promise<UpdateReport | null>;
  /** The silent check. Named `poll` and not `press` because the two are different requests. */
  poll?: () => Promise<void>;
  listen?: (show: (report: UpdateReport) => void) => Promise<() => void>;
}

/**
 * Arm the cadence for the life of this window, and hand back the way to stop it.
 *
 * Armed once, from the window's entry point, beside the other capabilities that belong to the
 * WINDOW rather than to any view. Inert outside the app and inert in a build whose window is
 * granted no update command: the read answers nothing, so nothing is ever pressed and nothing
 * is ever said.
 */
export function startUpdateCadence(options: UpdateCadenceOptions = {}): () => void {
  const now = options.now ?? (() => Date.now());
  const every = options.every ?? POLL_EVERY_MS;
  const linux = options.linux ?? BUILD_PLATFORM === "linux";
  const read = options.read ?? updateState;
  const poll = options.poll ?? updatePoll;
  const listen = options.listen ?? onUpdateState;

  const armedAt = now();
  let stopped = false;
  let release: (() => void) | null = null;
  /** When this cadence last asked — the second half of `checkDue`'s floor. */
  let askedAt: number | null = null;
  /**
   * Is a refused install still what stands in front of this window, and how many scheduled
   * checks have been spent since — the bound on the daily loop a refusal would begin. A LATCH,
   * never a run of consecutive reports: the check itself moves the report off that state
   * (checking → downloading → ready), so a counter reset on those would reset on every cycle
   * it was meant to count and the bound would never engage. CLEARED ONLY BY `idle`: once the
   * flow has left `idle` the only way back is a completed check that found nothing, so `idle`
   * means the refused release is no longer offered — withdrawn, or version-guard refused (a
   * copy installed beside still ends `ready`); inside one window it is permanent, everywhere.
   */

  /*
   * `failed` was measured as the only other candidate and it is ambiguous: an unreachable
   * feed and a download that died both write `failed` as the last check's result, so reading
   * it as recovery hands a package-managed copy on flaky wifi a fresh install dialog every
   * couple of days, for ever. The recovery is the one retry's own cycle: it ends in `ready`,
   * the shell raises its dialog, and somebody who freed the disk presses Restart. Settings →
   * Check now still reaches the feed and still offers the install, unaffected by the latch —
   * and it does not clear it either, because its cycle ends in `ready` and not in `idle`.
   */
  let installWasRefused = false;
  let checksSinceRefusal = 0;
  /** Consecutive requests the shell refused outright. */
  let refusedRequests = 0;

  /**
   * Take note of a report — the latch, and nothing else.
   *
   * SEPARATE FROM THE POLL, because the poll is a quarter-hour sample of a state machine that
   * moves on events. A refused install can begin and end between two ticks: the failure dialog
   * offers "Try again", somebody presses it, and the flow leaves `failed` for `checking` before
   * any tick has looked. The subscription sees every transition, so the latch is set from there
   * as well — otherwise the bound would miss exactly the person who is already trying hardest,
   * and the daily loop it exists to stop would run unbounded.
   */
  const note = (report: UpdateReport): void => {
    if (installRefused(report)) {
      installWasRefused = true;
      return;
    }
    // A COMPLETED CHECK WITH NOTHING TO INSTALL ends the episode, and only that. `checking`,
    // `downloading` and `ready` are what the retry itself produces; `failed` cannot be told from
    // a download dying inside a cycle heading back to the same refusal. See the latch's own note.
    if (report.state === "idle") {
      installWasRefused = false;
      checksSinceRefusal = 0;
    }
  };

  /**
   * Decide what this report means for the strip.
   *
   * Silence is a decision here too: a report with nothing on offer WITHDRAWS a standing strip,
   * because an offer that has been installed or has failed away is one nobody should still be
   * looking at.
   */
  const say = (report: UpdateReport): void => {
    const offer = offerOf(report, linux);
    if (offer === null) {
      announceUpdate(null);
      return;
    }
    const key = offerKey(offer);
    const memory = readAskMemory();
    /* THE SHELL'S OWN DIALOG IS THIS RELEASE'S FIRST ASK. It is raised the moment a payload
       becomes ready, so the first time this sees `ready` for a version, somebody is being asked
       already — and a strip beside that dialog would be the same question twice. Recorded and
       not spoken; a day later the entry has aged out and the strip is what asks. */
    const first = report.state === "ready" && memory[key] === undefined;
    if (first || !askDue(memory, key, now())) {
      if (first) writeAskMemory(rememberAsk(memory, key, now()));
      return;
    }
    writeAskMemory(rememberAsk(memory, key, now()));
    announceUpdate(offer);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const report = await read();
    if (stopped || report === null) return;
    note(report);
    say(report);

    /* ── ONE RETRY AFTER A REFUSED INSTALL, THEN THIS WINDOW STOPS ASKING ──────────────────
       A refused install leaves the flow where a check would start, and the release is still
       newer — unbounded, the day sends this window round the loop for ever: fetch, verify,
       raise the shell's "ready to install" dialog, fail, repeat tomorrow; a modal over
       somebody's mail once a day for the life of the install. ONE more attempt, and NOT
       platform-gated even though the strip's sentence is: the same state is reachable from a
       full disk or a read-only mount and can be repaired while the app is open. One retry
       buys the recovery and stops short of a daily dialog. */
    const givenUp = installWasRefused && checksSinceRefusal >= INSTALL_RETRIES;

    if (givenUp || !checkDue(report, now(), Math.max(armedAt, askedAt ?? armedAt))) {
      /* Nothing was attempted, so a part-spent run of refusals is not carried into a later day:
         it would silently shorten that day's allowance to whatever was left of this one. */
      refusedRequests = 0;
      return;
    }
    try {
      await poll();
      /* COUNTED AND STAMPED ONLY WHERE THE REQUEST LANDED, and the order is the point. Stamping
         first would hold a REFUSED request off for a full period — an older shell, or a grant
         that dropped the command, would cost a whole day of not checking on exactly the build
         where the command is unreliable — and counting first would spend the install allowance on
         an attempt that never reached the shell at all. */
      askedAt = now();
      refusedRequests = 0;
      if (installWasRefused) checksSinceRefusal += 1;
    } catch {
      /* A request that did not land must never take a mail client down — and must not turn into
         a call every quarter hour for the life of the window either. A shell without the command
         refuses every time, and nothing that could ever arrive would stop it, so the retries are
         counted: a few quick ones for a transient refusal, then the period applies again. */
      refusedRequests += 1;
      if (refusedRequests >= REQUEST_RETRIES) {
        askedAt = now();
        refusedRequests = 0;
      }
    }
  };

  const timer = setInterval(() => void tick(), every);
  /* The shell's own launch check has just run or is running, so the first tick is deliberately
     one interval away rather than immediate. What IS immediate is the listen: a payload that
     becomes ready while this window is open has to reach `say` when it happens, not at the next
     quarter-hour. */
  void (async () => {
    const off = await listen((report) => {
      if (stopped) return;
      note(report);
      say(report);
    });
    if (stopped) off();
    else release = off;
  })();

  return () => {
    stopped = true;
    clearInterval(timer);
    release?.();
  };
}
