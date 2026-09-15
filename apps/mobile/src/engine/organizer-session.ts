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
import { faultDetail, refuse, type Refusal } from "../refusal";
import type { ClaimHereOutcome, StandaloneEngine, StopOrganizingOutcome } from "./standalone-door";
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
  /** Diagnostics — the engine's own logger. NEVER the address; the notice's body is not logged. */
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
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

/**
 * WHICH LAUNCH A SETTLED IMPORT BELONGS TO. The background half is reached by a dynamic `import()`
 * the door screen neither awaits nor cancels, and the profile write after it can be refused —
 * {@link discardStandaloneLaunch} then hands the claim back and stops the engine. An import
 * settling after that started a live session over a dead engine, and {@link startOrganizerSession}
 * is first-start-wins, so the next successful Connect could not attach its own and the mailbox was
 * organized behind no notification, no service and neither watch. A launch therefore carries a
 * generation, bumped when one opens and again when one is discarded; a session may only be raised
 * for the generation in force.
 */
let launchGeneration = 0;

/** The launch in force — read before the background import and handed to {@link startOrganizerSession}. */
export const standaloneLaunchGeneration = (): number => launchGeneration;

/** Take the launch slot, or `standing` — an engine is already alive, or one is being opened. */
export function takeStandaloneLaunch(): "open" | "standing" {
  if (door !== null || launching) return "standing";
  launching = true;
  launchGeneration += 1;
  return "open";
}

/** Give it back — on EVERY exit of a launch, or the next press is refused for the run of the app. */
export function releaseStandaloneLaunch(): void {
  launching = false;
}

/**
 * Who is watching this module's state — the Settings panel, and nothing else yet. The panel read
 * {@link standaloneHere} at RENDER and nothing re-rendered it, so it was correct only at mount:
 * `Stopping` and `Organizing` stood for minutes over a finished stop or a mailbox another machine
 * held, settling only when the screen was re-entered. A version counter and `useSyncExternalStore`
 * rather than a copy of the state — the state lives in the engine's `runtimes()` and this module's
 * own `let`s, and a second copy is two answers to one question — so a notify means "ask again".
 * Every writer below notifies, and so does the claim watch, which carries an engine-side change (a
 * stand-down mid-poll, a holder going away) onto the screen without the panel polling.
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
 * A person asked, in this run of the app — the one thing that licenses a consent press. The press
 * used to run from `runConnect`, which is every launch, profile switch and door press; on a phone
 * beside a laptop holding the mailbox that made a plain relaunch a takeover (the engine stood down
 * and the app authorized a fresh claim seconds later). So the press needs a licence, and the
 * licence is a finger: the door screen's Connect and the panel's start verb. It is MODULE state and
 * deliberately not persisted — "in this run of the app" is the bound, and a persisted one would
 * license the next launch too. It is TAKEN rather than read: one arm, one press, or a switch away
 * and back would spend the same finger twice.
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
  /**
   * THE PERSON'S STOP STILL STANDING ON THE ROW — ISO 8601, or `null` where none is; `null` too
   * before the engine has said. `organizing: false` with this set is a stop the mail server has
   * not honoured, which is the one state the panel could not tell from a free mailbox.
   */
  readonly releaseRequestedAt: string | null;
  readonly heldBy: StandDownHolder | null;
  /** `null` until the engine has said — see the body. */
  readonly reachable: boolean | null;
  /** ISO 8601, or `null` while reachable. The FIRST observation of the current outage. */
  readonly unreachableSince: string | null;
  /** The server answered and rejected the sign-in — not an outage, and not retried. */
  readonly signInRefused: boolean;
  /**
   * NO PASSWORD ON THIS PHONE FOR THIS MAILBOX — nothing was dialled, so it is neither reachable
   * nor an outage. The engine's own field, re-spelled nowhere. `false` while the engine has not
   * said, which is what every build before the field reported.
   */
  readonly needsCredential: boolean;
  /**
   * WHAT THE FIRST SYNC OF THIS MAILBOX PRODUCED — `pending`, `finished`,
   * `produced_nothing_readable`, or `null` while the engine has not said, exactly as the two
   * fields above are. The engine's own word, unmodified: this app re-spells no engine value.
   */
  readonly firstSync: string | null;
}

