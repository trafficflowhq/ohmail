/**
 * What happens to the mailbox when the app leaves the screen — one state machine, two platforms.
 * A standalone phone IS the organizer, and an app that is not running organizes nothing. Android
 * keeps a foreground service alive; iOS suspends the process, and a claim held by a suspended app
 * is the double-organizer hazard, so it is given back on the way out and taken again on the way
 * in. TWO questions, each asked once: `organizerRuns` — can the organizer run? — read from the
 * service's own state, never from {@link BackgroundDeps.platform}; and `stateNow().claimed` — is
 * the mailbox ours? — read from the engine's record of the claim, never from whether a pass has
 * reported itself organizing. The release is `handBack()`; nothing here writes `ohmail/_meta`.
 */
import type { StopOrganizingOutcome } from "./standalone-door";

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
  /**
   * THE BODY A STOP THAT COULD NOT COMPLETE LEAVES ON THE NOTIFICATION.
   *
   * Composed by the app beside the ordinary body, because the deck is the app's and the address
   * is runtime data. REQUIRED, so TypeScript is the census over every composition: absent, a
   * failed stop would keep the "Organizing" body over a person who has just pressed stop, and
   * nothing would say so.
   */
  readonly stopFailedBody: string;
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
  /**
   * THE PERSON'S STOP, RECORDED WHERE A RELAUNCH READS IT — the engine's `stopOrganizing`.
   * Separate from {@link handBack} because the two are opposite instructions with opposite
   * durability: `handBack` leaves the ROW saying organizer so the next resume takes the mailbox
   * back with no press, which is what an app leaving the foreground needs, while a person's stop
   * must survive the app being killed, so it goes through the release the row records — and a
   * reader with no press never re-enters the gate again. Three answers, not a boolean; see
   * {@link StopOrganizingOutcome}.
   */
  stopOrganizing(): Promise<StopOrganizingOutcome>;
  /**
   * ASK FOR THIS PHONE — the engine's `claimHere`. `held` is a live foreign claim, refused at the
   * door; it is the ordinary answer while another machine organizes the mailbox and owes nobody a
   * sentence.
   */
  claimHere(): Promise<"claimed" | "held" | "unreadable" | "refused">;
  /**
   * What the engine says about each mailbox right now — THREE facts, and no two of them are the
   * negation of another.
   *
   * `claimed` is the one this module decides on: is this mailbox's claim ours? `organizing` flips
   * a round trip LATER — the claim is appended to `ohmail/_meta` and the permit is a second write
   * — so between them a mailbox just given to this phone reads like one nobody consented to.
   * `standDown` is true both before anybody consents and after another machine took the mailbox,
   * and only the second is a state the claim watch may try to come back from.
   */
  organizing(): readonly {
    readonly mailboxId: string;
    readonly organizing: boolean;
    readonly standDown: boolean;
    readonly claimed: boolean;
  }[];
}

