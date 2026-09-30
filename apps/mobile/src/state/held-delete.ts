/**
 * The delete window's held set — the phone's port of the webapp's delayed commit
 * (`delete-undo.ts`): there is no un-delete on the wire, so a confirmed delete HIDES the row,
 * the pill carries Undo while the window runs, and the mutation dispatches only when the
 * window closes. One press is one id (the phone deletes from the reading screen, never over a
 * selection); the projection subtracts {@link heldDeleteIds} from every presented list, and
 * Undo restores the row by forgetting the id — the mirror kept it the whole time. DURABLE: the
 * press is a client-local row in the account's mirror (`held-journal.ts`, the routing window's
 * door) before its Undo is offered, and the next launch commits what a kill left and says so.
 */
import { logLaunchReplay } from "../engine/engine-log";
import { refuse, type Refusal, type RefusalArg } from "../refusal";
import { HELD_PRESS_TTL_MS, journalDoor, type HeldJournal, type JournalDoor } from "./held-journal";

/** The disk's answer, as the journal door gives it (the engine's type, through the one door). */
type DurableWrite = Awaited<ReturnType<JournalDoor["landed"]>>;

/**
 * THE WEBAPP'S ROW GRAMMAR (`delete-intents.ts`), one delete shape across surfaces: a press id,
 * the ids it named, the press's clock and the held verb. `kind` absent is a delete; a verb this
 * build does not know is dropped rather than replayed as a delete.
 */
interface DeleteIntent {
  id: string;
  messageIds: string[];
  at: number;
  kind?: "delete";
}

/** The webapp's key under its prefix; one account per mirror, so the key ends in `local`. */
export const DELETE_INTENTS_KEY = "ohmail.delete.intents.local";

interface HeldPress {
  timer: ReturnType<typeof setTimeout>;
  commit: () => unknown;
  /** The journal this press was written to — its row is cleared there, whatever session follows. */
  door: JournalDoor | null;
}

const held = new Map<string, HeldPress>();
/**
 * Presses whose Undo is saving: disarmed, still out of the lists, never flushed as a delete — and
 * never READ as a row ({@link readRows}). Module state, so it outlives a session reopened over the
 * same mirror: that session's replay would otherwise send a press the person just took back.
 */
const undoing = new Set<string>();
const listeners = new Set<() => void>();
/** The snapshot the projection subscribes to — a NEW set per change, `useSyncExternalStore`'s contract. */
let snapshot: ReadonlySet<string> = new Set();
/** The open session's journal, or `null` before one opens — a press then has no record. */
let session: { door: JournalDoor; now: () => number } | null = null;

function publish(): void {
  snapshot = new Set([...held.keys(), ...undoing]);
  for (const cb of listeners) cb();
}

