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
  ROUTING_JOURNAL_TYPE,
  createRoutingWindow,
  presentAt,
  routingIntentsKey,
  routingSubject,
  type DurableWrite,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type AnyRoutingIntent,
  type MutationResult,
  type RoutingOpen,
  type RoutingWindow,
  type ScreenIntent,
  type StorageDoor,
} from "@ohmail/client-engine";

/** The part of the account's mirror the journal lives in — the app hands its `SqlMirrorStore`. */
export interface RoutingJournal {
  get<T = unknown>(type: string, id: string): T | undefined;
  commitLocal(
    puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
    deletes: ReadonlyArray<{ type: string; id: string }>,
  ): Promise<void>;
}

/** What a launch finished of the presses a killed session left, and what it could not make. */
export interface RoutingReplay {
  /** Committed at the launch and not refused by the server, oldest first. */
  moved: readonly AnyRoutingIntent[];
  /** Past the journal's horizon: never made. */
  expired: readonly AnyRoutingIntent[];
}

/** What one session's window needs to plan and to send. Supplied when the session opens. */
export interface RoutingSessionDeps {
  /** The ROUTING half, re-read from the mirror at the commit — never replayed from the record. */
  plan: (intent: AnyRoutingIntent) => readonly EngineMutation[];
  /** `false` for a commit the server refused, which the dispatch has already said. */
  dispatch: (mutations: readonly EngineMutation[], intent: AnyRoutingIntent) => Promise<boolean | void>;
  windowMs: number;
  /** The account's mirror. REQUIRED: a defaulted jar is how a surface stops keeping records. */
  journal: RoutingJournal;
  /** Called once per launch that found presses to finish or to report. */
  onReplayed?: (replay: RoutingReplay) => void;
  now?: () => number;
}

/**
 * THE JOURNAL AS A DOOR over the mirror's client-local rows. The window's door is synchronous and
 * the mirror's write is not, so this answers from its own copy at once and queues the writes in
 * order behind it. Its "stored" is the COPY's answer: `landed` is the disk's, and only
 * {@link holdRouting} reads it, before a press may offer Undo.
 */
interface JournalDoor extends StorageDoor {
  landed: () => Promise<DurableWrite>;
}

function journalDoor(journal: RoutingJournal): JournalDoor {
  const copy = new Map<string, string | null>();
  const last = new Map<string, Promise<DurableWrite>>();
  const write = (key: string, value: string | null): DurableWrite => {
    copy.set(key, value);
    const row = { type: ROUTING_JOURNAL_TYPE, id: key };
    const put = value === null ? journal.commitLocal([], [row]) : journal.commitLocal([{ ...row, entity: { value } }], []);
    last.set(key, put.then((): DurableWrite => "stored", (): DurableWrite => "lost"));
    return "stored";
  };
  return {
    get: (key) => {
      if (copy.has(key)) return copy.get(key) ?? null;
      const row = journal.get<{ value?: unknown }>(ROUTING_JOURNAL_TYPE, key);
      return typeof row?.value === "string" ? row.value : null;
    },
    set: (key, value) => write(key, value),
    remove: (key) => write(key, null),
    landed: async () => ((await Promise.all(last.values())).includes("lost") ? "lost" : "stored"),
  };
}

let live: RoutingWindow | null = null;
let liveDoor: JournalDoor | null = null;
const listeners = new Set<() => void>();
/** The snapshot the projection subscribes to — a NEW map per change, the store's contract. */
let snapshot: ReadonlyMap<string, Folder> = new Map();

function publish(open: readonly AnyRoutingIntent[]): void {
  const next = new Map<string, Folder>();
  for (const i of open) {
    const folder = FOLDER_OF_VIEW[i.dest];
    if (!folder) continue;
    for (const id of i.messageIds) next.set(id, folder);
  }
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
  let launched: Map<string, Promise<boolean>> | null = null;
  const win = createRoutingWindow({
    /* ONE ACCOUNT PER MIRROR: the account-keyed name is kept for its shape, not its scope. */
    door,
    key: routingIntentsKey(null),
    windowMs: deps.windowMs,
    plan: deps.plan,
    dispatch: (mutations, intent) => {
      const landed = deps.dispatch(mutations, intent).then((ok) => ok !== false, () => false);
      launched?.set(intent.id, landed);
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
    const ok = await Promise.all(done.map((i) => answers.get(i.id) ?? Promise.resolve(false)));
    const moved = done.filter((_, k) => ok[k]);
    if (moved.length > 0 || expired.length > 0) deps.onReplayed?.({ moved, expired });
  });
}

/** Commit every open window and forget the session's. */
export function closeRoutingSession(): void {
  if (!live) return;
  live.flush();
  live = null;
  liveDoor = null;
  publish([]);
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
  const out = win.open(intent);
  if (!out.held) return { ...out, sent: true };
  if ((await door.landed()) === "stored") return { ...out, sent: false };
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
 * Hold one SHEET press, with what to say once its commit is answered — on disk first, as
 * {@link holdRouting}. A press handed back for the caller to send drops its follow-up with it.
 */
export async function holdScreenRouting(
  intent: ScreenIntent, after: (a: ScreenCommitAnswer) => void,
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