/** The engine's answers in the order a person needs them — the worst news about the FIRST SYNC
 *  first. One mailbox on this phone, so any entry is the answer; where a build ever holds more
 *  than one, a mailbox that could not be read outranks one that could, for the reason the
 *  unreachable reading takes the same way round: the sentence is about mail that is not here. */
const FIRST_SYNC_RANK = ["produced_nothing_readable", "pending", "finished"];

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
  let needsCredential = false;
  /** `null` until the engine has said — see the field. */
  let firstSync: string | null = null;
  /**
   * WHO HOLDS THE MAILBOX WHEN THIS INSTALL DOES NOT — the engine's own peek at the claim.
   *
   * `null` is "nobody, or not read yet". Without it the panel could only say `Nothing organizes
   * this mailbox`, which is also what it says when the mailbox is free — so a phone standing down
   * correctly told a person nothing was organizing their mail.
   *
   * TWO PRODUCERS AND ONE READER. The gate writes it at a stand-down; the door writes it when it
   * REFUSES a press over a live foreign claim, which is the state a mailbox this phone handed back
   * and another install then took — nothing runs the gate there, so without the second producer a
   * refused press left "Nothing organizes this mailbox" and a live Start verb standing over a
   * mailbox the door had just said was held. Both write the same field on the same state, so this
   * app still has one answer to "who holds this mailbox"; the engine's own word wins where it has
   * one.
   */
  let heldBy: StandDownHolder | null = null;
  /** See {@link StandaloneHere.releaseRequestedAt}. `null` is "none standing, or not said yet". */
  let releaseRequestedAt: string | null = null;
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
      /* ONE MAILBOX ON THIS PHONE, so any entry carrying a standing stop is the answer — the same
         reading `organizing` takes above. */
      releaseRequestedAt = entries
        .map(([, state]) => state.releaseRequestedAt)
        .find((at) => at !== null) ?? null;
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
      /* `some`, like the refusal beside it and unlike `reachable`: the news is that a mailbox on
         this phone is waiting for a password, and a second healthy link does not answer it. */
      needsCredential = conn.some((c) => c.needsCredential === true);
      const since = conn
        .map((c) => c.unreachableSince)
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      unreachableSince = since === undefined ? null : since.toISOString();
      /* THE SAME PASS AND THE SAME `conn`, for the reason the block above states. An unknown
         spelling ranks last rather than being dropped: a build whose engine answers a value this
         app has never heard of must not read as "the engine has not said". */
      firstSync = conn
        .map((c) => c.firstSync)
        .sort((a, b) => {
          const rank = (v: string): number => {
            const at = FIRST_SYNC_RANK.indexOf(v);
            return at === -1 ? FIRST_SYNC_RANK.length : at;
          };
          return rank(a) - rank(b);
        })[0] ?? null;
    }
  } catch {
    /* An unreadable runtime is "has not said", never "does not organize" — the background half
       takes the same reading, and for the same reason: a momentary failure must not end
       somebody's organizing on screen. */
  }
  return {
    id, address: held.address, organizing, releaseRequestedAt, heldBy, reachable,
    unreachableSince, signInRefused, needsCredential, firstSync,
  };
}

/**
 * THE DOOR IN THIS PROCESS, FOR A SESSION THAT IS IT — `null` for every other account.
 *
 * {@link standaloneHere} is MODULE state: one engine per process, and it outlives a switch. A
 * surface scoped to an account read it unscoped, so after switching to a healthy paired or Cloud
 * account the retained standalone engine's outage was rendered as that account's — a person
 * looking at a working mailbox told it was broken, about a mailbox they had switched away from.
 * Every rendered state belongs to the account being rendered, so the read is scoped at the one
 * place both verdicts come through.
 */
