"use client";

/**
 * A DURABLE WRITE THAT DID NOT LAND SAYS SO.
 *
 * Every store the durability slice added swallowed its own write failure, so in a private window
 * or against a full quota a "durable" decision silently became the in-memory one it replaced —
 * with the undo window still on offer over a record nobody holds. The class shares one property:
 * the caller could not tell "persisted" from "not". So a write answers, the caller degrades (see
 * `screener-state.ts#decide` and `delete-undo.ts`), and the shell says once that this browser is
 * not keeping decisions between reloads.
 *
 * The signal is a `window` event rather than a callback set because a store here is a plain
 * function called from a key handler, with no React on either side; `window` is the one bus the
 * store and the shell both already reach. The NOTICE is once per session — a latch, not a
 * counter — while the event fires on every lost write, because each caller has its own
 * degradation to run.
 */

/** Did the value reach the jar. */
export type DurableWrite = "stored" | "lost";

export const DURABILITY_LOST_EVENT = "ohmail:durability-lost";

/** Which store lost the write. For a log line, never for the sentence — see the notice's copy. */
export interface DurabilityLostDetail {
  store: string;
}

export class DurabilityLostEvent extends CustomEvent<DurabilityLostDetail> {
  constructor(detail: DurabilityLostDetail) {
    super(DURABILITY_LOST_EVENT, { detail });
  }
}

/** A write has been lost in this session. Never returns to false — see {@link durabilityLost}. */
let announced = false;
/** The reader has put the notice away. Only ever set once, and only by them. */
let dismissed = false;

/**
 * IS THERE A NOTICE TO DRAW. `announced && !dismissed`, which is what makes it once per session:
 * a dismissal cannot be undone by the next failed write, and a failed write before the shell
 * mounted is still on screen afterwards.
 */
export function durabilityLost(): boolean {
  return announced && !dismissed;
}

/** Put the notice away for the rest of this session. */
export function dismissDurabilityLost(): void {
  if (dismissed) return;
  dismissed = true;
  raise({ store: "dismissed" });
}

function raise(detail: DurabilityLostDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new DurabilityLostEvent(detail));
}

function lost(store: string): DurableWrite {
  announced = true;
  raise({ store });
  return "lost";
}

/** Write one key, and say whether it landed. */
export function durableSet(key: string, value: string, store: string): DurableWrite {
  try {
    window.localStorage.setItem(key, value);
    return "stored";
  } catch {
    return lost(store);
  }
}

/**
 * Remove one key, and say whether it landed.
 *
 * A refused REMOVE is reported like a refused write: a jar that will not drop a spent record is
 * a jar whose next read offers it again, which is the same fact about the browser.
 */
export function durableRemove(key: string, store: string): DurableWrite {
  try {
    window.localStorage.removeItem(key);
    return "stored";
  } catch {
    return lost(store);
  }
}

/** Test seam: forget this session's answer. Never called by product code. */
export function resetDurabilityForTest(): void {
  announced = false;
  dismissed = false;
}