export interface BackgroundDeps {
  readonly platform: OrganizerPlatform;
  readonly engine: BackgroundEngine;
  /** `null` on iOS and in the suite's iOS cells — see {@link BackgroundService}. */
  readonly service: BackgroundService | null;
  /** The notice, re-read per start so a language change between backgrounds is picked up. */
  readonly notice: () => ServiceNotice;
  /**
   * SAY IT IN THE APP, ONCE — the battery-saver announcement, and ONLY that one.
   *
   * Called at most once per {@link BackgroundOrganizing} for battery saver or a per-app background
   * restriction: a person who has battery saver on has it on all day, and a sentence repeated at
   * every background is a sentence nobody reads. The app renders it the next time it is open; this
   * machine does not decide where.
   */
  readonly announceRestricted: () => void;
  /**
   * AND THE OTHER CAUSE, WHICH IS NOT THAT ONE — the notification permission.
   *
   * Both declines used to arrive as `announceRestricted`, and the sentence it reaches names battery
   * saver: *"Battery saver does not let ohmail organize in the background on this phone."* On an
   * Android 13+ first install, where `POST_NOTIFICATIONS` starts denied and the service refuses to
   * start behind a notification nobody can see, that sentence is FALSE and it is the only thing the
   * panel said. Two causes, two records, two sentences — and the person can act on this one, which
   * is the whole reason it is worth telling them apart. Once per session, for the same reason.
   */
  readonly announceNotificationsOff: () => void;
  /**
   * AND THE ONE THAT IS NOT A DECLINE AT ALL — a start that did not finish starting.
   *
   * The engine claims the mailbox and then fails before anything is polling or renewing; it gives
   * the claim back and tries again, and past its own bound it refuses. A silent refusal here is a
   * person watching a mailbox that says nothing and never changes, so the reason travels to the
   * panel as a value ({@link Refusal}) and is worded at render. Called on the FINAL refusal only —
   * the engine's own attempts are not the person's business — and cleared by a resume that works,
   * so a sentence cannot outlive the thing it was about.
   */
  readonly sayStartFailed: (detail: unknown) => void;
  /**
   * How often the service asks the engine whether it still organizes anything — armed with
   * the service and cleared with it, never otherwise. The claim can be lost while the app is
   * backgrounded and nothing in JS chose it: somebody presses "Organize here" on their desktop
   * and this install's next gated cycle stands down — the notification would then be a false
   * statement on a surface a person cannot argue with, for as long as the app stayed
   * backgrounded. Armed from the service's own state rather than a flag: a check with no
   * service is a timer nothing needs, and a service with no check is the false-state window.
   */
  readonly checkEveryMs?: number;
  /**
   * Say that the mailbox's state may have moved — the screen's cue to ask again. Settings' "This
   * phone" panel read the door at RENDER and nothing re-rendered it, so it showed the state from
   * when it was opened. Every arm that can move the claim calls this, and so does the claim watch,
   * which is what carries an ENGINE-side change (a stand-down mid-poll, a holder going away) onto
   * a screen already open. It carries no state: the caller's own reader decides whether anything
   * changed, and a payload here would be a second copy of the answer the engine already gives.
   */
  readonly stateChanged?: () => void;
  /**
   * Diagnostics — the ENGINE's own hardened logger, handed back out to the app. NEVER the address:
   * see {@link ServiceNotice}, the notice's body is not logged. `detail` is required rather than
   * optional so the artifact's `Diagnostic` fits here without an adapter — an app wrapping this
   * seam is an app one edit away from composing its own line.
   */
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

/** The claim watch's cadence. A minute: the engine's own poll is slower, so this never leads it. */
export const CLAIM_WATCH_MS = 60_000;

/**
 * HOW MANY TIMES A STOP THE MAIL SERVER WOULD NOT CONFIRM IS ASKED AGAIN, and the wait between.
 *
 * Three: the fault a release meets is a busy folder or a connection just back — passing — and one
 * attempt makes somebody's stop the cost of a bad half-second. Bounded rather than open, because a
 * retry loop over a fault that is NOT passing is an install asking for ever. Past the bound the
 * engine is still organizing, so the notification STAYS, carrying
 * {@link ServiceNotice.stopFailedBody}: the person can press again, and nothing has hidden a
 * mailbox that is being organized.
 */
export const STOP_ATTEMPTS = 3;
export const STOP_BACKOFF_MS = 200;

/**
 * WHY THE MAILBOX WAS GIVEN BACK, KEPT, OR THE NOTIFICATION TAKEN DOWN — a closed set of CODES.
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
  /** This install HAD the mailbox and no longer does — another machine took it. The claim is NOT
   *  ours to hand back here. */
  | "claim_lost"
  /** Nothing of ours: no claim this install wrote — before anybody has consented to this phone,
   *  and after it has given the mailbox back. Not a loss; there was never anything to lose. */
  | "no_claim_here"
  /** The mailbox this install had stood down from is free again, and this install took it back. */
  | "holder_left"
  /** The organizer is running behind its notification and goes on running, so leaving the screen
   *  gives nothing back — the only code here that is not about something ending. */
  | "organizer_still_running";

/**
 * Whether the SYSTEM declined — battery saver, or a notification it will not show — rather than
 * this build having no background service at all. From the person's side those two are one fact,
 * which is why the line carries this beside the code that tells them apart.
 */
const systemDeclined = (why: BackgroundReason): boolean =>
  why === "system_restricted" || why === "notification_not_showing";

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
  /* NEVER THROWS INTO THIS MACHINE. A screen's re-render must not be able to abort a hand-back. */
  const moved = (): void => {
    try {
      deps.stateChanged?.();
    } catch {
      /* See above: a subscriber's failure is its own. */
    }
  };
  /**
   * Announced at most once EACH — see {@link BackgroundDeps.announceRestricted}. Two latches and
   * not one: a phone can meet battery saver and a denied notification in one session, and a shared
   * latch would spend the first sentence's turn on the second cause and leave one of the two facts
   * unsaid for the rest of the session.
   */
  let announcedRestricted = false;
  let announcedNotificationsOff = false;
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
    log("organizer_hand_back", { why, mailboxes: all.length, unresolved: unknown, handedBack });
    moved();
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

