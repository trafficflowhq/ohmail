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
 * ══ ONE ENGINE IN THIS PROCESS, AND A SECOND PRESS DOES NOT MAKE ANOTHER ════════════════════
 *
 * {@link holdStandaloneDoor} is first-start-wins, which keeps the DOOR right and leaves the
 * second engine running with nothing holding it: two engines polling one device store is two
 * organizers of one mailbox, which is the invariant this app lives under. A door is held only
 * after a launch returns, so the door alone cannot refuse a press made while one is in flight —
 * this slot is that half. Both openers take it: the fourth door's Connect, and the relaunch the
 * connection layer runs over a stored row.
 */
let launching = false;

/** Take the launch slot, or `standing` — an engine is already alive, or one is being opened. */
export function takeStandaloneLaunch(): "open" | "standing" {
  if (door !== null || launching) return "standing";
  launching = true;
  return "open";
}

/** Give it back — on EVERY exit of a launch, or the next press is refused for the run of the app. */
export function releaseStandaloneLaunch(): void {
  launching = false;
}

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
export interface StandaloneHere {
  readonly id: string | null;
  readonly address: string;
  readonly organizing: boolean | null;
  readonly heldBy: StandDownHolder | null;
  /** `null` until the engine has said — see the body. */
  readonly reachable: boolean | null;
  /** ISO 8601, or `null` while reachable. The FIRST observation of the current outage. */
  readonly unreachableSince: string | null;
  /** The server answered and rejected the sign-in — not an outage, and not retried. */
  readonly signInRefused: boolean;
}

