/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ONE LIVE ORGANIZER SESSION — what holds `background.ts` to the app's own lifecycle
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `createBackgroundOrganizing` decides what happens to the mailbox at every app-state edge, and it
 * landed with no call site: the fourth door started an engine and nothing subscribed to `AppState`,
 * so every arm in that file was unreachable. This module is the subscription, and it is MODULE
 * SCOPE rather than a hook because the screen that opens the door (`app/standalone.tsx`) is
 * replaced the instant the engine is up — a session owned by that component would be disposed by
 * the navigation that follows its own success.
 *
 * ── ONE, AND THE FIRST WINS ───────────────────────────────────────────────────────────────
 *
 * Exactly one active organizer per mailbox is the product's invariant, and two sessions would be
 * two answers to "what happens when this app is backgrounded" — two `AppState` listeners, two
 * hand-backs racing one release. So a second start does not replace the live one; it answers
 * `false` and leaves it alone, which is `registerPhoneEngine`'s rule for the same reason.
 *
 * ── THE STOP IS A PERSON'S ACT AND TAKES THE NOTIFICATION WITH IT ─────────────────────────
 *
 * `BackgroundOrganizing.dispose()` deliberately leaves the service up — it is disposed on teardown,
 * where stopping somebody's organizing would be this app's decision rather than theirs.
 * {@link stopOrganizerSession} is the other case: it runs from "Stop organizing here", where the
 * release route has ALREADY removed the claim and recorded this install as a reader, so a
 * notification left standing would say "Organizing" over an install that reads. The claim is not
 * handed back here for that same reason — it is already gone, and asking the server to expunge
 * records by our own id afterwards is a write about a mailbox this install no longer holds.
 */
import type { StandaloneEngine } from "./standalone-door";
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
 * ══ THE DOOR THIS PROCESS HOLDS — one, and the first wins ══════════════════════════════════
 *
 * The connection layer builds its session over this door (`net/pairing.ts`'s standalone arm), so
 * something has to hold it between the moment it opens and the moment a screen asks for it. Here,
 * beside the session, because the invariant is the same one and the module already enforces it:
 * exactly one engine in this process, first-start-wins.
 *
 * It is SEPARATE from `live` on purpose. Two acts that look alike are not: "Stop organizing here"
 * ends the session and leaves the engine serving this phone's cached mail as a reader, so it must
 * not release the door. Only {@link endStandaloneHere} — the forget — does.
 */
let door: StandaloneEngine | null = null;

/**
 * Record the door this app just opened. Answers whether THIS call is the held one, so a caller that
 * cares can say so; a second, different door changes nothing.
 */
export function holdStandaloneDoor(opened: StandaloneEngine): boolean {
  if (door === null) door = opened;
  return door === opened;
}

/** The door, or `null` — "no engine is running in this process", which is not an error. */
export const organizerDoor = (): StandaloneEngine | null => door;

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
    announceRestricted: () => { restrictedSaid = true; },
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  });
  const unsubscribe = deps.appPhases((status) => {
    void organizing.phaseChanged(appPhaseOf(status));
  });
  live = { organizing, service: deps.service, unsubscribe };
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
}

/**
 * END IT HERE — the forget's verb, and the only one that stops the engine.
 *
 * Three effects in one call because a person pressing Forget on this phone's own mailbox is asking
 * for all three, and any two of them without the third is a state nothing describes:
 *
 *  1. the CLAIM goes back — the engine's own `handBack`, so another machine can take the mailbox
 *     immediately rather than waiting out the staleness window;
 *  2. the SESSION stops, which takes the notification down with it;
 *  3. the ENGINE stops, because the profile row that named it is about to go.
 *
 * In that order: the hand-back needs a running engine, and a notification left standing over a
 * stopped one would say this phone is organizing mail it no longer holds. Never throws — the row
 * removal must not be blocked by a mailbox that could not be reached. The claim not going back is
 * the recoverable half: it ages out.
 */
export async function endStandaloneHere(): Promise<void> {
  const held = door;
  door = null;
  if (held !== null) await held.handBack().catch(() => undefined);
  await stopOrganizerSession();
  if (held !== null) await held.stop().catch(() => undefined);
}

/** Test seam: forget everything. Never called by the app. */
export function forgetOrganizerSessionForTests(): void {
  live = null;
  door = null;
  restrictedSaid = false;
}