export function standaloneHereFor(session: { readonly standalone: boolean }): StandaloneHere | null {
  return session.standalone ? standaloneHere() : null;
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
 * The person's hand-back from Settings, on this door — and it is REMEMBERED. This was
 * `held.handBack()`, which leaves the ROW saying organizer so the next resume takes the mailbox
 * back with no press — right for an app leaving the foreground, wrong for a person pressing stop (a
 * swipe-away then reopen wrote a fresh claim nothing serviced). So the stop goes through the
 * RELEASE the row records, the desktop's own ceremony: `release_requested_at`, honoured before the
 * lease, writing the reader role and `organizer_released_at`, so it survives a kill while login,
 * poll timer and mirror are kept. Never throws — an unrecorded release leaves the claim to lapse,
 * and the caller decides what the notification does; see {@link StopOrganizingOutcome}.
 */
export async function stopOrganizingStandalone(): Promise<StopOrganizingOutcome> {
  const held = door;
  if (held === null) return "refused";
  const stopped = await held.stopOrganizing().catch((): StopOrganizingOutcome => "refused");
  notifyOrganizerState();
  return stopped;
}

/**
 * ONE STANDING INSTRUCTION, AND A PRESS REPLACES IT RATHER THAN RACING IT. Stop and Start were two
 * unawaited calls on one mailbox with nothing between them: pressing both in one run left either a
 * start refused for the life of the process or a panel reading `Stopping` over a phone that was
 * filing mail. The session holds ONE instruction and every press goes through
 * {@link pressOrganizeHere}: a press asking for the instruction already in force is not a second
 * one, and a press made while the opposite act is in flight is QUEUED once and run when that act
 * settles — that is the cancel. The instruction is settled from the ENGINE's own answer and never
 * outranks it ({@link settleInstruction}), so a press whose call never returns leaves no stale word.
 */
export type OrganizeInstruction = "idle" | "starting" | "running" | "stopping";

/** What a press did. `standing` = the instruction it asked for was already in force. */
export type PressOutcome =
  | "started" | "stopped" | "queued" | "standing"
  /**
   * THE DOOR COULD NOT SEE WHETHER ANYBODY HOLDS THE MAILBOX, so it wrote nothing.
   *
   * Beside `refused` rather than inside it, because the panel says a different sentence for each:
   * `refused` is something wrong on this phone, and this is a look that did not land. They are
   * also the pair that must never merge with `started` — a press over an unreadable claim folder
   * used to be admitted and reported as a start.
   */
  | "unreadable"
  /**
   * ANOTHER INSTALL HOLDS THE MAILBOX, and the door said so to this press.
   *
   * It answered `standing` — "the instruction you asked for is already in force" — which is false
   * twice over: nothing of this install's is organizing the mailbox, and nothing about the press
   * was already happening. The word exists so the press has a true answer of its own; the SENTENCE
   * a person reads comes from the holder the door now records on the engine's own state, which is
   * where every other holder in this app is read from.
   */
  | "held"
  | "refused";

let instruction: OrganizeInstruction = "idle";
/** At most one press waiting behind the act in flight, and only ever the opposite one. */
let queued: "start" | "stop" | null = null;
/** The act being carried out, so a press can wait for it rather than race it. */
let inFlight: Promise<void> | null = null;
/**
 * WHICH act is in flight — the other half of the standing instruction while one is.
 *
 * Without it a press could only be compared against the WORD on screen, and the word says
 * `stopping` both for a stop that is the last thing anybody asked for and for one the person has
 * since pressed past. See {@link standingInstruction}.
 */
let acting: "start" | "stop" | null = null;

/**
 * ══ THE STANDING INSTRUCTION IS THE LAST PRESS, AND NOTHING ELSE ════════════════════════════
 *
 * While an act is in flight the last press is the QUEUED one where there is one, and the act
 * itself where there is not. `null` means nothing is being carried out, and the engine's own
 * answer is then the whole of the state.
 */
const standingInstruction = (): "start" | "stop" | null =>
  inFlight === null || acting === null ? null : queued ?? acting;

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
  /* THE QUEUE IS READ BEFORE THE PRESS IS ANSWERED, AND THE PRESS REPLACES IT. The WORD on screen
   * was read first, so a press matching the act in flight answered `standing` without looking at
   * the queue: Stop, Start, then Stop while the first stop ran settled on the queued START — the
   * person's last press discarded as "already in force" by the act their earlier press had queued
   * away from, and the phone went on organizing. Start-Stop-Start mirrors it. So while an act is
   * in flight the standing instruction is {@link standingInstruction}, a press REPLACES it rather
   * than appending, and the answer is read from the machine after the replacement is recorded. A
   * press for the act already in flight needs nothing behind it and CLEARS the queue. */
  const standing = standingInstruction();
  if (standing !== null) {
    if (standing === want) return "standing";
    queued = want === acting ? null : want;
    notifyOrganizerState();
    return queued === null ? "standing" : "queued";
  }
  const state = organizerInstruction();
  if (want === "start" && (state === "running" || state === "starting")) return "standing";
  /**
   * A STOP OVER A STANDING RELEASE IS NOT ALREADY IN FORCE, AND THE PRESS REACHES THE ENGINE.
   *
   * The engine answers `organizing: false` while it carries out a release — a pass honouring one
   * arranges nothing either way — so the instruction settled to `idle` and a second press was
   * served from the SURFACE's word: it answered `standing` without calling the engine at all, and
   * the panel's only explanation was wiped by the press that produced nothing. The row's standing
   * `release_requested_at` is the engine's second answer and it is what separates a stop the mail
   * server honoured from one it has not, so a press made over one is a fresh ask.
   */
  const releaseStanding = standaloneHere()?.releaseRequestedAt != null;
  if (want === "stop" && !releaseStanding && (state === "idle" || state === "stopping")) {
    return "standing";
  }
  return runInstruction(want);
}

