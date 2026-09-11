/**
 * The one live organizer session — what holds `background.ts` to the app's own lifecycle.
 * `createBackgroundOrganizing` decides what happens to the mailbox at every app-state edge;
 * this module is its subscription, at module scope because the screen that opens the door is
 * replaced the instant the engine is up. One, and the first wins: exactly one active organizer
 * per mailbox, so a second start answers `false` rather than replacing the live one. The stop
 * is a person's act: `dispose()` leaves the service up (teardown must not stop somebody's
 * organizing); {@link stopOrganizerSession} runs from "Stop organizing here", where the claim
 * is already released — a standing notification would say "Organizing" over a reader.
 */
import type { Refusal } from "../refusal";
import type { ClaimHereOutcome, StandaloneEngine } from "./standalone-door";
import {
  createBackgroundOrganizing,
  type AppPhase,
  type BackgroundEngine,
  type BackgroundOrganizing,
  type BackgroundService,
  type OrganizerPlatform,
  type ServiceNotice,
} from "./background";

/** What the platform half supplies. Every field is a seam the node suite drives directly. */
export interface OrganizerSessionDeps {
  readonly platform: OrganizerPlatform;
  readonly engine: BackgroundEngine;
  /** `null` on iOS and in a build with no service — see `BackgroundService`. */
  readonly service: BackgroundService | null;
  readonly notice: () => ServiceNotice;
  /**
   * SUBSCRIBE TO THE APP'S OWN LIFECYCLE, and hand back the unsubscribe.
   *
   * React Native's `AppState` in the app; a driver in the suite. The raw status string is passed
   * through rather than pre-classified, because {@link appPhaseOf} is the mapping and a mapping
   * done in the untestable half is a mapping nothing measures.
   */
  readonly appPhases: (listener: (status: string) => void) => () => void;
  /** Diagnostics. NEVER the address — the notification's body is not logged. */
  readonly log?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * REACT NATIVE'S `AppStateStatus` NARROWED TO THE THREE EDGES THAT DECIDE.
 *
 * `AppPhase` has an `inactive` that `background.ts` deliberately ignores, so every status that is
 * not one of the two acts maps onto it: `unknown` and `extension` are states in which nothing has
 * happened to the mailbox, and reading either as a background would hand it back for a transition
 * nobody made.
 */
export function appPhaseOf(status: string): AppPhase {
  if (status === "active") return "active";
  if (status === "background") return "background";
  return "inactive";
}

/**
 * The door this process holds — one, and the first wins. The connection layer builds its
 * session over this door (`net/pairing.ts`'s standalone arm), so something has to hold it
 * between the moment it opens and the moment a screen asks. Here, beside the session, because
 * the invariant is the same one: exactly one engine in this process, first-start-wins.
 * Separate from `live` on purpose: "Stop organizing here" ends the session and leaves the
 * engine serving cached mail as a reader, so it must not release the door — only
 * {@link endStandaloneHere}, the forget, does.
 */
let door: StandaloneEngine | null = null;

/**
 * Record the door this app just opened. Answers whether THIS call is the held one, so a caller that
 * cares can say so; a second, different door changes nothing.
 */
export function holdStandaloneDoor(opened: StandaloneEngine): boolean {
  if (door === null) {
    door = opened;
    /* THE PANEL HAS A DOOR TO READ NOW. A screen mounted before the engine came up would
       otherwise keep rendering nothing until something else re-rendered it. */
    notifyOrganizerState();
  }
  return door === opened;
}

/** The door, or `null` — "no engine is running in this process", which is not an error. */
export const organizerDoor = (): StandaloneEngine | null => door;

/**
 * ══ WHO IS WATCHING THIS MODULE'S STATE — the Settings panel, and nothing else yet ══════════
 *
 * The panel read {@link standaloneHere} at RENDER and nothing re-rendered it, so it was correct
 * only at mount: measured on a device showing `Stopping` for two and a half minutes over a
 * finished stop, and `Organizing` for two minutes over a mailbox another machine held. Both
 * settled the instant the screen was left and re-entered, which is the whole diagnosis.
 *
 * A version counter and `useSyncExternalStore` rather than a copy of the state: the state lives in
 * the engine's `runtimes()` and in this module's own `let`s, and a second copy kept in sync is two
 * answers to "does this phone organize this mailbox". So a notify means "ask again", and the panel
 * asks the same function it always did.
 *
 * Every writer below notifies, and so does the session's own claim watch — which is what carries
 * an engine-side change (a stand-down mid-poll, a holder going away) onto the screen without the
 * panel polling for it.
 */
const watchers = new Set<() => void>();
let stateVersion = 0;

/** Subscribe. Returns the unsubscribe. `useSyncExternalStore`'s first argument. */
export function onOrganizerState(listener: () => void): () => void {
  watchers.add(listener);
  return () => { watchers.delete(listener); };
}

/** The version a subscriber compares. Changes whenever something about the door may have moved. */
export const organizerStateVersion = (): number => stateVersion;

/**
 * SAY THAT SOMETHING MOVED. Never throws — a listener that throws must not take a hand-back with
 * it, and every caller here is on a path that is finishing an act on somebody's mailbox.
 */
export function notifyOrganizerState(): void {
  stateVersion += 1;
  for (const listener of [...watchers]) {
    try {
      listener();
    } catch {
      /* A subscriber's failure is its own. See above. */
    }
  }
}

/**
 * ══ A PERSON ASKED, IN THIS RUN OF THE APP — the one thing that licenses a consent press ═══════
 *
 * The consent press used to run from `runConnect`, which is every launch, every profile switch and
 * every door press. On a phone beside a laptop holding the mailbox that made a plain relaunch a
 * takeover: the engine stood down correctly and the app authorized a fresh claim 2.3 s later.
 *
 * So the press needs a licence, and the licence is a finger: the door screen's Connect, and the
 * panel's start verb. It is deliberately MODULE state and not persisted — "in this run of the app"
 * is exactly the bound, and a persisted one would license the next launch too, which is the defect.
 *
 * It is TAKEN rather than read: one arm, one press. Without that, a switch away and back inside one
 * run would spend the same finger twice.
 */
let consentArmed = false;

/** A person asked this phone to organize the mailbox it is about to open. */
export function armConsentPress(): void {
  consentArmed = true;
}

/** Spend the arm, if there is one. `false` means nobody asked and nothing may be written. */
export function takeConsentPress(): boolean {
  const armed = consentArmed;
  consentArmed = false;
  return armed;
}

/**
 * ASK FOR THIS PHONE, ON THE DOOR IN THIS PROCESS — the panel's start verb and the claim watch.
 *
 * The engine's own verb, because the app may not compose a request here (the privacy census admits
 * a transport in six named files and this is not one) and because the engine is the only thing that
 * knows which mailbox this door serves. `refused` where no door is held: a start over no engine is
 * not something to report as done.
 */
export async function claimHereStandalone(): Promise<ClaimHereOutcome> {
  const held = door;
  if (held === null) return "refused";
  const outcome = await held.claimHere().catch((): ClaimHereOutcome => "refused");
  notifyOrganizerState();
  return outcome;
}

/**
 * WHO HOLDS A MAILBOX THIS PHONE HAS STOOD DOWN FROM — the two facts the claim carries, together.
 *
 * One member and not two loose ones: `name` without a reason is not a holder, and a reason without
 * a name is a holder this build cannot name. Pairing them makes the state "named a holder, but
 * nobody holds it" unrepresentable.
 *
 * `standDownReason` is the engine's own word, verbatim (`organized_elsewhere:<kind>`) — this app
 * re-spells no engine value, and `holderKind` in `ui/standalone-form.ts` is the one reader of it.
 */
export interface StandDownHolder {
  /** The holder's display name, or `""` where the claim named none. NEVER an address. */
  readonly name: string;
  /** The engine's stand-down reason, unmodified. Non-null by construction: see the field above. */
  readonly standDownReason: string;
}

/**
 * What the door in this process says about the mailbox it serves — the address, and whether
 * this install organizes it; `null` when no door is held. The engine's own word, with no
 * request: deriving this from a loopback `GET /mailboxes` folded three outcomes (never asked,
 * refused, answered empty) into one `known: false`, so a phone with an engine running behind
 * it showed no panel at all. `organizing: null` is "the engine has not said yet" and is its
 * own state: the map is empty until the first gated cycle, and reading that as "nothing
 * organizes this mailbox" would put a false sentence on screen a second after the door opened.
 */
export function standaloneHere():
  { id: string | null; address: string; organizing: boolean | null; heldBy: StandDownHolder | null }
  | null {
  const held = door;
  if (held === null) return null;
  let organizing: boolean | null = null;
  let id: string | null = null;
  /**
   * WHO HOLDS THE MAILBOX WHEN THIS INSTALL DOES NOT — the engine's own peek at the claim.
   *
   * `null` is "nobody, or not read yet". Without it the panel could only say `Nothing organizes
   * this mailbox`, which is also what it says when the mailbox is free — so a phone standing down
   * correctly told a person nothing was organizing their mail.
   */
  let heldBy: StandDownHolder | null = null;
  try {
    const entries = Object.entries(held.runtimes().organizer);
    /* ONE MAILBOX ON THIS PHONE is the fourth door's own ruled line and the door carries one
       address, so this asks "does this install organize the mailbox it opened" and any entry
       saying so is that. */
    if (entries.length > 0) {
      organizing = entries.some(([, state]) => state.organizing);
      /**
       * THE REASON IS THE DISCRIMINATOR AND THE NAME IS NOT. A name is absent in two different
       * states — a claim that named nothing, and EVERY RELAUNCH, where the engine reassembles the
       * stand-down off its own row and the row remembers no holder — so reading the name called
       * both of those a free mailbox (the desktop's `reader-holder.ts` defect, here). `reason` is
       * written at the stand-down and nowhere else, so a non-null reason IS "somebody else has it".
       *
       * Only where this install is NOT organizing: over our own claim the engine reports US, and
       * rendering that as "another machine has it" is the false state in the other direction.
       */
      if (!organizing) {
        const stood = entries.map(([, state]) => state).find((state) => state.reason !== null);
        heldBy = stood === undefined
          ? null
          : { name: stood.heldBy ?? "", standDownReason: stood.reason! };
      }
    }
    /**
     * AND THE MAILBOX ID, WHICH IS THE MAP'S OWN KEY — the only id the app can have on this door
     * without asking for it, and the consent press needs one. `null` where the engine reports a
     * number of mailboxes this reader cannot name truthfully: one entry is the ruled shape, and
     * picking the first of several would consent for whichever came back first.
     */
    if (entries.length === 1) id = entries[0]![0];
  } catch {
    /* An unreadable runtime is "has not said", never "does not organize" — the background half
       takes the same reading, and for the same reason: a momentary failure must not end
       somebody's organizing on screen. */
  }
  return { id, address: held.address, organizing, heldBy };
}

/**
 * What the consent press answered, where a person asks the question. `restrictedSaid`'s idiom
 * one fact over; the first surface chosen for this was wrong — a consent refusal written into
 * `syncError` rendered inside "Sync failed — the mirror keeps what it has", so a mailbox
 * whose sync had not failed announced a sync failure. A sentence in the wrong frame is a
 * false sentence. It lives here and renders in the panel that names this phone, under the
 * line describing what this phone does — where somebody asking "is my mail being filed?" is
 * looking. Cleared by a later success, so a refusal cannot outlive the thing it was about.
 */
let organizeRefused: Refusal | null = null;

/** Record what the consent press answered. `null` clears it — a later press succeeded. */
export function sayOrganizeRefused(reason: Refusal | null): void {
  organizeRefused = reason;
  notifyOrganizerState();
}

/** The standing consent refusal, or `null`. Read by Settings' "This phone" panel. */
export const organizeRefusal = (): Refusal | null => organizeRefused;

/**
 * ══ THE PERSON'S HAND-BACK FROM SETTINGS, on this door — and it is REMEMBERED ═══════════════
 *
 * This was `held.handBack()`, the engine's claim removal, on the argument that a paired session
 * releases through a route needing a mailbox id and the door had none. The door has one now — it
 * is the key of the engine's own runtime map, which the consent press already reads — and the
 * argument had a hole the device measured: `handBack` deliberately leaves the ROW saying organizer
 * so that the next resume takes the mailbox back with no press, which is right for an app leaving
 * the foreground and exactly wrong for a person pressing stop. Swipe the notification away the way
 * the app tells you to, reopen it, and the foreground path's resume wrote a fresh claim into
 * `ohmail/_meta` that nothing serviced — no notification, no service, a message unfiled for 70 s,
 * and Settings saying `Organizing` throughout.
 *
 * So the person's stop goes through the RELEASE the row records, which is the same ceremony the
 * desktop's own "Stop organizing here" has always used: `release_requested_at`, honoured by the
 * gate before it reads the lease, writing the reader role and `organizer_released_at`. A reader
 * with no press never re-enters the gate — on this launch or any later one — so the stop survives
 * a kill, and the mailbox keeps its login, its poll timer and its mirror, which is what
 * `settingsStopHereWhat` promises and what a bare `handBack` did not deliver either.
 *
 * Never throws. A release that could not be recorded leaves the claim to lapse, and a notification
 * that must come down is the caller's next line.
 */
export async function stopOrganizingStandalone(): Promise<boolean> {
  const held = door;
  if (held === null) return false;
  const stopped = await held.stopOrganizing().catch(() => false);
  notifyOrganizerState();
  return stopped;
}

/** The live session, or `null`. Module scope for the reason in the header. */
let live: {
  readonly organizing: BackgroundOrganizing;
  readonly service: BackgroundService | null;
  readonly unsubscribe: () => void;
} | null = null;

/**
 * HAS THIS APP BEEN TOLD THE SYSTEM WILL NOT LET IT ORGANIZE IN THE BACKGROUND — once, and for
 * this launch.
 *
 * `background.ts` calls `announceRestricted` at most once per session and states that the app
 * "renders it the next time it is open; this machine does not decide where". This is that record,
 * and Settings reads it. It outlives the session on purpose: the fact is about the phone's
 * settings, not about one engine, and a person who has battery saver on still has it on after a
 * stop.
 */
let restrictedSaid = false;

/**
 * Start it. Answers whether THIS call is the live session, so a caller that cares can say so.
 *
 * The `AppState` subscription is taken before anything else, because the first transition can
 * arrive while this function is still on the stack — a person who opens the door and immediately
 * switches away produces `background` with no session to receive it.
 */
export function startOrganizerSession(deps: OrganizerSessionDeps): boolean {
  if (live !== null) return false;
  const organizing = createBackgroundOrganizing({
    platform: deps.platform,
    engine: deps.engine,
    service: deps.service,
    notice: deps.notice,
    announceRestricted: () => { restrictedSaid = true; notifyOrganizerState(); },
    /* THE SESSION'S CUE TO THE SCREEN. `pokeOrganizerState` and not `notifyOrganizerState`: the
       claim watch fires on a timer whether anything moved or not, and an unconditional bump would
       re-render an open Settings panel once a minute for ever. */
    stateChanged: pokeOrganizerState,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  });
  const unsubscribe = deps.appPhases((status) => {
    void organizing.phaseChanged(appPhaseOf(status));
  });
  live = { organizing, service: deps.service, unsubscribe };
  notifyOrganizerState();
  return true;
}

/**
 * THE PERSON'S STOP — drop the subscription, then the notification. Idempotent; never throws.
 *
 * The order is the header's: the release route has already taken the claim back, so what is left
 * is a notification that must not outlive it, and a subscription that must not act on a transition
 * after the session it belonged to is over.
 */
export async function stopOrganizerSession(): Promise<void> {
  const held = live;
  if (held === null) return;
  live = null;
  held.unsubscribe();
  held.organizing.dispose();
  notifyOrganizerState();
  if (held.service === null) return;
  try {
    await held.service.stop();
  } catch {
    /* The service's own stop is idempotent and its watchdog takes the notification down anyway.
       A throw here would be this module's only failure path and it has nothing to add to it. */
  }
}

/** Is there a session at all? Read by Settings, which says nothing about organizing without one. */
export const organizerSessionLive = (): boolean => live !== null;

/** Whether the background service is up right now — the Settings row that says so. */
export const organizerBackgrounded = (): boolean => live?.organizing.backgrounded() ?? false;

/** The iOS transitional state: handed back and not yet taken again. */
export const organizerHandedBack = (): boolean => live?.organizing.handedBack() ?? false;

/** See {@link restrictedSaid}. The sentence itself is `Copy.organizerRestricted`. */
export const organizerRestrictedSaid = (): boolean => restrictedSaid;

/**
 * RECORD THE SAME FACT FROM OUTSIDE THE STATE MACHINE — the one caller is the door, when the
 * platform half cannot be reached at all.
 *
 * A failed load of `organizer-session-native.ts` leaves an app with an open mailbox and no
 * background arm anywhere: on Android it organizes while it is open and posts no notification,
 * which is exactly the state `Copy.organizerRestricted` describes. Swallowing it would be the
 * reliability-feature-that-renders-as-healthy shape — the mailbox looks organized and is not, with
 * nothing anywhere saying so.
 */
export function sayOrganizerRestricted(): void {
  restrictedSaid = true;
  notifyOrganizerState();
}

/**
 * End it here — the forget's verb, and the only one that stops the engine. Three effects in
 * one call, because any two without the third is a state nothing describes: the claim goes
 * back (the engine's own `handBack`, so another machine can take the mailbox immediately);
 * the session stops, taking the notification down; the engine stops, because the profile row
 * that named it is about to go. In that order — the hand-back needs a running engine, and a
 * notification over a stopped one would say this phone organizes mail it no longer holds.
 * Never throws: the row removal must not be blocked by an unreachable mailbox; a claim that
 * did not go back is the recoverable half — it ages out.
 */
export async function endStandaloneHere(): Promise<void> {
  const held = door;
  door = null;
  notifyOrganizerState();
  if (held !== null) await held.handBack().catch(() => undefined);
  await stopOrganizerSession();
  if (held !== null) await held.stop().catch(() => undefined);
}

/**
 * ══ ASK AGAIN ONLY IF SOMETHING MOVED — the claim watch's cue, and the reason it is gated ══════
 *
 * The session's watch fires on a timer whether the mailbox changed or not, and that is what makes
 * an engine-side change (a stand-down mid-poll, a holder going away) reach a screen that is
 * already open. An unconditional bump would also re-render the panel once a minute for ever, so
 * this compares the panel's WHOLE input — the door's own answer plus the three module facts the
 * panel renders beside it — and notifies only on a difference.
 *
 * The comparison lives here because this module owns every one of those facts. A comparison in
 * `background.ts` would need a copy of the door's answer, which is the second source of truth this
 * whole lane is about.
 */
let lastSeen = "";

export function pokeOrganizerState(): void {
  const here = standaloneHere();
  const now = JSON.stringify([
    here === null
      ? null
      : [here.id, here.address, here.organizing, here.heldBy?.name ?? null,
        here.heldBy?.standDownReason ?? null],
    live !== null,
    live?.organizing.backgrounded() ?? false,
    restrictedSaid,
    organizeRefused?.say ?? null,
  ]);
  if (now === lastSeen) return;
  lastSeen = now;
  notifyOrganizerState();
}

/** Test seam: forget everything. Never called by the app. */
export function forgetOrganizerSessionForTests(): void {
  live = null;
  door = null;
  restrictedSaid = false;
  organizeRefused = null;
  consentArmed = false;
  lastSeen = "";
  watchers.clear();
}
