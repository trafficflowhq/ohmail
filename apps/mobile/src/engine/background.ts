/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT HAPPENS TO THE MAILBOX WHEN THE APP LEAVES THE SCREEN — one state machine, two platforms
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A standalone phone IS the organizer of its mailbox, and an app that is not running organizes
 * nothing. The two platforms allow different answers to that, so this app gives different answers
 * — and the SENTENCES on the fourth door already say which:
 *
 *  · Android — *"It organizes while its notification is shown. Dismiss the notification to stop."*
 *    A foreground service keeps this process alive and unfrozen, so the engine's own poll timer
 *    goes on firing, and the notification is what makes that visible. It is the ONLY background
 *    surface: no notification, nothing organizing.
 *  · iPhone — *"It organizes while ohmail is open. When you leave the app, it hands the mailbox
 *    back."* iOS suspends the process, and a claim held by a suspended app is the
 *    double-organizer hazard: somebody's desktop would stand itself down against a phone in a
 *    pocket. So the claim is GIVEN BACK on the way out and taken again on the way in.
 *
 * ── IT IS ONE MODULE AND NOT TWO, WHICH IS THE PLATFORM-PARITY RULE APPLIED HONESTLY ──────
 *
 * Both platforms run every line below. What forks is one field — {@link BackgroundDeps.platform}
 * — and whether {@link BackgroundDeps.service} is present, and the iOS arms are therefore driven
 * by the node suite on the same seams the Android arms are. A second module per platform would be
 * two answers to "may this install organize right now", and that question has exactly one.
 *
 * ── AND IT IMPORTS NO NATIVE MODULE, FOR `local-engine.ts`'s REASON ────────────────────────
 *
 * The Android binding lives in `background-native.ts`. The expo packages ship Flow-typed
 * JavaScript that the node suite's transform refuses, so a module that reached for the platform
 * here could not be imported by a test at all — not a tidiness rule, a loadability one.
 *
 * ── THE RELEASE IS THE ENGINE'S OWN, ALWAYS ───────────────────────────────────────────────
 *
 * Nothing here writes to `ohmail/_meta`. {@link BackgroundEngine.handBack} is the engine's
 * `handBack()`, which calls the same `releaseOwnClaim` the detach arm and the release route call;
 * the re-claim is the ordinary gated cycle, reached by forcing one. A lease write from this app
 * would be a second implementation of "who organizes this mailbox", and the one thing two halves
 * of that must never do is differ.
 */

/** Which set of arms this install runs. `Platform.OS` in the app; a literal in the suite. */
export type OrganizerPlatform = "android" | "ios";

/**
 * The app-state values this machine reacts to — React Native's own, minus the ones it ignores.
 *
 * `inactive` is iOS's transitional state (the app switcher, an incoming call, a system sheet) and
 * it is NOT a background: a person flicking through the switcher and coming straight back would
 * otherwise hand the mailbox back and take it again every time, which is a pair of IMAP writes per
 * flick and a window in which a desktop can take the mailbox for a gesture nobody made. Android
 * reports `inactive` for a split second on the way to `background`, so treating it as one would
 * also stop the service the next transition is about to need.
 */
export type AppPhase = "active" | "inactive" | "background";

/** What the notification says. Composed in JS from the deck, because the address is runtime data. */
export interface ServiceNotice {
  /** The channel's user-visible name — "Organizing". */
  readonly channelName: string;
  /** The body — "Organizing mila@example.com." The address comes from the mailbox row. */
  readonly body: string;
  /** The one action's label — "Stop organizing". */
  readonly stopLabel: string;
}

/**
 * THE ANDROID FOREGROUND SERVICE, behind a seam.
 *
 * `null` where there is no such thing (iOS, and the node suite), and `null` is not a degraded
 * Android: it means this install cannot organize while backgrounded, and the arms below hand the
 * mailbox back rather than pretending otherwise.
 */