async function runInstruction(want: "start" | "stop"): Promise<PressOutcome> {
  instruction = want === "start" ? "starting" : "stopping";
  acting = want;
  notifyOrganizerState();
  const act = want === "start" ? startHere() : stopHere();
  /* The queue waits on a promise that cannot reject — a refused act still has to release the
     press behind it, or "start after stop" would be lost by the stop having failed. */
  inFlight = act.then(() => undefined, () => undefined);
  const outcome = await act.catch((): PressOutcome => "refused");
  inFlight = null;
  acting = null;
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
  /* CARRIED AS ITSELF. A refused press over a live foreign claim is not `standing` — see
     {@link PressOutcome}. The door records the holder on the engine's own organizer state as it
     refuses, so `standaloneHere().heldBy` names it on this very render and the panel's claim is
     `theirs`: the holder sentence, and no Start verb over a mailbox the door just said is held. */
  if (outcome === "held") return "held";
  /* CARRIED, not folded. The door says `unreadable` exactly where it could not check, and the
     panel owes that its own sentence — see {@link PressOutcome}. */
  if (outcome === "unreadable") return "unreadable";
  if (outcome !== "claimed") return "refused";
  /* AND THE SESSION COMES BACK WITH THE CLAIM. The stop disposed it, taking the notification, the
     foreground service and both watches with it — so a start that only claimed would leave the
     engine organizing behind nothing a person can see, which is the state `organizerRestricted`
     describes and the half that made this two standing instructions rather than one. */
  /* THE LAUNCH IN FORCE, which is this door's own: a start raises the session again over the
     engine that is running now, and the deps were kept by the launch that opened it. */
  if (sessionDeps !== null) startOrganizerSession(launchGeneration, sessionDeps);
  return "started";
}