export function standaloneHere(): StandaloneHere | null {
  const held = door;
  if (held === null) return null;
  let organizing: boolean | null = null;
  let id: string | null = null;
  /**
   * AND WHETHER THE MAIL SERVER CAN BE REACHED AT ALL — read in the SAME pass, from the same
   * `runtimes()` answer, because two reads would be two clocks: a panel saying "Organizing" over
   * a connection this call had already found dead is the pair disagreeing with itself.
   *
   * `reachable: null` is "the engine has not said yet", exactly as `organizing: null` is — the
   * map is empty until the first cycle, and reading that as "unreachable" would put
   * "Connection lost" on screen a second after the door opened.
   */
  let reachable: boolean | null = null;
  let unreachableSince: string | null = null;
  let signInRefused = false;
  /**
   * WHO HOLDS THE MAILBOX WHEN THIS INSTALL DOES NOT — the engine's own peek at the claim.
   *
   * `null` is "nobody, or not read yet". Without it the panel could only say `Nothing organizes
   * this mailbox`, which is also what it says when the mailbox is free — so a phone standing down
   * correctly told a person nothing was organizing their mail.
   */
  let heldBy: StandDownHolder | null = null;
  try {
    /* ONE read of the engine's answer, and both halves off it: `runtimes()` is a snapshot per
       call, so asking twice is asking two different moments. */
    const reported = held.runtimes();
    const entries = Object.entries(reported.organizer);
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
    /* ONE MAILBOX ON THIS PHONE, so any entry is the answer — the same reading `organizing`
       takes above. Unreachable wins over reachable where a build ever holds more than one: the
       sentence is about mail not arriving, and saying nothing because one of two links is up
       would be the silence this whole field exists to end. */
    const conn = Object.values(reported.connection);
    if (conn.length > 0) {
      reachable = conn.every((c) => c.reachable);
      signInRefused = conn.some((c) => c.signInRefused);
      const since = conn
        .map((c) => c.unreachableSince)
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      unreachableSince = since === undefined ? null : since.toISOString();
    }
  } catch {
    /* An unreadable runtime is "has not said", never "does not organize" — the background half
       takes the same reading, and for the same reason: a momentary failure must not end
       somebody's organizing on screen. */
  }
  return { id, address: held.address, organizing, heldBy, reachable, unreachableSince, signInRefused };
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

/**
 * ══ ONE STANDING INSTRUCTION, AND A PRESS REPLACES IT RATHER THAN RACING IT ═════════════════
 *
 * Stop and Start were two unawaited calls on one mailbox with nothing between them. Measured on a
 * device: pressing both in one run left either a start refused for the life of the process or a
 * panel reading `Stopping` for three minutes over a phone that was demonstrably filing mail.
 *
 * So the session holds ONE instruction and every press goes through {@link pressOrganizeHere}. A
 * press asking for the instruction already in force is not a second instruction; a press made
 * while the opposite act is in flight is QUEUED once and run when that act settles — Start after a
 * stop, and Stop after a start, which releases what the start claimed. That is the cancel.
 *
 * The instruction is settled from the ENGINE's own answer and never outranks it
 * ({@link settleInstruction}), so a press whose call never returns cannot leave a stale word on
 * screen — the transition ends when the engine says it has.
 */
export type OrganizeInstruction = "idle" | "starting" | "running" | "stopping";

/** What a press did. `standing` = the instruction it asked for was already in force. */
export type PressOutcome = "started" | "stopped" | "queued" | "standing" | "refused";

let instruction: OrganizeInstruction = "idle";
/** At most one press waiting behind the act in flight, and only ever the opposite one. */
let queued: "start" | "stop" | null = null;
/** The act being carried out, so a press can wait for it rather than race it. */
let inFlight: Promise<void> | null = null;

/**
 * THE ENGINE'S ANSWER ENDS THE TRANSITION, not the press and not a timer.
 *
 * `null` is "the engine has not said" and settles nothing. A `starting` over a mailbox the engine
 * does not yet organize stays `starting`, and a `stopping` over one it still does stays
 * `stopping` — those are the two transitions, and they end when the engine's word changes.
 */
function settleInstruction(organizing: boolean | null): void {
  if (organizing === null) return;
  if (organizing && (instruction === "starting" || instruction === "idle")) instruction = "running";
  else if (!organizing && (instruction === "stopping" || instruction === "running")) instruction = "idle";
}

/**
 * The instruction in force, settled against the engine before it is handed out — which is what
 * makes "never a stale one" true without a second clock. The panel reads this at render.
 */
export function organizerInstruction(): OrganizeInstruction {
  settleInstruction(standaloneHere()?.organizing ?? null);
  return instruction;
}

/**
 * THE ONE DOOR BOTH VERBS GO THROUGH. Every caller is a finger.
 *
 * A press for the instruction already in force answers `standing` and writes nothing — which is
 * what stops a second Start from queueing a second instruction behind the first.
 */
export async function pressOrganizeHere(want: "start" | "stop"): Promise<PressOutcome> {
  const state = organizerInstruction();
  if (want === "start" && (state === "running" || state === "starting")) return "standing";
  if (want === "stop" && (state === "idle" || state === "stopping")) return "standing";
  if (inFlight !== null) {
    /* ONE SLOT, AND A PRESS FOR WHAT IS ALREADY WAITING IS NOT A SECOND INSTRUCTION. Two Starts
       behind one stop would otherwise claim the mailbox twice — and the second claim would land on
       a session the first had already raised. */
    if (queued === want) return "standing";
    queued = want;
    notifyOrganizerState();
    return "queued";
  }
  return runInstruction(want);
}

async function runInstruction(want: "start" | "stop"): Promise<PressOutcome> {
  instruction = want === "start" ? "starting" : "stopping";
  notifyOrganizerState();
  const act = want === "start" ? startHere() : stopHere();
  /* The queue waits on a promise that cannot reject — a refused act still has to release the
     press behind it, or "start after stop" would be lost by the stop having failed. */
  inFlight = act.then(() => undefined, () => undefined);
  const outcome = await act.catch((): PressOutcome => "refused");
  inFlight = null;
  /* THE TRANSITION IS OVER, whatever it achieved, so the engine's answer is the whole of the state
     again. Without this a REFUSED start reads `Starting` for ever — the defect this door exists to
     close, in the direction nobody measured on the device. */
  instruction = "idle";
  settleInstruction(standaloneHere()?.organizing ?? null);
  notifyOrganizerState();
  const next = queued;
  queued = null;
  return next === null ? outcome : runInstruction(next);
}

async function startHere(): Promise<PressOutcome> {
  const outcome = await claimHereStandalone();
  if (outcome === "held") return "standing";
  if (outcome !== "claimed") return "refused";
  /* AND THE SESSION COMES BACK WITH THE CLAIM. The stop disposed it, taking the notification, the
     foreground service and both watches with it — so a start that only claimed would leave the
     engine organizing behind nothing a person can see, which is the state `organizerRestricted`
     describes and the half that made this two standing instructions rather than one. */
  if (sessionDeps !== null) startOrganizerSession(sessionDeps);
  return "started";
}

async function stopHere(): Promise<PressOutcome> {
  const stopped = await stopOrganizingStandalone();
  /* AND THE NOTIFICATION COMES DOWN WITH THE CLAIM — a service left standing would say
     "Organizing" over a phone that reads. */
  await stopOrganizerSession();
  /* `false` is "nothing of ours was recorded as given up", which is the state the person asked
     for rather than a failure — `PhoneEngine.stopOrganizing`'s own contract. */
  return stopped ? "stopped" : "standing";
}

/**
 * The platform half's deps, kept so a start after a stop can raise the session again.
 *
 * The native starter is reached by a dynamic import from two screens; the door has no way to run
 * it, and `react-native` may not be imported here. So the deps it was handed are the way back.
 */
let sessionDeps: OrganizerSessionDeps | null = null;

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
  sessionDeps = deps;
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
  /* The mailbox is going, so the instruction about it goes too — a queued start would otherwise
     claim a mailbox this install is in the middle of forgetting. */
  instruction = "idle";
  queued = null;
  sessionDeps = null;
  notifyOrganizerState();
  if (held !== null) await held.handBack().catch(() => undefined);
  await stopOrganizerSession();
  if (held !== null) await held.stop().catch(() => undefined);
}