export interface BackgroundService {
  /**
   * Post the notification and hold this process. Answers whether it is actually showing.
   *
   * `false` rather than a throw for the ordinary refusals — a denied notification permission, a
   * background-start restriction — because they are not faults and the caller's answer to all of
   * them is the same: do not organize in the background. A notification that is not showing over a
   * process that is organizing is exactly the state the door's sentence forbids.
   */
  start(notice: ServiceNotice): Promise<boolean>;
  /** Drop the notification and let this process be frozen again. Idempotent. */
  stop(): Promise<void>;
  /**
   * SAY THAT THIS RUNTIME IS STILL RUNNING, and answer whether the service is still up.
   *
   * A foreground service keeps the process unfrozen; it does NOT keep React Native's timers
   * running, and the engine's poll and the watch below are timers. The service's own watchdog takes
   * the notification down after two silent intervals, so this beat is what separates a live
   * runtime from a frozen one — and it can only be sent by a runtime that is in fact running,
   * which is what makes it evidence rather than a flag.
   */
  beat(): boolean;
  /** How long this runtime may be silent before the notification comes down. */
  beatIntervalMs(): number;
  /** Is the service up right now? Read from the platform, never remembered here. */
  running(): boolean;
  /**
   * HAS THE SYSTEM RESTRICTED THIS APP'S BACKGROUND WORK — battery saver, or a per-app background
   * restriction a person set.
   *
   * Asked BEFORE the service is started rather than discovered by its death: under a restriction
   * Android may kill the service at any moment with nothing anywhere saying why, and the person
   * would be left with an app that says it organizes and a mailbox that is not being organized.
   */
  restricted(): boolean;
  /**
   * The user's stop. Fires for the notification's action AND for a swipe-dismiss, which are the
   * same act — see the Kotlin half: one `ACTION_STOP`, one handler.
   *
   * Returns its own unsubscribe.
   */
  onStopRequested(listener: () => void): () => void;
}

/** What this machine needs of the engine. `PhoneEngine` satisfies it structurally. */
export interface BackgroundEngine {
  /**
   * Remove this install's claim on every mailbox and leave the rows alone — the engine's
   * `handBack()`. One entry per mailbox; `released: null` is "could not look", and this install
   * may still hold that mailbox's claim.
   */
  handBack(): Promise<readonly { readonly mailboxId: string; readonly released: number | null }[]>;
  /**
   * Force one gated cycle per mailbox, so the lease is re-read now rather than at the next poll
   * tick. The gate claims a free mailbox and stands this install down against a holder; neither
   * needs a press, and neither can displace anybody.
   */
  resume(): Promise<void>;
  /** What the engine says it organizes right now, one entry per mailbox. */
  organizing(): readonly { readonly mailboxId: string; readonly organizing: boolean }[];
}

export interface BackgroundDeps {
  readonly platform: OrganizerPlatform;
  readonly engine: BackgroundEngine;
  /** `null` on iOS and in the suite's iOS cells — see {@link BackgroundService}. */
  readonly service: BackgroundService | null;
  /** The notice, re-read per start so a language change between backgrounds is picked up. */
  readonly notice: () => ServiceNotice;
  /**
   * SAY IT IN THE APP, ONCE — the battery-saver announcement.
   *
   * Called at most once per {@link BackgroundOrganizing} for the whole class of "the system will
   * not let this organize in the background": a person who has battery saver on has it on all day,
   * and a sentence repeated at every background is a sentence nobody reads. The app renders it the
   * next time it is open; this machine does not decide where.
   */
  readonly announceRestricted: () => void;
  /**
   * HOW OFTEN THE SERVICE ASKS THE ENGINE WHETHER IT STILL ORGANIZES ANYTHING — armed WITH the
   * service and cleared with it, never otherwise.
   *
   * The claim can be lost while the app is in the background and nothing in JS chose it: somebody
   * presses "Organize here" on their desktop and this install's next gated cycle stands down. The
   * notification would then be a false statement on a surface a person cannot argue with, for as
   * long as the app stayed backgrounded. Checking only on the way back in would leave exactly that
   * window open, so the watch exists for as long as the notification does.
   *
   * Armed from the service's own state rather than from a flag: a check running with no service is
   * a timer nothing needs, and a service with no check is the false-state window.
   */
  readonly checkEveryMs?: number;
  /** Diagnostics. NEVER the address — see {@link ServiceNotice}; the body is not logged. */
  readonly log?: (event: string, detail?: Record<string, unknown>) => void;
}

/** The claim watch's cadence. A minute: the engine's own poll is slower, so this never leads it. */
export const CLAIM_WATCH_MS = 60_000;

/**
 * WHY THE MAILBOX WAS GIVEN BACK, OR THE NOTIFICATION TAKEN DOWN — a closed set of CODES.
 *
 * Codes and not sentences, for two reasons that point the same way. Nobody reads these but a
 * developer holding a log, so an English sentence here is prose in a file the copy census scans —
 * and it was flagged as exactly that. And a code is a value: the cells below assert which arm ran
 * by comparing one, where a sentence would have them matching prose.
 *
 * What each one means is in the arm that emits it; they are not abbreviations of anything.
 */