function readRows(door: JournalDoor): DeleteIntent[] {
  try {
    const raw = door.get(DELETE_INTENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: DeleteIntent[] = [];
    for (const r of parsed) {
      if (typeof r !== "object" || r === null) continue;
      const row = r as Partial<DeleteIntent> & { kind?: unknown };
      if (row.kind !== undefined && row.kind !== "delete") continue;
      if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue;
      const ids = Array.isArray(row.messageIds)
        ? row.messageIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
      if (ids.length === 0) continue;
      // A row under undo is already taken back: never replayed, never written back by a rewrite.
      if (typeof row.id === "string" && undoing.has(row.id)) continue;
      out.push({ id: typeof row.id === "string" && row.id.length > 0 ? row.id : ids[0]!, messageIds: ids, at: row.at, kind: "delete" });
    }
    return out;
  } catch {
    return [];
  }
}

function writeRows(door: JournalDoor, rows: readonly DeleteIntent[]): void {
  if (rows.length === 0) door.remove(DELETE_INTENTS_KEY);
  else door.set(DELETE_INTENTS_KEY, JSON.stringify(rows));
}

function forgetRow(door: JournalDoor | null, pressId: string): void {
  if (door === null) return;
  const rows = readRows(door);
  const kept = rows.filter((r) => r.id !== pressId);
  if (kept.length !== rows.length) writeRows(door, kept);
}

/** Commit, then clear the row once the dispatch has SETTLED — the outbox holds it from then on. */
function settle(pressId: string, press: HeldPress): void {
  const done = (): void => { forgetRow(press.door, pressId); };
  let sent: unknown;
  try {
    sent = press.commit();
  } catch {
    done();
    return;
  }
  void Promise.resolve(sent).then(done, done);
}

export function subscribeHeldDeletes(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function heldDeleteIds(): ReadonlySet<string> {
  return snapshot;
}

/**
 * Open the window over one id, its row written first. A second press on a held id re-arms
 * nothing — the first window stands (pressing Delete twice is one delete, and re-arming would
 * stretch the promise the first pill made). `commit` runs exactly once: the timer, a flush, or a
 * session teardown, whichever comes first; Undo disarms it.
 */
export function armHeldDelete(id: string, windowMs: number, commit: () => unknown): void {
  if (held.has(id)) return;
  const door = session?.door ?? null;
  if (door !== null && session !== null) {
    const rows = readRows(door).filter((r) => r.id !== id && !r.messageIds.includes(id));
    writeRows(door, [...rows, { id, messageIds: [id], at: session.now(), kind: "delete" }]);
  }
  const press: HeldPress = {
    commit,
    door,
    timer: setTimeout(() => {
      held.delete(id);
      publish();
      settle(id, press);
    }, windowMs),
  };
  held.set(id, press);
  publish();
}

/**
 * Take the press back: `null` when no window was open (nothing restored is not an undo), else the
 * disk's answer. The timer is disarmed and the row's removal written in the same synchronous act;
 * the row stays out of the lists until that removal LANDED, because until then the next launch
 * would still delete it. `lost`: the delete the undo could not take back is committed now.
 */
export function undoHeldDelete(id: string): Promise<DurableWrite> | null {
  const press = held.get(id);
  if (!press) return null;
  clearTimeout(press.timer);
  held.delete(id);
  if (press.door === null) { publish(); return Promise.resolve("stored"); }
  // The removal FIRST: once the id is under undo, {@link readRows} no longer sees its row.
  forgetRow(press.door, id);
  undoing.add(id);
  publish();
  return press.door.landed().then((stored) => {
    undoing.delete(id);
    publish();
    if (stored !== "stored") settle(id, press);
    return stored;
  });
}

/** Commit every open window now — backgrounding, and the session teardown. Leaving is not undo. */
export function flushHeldDeletes(): void {
  const open = [...held.entries()];
  held.clear();
  for (const [, press] of open) clearTimeout(press.timer);
  publish();
  for (const [id, press] of open) settle(id, press);
}

/** What a launch finished of the presses a killed session left. Counted in messages. */
export interface DeleteReplay {
  moved: number;
  expired: number;
  refused: number;
}

/**
 * WHAT A LAUNCH SAYS about the deletes a killed session left — the Move's replay sentence naming
 * Trash, and the ones past the horizon it did not make. A refusal has already said itself.
 */
export function deleteReplaySay(r: DeleteReplay): Refusal[] {
  const out: Refusal[] = [];
  if (r.moved > 0) out.push(refuse("routingReplayedTo", r.moved, refuse("trashTitle")));
  if (r.expired > 0) out.push(refuse("deleteReplayExpired", r.expired));
  return out;
}

/** The same, with the launch's one line in the engine log — what a device run reads it by. */
export function sayDeleteReplay(r: DeleteReplay): Refusal[] {
  const says = deleteReplaySay(r);
  logLaunchReplay(r.moved, r.refused, r.expired, says.length);
  return says;
}

export interface DeleteSessionDeps {
  /** The account's mirror. REQUIRED: a defaulted jar is how a surface stops keeping records. */
  journal: HeldJournal;
  /**
   * The quiet commit a stranded press is sent through — re-read against the mirror at the
   * commit: `"nothing"` where the message is no longer there, `false` for a refusal the
   * dispatch has already said.
   */
  dispatch: (messageId: string) => Promise<boolean | void | "nothing">;
  /** Called once per launch that finished or dropped presses a killed session left. */
  onReplayed?: (replay: DeleteReplay) => void;
  now?: () => number;
}

/**
 * OPEN THE SESSION'S DELETE WINDOW, and finish what the last one left — BEFORE the lists paint,
 * elapsed or not: past its window a press was owed, and inside it the Undo died with the toast
 * that carried it. Past the outbox's horizon a press is not made, and said.
 */
export function openDeleteSession(deps: DeleteSessionDeps): void {
  closeDeleteSession();
  const door = journalDoor(deps.journal);
  const now = deps.now ?? Date.now;
  session = { door, now };
  const rows = readRows(door);
  if (rows.length === 0) return;
  const at = now();
  const live = rows.filter((r) => at - r.at <= HELD_PRESS_TTL_MS);
  const expired = rows.filter((r) => at - r.at > HELD_PRESS_TTL_MS)
    .reduce((n, r) => n + r.messageIds.length, 0);
  if (live.length !== rows.length) writeRows(door, live);
  const answers = live.map(async (r) => {
    const oks = await Promise.all(r.messageIds.map((m) => deps.dispatch(m).then((ok) => ok, () => false as const)));
    forgetRow(door, r.id);
    return oks;
  });
  void Promise.all(answers).then((all) => {
    const flat = all.flat();
    const moved = flat.filter((ok) => ok !== false && ok !== "nothing").length;
    const refused = flat.filter((ok) => ok === false).length;
    if (moved > 0 || expired > 0 || refused > 0) deps.onReplayed?.({ moved, expired, refused });
  });
}

/** Commit every open window and forget the session's journal. */
export function closeDeleteSession(): void {
  flushHeldDeletes();
  session = null;
}

/**
 * What a delete press wires up — the ceremony one place owns so the DEVICE PATH (the world
 * provider's arm) is the thing a test drives, not a naive double (the 0.20 review's device defect:
 * the pill never rendered on device because the reader navigated away in the same tick the
 * window opened — a confirmed delete used to fire `onClose` at once, on the old immediate-
 * tombstone assumption the delayed commit broke). `onCommitted` is the navigation, and it
 * belongs to the WINDOW's close, never the press: the reader stays open over the pill for the
 * whole window (exactly as Later/Park do, whose pills render), and leaves only when the delete
 * actually commits — or never, if Undo took it back.
 */
export interface DeleteCeremony {
  id: string;
  windowMs: number;
  /** The screens' toast — sentence plus the pill's Undo and its hold. */
  toast: (say: RefusalArg, opts?: { undo?: () => void; holdMs?: number }) => void;
  deleted: RefusalArg;
  /** Said once the undo is ON DISK — never at the press, or a kill could make it false. */
  undone: RefusalArg;
  /** Said when the undo could not be saved and the delete went ahead. */
  undoLost: RefusalArg;
  /** The QUIET wire dispatch at the window's close — the pill already spoke "Moved to Trash." */
  dispatchQuiet: () => unknown;
  /** Leave the reader when the delete COMMITS (window closed), never at the press, never on Undo. */
  onCommitted?: () => void;
}

/**
 * THE PRESS: the row leaves the lists at once and its record is written; the Undo is offered only
 * once that record is ON DISK — a record that did not land (or no session to write it to) commits
 * the delete now, with the sentence and no Undo it could not honour.
 */
export async function runDeleteCeremony(d: DeleteCeremony): Promise<void> {
  const door = session?.door ?? null;
  armHeldDelete(d.id, d.windowMs, () => {
    // The window closed: navigate away THEN send, so the reader unmounts before the tombstone
    // could paint "no longer here". Undo never reaches here — `undoHeldDelete` disarms the timer.
    d.onCommitted?.();
    return d.dispatchQuiet();
  });
  const stored = door === null ? "lost" : await door.landed();
  if (stored !== "stored") {
    const press = held.get(d.id);
    if (press) {
      clearTimeout(press.timer);
      held.delete(d.id);
      publish();
      settle(d.id, press);
    }
    d.toast(d.deleted);
    return;
  }
  if (!held.has(d.id)) { d.toast(d.deleted); return; }
  d.toast(d.deleted, {
    holdMs: d.windowMs,
    // Nothing restored is not an undo; the sentence waits for the disk's answer.
    undo: () => {
      void undoHeldDelete(d.id)?.then((stored) => d.toast(stored === "stored" ? d.undone : d.undoLost));
    },
  });
}
