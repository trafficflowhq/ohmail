/**
 * The routing window's held presses — the phone's binding of the engine's own window, beside
 * `held-delete.ts` and shaped like it. A Move writes the sender's ROUTING and no rule mutation
 * has a wire inverse, so the mail moves at the press and the rule is HELD: the pill carries Undo
 * while the window runs, and it is sent when the window closes. The WINDOW and the INTENT are the
 * engine's, so the phone and the desktop make one promise; the plan and the dispatch stay here,
 * because only this surface knows its ladder. DURABLE: the journal is a client-local row in the
 * account's mirror, on disk before the Undo is offered, and the next launch finishes a press a
 * kill left inside its window and says so.
 */
import {
  FOLDER_OF_VIEW,
  createRoutingWindow,
  presentAt,
  routingIntentsKey,
  routingSubject,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type AnyRoutingIntent,
  type DecideIntent,
  type MutationResult,
  type RoutingOpen,
  type RoutingWindow,
  type ScreenIntent,
} from "@ohmail/client-engine";
import { journalDoor, type HeldJournal, type JournalDoor } from "./held-journal";

/** The part of the account's mirror the journal lives in — `held-journal.ts`'s, one door for both windows. */
export type RoutingJournal = HeldJournal;

/** What a launch finished of the presses a killed session left, and what it could not make. */
export interface RoutingReplay {
  /** Committed at the launch and not refused by the server, oldest first. */
  moved: readonly AnyRoutingIntent[];
  /** Past the journal's horizon: never made. */
  expired: readonly AnyRoutingIntent[];
  /** Committed at the launch and refused by the server, which the dispatch has already said. */
  refused: readonly AnyRoutingIntent[];
}

/** What one session's window needs to plan and to send. Supplied when the session opens. */
export interface RoutingSessionDeps {
  /** The ROUTING half, re-read from the mirror at the commit — never replayed from the record. */
  plan: (intent: AnyRoutingIntent) => readonly EngineMutation[];
  /**
   * `false` for a commit the server refused, which the dispatch has already said; `"nothing"` for
   * one with nothing left to send — neither made nor refused, and a launch says nothing for it.
   */
  dispatch: (mutations: readonly EngineMutation[], intent: AnyRoutingIntent) => Promise<boolean | void | "nothing">;
  windowMs: number;
  /** The account's mirror. REQUIRED: a defaulted jar is how a surface stops keeping records. */
  journal: RoutingJournal;
  /** Called once per launch that found presses to finish or to report. */
  onReplayed?: (replay: RoutingReplay) => void;
  /**
   * THE WAY BACK FROM A COMMIT, read BEFORE its writes leave: what an Undo pressed after the
   * window sent the rules dispatches, built once the commit has answered. `null`: none offered.
   */
  reverse?: (mutations: readonly EngineMutation[], intent: AnyRoutingIntent) => (() => readonly EngineMutation[]) | null;
  now?: () => number;
}

let live: RoutingWindow | null = null;
let liveDoor: JournalDoor | null = null;
/** Committed presses' ways back, by press id — the last few, since only a standing pill asks. */
const reversals = new Map<string, () => Promise<readonly EngineMutation[]>>();
const REVERSALS_KEPT = 16;
const listeners = new Set<() => void>();
/** The snapshot the projection subscribes to — a NEW map per change, the store's contract. */
let snapshot: ReadonlyMap<string, Folder> = new Map();
/** Presses whose record has not landed yet: no frame shows them until it has. */
const landing = new Set<string>();

/**
 * A MOVE THAT DECIDES NO RULE SHOWS NO HELD PLACE: its letter's own move draws it, once the record
 * has landed. `holdsRule: false` is the phone's mark on that v1 row (`live.ts#PhoneMoveIntent`).
 */
function showsPlace(i: AnyRoutingIntent): boolean {
  return !(i.v === 1 && (i as { holdsRule?: unknown }).holdsRule === false);
}