  /**
   * The person's stop — REMEMBERED, which a hand-back is not. The notification action and a
   * swipe-dismiss used to run {@link stopBackground}, which removes the claim but leaves the ROW
   * saying organizer — wrong here, because the row is what the next launch reads: dismiss, reopen,
   * and the resume wrote a fresh claim nothing serviced (a message unfiled, Settings saying
   * `Organizing`), and the mailbox reads as taken so the laptop is refused. So this goes through
   * the engine's own release, which the row records; the notification comes down second so the
   * claim is not still standing when the surface that advertises it disappears. A release that
   * recorded nothing still takes it down — the person pressed stop, and the claim lapses on its own.
   */
  /**
   * HAS THE ENGINE ACTUALLY STOPPED — its own answer, consumed and never re-derived here.
   *
   * `organizing` on the engine's report is already a MASK over the mechanism: it can only ever
   * withhold what a pass declared, so it cannot say "organizing" over a runtime with nothing
   * running. A second derivation on this side would be a second source of truth about the one
   * question that decides whether the notification may go. An unreadable runtime is NOT a stop —
   * the same reading every other path here takes: a momentary failure must not take a person's
   * only sign that their mailbox is being organized away.
   */
  const engineStopped = (): boolean => {
    try {
      return deps.engine.organizing().every((m) => !m.organizing);
    } catch (err) {
      log("organizer_stop_state_unreadable", { err, why: "stopped_from_notification" });
      return false;
    }
  };

  /**
   * SAY ON THE NOTIFICATION THAT THE STOP DID NOT COMPLETE — the same surface the press was made
   * on. `start` with the same channel re-issues `startForeground` under one notification id, so
   * this updates the body rather than posting a second one. A refused re-post leaves the standing
   * notification as it was, which is still a true statement about a running engine.
   */
  const sayStopFailed = async (): Promise<void> => {
    if (deps.service === null) return;
    const notice = deps.notice();
    try {
      await deps.service.start({ ...notice, body: notice.stopFailedBody });
    } catch (err) {
      log("organizer_stop_notice_failed", { err, why: "stopped_from_notification" });
    }
  };