async function stopHere(): Promise<PressOutcome> {
  /* THE ENGINE'S ANSWER DECIDES WHAT HAPPENS TO THE SESSION, NOT THE PRESS. The teardown ran
   * unconditionally, so a release the mail server refused took the notification, the foreground
   * service and both watches down over a phone that was STILL ORGANIZING. The reading that
   * replaced it was `organizing`, which answers a DIFFERENT question — a pass carrying out a
   * release arranges nothing either way — so production answered `false` on the refusal arm too.
   * The engine now answers what was asked: `released` is the only word that licenses taking the
   * notification down, `not_organizing` is a mailbox with nothing to give up, and `refused` leaves
   * everything up while Settings says the mailbox could not be handed back. */
  const stopped = await stopOrganizingStandalone();
  if (stopped === "refused") return "refused";
  await stopOrganizerSession();
  /* `standing` means "already in force", which is what nothing-to-give-up is. */
  return stopped === "released" ? "stopped" : "standing";
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
 * AND THE OTHER ONE — this phone may not show the notification its organizing stands behind.
 *
 * A SEPARATE record from {@link restrictedSaid}: separate fact, separate sentence, separate
 * remedy. Collapsed into one, an Android 13+ first install was told battery saver was the reason.
 *
 * CLEARABLE, unlike the restriction — see {@link sayNotificationsOn}: the permission can be given
 * back from system settings at any moment, and a record that could only be set would keep
 * "Notifications are off" on screen over a phone that had just been granted them.
 */
let notificationsOff = false;

/**
 * Start it, FOR ONE LAUNCH. Answers whether THIS call is the live session, so a caller that cares
 * can say so. The `AppState` subscription is taken first, because the first transition can arrive
 * while this function is still on the stack — a person who opens the door and immediately switches
 * away produces `background` with no session to receive it. `generation` is the launch the session
 * belongs to and it is REQUIRED, here rather than in the two callers: a stale import reaching this
 * function sets {@link sessionDeps} over a stopped engine and a later start reuses those deps. See
 * {@link standaloneLaunchGeneration}.
 */
export function startOrganizerSession(generation: number, deps: OrganizerSessionDeps): boolean {
  if (generation !== launchGeneration) {
    /* SAID, never swallowed: a session that was not raised is a phone with no background arm, and
       this is the one place that knows why. A TOKEN, not a sentence — this module's own idiom, and
       the copy census refuses English in `src` that no catalogue holds. */
    deps.log?.("organizer_session_launch_discarded", { why: "launch_given_up" });
    return false;
  }
  if (live !== null) return false;
  sessionDeps = deps;
  const organizing = createBackgroundOrganizing({
    platform: deps.platform,
    engine: deps.engine,
    service: deps.service,
    notice: deps.notice,
    announceRestricted: () => { restrictedSaid = true; notifyOrganizerState(); },
    /* THE OTHER CAUSE, ITS OWN RECORD — see {@link notificationsOff}. The background half meets
       this on every Android 13+ install whose notification permission was never granted. */
    announceNotificationsOff: sayNotificationsOff,
    /* A START THAT DID NOT FINISH STARTING, onto the panel that names this phone — the surface
       `organizeRefused` already owns, because a person asking "is my mail being filed?" is looking
       there. A VALUE and not a sentence: worded at render, so a language change turns it over with
       everything else. `null` clears it, which is what a resume that worked hands in. */
    sayStartFailed: (detail: unknown) => {
      sayOrganizeRefused(detail === null ? null : refuse("organizeStartFailed", faultDetail(detail)));
    },
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

/** See {@link notificationsOff}. The sentence is `Copy.organizerNotificationsOff`. */
export const organizerNotificationsOffSaid = (): boolean => notificationsOff;

/**
 * This phone may not show the organizer's notification. Written by the background half's decline,
 * and by a press whose permission request was refused — one state, however it was learnt.
 */
export function sayNotificationsOff(): void {
  if (notificationsOff) return;
  notificationsOff = true;
  notifyOrganizerState();
}

/**
 * And it may again — the OS's live answer, read when the panel opens. The permission can be given
 * back in system settings at any moment, and nothing inside this app is told; without this the
 * state would outlive the refusal it describes.
 */
export function sayNotificationsOn(): void {
  if (!notificationsOff) return;
  notificationsOff = false;
  notifyOrganizerState();
}

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
 * End it here — the forget's verb, and the only one that stops the engine. Three effects in one
 * call, in this order: the claim goes back (`handBack`, so another machine can take the mailbox at
 * once), the session stops with its notification, the engine stops because the profile row naming
 * it is about to go. Any two without the third is a state nothing describes. It also ANSWERS
 * whether the claim went: this returned `void` over a swallowed `handBack`, so a forget reported a
 * mailbox let go while its record in `ohmail/_meta` stood to expiry. `released: null` is the
 * engine's own word for "the caller may not say the mailbox was handed back", and that is what
 * comes back. Never throws, and `false` never blocks the row removal — the caller says so.
 */
export async function endStandaloneHere(): Promise<boolean> {
  const held = door;
  door = null;
  /* The launch is over too, and for the discard's reason: this stops the engine, so a background
     import still in flight may not raise a session over it. */
  launchGeneration += 1;
  /* The mailbox is going, so the instruction about it goes too — a queued start would otherwise
     claim a mailbox this install is in the middle of forgetting. */
  instruction = "idle";
  queued = null;
  sessionDeps = null;
  notifyOrganizerState();
  /* A throw and a `null` entry are the same fact — nothing proves the claim left the folder — and
     an install holding no door has none to give back, which is not a failed release. */
  const released = held === null
    ? true
    : await held.handBack().then(
      (entries) => entries.every((e) => e.released !== null),
      () => false,
    );
  await stopOrganizerSession();
  if (held !== null) await held.stop().catch(() => undefined);
  return released;
}

/**
 * A REFUSED CONNECT LEAVES NO ENGINE AND NO SEAL. The launch succeeded, the app could not record
 * the mailbox it had opened, and the screen said so over an engine, a door and a session still
 * alive: the next Connect started a SECOND engine over the same device store, which
 * `holdStandaloneDoor` and {@link startOrganizerSession} both silently declined to adopt. So the
 * refusal is the one exit and it undoes the launch. The seal goes with it: the credential is
 * written at ATTACH, before anything dials, and `resolveLogin` lets the STORE win, so a second
 * press with a corrected server would dial the first press's coordinates and hand back an opened
 * mailbox with nothing on the wire. Only here — the forget above deletes the whole store.
 */
export async function discardStandaloneLaunch(): Promise<void> {
  const held = door;
  door = null;
  /* BEFORE ANYTHING IS AWAITED. The background import is in flight while this runs, and a
     generation bumped after the engine had already been stopped would leave exactly the window
     this exists to close — see {@link standaloneLaunchGeneration}. */
  launchGeneration += 1;
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
 * Ask again only if something moved — the claim watch's cue, and why it is gated. The watch fires
 * on a timer whether the mailbox changed or not, which is what makes an engine-side change (a
 * stand-down mid-poll, a holder going away) reach a screen already open. An unconditional bump
 * would re-render the panel once a minute for ever, so this compares the panel's WHOLE input — the
 * door's answer plus the three module facts rendered beside it — and notifies only on a difference.
 * The comparison lives here because this module owns those facts; one in `background.ts` would need
 * a copy of the door's answer, the second source of truth this is all about.
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
      : [here.id, here.address, here.organizing, here.releaseRequestedAt,
        here.heldBy?.name ?? null, here.heldBy?.standDownReason ?? null],
    instruction,
    live !== null,
    live?.organizing.backgrounded() ?? false,
    /* THE HANDED-BACK STATE IS THE PANEL'S INPUT TOO, since it has a chip of its own. A fact the
       panel renders and this fingerprint does not carry is a chip nothing re-derives: the claim
       watch would compare an unchanged string and notify nobody. */
    live?.organizing.handedBack() ?? false,
    restrictedSaid,
    notificationsOff,
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
  acting = null;
  /* NOT reset to zero: a case that read a generation before the reset must not have it handed
     back by the next case, which is the same staleness the counter exists to refuse. */
  launchGeneration += 1;
  sessionDeps = null;
  restrictedSaid = false;
  notificationsOff = false;
  organizeRefused = null;
  consentArmed = false;
  lastSeen = "";
  watchers.clear();
}