export type BackgroundReason =
  /** iOS: the app left the foreground on a platform that suspends it. */
  | "left_the_foreground"
  /** There is no background service in this build, so it organizes only while it is open. */
  | "no_background_service"
  /** Battery saver, or a per-app background restriction somebody set. */
  | "system_restricted"
  /** The service started and its notification is not showing — a refused permission, a refused
   *  background start. Nothing may organize behind a notification nobody can see. */
  | "notification_not_showing"
  /** The person's stop: the notification's action, or a swipe-dismiss. */
  | "stopped_from_notification"
  /** This install organizes nothing any more — another machine took the mailbox, the lease could
   *  not be read, or the mailbox was removed. The claim is NOT ours to hand back here. */
  | "claim_lost";

/** What the app holds. One per standalone engine; disposed with it. */
export interface BackgroundOrganizing {
  /** Drive a transition. The app's `AppState` listener is the only production caller. */
  phaseChanged(next: AppPhase): Promise<void>;
  /**
   * Has the claim been handed back and not yet taken again? The iOS transitional state Settings
   * renders as "Handed back", and false everywhere a claim is held.
   */
  handedBack(): boolean;
  /** Whether the background service is up, for the Settings row that says so. */
  backgrounded(): boolean;
  /** Drop the stop listener. The service, if up, is left alone — stopping it is a person's act. */
  dispose(): void;
}

/**
 * Wire it up. Subscribes the stop listener immediately, because the service can already be
 * running: Android restarts nothing on its own (`START_NOT_STICKY`), but a JS reload over a live
 * service leaves a notification whose stop must still reach an engine.
 */
