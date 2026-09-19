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
