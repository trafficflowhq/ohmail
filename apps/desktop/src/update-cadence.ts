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
 * it. What it does is press the same button a person presses, on a schedule: `update_press`
 * takes no argument, names nothing, and does exactly what picking the menu item does. A check
 * is started only where the shell's own state says a press WOULD start one, so this can never
 * turn a press into an install.
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
import { onUpdateState, updatePress, updateState, type UpdateReport } from "./update.js";

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
 * Has this install established that it cannot replace its own files?
 *
 * ── HOW A FAILED INSTALL IS TOLD APART FROM A FAILED CHECK, WHICH SHARE ONE STATE ──────────
 *
 * The shell reports a stage and, separately, what the last completed CHECK found, and the pair
 * separates them exactly. Every path that ends a check writes the check's result: a check that
 * could not reach the feed writes `failed`, and so does a download that died after the offer.
 * An install that failed writes nothing — it was not a check — so the last result still reads
 * `offered` from the successful check that produced the payload. `failed` beside `offered` is
 * therefore the one combination that can only mean the install itself refused.
 *
 * Linux only, and that is the whole reason it is worth a name. This app updates itself by
 * replacing the single executable file it runs from. Installed from a distribution's packages
 * instead, those files belong to the package manager, the replacement is not this app's business
 * and it will not succeed on the next attempt either. Everywhere else a refused install can be
 * something transient — a file held open, a half-written temporary directory — and trying again
 * tomorrow is the right answer rather than a resignation.
 *
 * ONE PREDICATE FOR TWO DECISIONS, deliberately: what the window SAYS about this state and
 * whether the cadence keeps CHECKING in it are the same judgement, and a version of this that
 * said "your package manager has it" while quietly re-downloading the release every night would
 * be the exact nag the strip exists to replace.
 */
export function cannotSelfInstall(report: UpdateReport, linux: boolean): boolean {
  return linux && report.state === "failed" && report.lastResult === "offered";
}

/**
 * Is a periodic check due?
 *
 * `canCheck` is the shell's own `Flow::press` answer, carried over rather than re-derived, so
 * this cannot start a check the menu item has disabled — and, more importantly, cannot press in
 * the one state where a press INSTALLS. A payload waiting to be installed is not a state to
 * re-check from; the shell would only fetch an identical copy of what it already holds.
 *
 * ── AND IT STOPS WHERE CHECKING AGAIN IS KNOWN TO BE FUTILE ────────────────────────────────
 *
 * `canCheck` alone is not enough, and the gap it leaves is worse than the one this file closed.
 * A refused install leaves the flow in a state a press WOULD check from, and the release is
 * still newer, so a bare daily cadence on a package-managed Linux install would: fetch the whole
 * release again, verify it, raise the shell's own "ready to install" dialog — which is not gated
 * on anybody having asked — fail the install again, and repeat every twenty-four hours for the
 * life of the install. Before a cadence existed that sequence cost one run per launch. Making it
 * daily, on precisely the machines whose strip says the app cannot do this, is not a smaller
 * version of the same behaviour; it is the feature working against the people it names.
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
export function checkDue(
  report: UpdateReport,
  now: number,
  floor: number,
  linux: boolean,
): boolean {
  if (!report.canCheck || cannotSelfInstall(report, linux)) return false;
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
  press?: () => Promise<void>;
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
  const press = options.press ?? updatePress;
  const listen = options.listen ?? onUpdateState;

  const armedAt = now();
  let stopped = false;
  let release: (() => void) | null = null;
  /** When this cadence last pressed — the second half of `checkDue`'s floor. */
  let pressedAt: number | null = null;

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
    say(report);
    if (checkDue(report, now(), Math.max(armedAt, pressedAt ?? armedAt), linux)) {
      try {
        await press();
        /* STAMPED ONLY WHERE THE PRESS LANDED, and the order is the point. Stamping first would
           hold a REJECTED press off for a full period — an older shell or a grant that dropped
           the command would cost a whole day of not checking, on exactly the build where the
           command is unreliable. A rejected press is retried on the next poll instead, which is
           bounded by the poll interval and reaches no network at all: a command the shell
           refuses is answered by the shell. */
        pressedAt = now();
      } catch {
        /* A press that did not land must never take a mail client down. */
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
      if (!stopped) say(report);
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
