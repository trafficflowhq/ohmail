/**
 * THE APP LOOKS FOR ITS OWN UPDATE AT LEAST ONCE A DAY — from the window, on a wall clock.
 *
 * ── WHAT THE SHELL DID BEFORE THIS, WHICH WAS NEARLY ENOUGH ────────────────────────────────
 *
 * `src-tauri/src/updater.rs` checks the signed release feed once, shortly after the window
 * opens, and whenever somebody asks it to. That is the right shape and it has one gap: a window
 * that is never closed never asks again. This is a mail client, and a mail client is the
 * archetype of a program left running for weeks — so "checks at launch" is, for the people who
 * use it most, "checked once, in March".
 *
 * ── WHY THE CADENCE IS HERE AND NOT IN THE SHELL ───────────────────────────────────────────
 *
 * Because the check itself is not moving anywhere. Every part of the update that could be
 * dangerous — the one pinned endpoint, the minisign verification, the version guard read out of
 * signed material, the install — stays in the native process, and this file cannot reach any of
 * it. What it asks for is the LAUNCH CHECK, on a schedule: `update_poll` takes no argument,
 * names nothing, and makes the same request `on_launch` makes.
 *
 * NOT `update_press`, and that distinction is load-bearing rather than tidy. A press is a person
 * asking, and the shell answers a person out loud: a press that finds nothing raises "ohmail is
 * up to date", a press that cannot reach the feed raises an error with a Try-again, and a press
 * that finds a release opens the progress window. Each is right for somebody who just pressed a
 * button; each is wrong once a day, forever. A cadence routed through the press would put a
 * modal over a person's mail every twenty-four hours for as long as the app stayed open and
 * current — the exact nag this file exists to replace. The check the poll starts is silent
 * unless it finds something, and even then the only thing raised is the one dialog `prompt_ready`
 * always raised. A check is started only where the shell's own state says a press WOULD start
 * one, so this can never turn a request into an install.
 *
 * ── WALL CLOCK, NEVER TICKS, AND THAT IS THE WHOLE DESIGN ──────────────────────────────────
 *
 * A timer set for twenty-four hours does not fire twenty-four hours later on a laptop; it fires
 * after twenty-four hours of the machine being awake, because a suspended machine runs no
 * timers and every monotonic clock the platforms offer stops with it. A person who shuts the
 * lid every evening would be checked every three or four days.
 *
 * So nothing here counts firings. A short interval wakes up, asks the shell what it knows —
 * including WHEN its last check finished, which is a wall-clock instant the shell already keeps
 * — and compares two instants. Suspend and resume become a non-event: whatever the machine did
 * in between, the first evaluation after it wakes sees the true gap and acts. The arithmetic is
 * `periodElapsed` in the shared `app-update.ts`, including the guard for a clock that moves
 * backwards.
 *
 * ── AND IT ASKS RATHER THAN INSTALLING ─────────────────────────────────────────────────────
 *
 * Nothing here installs anything, and nothing here can. When a check finds a release, the shell
 * fetches and verifies it and asks once, in a native dialog. "Later" leaves the payload ready
 * and spends that question for the run — which is the correct restraint for a dialog and would,
 * on a window left open for a fortnight, mean a verified update sitting there unmentioned for a
 * fortnight. So this re-raises it, ONCE A DAY AND NEVER MORE, as the quiet strip the shared
 * shell renders (`app/shell/UpdateNotice.tsx`) rather than as a second dialog.
 *
 * The first sight of a ready payload deliberately does NOT raise the strip: the shell's dialog
 * is on screen at that exact moment, and two asks about one release is the nagging this whole
 * cadence is written to avoid. It records that ask instead, and the strip is what the person
 * sees a day later if the payload is still waiting.
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
 * Did an INSTALL refuse — as opposed to a check failing to reach the feed?
 *
 * ── THE TWO SHARE ONE STAGE, AND THE LAST CHECK'S RESULT SEPARATES THEM EXACTLY ────────────
 *
 * The shell reports a stage and, separately, what the last completed CHECK found, and the pair
 * separates them exactly. Every path that ends a check writes the check's result: a check that
 * could not reach the feed writes `failed`, and so does a download that died after the offer.
 * An install that failed writes nothing — it was not a check — so the last result still reads
 * `offered` from the successful check that produced the payload. `failed` beside `offered` is
 * therefore the one combination that can only mean the install itself refused.
 *
 * This is the whole of the discrimination, and it is exact: every path that ENDS A CHECK writes
 * the check's result, and the install's failure path writes none, because it was not a check. So
 * `failed` beside `offered` is the one pair that can only mean the install itself refused.
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
 * Is a periodic check due?
 *
 * `canCheck` is the shell's own `Flow::press` answer, carried over rather than re-derived, so
 * this cannot start a check the menu item has disabled — and, more importantly, cannot press in
 * the one state where a press INSTALLS. A payload waiting to be installed is not a state to
 * re-check from; the shell would only fetch an identical copy of what it already holds.
 *
 * ── WHAT IS *NOT* HERE ─────────────────────────────────────────────────────────────────────
 *
 * Giving up. A refused install leaves the flow in a state a press WOULD check from, and stopping
 * there is a decision about how many times to try rather than about time — so it lives in the
 * driver, beside the counter it needs, and [`cannotSelfInstall`] is the classifier both use.
 *
 * `floor` is the earliest instant a periodic check may be counted from, and it carries two
 * facts the report cannot: when this window opened, and when this cadence last pressed.
 *
 *  · THE WINDOW OPENING is the fallback origin for a shell that has no last check to report —
 *    one whose launch check has not finished, or one too old to keep the stamp. Counting from
 *    then is the honest reading of "it has not been checked since", and it puts the first
 *    periodic check a full period after the launch check rather than a moment after it.
 *  · THE LAST PRESS is what stops a press repeating. The shell normally answers the press by
 *    moving to `checking` and then writing a new stamp, and both of those close this on their
 *    own — but a press that lands and produces neither would otherwise be re-pressed at every
 *    tick for as long as the window stayed open, which is a check every quarter of an hour
 *    dressed up as a daily one. The cadence therefore presses at most once a period whatever
 *    the shell does with it.
 *
 * So the instant compared is the LATER of what the shell recorded and what this cadence did.
 */