  /**
   * ══ THE CONTROLS ARE TORN DOWN BY THE STOP'S SUCCESS, NEVER BY THE ATTEMPT ═════════════════
   *
   * This dropped the notification and the watchdog unconditionally, so a release that failed took
   * every visible sign the mailbox was being organized while the engine went on polling and
   * RENEWING the lease — no other install could take it either, and there was no way back to the
   * control. The reading that licenses the teardown is the ENGINE's, asked after the release;
   * anything else is asked again under {@link STOP_ATTEMPTS}, and past the bound the notification
   * stays, saying what happened.
   */
  const stopByPerson = async (): Promise<void> => {
    /* NOT `handedBack`. That flag is the iOS transitional state — given back, and to be taken again
       on the way in — and a person's stop is the opposite of a state something resumes from. */
    handedBack = false;
    for (let attempt = 1; ; attempt += 1) {
      let stopped: StopOrganizingOutcome = "refused";
      try {
        stopped = await deps.engine.stopOrganizing();
      } catch (err) {
        log("organizer_stop_by_person_failed", { err, why: "stopped_from_notification", attempt });
      }
      /* The WORD the engine answered, so a refused release is readable in the log rather than
         arriving as a `false` that also means "nothing to give up". */
      log("organizer_stopped_by_person", { why: "stopped_from_notification", stopped, attempt });
      moved();
      if (engineStopped()) {
        await dropService("stopped_from_notification");
        return;
      }
      if (attempt >= STOP_ATTEMPTS) break;
      await sayStopFailed();
      await new Promise((r) => {
        (setTimeout(r, STOP_BACKOFF_MS * attempt) as unknown as { unref?: () => void }).unref?.();
      });
    }
    /* A CODE AND A COUNT, never a sentence — {@link BackgroundReason}'s rule: prose in this file
       is prose the copy census scans, and what this line means is in the block above it. */
    log("organizer_stop_did_not_complete", { why: "stopped_from_notification", attempts: STOP_ATTEMPTS });
    await sayStopFailed();
    moved();
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
   * The stood-down watch's own timer — a second interval, because its LIFETIME differs. The claim
   * watch above lives with the NOTIFICATION (armed and disarmed with the service, defending
   * against a notification outliving its claim); this one lives with the SESSION — the app being
   * open — defending against a stand-down nothing re-reads. Folding them would tie "may this phone
   * take its mailbox back" to whether a notification is showing, which on Android is backwards: the
   * phone is in front of the person when it is NOT showing. The CADENCE is the claim watch's own
   * ({@link beatEveryMs}).
   */
  let reclaim: ReturnType<typeof setInterval> | null = null;

  const armReclaim = (): void => {
    if (reclaim !== null) return;
    reclaim = setInterval(() => {
      /* ══ THE TICK SAYS SO, WHATEVER IT GOES ON TO DO — and this is the whole of the re-derive ══
       *
       * `moved()` was called only where this machine had CHANGED something: a re-claim that landed,
       * a notification torn down, an app-state edge. Nothing said so when the ENGINE moved on its
       * own, and a stand-down is exactly that — measured, a laptop took the mailbox, this install's
       * engine stood down 7.8 s later, and the open panel read `Organizing` with `Stop organizing
       * here` for 6 min 26 s, correcting only when somebody left Settings and came back. The claim
       * direction re-derived in 22.9 s for one reason: the re-claim ran through this machine and
       * this machine called `moved()`.
       *
       * So the TICK says it, both directions, and the reader decides whether anything changed —
       * `pokeOrganizerState` compares the panel's whole input and notifies only on a difference, so
       * an unchanged mailbox costs one comparison and no render. Bound: the panel reflects the
       * engine's own answer within one tick of {@link beatEveryMs} (10 s beside a foreground
       * service on the device measured, {@link CLAIM_WATCH_MS} without one).
       *
       * OUTSIDE the queue, for {@link armWatch}'s reason: a slow IMAP read behind the serial gate
       * must not hold the screen's cue behind it. */
      moved();
      /* THROUGH THE SAME QUEUE as every other act on this mailbox, so a re-claim can never overlap
         a hand-back, a resume or a stop — the {@link serial} header's whole argument. */
      void serial(() => reclaimCheck());
    }, beatEveryMs());
    /* UNREF WHERE THE RUNTIME HAS ONE. React Native's timers do not, and there it changes nothing:
       the app's process is alive for as long as this session is. Under node it is what keeps a
       session nobody disposed from holding the event loop open after its case has ended. */
    (reclaim as unknown as { unref?: () => void }).unref?.();
  };

  const disarmReclaim = (): void => {
    if (reclaim !== null) {
      clearInterval(reclaim);
      reclaim = null;
    }
  };

  /**
   * Arm the claim watch — once, and the caller is what decides it is wanted. The
   * `deps.service.running()` re-check that stood here is gone: both call sites have already
   * established the notification is showing, so that clause's contrary state was unreachable —
   * it could not be watched fail, which is why it is removed rather than tested around.
   * `watch !== null` is NOT such a clause: a background followed by a foreground reaches this
   * twice for one service, and a second interval would ask the engine twice a minute for ever
   * and outlive the first `clearInterval`.
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
    void serial(() => stopByPerson());
  }) ?? ((): void => undefined);

  /**
   * ══ IS THE ORGANIZER RUNNING — the ONE predicate the claim follows ══════════════════════════
   *
   * The claim stands exactly while the thing that renews it can run. On Android that is the
   * notification's own lifecycle, read from the platform at the moment of asking; with no service
   * — iOS, and a build without the module — nothing runs once the app leaves, so the mailbox goes
   * back. NEVER THE PLATFORM NAME: `deps.platform` decides nothing, it only picks which code
   * names the same absence ({@link absentReason}). Asked, never remembered — the system can take
   * the service at any moment, and a cached `true` is the false state this exists to prevent.
   */
  const organizerRuns = (): boolean => {
    if (deps.service === null) return false;
    try {
      return deps.service.running();
    } catch (err) {
      /* A platform that cannot say is not evidence that it is organizing — the same direction as
         every other unreadable state here. */
      log("organizer_service_state_unreadable", { err });
      return false;
    }
  };

  /** Which absence it is, for the LOG's sake only — see {@link organizerRuns}. */
  const absentReason = (): BackgroundReason =>
    deps.platform === "ios" ? "left_the_foreground" : "no_background_service";

  /**
   * Android's way out. Every arm that declines to organize in the background lands here.
   *
   * THE LINE COMES FIRST, before the hand-back's IMAP round trip: a line written after the
   * release says nothing about a release that hangs. THE REASON DECIDES WHICH SENTENCE — the
   * caller carries no flag, which was `true` on both declines and collapsed them onto the
   * battery-saver sentence. The announcement and the line's `restricted` field are derived from
   * the reason rather than passed beside it and able to disagree.
   */
  const declineBackground = async (why: BackgroundReason): Promise<void> => {
    log("organizer_background_declined", { why, restricted: systemDeclined(why) });
    if (why === "system_restricted" && !announcedRestricted) {
      announcedRestricted = true;
      deps.announceRestricted();
    } else if (why === "notification_not_showing" && !announcedNotificationsOff) {
      announcedNotificationsOff = true;
      deps.announceNotificationsOff();
    }
    await stopBackground(why);
  };

  const toBackground = async (): Promise<void> => {
    if (deps.service === null) {
      /* NOTHING CAN RUN ONCE THE APP LEAVES, so the mailbox goes back and somebody's desktop can
         have it while this phone is asleep. On iOS that is the platform and not a gap; the code
         says which absence it is and decides nothing — see {@link organizerRuns}. `restricted:
         false` is load-bearing: nothing on this phone said no, so announcing battery saver here
         would be a false sentence. Not through {@link declineBackground} — no service to drop. */
      const why = absentReason();
      log("organizer_background_declined", { why, restricted: false });
      await handBack(why);
      return;
    }
    /* ══ IS THE CLAIM OURS — the second predicate, and it is about OWNERSHIP ═════════════════
     *
     * A reader does not post "Organizing": a notification naming this phone as the organizer
     * would state something false until the claim watch ran. But "does this install organize
     * anything" was the wrong question — the claim reaches `ohmail/_meta` a round trip BEFORE the
     * runtime reports itself organizing, and inside that window a phone just GIVEN the mailbox
     * read as a reader. So the fact is `claimed`. `!== false` and not `=== true`: an engine that
     * cannot say is not evidence the mailbox is not ours. */
    /* ONE READ for the whole transition — see {@link stateNow}: the decision, the code it logs
       and the word the hold carries all name the same instant. */
    const state = stateNow();
    if (state?.claimed === false) {
      log("organizer_background_declined_reader", { why: nothingOfOurs(state) });
      /* NO HAND-BACK, in both states. Either another install holds the mailbox or nobody ever
         asked this phone for it, and asking the server to expunge records by our own id is a
         write about a mailbox this install has just been told is not its own. */
      disarmWatch();
      moved();
      return;
    }
    /* ALREADY UP? Then the restriction is not this transition's question. It is asked BEFORE a
       start, because a service the system may kill at any moment should not be started — but a
       service that is STANDING is organizing whatever the battery-saver flag says, and tearing
       down a live organizer because somebody turned battery saver on between two backgrounds was
       the mailbox locked for the staleness window with nothing running. If the system does take
       it, the beat and the watchdog say so within two intervals and the claim goes back then. */
    const alreadyUp = organizerRuns();
    if (!alreadyUp && deps.service.restricted()) {
      await declineBackground("system_restricted");
      return;
    }
    try {
      /* RE-READ PER START — a language change between backgrounds re-posts the notice. On a
         service that is already standing this refreshes the words and nothing else; what it
         ANSWERS is not read, because the next line asks the service itself. */
      await deps.service.start(deps.notice());
    } catch (err) {
      log("organizer_service_start_failed", { err });
    }
    if (!organizerRuns()) {
      /* THE SENTENCE THE DOOR MADE — "it organizes while its notification is shown". A service
         whose notification is not showing (a denied permission, a refused background start) may
         not go on organizing, so this hands the mailbox back like every other decline. It counts
         as restricted for the announcement: from the person's side it is the same fact. */
      await declineBackground("notification_not_showing");
      return;
    }
    /* THE CLAIM STANDS, and this line is the only place that says so. A device run reads the
       background machine's decision off the log and nowhere else; without it the difference
       between "kept the mailbox" and "did nothing" is invisible until the mail server is asked. */
    log("organizer_background_holds", { why: "organizer_still_running", state: organizingWord(state) });
    armWatch();
  };

  const toForeground = async (): Promise<void> => {
    if (organizerRuns()) {
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
      /* AND A START THAT WORKED CLEARS THE SENTENCE the last one left, so a refusal cannot outlive
         the thing it was about — `announceRestricted`'s rule, one fact over. */
      deps.sayStartFailed(null);
    } catch (err) {
      /* The claim was NOT taken back. `handedBack` returns to true so nothing renders
         "Organizing" over a mailbox this install does not hold — the resume is retried by the
         engine's own poll and by the next time the app is opened. AND IT IS SAID: the engine has
         already spent its own attempts by the time this rejects, so this is the final answer and
         a silent one leaves a person looking at a mailbox that never changes. */
      handedBack = true;
      log("organizer_resume_failed", { err });
      deps.sayStartFailed(err);
    }
    /* THE GATE HAS SPOKEN, whichever way. A resume that stands this install down against a holder
       is the case the panel used to miss: it is the moment a screen already open must stop saying
       "Organizing". A resume that claims nothing because the person stopped is the other. */
    moved();
  };

  /**
   * THE CLAIM CAN BE LOST WITHOUT THIS APP DOING ANYTHING — somebody presses "Organize here" on
   * their desktop and the phone's next gated cycle stands it down. The notification then says
   * "Organizing <address>" over an install that organizes nothing, which is a false state on a
   * surface a person cannot argue with. So the service goes when the claim does.
   */
  /**
   * WHAT THE ENGINE SAYS ABOUT THIS INSTALL'S MAILBOXES — one read, three answers, or `null`.
   *
   * ONE read per act, and that is not thrift: the claim can move between two reads, so a decision
   * taken on one and a line written from another contradict each other about the same instant.
   * `null` is the third answer every caller treats apart from a negative one — an engine that
   * cannot answer is not evidence the mailbox is not ours, and a decline or a teardown over a
   * momentary failure is a decision taken on nothing.
   */
  const stateNow = (): { claimed: boolean; standDown: boolean; organizing: boolean } | null => {
    try {
      const states = deps.engine.organizing();
      return {
        /* THE FACT THE DECISIONS TURN ON. Not the negation of the others and not a slower copy of
           `organizing`: the engine calls the mailbox ours from the moment its gate is entitled to
           the lease, which is before the claim is in the folder and a round trip before the pass
           reports itself organizing — see {@link BackgroundEngine.organizing}. */
        claimed: states.some((m) => m.claimed),
        /* A SEPARATE QUESTION, because both of the others are false before anybody has consented
           and only a stand-down is a state the claim watch may come back from. */
        standDown: states.some((m) => m.standDown),
        /* READ FOR THE LOG'S WORD AND NOTHING ELSE — see {@link organizingWord}. */
        organizing: states.some((m) => m.organizing),
      };
    } catch (err) {
      log("organizer_state_unreadable", { err });
      return null;
    }
  };

  /**
   * WHICH of the two ways a mailbox is not ours, for the LOG's sake only.
   *
   * Decides nothing — {@link absentReason}'s shape, for its reason: "another machine took it" and
   * "there was never a claim here" want different remedies from a person reading a device log,
   * and neither is a different act.
   */
  const nothingOfOurs = (state: { standDown: boolean }): BackgroundReason =>
    state.standDown ? "claim_lost" : "no_claim_here";

  /**
   * THE RUNTIME'S OWN WORD for a claim this phone holds, for the hold line — the only thing
   * `organizing` decides. A claim taken a moment ago reads `starting` until the gate's permit
   * lands, so a device log shows the hold AND the state it was held in; the sentence a person
   * sees is the engine's rather than the copy's.
   */
  const organizingWord = (state: { organizing: boolean } | null): string =>
    state === null ? "unknown" : state.organizing ? "organizing" : "starting";

    /**
     * ══ A REFUSAL COSTS TICKS, AND IT IS ONE LINE PER CLASS ════════════════════════════════════
     *
     * Measured on a device: twenty-nine re-claims over 4 min 24 s, every one refused for the same
     * permanent reason, every one a log line and a re-render. A watch that answers a standing
     * refusal by asking again immediately is the shape, not that one cause.
     *
     * So a refusal doubles the ticks skipped before the next press, to a ceiling; any other answer
     * clears it, `held` included. The line is written only where the VERDICT CHANGES CLASS.
     */
  const RECLAIM_BACKOFF_MAX_TICKS = 8;
  /** Ticks still to skip before the next press. */
  let reclaimSkip = 0;
  /** Consecutive refusals, which is what the doubling is measured on. */
  let reclaimRefusals = 0;
  /** The last verdict this watch reached, so a repeat writes no second line. */
  let reclaimVerdict: "claimed" | "held" | "refused" | null = null;

  const reclaimSettled = (outcome: "claimed" | "held" | "refused"): void => {
    if (outcome === "refused") {
      reclaimRefusals += 1;
      reclaimSkip = Math.min(2 ** (reclaimRefusals - 1), RECLAIM_BACKOFF_MAX_TICKS);
    } else {
      reclaimRefusals = 0;
      reclaimSkip = 0;
    }
    const repeated = outcome === "refused" && reclaimVerdict === "refused";
    reclaimVerdict = outcome;
    /* HELD IS NOT A FAILURE and is not logged: it is the state of every stood-down phone whose
       mailbox is still being organized, for as long as that lasts.
       A `claimed` ALWAYS writes its line — it is a becoming, and two of them in one session are
       two events. Only the standing refusal is collapsed, because it is one state. */
    if (outcome === "held" || repeated) return;
    log("organizer_reclaim", { why: "holder_left", verdict: outcome });
    moved();
  };

  /**
   * The holder left, and this phone is the one in front of the person — a stand-down is a one-way
   * door without this. Measured on a device: the laptop handed the mailbox back, the claim was
   * gone, and minutes later the phone had not re-claimed while its panel still named the machine
   * that left. A phone organizes WHILE OPEN, so a stood-down session keeps asking on the claim
   * watch's cadence and takes the mailbox back when nothing holds it — it cannot displace anybody,
   * since {@link BackgroundEngine.claimHere} is refused while a foreign claim is renewed (where the
   * one-organizer invariant is enforced). Bounded three ways — only while the session is live, only
   * where the engine says this install is STOOD DOWN, and on the claim watch's clock.
   */
  const reclaimCheck = async (): Promise<void> => {
    if (disposed) return;
    /* ══ AND THE PANEL RE-DERIVES ON EVERY TICK, NOT ONLY WHERE SOMETHING WAS RECLAIMED ═══════
     *
     * Measured on a device: the engine stood the phone down under an open Settings panel and it
     * read `Organizing` for 2 min 2 s over a mailbox another phone held. Every other arm already
     * told the screen; the STAND-DOWN direction told it nothing. `moved()` costs a fingerprint
     * comparison, which is why it is unconditional and why the cue lives on this timer rather
     * than on the claim watch — that one is armed with the NOTIFICATION, and a phone is in front
     * of a person exactly when no notification is showing. */
    moved();
    /* `=== true` and not `!== false`: a read that could not answer is not a licence to ask for
       somebody else's mailbox, which is the opposite direction from the notification teardown's. */
    /* ONE READ for the whole tick — see {@link stateNow}. */
    if (stateNow()?.standDown !== true) return;
    if (reclaimSkip > 0) {
      reclaimSkip -= 1;
      return;
    }
    let outcome: "claimed" | "held" | "unreadable" | "refused";
    try {
      outcome = await deps.engine.claimHere();
    } catch (err) {
      log("organizer_reclaim_failed", { err, why: "holder_left" });
      /* A THROW IS A REFUSAL FOR THE BACKOFF'S PURPOSE. It has its own line — the one above, which
         carries the error — so it is settled without a second one. */
      reclaimRefusals += 1;
      reclaimSkip = Math.min(2 ** (reclaimRefusals - 1), RECLAIM_BACKOFF_MAX_TICKS);
      reclaimVerdict = "refused";
      return;
    }
    /* `unreadable` MOVES NOTHING. The door refused a press it could not check, so the claim
       stands exactly where it stood, and telling the screen something changed would redraw a
       panel whose facts are unchanged. It IS logged — unlike `held`, this one is a look that did
       not land, and the watch asks again rather than backing off. */
    if (outcome === "unreadable") {
      log("organizer_reclaim_unreadable", { why: "holder_left" });
      return;
    }
    reclaimSettled(outcome);
  };

  const claimLostCheck = async (): Promise<void> => {
    if (!organizerRuns()) return;
    /* THE SAME OWNERSHIP FACT the background arm reads, and for its reason. "Organizes nothing"
       takes the notification down over an unreadable lease — an outage, where the claim is still
       ours and the next poll asks again — and over the window between a fresh claim and the
       gate's permit. THREE ANSWERS: `null` — the engine could not say — leaves the notification
       standing and asks again next tick, because a teardown over a momentary failure would end a
       person's organizing and leave the claim to lapse from a mailbox nobody gave up. */
    if (stateNow()?.claimed !== false) return;
    log("organizer_service_stopped_claim_lost", { why: "claim_lost" });
    moved();
    /* NO HAND-BACK HERE. The claim is not ours to give back: either another install holds it, or
       the lease could not be read, and asking the server to expunge records by our own id in
       either state is a write about a mailbox this install has just been told it does not hold.
       The engine's own gate already released or never had it. */
    await dropService("claim_lost");
  };

  /* ARMED AT CONSTRUCTION, which is where the session begins. A phone can be STOOD DOWN from its
     mailbox at the first gated cycle — before any app-state edge has happened — so waiting for a
     transition to arm this would leave the ordinary contention case unwatched for a whole
     foreground. */
  armReclaim();

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
    backgrounded: () => organizerRuns(),
    dispose() {
      disposed = true;
      disarmWatch();
      disarmReclaim();
      unsubscribe();
    },
  };
}
