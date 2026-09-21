/**
 * WHICH SENTENCE IS ON SCREEN — the newest, always, and there is nowhere for a second to wait
 * (owner ruling 2026-09-21, closing `MOBILE-TOAST-QUEUE-SILENTLY-DROPS-A-VERBS-SENTENCE`: a
 * queue of four held each sentence for its turn and returned the fifth unrendered).
 *
 * Safe because a sentence REPORTS a dispatch that already happened: a held delete commits on
 * its own timer (`held-delete.ts`) and an undo offer dies on its own clock (`live.ts`'s
 * `UNDO_MS`, read at the press); neither consults the pill. What a displaced sentence costs is
 * the CHANCE to press Undo, and that is the trade.
 */
import type { RefusalArg } from "../refusal";

/** One sentence, as the provider holds it and the pill renders it. */
export interface ToastEntry {
  id: number;
  say: RefusalArg;
  undo?: () => void;
  holdMs?: number;
}

/**
 * The show door. It takes what is standing only to say, in one place, that it never keeps it —
 * a writer that can return its own input is the bounded-queue shape this replaces, and
 * `verbs-announce.test.ts` refuses one by name.
 */
export function nextToast(_standing: ToastEntry | null, incoming: ToastEntry): ToastEntry {
  return incoming;
}

/**
 * The dismiss door, BY ID. The pill hands its own id back because two callers can dismiss a
 * sentence that is no longer the one they were looking at: the hold timer of a displaced entry,
 * and an Undo press whose handler belongs to the last PAINTED render while state already holds a
 * newer sentence. Either would take the new one off the screen a moment after it arrived. An
 * id-less dismiss clears whatever stands, which is what a caller with no entry in hand means.
 */
export function afterDismiss(standing: ToastEntry | null, id?: number): ToastEntry | null {
  if (standing === null) return null;
  if (id !== undefined && standing.id !== id) return standing;
  return null;
}