/** Every open press's place, and NO new snapshot when it equals the last: each is a world re-derivation. */
function publish(open: readonly AnyRoutingIntent[]): void {
  const next = new Map<string, Folder>();
  for (const i of open) {
    if (landing.has(i.id) || !showsPlace(i)) continue;
    const folder = FOLDER_OF_VIEW[i.dest];
    if (!folder) continue;
    for (const id of i.messageIds) next.set(id, folder);
  }
  if (next.size === snapshot.size && [...next].every(([id, f]) => snapshot.get(id) === f)) return;
  snapshot = next;
  for (const cb of listeners) cb();
}

export function subscribeRoutingPlaces(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Where held presses are showing their mail — composed into the projection. */
export function routingPlaces(): ReadonlyMap<string, Folder> {
  return snapshot;
}

/**
 * OPEN THE SESSION'S WINDOW, and finish what the last one left. Replaces whatever the previous
 * session had, committing it first: a session ending is not a retraction, `flushHeldDeletes`'
 * rule at the same seam. A press found in the journal commits NOW, before the lists paint: past
 * its window it was owed, and inside it the Undo died with the toast that carried it.
 */
export function openRoutingSession(deps: RoutingSessionDeps): void {
  closeRoutingSession();
  const door = journalDoor(deps.journal);
  /** Each launch commit's answer, captured only while the replay sends — what the sentence counts. */
  let launched: Map<string, Promise<boolean | void | "nothing">> | null = null;
  const win = createRoutingWindow({
    /* ONE ACCOUNT PER MIRROR: the account-keyed name is kept for its shape, not its scope. */
    door,
    key: routingIntentsKey(null),
    windowMs: deps.windowMs,
    plan: deps.plan,
    dispatch: (mutations, intent) => {
      const back = deps.reverse?.(mutations, intent) ?? null;
      const answer = deps.dispatch(mutations, intent).then((ok) => ok, () => false as const);
      const landed = answer.then((ok) => ok !== false);
      launched?.set(intent.id, answer);
      if (back) {
        reversals.set(intent.id, () => landed.then((ok) => (ok ? back() : [])));
        for (const id of reversals.keys()) { if (reversals.size <= REVERSALS_KEPT) break; reversals.delete(id); }
      }
      return landed.then(() => undefined);
    },
    onPending: publish,
  });
  live = win;
  liveDoor = door;
  launched = new Map();
  const seen = win.replay((deps.now ?? Date.now)());
  win.flush();
  const answers = launched;
  launched = null;
  void seen.then(async ({ committed, resumed, expired }) => {
    const done = [...committed, ...resumed];
    const ok = await Promise.all(done.map((i) => answers.get(i.id) ?? Promise.resolve("nothing" as const)));
    /* A commit that sent nothing made nothing: nothing was waiting, so the launch is quiet. */
    const moved = done.filter((_, k) => ok[k] !== false && ok[k] !== "nothing");
    const refused = done.filter((_, k) => ok[k] === false);
    if (moved.length > 0 || expired.length > 0 || refused.length > 0) deps.onReplayed?.({ moved, expired, refused });
  });
}

/** Commit every open window and forget the session's. */
export function closeRoutingSession(): void {
  if (!live) return;
  live.flush();
  live = null;
  liveDoor = null;
  reversals.clear();
  publish([]);
}

/** Is a press on this subject held open now — the question a Move that decides no rule asks first. */
export function heldOn(subject: string): boolean {
  return live ? live.pending().some((p) => routingSubject(p) === subject) : false;
}

/** What a hold answered. `sent`: the routing already went, so the caller neither sends nor offers Undo. */
export interface PhoneRoutingHold extends RoutingOpen {
  sent: boolean;
}

/**
 * Hold one press, ON DISK before it answers — the Undo is offered only over a record a kill
 * cannot take. `held: false, sent: false` where there is no session: nothing to undo, and the
 * caller sends the rules itself.
 */
export async function holdRouting(intent: AnyRoutingIntent): Promise<PhoneRoutingHold> {
  const win = live;
  const door = liveDoor;
  if (!win || !door) return { held: false, superseded: false, sent: false };
  landing.add(intent.id);
  const out = win.open(intent);
  const shown = (): void => { landing.delete(intent.id); if (live === win) publish(win.pending()); };
  if (!out.held) { shown(); return { ...out, sent: true }; }
  const stored = await door.landed();
  shown();
  if (stored === "stored") return { ...out, sent: false };
  /* THE RECORD DID NOT LAND, so this press may not promise an Undo. Still open: taken back, and
     the caller sends now. Gone meanwhile (a flush, a later press about the sender): nothing is
     left for the caller to send. */
  const open = win.pending().some((p) => p.id === intent.id);
  if (open) win.undo(routingSubject(intent));
  return { held: false, superseded: out.superseded, sent: !open };
}

/** What a sheet press's commit answered: the writes, their answers, and the shown rules that changed. */
export interface ScreenCommitAnswer {
  mutations: readonly EngineMutation[];
  answers: readonly (MutationResult | null)[];
  changed: readonly string[];
}

/** The press's own follow-up, by press id — in memory: a kill loses it, and the launch says its own. */
const afters = new Map<string, { after: (a: ScreenCommitAnswer) => void; changed: string[] }>();

/**
 * Hold one SHEET press or Screener decision, with what to say once its commit is answered — on disk
 * first, as {@link holdRouting}. A press handed back for the caller to send drops its follow-up.
 */
export async function holdScreenRouting(
  intent: ScreenIntent | DecideIntent, after: (a: ScreenCommitAnswer) => void,
): Promise<PhoneRoutingHold> {
  if (!live) return { held: false, superseded: false, sent: false };
  afters.set(intent.id, { after, changed: [] });
  const out = await holdRouting(intent);
  if (!out.held && !out.sent) afters.delete(intent.id);
  return out;
}

/** The commit planner's shown rules that changed inside the window, noted for the follow-up. */
export function noteScreenChanged(pressId: string, changed: readonly string[]): void {
  const held = afters.get(pressId);
  if (held) held.changed = [...changed];
}

/** Hand a committed sheet press its answer — `false` for a press with nobody left to tell. */
export function answerScreenPress(pressId: string, mutations: readonly EngineMutation[], answers: readonly (MutationResult | null)[]): boolean {
  const held = afters.get(pressId);
  afters.delete(pressId);
  if (!held) return false;
  held.after({ mutations, answers, changed: held.changed });
  return true;
}

/** Take the press on this subject back. `false` where no window was open — nothing held is not an undo. */
export function undoRouting(subject: string): boolean {
  return live ? live.undo(subject) : false;
}

/**
 * TAKE BACK ONE PRESS, BY ITS ID. The window keeps one press per sender, so a second Move about
 * the same sender REPLACES the first; the first toast's Undo then names a press that is no longer
 * held, and taking the subject back would cancel the second press instead. `superseded` says so.
 */
export function undoRoutingPress(subject: string, pressId: string): "undone" | "superseded" | "gone" {
  const held = live?.pending().find((p) => routingSubject(p) === subject);
  if (!held) return "gone";
  if (held.id !== pressId) return "superseded";
  return undoRouting(subject) ? "undone" : "gone";
}

/** The press's Undo is on screen: its window counts from here (`RoutingWindow.restart`). */
export function restartRouting(subject: string): boolean {
  return live ? live.restart(subject) : false;
}

/**
 * The way back from a press the window has already COMMITTED — the rules' inverse, answered once
 * the commit has, so it can never pass the write it undoes. Taken once; `null` for a press whose
 * commit this session did not send.
 */
export function takeRoutingReversal(pressId: string): Promise<readonly EngineMutation[]> | null {
  const back = reversals.get(pressId);
  reversals.delete(pressId);
  return back ? back() : null;
}

/** Commit every open window now — backgrounding, and the session teardown. Leaving is not undo. */
export function flushRouting(): void {
  live?.flush();
}

/**
 * THE PROJECTION WITH THE HELD PRESSES SHOWN WHERE THEY WERE FILED — and it lives here rather
 * than at the provider so the engine package keeps ONE importer on this path. A row's place comes
 * from its sender's rule, so a press whose rule is waiting would move nothing on screen; the
 * overlay carries the named rows until the window closes, and returns the base reader unwrapped
 * when nothing is held. `places` is passed rather than read, so the provider's subscription is
 * what re-derives the world.
 */
export function routingReader(
  base: EntityReader, places: ReadonlyMap<string, Folder>,
): EntityReader {
  return presentAt(base, places);
}