export function createBackgroundOrganizing(deps: BackgroundDeps): BackgroundOrganizing {
  const log = deps.log ?? ((): void => undefined);
  /** Announced at most once — see {@link BackgroundDeps.announceRestricted}. */
  let announced = false;
  /** True from a completed hand-back until a resume has been asked for. */
  let handedBack = false;
  let disposed = false;
  let watch: ReturnType<typeof setInterval> | null = null;
  /**
   * ONE TRANSITION AT A TIME, and it is not tidiness. A person who backgrounds the app and comes
   * straight back produces `background` then `active` within a few hundred milliseconds, and the
   * hand-back is an IMAP round trip. Overlapped, the resume's gate reads the lease BEFORE the
   * release lands, claims a mailbox this install already holds, and the release then removes the
   * claim it has just re-armed — an install that believes it is organizing over a mailbox whose
   * `ohmail/_meta` says nobody is.
   */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };

  /**
   * GIVE THE MAILBOX BACK AND SAY WHETHER IT WORKED.
   *
   * `handedBack` is set only when EVERY mailbox answered a number. One `null` means this install
   * may still hold that mailbox's claim, so "Handed back" would be a false state — the claim lapses
   * instead, and the row Settings renders says nothing that is not true.
   */
  const handBack = async (why: BackgroundReason): Promise<boolean> => {
    let all: readonly { readonly mailboxId: string; readonly released: number | null }[];
    try {
      all = await deps.engine.handBack();
    } catch (err) {
      /* The engine's own paths log the cause. What this adds is that the hand-back did not
         complete, which is what decides the state below. */
      log("organizer_hand_back_failed", { err, why });
      handedBack = false;
      return false;
    }
    const unknown = all.filter((m) => m.released === null).length;
    handedBack = all.length > 0 && unknown === 0;
    log("organizer_hand_back", { why, mailboxes: all.length, unknown, handedBack });
    return handedBack;
  };

  /**
   * STOP ORGANIZING IN THE BACKGROUND — the claim FIRST, the notification second.
   *
   * The order is the whole of it. Dropping the notification first leaves a window in which nothing
   * on the phone says the mailbox is being organized and the claim is still standing in it, which
   * is the state a person who pressed "Stop organizing" is entitled to assume is over. Releasing
   * first makes the notification's disappearance the LAST thing that happens rather than the first.
   */
  const stopBackground = async (why: BackgroundReason): Promise<void> => {
    await handBack(why);
    await dropService(why);
  };

  /** Drop the notification and the watch that belongs to it. Idempotent; never throws. */
  const dropService = async (why: BackgroundReason): Promise<void> => {
    disarmWatch();
    if (deps.service === null) return;
    try {
      await deps.service.stop();
    } catch (err) {
      log("organizer_service_stop_failed", { err, why });
    }
  };

  const disarmWatch = (): void => {
    if (watch !== null) {
      clearInterval(watch);
      watch = null;
    }
  };

  /**
   * ARM THE CLAIM WATCH — ONCE, and the caller is what decides it is wanted.
   *
   * This used to re-check `deps.service.running()` here as a belt. Both call sites have already
   * established that the notification is showing — one from `start()`'s own answer, the other from
   * the platform's `running()` — so that clause's contrary state was unreachable: it could not be
   * watched fail, which is the whole of why it is gone rather than tested around.
   *
   * `watch !== null` is NOT such a clause. A background followed by a foreground reaches this
   * twice for one service, and a second interval would ask the engine twice a minute for ever and
   * outlive the first `clearInterval`.
   */
  const armWatch = (): void => {
    if (watch !== null) return;
    /* THE BEAT PACES THE WATCH, not the other way round. The service's watchdog is the shorter of
       the two clocks — it has to be, or the notification would outlive the runtime — so the tick
       runs at the platform's own interval and the claim check rides it. Reading the number from
       the service rather than duplicating it: two copies of one deadline drift, and the one that
       drifts is the one that takes a person's notification down early. */
    const every = beatEveryMs();
    watch = setInterval(() => {
      /* THE BEAT FIRST, and OUTSIDE the queue. It says "this runtime is running", which is true
         at this instant whatever the claim read goes on to do — and behind a serial queue a slow
         IMAP read would hold it past the watchdog's deadline and take the notification down over a
         runtime that was working. */
      beatNow();
      void serial(() => claimLostCheck());
    }, every);
  };

  /** The tick, from the platform, bounded so a bad answer cannot make the watch a busy loop. */
  const beatEveryMs = (): number => {
    if (deps.checkEveryMs !== undefined) return deps.checkEveryMs;
    try {
      const platform = deps.service?.beatIntervalMs();
      if (typeof platform === "number" && platform >= 1000 && platform <= CLAIM_WATCH_MS) {
        /* HALF the deadline, so one lost tick is not a missed deadline. */
        return Math.max(1000, Math.floor(platform / 2));
      }
    } catch {
      /* A platform that cannot say paces on this module's own number. */
    }
    return CLAIM_WATCH_MS;
  };

  /**
   * Beat, and take the notification's own word for whether it is still showing.
   *
   * `false` means the service has gone — its watchdog fired, or the system killed it — and this
   * install is no longer organizing behind anything a person can see. The claim goes back, which
   * is the same thing every other decline does.
   */
  const beatNow = (): void => {
    if (deps.service === null) return;
    let up = true;
    try {
      up = deps.service.beat();
    } catch (err) {
      log("organizer_service_beat_failed", { err });
      return;
    }
    if (up) return;
    /* THE CODE AND NOTHING ELSE — see {@link BackgroundReason}. A prose `reason` here is a
       sentence in a file the copy census scans, and it was flagged as exactly that; what it said
       is in the comment above, which is where an invariant belongs. */
    log("organizer_service_gone", { why: "notification_not_showing" });
    disarmWatch();
    void serial(() => handBack("notification_not_showing"));
  };

  /**
   * THE USER'S STOP — the notification's action, and a swipe-dismiss, which are one act.
   *
   * Subscribed for the life of this object rather than per background: the stop arrives from the
   * system at a moment nothing in JS chose, including while the app is being resumed.
   */
  const unsubscribe = deps.service?.onStopRequested(() => {
    void serial(() => stopBackground("stopped_from_notification"));
  }) ?? ((): void => undefined);

  /** Android's way out. Every arm that declines to organize in the background lands here. */
  const declineBackground = async (why: BackgroundReason, restricted: boolean): Promise<void> => {
    if (restricted && !announced) {
      announced = true;
      deps.announceRestricted();
    }
    await stopBackground(why);
  };

  const toBackground = async (): Promise<void> => {
    if (deps.platform === "ios" || deps.service === null) {
      /* NO SERVICE, NO BACKGROUND ORGANIZING — and on iOS that is the platform, not a gap. The
         claim goes back so somebody's desktop can have the mailbox while this phone is asleep. */
      await handBack(deps.platform === "ios" ? "left_the_foreground" : "no_background_service");
      return;
    }
    /* ══ A READER DOES NOT POST "ORGANIZING" ════════════════════════════════════════════════
     *
     * Another install took the mailbox and this install's gate stood down. The notification names
     * this phone as the organizer, so starting one here states something false on a surface a
     * person cannot argue with — and it would stand until the claim watch ran, which is a minute
     * away at best. The watch is the belt for a claim lost LATER; this is the state at the moment
     * of backgrounding, and it is a different question with the same reader.
     *
     * `!== false` and not `=== true`: an engine that cannot say is not evidence that it organizes
     * nothing, and taking that as a decline would hand the mailbox back over a momentary failure.
     */
    if (organizingNow() === false) {
      log("organizer_background_declined_reader", { why: "claim_lost" });
      /* NO HAND-BACK. The claim is not ours — the gate has already stood down — and asking the
         server to expunge records by our own id would be a write about a mailbox this install has
         been told it does not hold. */
      disarmWatch();
      return;
    }
    if (deps.service.restricted()) {
      await declineBackground("system_restricted", true);
      return;
    }
    let showing = false;
    try {
      showing = await deps.service.start(deps.notice());
    } catch (err) {
      log("organizer_service_start_failed", { err });
      showing = false;
    }
    if (!showing) {
      /* THE SENTENCE THE DOOR MADE — "it organizes while its notification is shown". A service
         whose notification is not showing (a denied permission, a refused background start) may
         not go on organizing, so this hands the mailbox back like every other decline. It counts
         as restricted for the announcement: from the person's side it is the same fact. */
      await declineBackground("notification_not_showing", true);
      return;
    }
    armWatch();
  };

  const toForeground = async (): Promise<void> => {
    if (deps.platform === "android" && deps.service !== null && deps.service.running()) {
      /* THE SERVICE STAYS UP. It holds a claim that is live and a notification that is true, and
         tearing it down here would release a mailbox this app is now in the foreground of only to
         claim it again — two IMAP writes and a window, for nothing. Settings reads
         {@link backgrounded} and says so. */
      await claimLostCheck();
      /* AND THE WATCH IS ARMED HERE TOO, which is not a belt. A JS reload over a live service —
         a development reload, and a React context the system rebuilt — leaves the notification
         showing with no timer behind it, and nothing would then notice a claim lost from that
         moment on. This is the only path that can meet a service it did not start. */
      armWatch();
      return;
    }
    /* EVERY OTHER WAY BACK IN asks the gate. On iOS the claim was given up on the way out; on
       Android it was given up by a decline or a stop. Either way the lease decides, and the same
       call covers both: claim a free mailbox, stand down against a holder. */
    handedBack = false;
    try {
      await deps.engine.resume();
    } catch (err) {
      /* The claim was NOT taken back. `handedBack` returns to true so nothing renders
         "Organizing" over a mailbox this install does not hold — the resume is retried by the
         engine's own poll and by the next time the app is opened. */
      handedBack = true;
      log("organizer_resume_failed", { err });
    }
  };

  /**
   * THE CLAIM CAN BE LOST WITHOUT THIS APP DOING ANYTHING — somebody presses "Organize here" on
   * their desktop and the phone's next gated cycle stands it down. The notification then says
   * "Organizing <address>" over an install that organizes nothing, which is a false state on a
   * surface a person cannot argue with. So the service goes when the claim does.
   */
  /**
   * DOES THIS INSTALL ORGANIZE ANYTHING RIGHT NOW — `true`, `false`, or `null` for "cannot say".
   *
   * Three answers and not two, because the two arms that read this must treat a failed read
   * differently from a negative one: an engine that cannot answer is not evidence that it organizes
   * nothing, and both a decline and a notification teardown over that would be a decision taken on
   * a momentary failure.
   */
  const organizingNow = (): boolean | null => {
    try {
      const states = deps.engine.organizing();
      return states.some((m) => m.organizing);
    } catch (err) {
      log("organizer_state_unreadable", { err });
      return null;
    }
  };

  const claimLostCheck = async (): Promise<void> => {
    if (deps.service === null || !deps.service.running()) return;
    /* THREE ANSWERS. `null` — the engine could not say — leaves the notification standing and asks
       again next tick: a teardown over a momentary failure would end a person's organizing and
       leave the claim to lapse from a mailbox nothing had decided to give up. */
    const organizing = organizingNow();
    if (organizing !== false) return;
    log("organizer_service_stopped_claim_lost", { why: "claim_lost" });
    /* NO HAND-BACK HERE. The claim is not ours to give back: either another install holds it, or
       the lease could not be read, and asking the server to expunge records by our own id in
       either state is a write about a mailbox this install has just been told it does not hold.
       The engine's own gate already released or never had it. */
    await dropService("claim_lost");
  };

  return {
    /* SERIALIZED, and the whole transition is one job — see {@link serial}. */
    phaseChanged: (next: AppPhase): Promise<void> => serial(async () => {
      if (disposed) return;
      /* `inactive` IS NOT A BACKGROUND. See {@link AppPhase}: it is the app switcher and the
         incoming call, and acting on it would hand the mailbox back for a gesture nobody made. */
      if (next === "inactive") return;
      if (next === "background") {
        await toBackground();
        return;
      }
      await toForeground();
    }),
    handedBack: () => handedBack,
    backgrounded: () => deps.service !== null && deps.service.running(),
    dispose() {
      disposed = true;
      disarmWatch();
      unsubscribe();
    },
  };
}