export function checkDue(report: UpdateReport, now: number, floor: number): boolean {
  if (!report.canCheck) return false;
  return periodElapsed(Math.max(report.lastCheckedAt ?? floor, floor), now, CHECK_EVERY_MS);
}

/**
 * What, if anything, the window should say about this report.
 *
 *  · A verified payload waiting to be installed is the ask: one press restarts into it.
 *  · An install this app could not perform is the other case, and it is a different sentence
 *    rather than a louder one — [`cannotSelfInstall`] carries which state that is and why it is
 *    Linux's alone. "Try again in a moment" is advice that cannot work there.
 *
 * THE SENTENCE HEDGES ITS PROVENANCE ON PURPOSE. What this state establishes is that the
 * replacement failed, not HOW the copy was installed: an AppImage on a read-only mount, or under
 * a directory its user cannot write, reaches it too. So the copy says the app could not replace
 * its own files and names the package manager as a condition rather than as a diagnosis. A
 * sentence that asserted "this copy came from your package manager" would be false for that
 * person and would send them somewhere the release is not.
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
   * Is a refused install still the thing standing in front of this window, and how many scheduled
   * checks have been spent since it started — the bound on the daily loop a refusal would
   * otherwise begin.
   *
   * A LATCH RATHER THAN A RUN OF CONSECUTIVE REPORTS, and the difference is the whole guard.
   * Counting consecutive refused reports cannot work, because THE CHECK ITSELF moves the report
   * off that state: the request starts a check, the flow goes checking → downloading → ready, and
   * every tick in between reports something that is not a refused install. A counter reset on
   * those would reset on every cycle it was meant to be counting, so the bound would never engage
   * — the release re-fetched and the install dialog re-raised every twenty-four hours for ever,
   * which is exactly the outcome it exists to prevent.
   *
   * CLEARED ONLY BY `idle`, and it is worth being exact about how little that is rather than
   * describing a recovery this does not perform. `idle` is reachable from one place — a check
   * that COMPLETED and found nothing to install — so it means the release this window kept
   * failing on is no longer being offered: withdrawn, or refused by the version guard, or already
   * installed by some other means. While the release is still there no report can be `idle`, so
   * inside one window a refusal that persists is permanent, on every platform.
   *
   * That is deliberate, and the alternative was measured against the same states rather than
   * hoped about. `failed` is the only other candidate and it is ambiguous: a check that could not
   * reach the feed and a DOWNLOAD that died inside a cycle heading straight back to the same
   * refused install both land there, both writing `failed` as the last check's result. Reading it
   * as recovery hands a package-managed copy on flaky wifi a fresh retry — and so a fresh install
   * dialog — every couple of days, for ever. That is the nag this bound exists to prevent, at a
   * slower rate, and it is certain rather than possible.
   *
   * WHERE THE RECOVERY ACTUALLY IS, since it is not here: the one retry's own cycle ends in
   * `ready` and the shell raises its install dialog, so somebody who has since freed the disk or
   * fixed the permission presses Restart and is done. If it refuses again, this window has said
   * what it can and stops; the app's next launch checks as it always does. Settings → Check now
   * still reaches the feed and still offers the install, and is unaffected by the latch — but it
   * does not clear it either, because its cycle ends in `ready` and not in `idle`.
   *
   * The in-flight stages are not an end at all — they are what the retry produces, and treating
   * them as recovery is the defect above.
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
       A refused install leaves the flow somewhere a check would start from, and the release is
       still newer — so without a bound the day sends this window round the whole loop for ever:
       fetch the release again, verify it, raise the shell's own "ready to install" dialog (which
       is not gated on anybody having asked for the check), fail the install again, repeat
       tomorrow. That is a modal over somebody's mail once a day for the life of the install.

       ONE more attempt, and NOT platform-gated even though the sentence the strip says is. On a
       copy whose files belong to a package manager the second attempt is certain to fail; the
       same state is reachable elsewhere from a full disk or a read-only mount and can be repaired
       while the app is open, so refusing to try again at all would leave that person a window
       that never checks again. One retry buys the recovery and stops short of a daily dialog. */
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
