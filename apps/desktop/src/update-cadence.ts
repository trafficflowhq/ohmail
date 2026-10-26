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
 * is `periodElapsed` in the shared `app-update.ts`, backwards-clock guard included. What it
 * found is said HERE, in ohmail's own window, as one quiet line at the rail's foot
 * (`app/shell/UpdateLine.tsx`): ready, downloading, or failed. It also tells the shell when a
 * send waits or a draft holds files, which holds every install until they are gone.
 */
import {
  announceUpdate,
  announceVersion,
  askDue,
  currentUpdateOffer,
  flushBeforeRestart,
  periodElapsed,
  putAwayThisRun,
  readAskMemory,
  rememberAsk,
  restartHold,
  subscribeRestartHold,
  UPDATE_PERIOD_MS,
  writeAskMemory,
  type UpdateOffer,
} from "../../webapp/app/shell/app-update.js";
import {
  onRestartAsked,
  onUpdateState,
  updateHold,
  updatePoll,
  updatePress,
  updateState,
  type UpdateReport,
} from "./update.js";

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

/** How often a hold is renewed while a send waits; the shell lets one lapse after two minutes. */
export const HOLD_RENEW_MS = 60 * 1000;

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
 * Is a periodic check due? `canCheck` is the shell's own `Flow::press` answer, carried over
 * rather than re-derived: this cannot start a check the menu item has disabled, and cannot
 * press in the one state where a press INSTALLS. Giving up is NOT here — a refused install
 * leaves a state a press would check from, so the stop lives in the driver beside its counter
 * (`installRefused` is the classifier both use). `floor` is the earliest instant a check
 * may be counted from: the WINDOW OPENING for a shell with no last check to report, and the
 * LAST PRESS, which stops a press that produced neither `checking` nor a stamp from being
 * re-pressed every tick. The instant compared is the LATER of the two.
 */
export function checkDue(report: UpdateReport, now: number, floor: number): boolean {
  if (!report.canCheck) return false;
  return periodElapsed(Math.max(report.lastCheckedAt ?? floor, floor), now, CHECK_EVERY_MS);
}

/**
 * WHAT THE LINE SAYS ABOUT THIS REPORT, or null for nothing. Ready is a release one press from
 * installing (greyed while a send waits or a draft holds files); downloading is one being
 * fetched; failed is an install that did not go through, at a press, a quit or a launch, or a
 * check somebody pressed that did not finish. A scheduled check that fails says nothing. Each line
 * carries the key its restraint is counted against: a ready or a failure that answers a press is
 * keyed by that instant, so it is said once, at once.
 */
export function lineOf(report: UpdateReport): UpdateOffer | null {
  const version = report.offered ?? report.version;
  const line = (kind: UpdateOffer["kind"], key: string, failed?: UpdateOffer["failed"]): UpdateOffer => ({
    kind,
    version,
    key,
    act: () => void updatePress(),
    ...(failed ? { failed } : {}),
  });
  if (report.state === "ready" && typeof report.notStartedAt === "number") {
    return line("failed", `failed:${version}@${report.notStartedAt}`, "install");
  }
  /* AN INSTALL AT QUIT OR LAUNCH THAT FAILED stands through the release's next download, keyed by
     its instant; Retry is drawn only where a press can act now. */
  if (typeof report.installFailedAt === "number") {
    const key = `failed:install@${report.installFailedAt}`;
    return report.canInstall || report.canCheck
      ? line("failed", key, "install")
      : { kind: "failed", version, key, failed: "install" };
  }
  if (report.state === "downloading") return { kind: "downloading", version, key: `downloading:${version}` };
  if (report.state === "ready" && (report.canInstall || report.held)) {
    const at = report.pressedAt;
    return line("ready", typeof at === "number" ? `ready:${version}@${at}` : `ready:${version}`);
  }
  if (installRefused(report)) return line("failed", "failed:install", "install");
  if (report.state === "failed" && typeof report.pressedAt === "number") {
    return line("failed", `failed:check@${report.pressedAt}`, "check");
  }
  return null;
}

