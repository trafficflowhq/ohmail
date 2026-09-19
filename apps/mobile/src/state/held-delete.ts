/**
 * The delete window's held set — the phone's port of the webapp's delayed commit
 * (`delete-undo.ts`): there is no un-delete on the wire, so a confirmed delete HIDES the row,
 * the pill carries Undo while the window runs, and the mutation dispatches only when the
 * window closes. One press is one id (the phone deletes from the reading screen, never over a
 * selection); the projection subtracts {@link heldDeleteIds} from every presented list, and
 * Undo restores the row by forgetting the id — the mirror kept it the whole time. NOT DURABLE,
 * stated: leaving the app commits ({@link flushHeldDeletes}, the provider's AppState listener);
 * a hard kill inside the window loses the PRESS, not the mail. The gap row names it.
 */
import type { RefusalArg } from "../refusal";

interface HeldPress {
  timer: ReturnType<typeof setTimeout>;
  commit: () => void;
}

const held = new Map<string, HeldPress>();
const listeners = new Set<() => void>();
/** The snapshot the projection subscribes to — a NEW set per change, `useSyncExternalStore`'s contract. */
let snapshot: ReadonlySet<string> = new Set();

function publish(): void {
  snapshot = new Set(held.keys());
  for (const cb of listeners) cb();
}

export function subscribeHeldDeletes(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function heldDeleteIds(): ReadonlySet<string> {
  return snapshot;
}

/**
 * Open the window over one id. A second press on a held id re-arms nothing — the first window
 * stands (pressing Delete twice is one delete, and re-arming would stretch the promise the
 * first pill made). `commit` runs exactly once: the timer, a flush, or a session teardown,
 * whichever comes first; Undo disarms it.
 */
export function armHeldDelete(id: string, windowMs: number, commit: () => void): void {
  if (held.has(id)) return;
  const press: HeldPress = {
    commit,
    timer: setTimeout(() => {
      held.delete(id);
      publish();
      commit();
    }, windowMs),
  };
  held.set(id, press);
  publish();
}

/** Take the press back. `true` only when a window was open — nothing restored is not an undo. */
export function undoHeldDelete(id: string): boolean {
  const press = held.get(id);
  if (!press) return false;
  clearTimeout(press.timer);
  held.delete(id);
  publish();
  return true;
}

/** Commit every open window now — backgrounding, and the session teardown. Leaving is not undo. */
export function flushHeldDeletes(): void {
  const open = [...held.entries()];
  held.clear();
  for (const [, press] of open) clearTimeout(press.timer);
  publish();
  for (const [, press] of open) press.commit();
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
  undone: RefusalArg;
  /** The QUIET wire dispatch at the window's close — the pill already spoke "Moved to Trash." */
  dispatchQuiet: () => void;
  /** Leave the reader when the delete COMMITS (window closed), never at the press, never on Undo. */
  onCommitted?: () => void;
}

export function runDeleteCeremony(d: DeleteCeremony): void {
  armHeldDelete(d.id, d.windowMs, () => {
    // The window closed: navigate away THEN send, so the reader unmounts before the tombstone
    // could paint "no longer here". Undo never reaches here — `undoHeldDelete` disarms the timer.
    d.onCommitted?.();
    d.dispatchQuiet();
  });
  d.toast(d.deleted, {
    holdMs: d.windowMs,
    // Nothing restored is not an undo — the sentence rides only a window that took.
    undo: () => { if (undoHeldDelete(d.id)) d.toast(d.undone); },
  });
}