/**
 * ══ A REFUSED CONNECT LEAVES NO ENGINE AND NO SEAL ══════════════════════════════════════════
 *
 * The launch succeeded and the app could not record the mailbox it had opened, and the screen
 * said so over an engine, a door and a session that were all still alive: the next Connect
 * started a SECOND engine over the same device store, which `holdStandaloneDoor` and
 * {@link startOrganizerSession} both silently declined to adopt — an orphan polling one mailbox
 * beside the one the app talks to. So the refusal is the one exit and it undoes the launch.
 *
 * The seal goes with it, which is the device-divergence lane's rule one arm over: the credential
 * is written at ATTACH, before anything dials, and `resolveLogin` lets the STORE win — so a
 * second press with a corrected server would dial the first press's coordinates and hand back an
 * opened mailbox with nothing on the wire. Only here: the forget above deletes the whole store.
 */
export async function discardStandaloneLaunch(): Promise<void> {
  const held = door;
  door = null;
  instruction = "idle";
  queued = null;
  sessionDeps = null;
  notifyOrganizerState();
  if (held !== null) await held.handBack().catch(() => undefined);
  await stopOrganizerSession();
  if (held !== null) {
    await held.forgetStoredLogin().catch(() => undefined);
    await held.stop().catch(() => undefined);
  }
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
  /* SETTLED FROM THIS SNAPSHOT, not from a second read: the claim watch's tick is what carries an
     engine-side change onto an open panel, and the transition it ends is part of that change. */
  settleInstruction(here?.organizing ?? null);
  const now = JSON.stringify([
    here === null
      ? null
      : [here.id, here.address, here.organizing, here.heldBy?.name ?? null,
        here.heldBy?.standDownReason ?? null],
    instruction,
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
  launching = false;
  instruction = "idle";
  queued = null;
  inFlight = null;
  sessionDeps = null;
  restrictedSaid = false;
  organizeRefused = null;
  consentArmed = false;
  lastSeen = "";
  watchers.clear();
}