export interface UpdateCadenceOptions {
  /** Seams, so the whole cadence is drivable from a test with no clock, no shell and no timers. */
  now?: () => number;
  every?: number;
  read?: () => Promise<UpdateReport | null>;
  /** The silent check. Named `poll` and not `press` because the two are different requests. */
  poll?: () => Promise<void>;
  listen?: (show: (report: UpdateReport) => void) => Promise<() => void>;
  /** Tells the shell a send waits (`true`) or no longer does. */
  hold?: (waits: boolean) => Promise<void>;
  renewEvery?: number;
  /** The menu's Restart asking this window to save an open draft, then press. */
  asked?: (run: () => void) => Promise<() => void>;
  press?: () => Promise<void>;
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
  const read = options.read ?? updateState;
  const poll = options.poll ?? updatePoll;
  const listen = options.listen ?? onUpdateState;
  const hold = options.hold ?? updateHold;
  const renewEvery = options.renewEvery ?? HOLD_RENEW_MS;
  const asked = options.asked ?? onRestartAsked;
  const press = options.press ?? updatePress;

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
   * the line asks, and somebody who freed the disk presses Restart. Settings →
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
   * May this line start standing now? Downloading always may. A ready line, with installs automatic,
   * may unless Later put it away this run: the release goes in at the next restart regardless. Every
   * other line asks the once-a-day memory, keyed per release, and at once for a press's own instant.
   */
  const mayStand = (line: UpdateOffer, report: UpdateReport): boolean => {
    const key = line.key ?? line.kind;
    if (line.kind === "downloading") return true;
    if (line.kind === "ready" && report.autoInstall === true) return !putAwayThisRun(key);
    const memory = readAskMemory();
    if (!askDue(memory, key, now())) return false;
    writeAskMemory(rememberAsk(memory, key, now()));
    return true;
  };

  /**
   * Decide what this report means for the line. The line standing under the same key is refreshed
   * (a send began or ended, the switch moved); a report with nothing to say withdraws it.
   */
  const say = (report: UpdateReport): void => {
    announceVersion(report.version);
    const line = lineOf(report);
    if (line === null) {
      announceUpdate(null);
      return;
    }
    const standing = currentUpdateOffer();
    if (standing !== null && standing.key === line.key) {
      announceUpdate(line);
      return;
    }
    if (!mayStand(line, report)) {
      if (standing !== null) announceUpdate(null);
      return;
    }
    announceUpdate(line);
  };

  /* A SEND WAITS OR A DRAFT HOLDS FILES: the shell is told at once, again each `renewEvery` while
     it holds, and as soon as nothing does. A hold the shell cannot take (an older shell) changes
     nothing here. */
  let renewal: ReturnType<typeof setInterval> | null = null;
  let holding = false;
  const tellHold = (waits: boolean): void => {
    if (waits === holding) return;
    holding = waits;
    if (renewal !== null) clearInterval(renewal);
    renewal = waits ? setInterval(() => void hold(true).catch(() => {}), renewEvery) : null;
    void hold(waits).catch(() => {});
  };
  const offWaits = subscribeRestartHold((why) => tellHold(why !== null));
  if (restartHold() !== null) tellHold(true);

  /* THE MENU'S RESTART ASKS HERE, so an open draft is written first, as from the line and Settings.
     One ask at a time. It presses only where a press still installs, and not after an attempt
     (`notStartedAt` moved) the shell made meanwhile; the shell restarts by itself if none lands. */
  let answering = false;
  const answer = async (): Promise<void> => {
    if (stopped || answering) return;
    answering = true;
    try {
      const before = await read();
      await flushBeforeRestart();
      const after = await read();
      if (stopped || after === null || !after.canInstall) return;
      if (after.notStartedAt !== (before?.notStartedAt ?? null)) return;
      await press();
    } catch {
      /* A refused read or press: the shell's own bound restarts. */
    } finally {
      answering = false;
    }
  };
  let releaseAsk: (() => void) | null = null;
  void (async () => {
    try {
      const off = await asked(() => void answer());
      if (stopped) off();
      else releaseAsk = off;
    } catch {
      /* No ask reaches this window; the shell restarts by itself. */
    }
  })();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const report = await read();
    if (stopped || report === null) return;
    note(report);
    say(report);

    /* ── ONE RETRY AFTER A REFUSED INSTALL, THEN THIS WINDOW STOPS ASKING ──────────────────
       A refused install leaves the flow where a check would start, and the release is still
       newer — unbounded, the day sends this window round the loop for ever: fetch, verify,
       ask "ready to install", fail, repeat tomorrow; a modal over
       somebody's mail once a day for the life of the install. ONE more attempt, on every
       platform: the same state is reachable from a
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
  const observe = (report: UpdateReport | null): void => {
    if (stopped || report === null) return;
    note(report);
    say(report);
  };
  void (async () => {
    const off = await listen(observe);
    if (stopped) off();
    else release = off;
  })();
  // A payload already waiting when this window opens (a reload, a late window) is asked about now.
  read().then(observe, () => {});

  return () => {
    stopped = true;
    clearInterval(timer);
    if (renewal !== null) clearInterval(renewal);
    offWaits();
    release?.();
    releaseAsk?.();
  };
}
