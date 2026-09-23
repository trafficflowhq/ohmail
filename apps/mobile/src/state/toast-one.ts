/**
 * WHICH SENTENCES ARE ON SCREEN — two slots, the newest in each, and nowhere for a third to wait:
 * a queue of four once held each sentence for its turn and returned the fifth unrendered.
 *
 * An entry carrying `undo` stands in the ACTION slot, any other in the NOTICE slot beneath it: a
 * notice never takes an Undo off the screen, an action replaces an action and a notice a notice.
 * A displaced offer still loses nothing but the chance to press: a held delete commits on its own
 * timer (`held-delete.ts`) and an undo dies on its own clock (`live.ts`'s `UNDO_MS`).
 */
import type { RefusalArg } from "../refusal";

/** One sentence, as the provider holds it and the pill renders it. */
export interface ToastEntry {
  id: number;
  say: RefusalArg;
  undo?: () => void;
  holdMs?: number;
}

/** The two slots as the provider holds them. */
export interface ToastSlots {
  action: ToastEntry | null;
  notice: ToastEntry | null;
}

export const NO_TOASTS: ToastSlots = Object.freeze({ action: null, notice: null });

/**
 * The show door: the incoming entry takes its own slot and the other slot is left as it stands.
 * It never keeps the entry standing in the incoming's slot — `verbs-announce.test.ts` refuses a
 * writer that can return its own input, the bounded-queue shape this replaced.
 */
export function nextToast(standing: ToastSlots, incoming: ToastEntry): ToastSlots {
  return incoming.undo
    ? { action: incoming, notice: standing.notice }
    : { action: standing.action, notice: incoming };
}

/**
 * The dismiss door, BY ID. Two callers can dismiss a sentence that is no longer the one they were
 * looking at — a displaced entry's hold timer, and an Undo press whose handler belongs to the last
 * PAINTED render — so a stale id leaves both slots standing. An id-less dismiss clears both.
 */
export function afterDismiss(standing: ToastSlots, id?: number): ToastSlots {
  if (id === undefined) return NO_TOASTS;
  if (standing.action?.id === id) return { action: null, notice: standing.notice };
  if (standing.notice?.id === id) return { action: standing.action, notice: null };
  return standing;
}

/** The gap between the Undo pill and a notice standing beneath it. */
export const STACK_GAP = 8;

/**
 * WHERE THE UNDO PILL STANDS: `lift` points above the shared anchor. A notice arriving under a
 * standing offer lifts it to clear the notice — upward only, so it moves once per arrival and never
 * back down when the notice leaves — and a press in progress defers the move to the press's end,
 * so the button is never moved from under a finger. A new offer is PLACED above a standing notice.
 */
export interface Rise {
  action: number | null;
  lift: number;
  pressing: boolean;
  pending: number;
}

export const AT_REST: Rise = Object.freeze({ action: null, lift: 0, pressing: false, pending: 0 });

export function riseForAction(action: number | null, noticeHeight: number | null): Rise {
  const lift = action !== null && noticeHeight !== null && noticeHeight > 0 ? noticeHeight + STACK_GAP : 0;
  return { action, lift, pressing: false, pending: 0 };
}

export function riseForNotice(r: Rise, noticeHeight: number): Rise {
  const want = noticeHeight + STACK_GAP;
  if (r.action === null || noticeHeight <= 0 || want <= r.lift) return r;
  return r.pressing ? { ...r, pending: Math.max(r.pending, want) } : { ...r, lift: want };
}

export function riseForPress(r: Rise, pressing: boolean): Rise {
  if (pressing) return { ...r, pressing: true };
  return { ...r, pressing: false, lift: Math.max(r.lift, r.pending), pending: 0 };
}

/** How long an act waits for its sentence to reach the screen before it goes ahead anyway. */
export const PAINT_BOUND_MS = 400;

/**
 * THE ACT WAITS FOR ITS SENTENCE TO BE ON SCREEN. Measured on the iPhone 18 Pro (FIX-022,
 * 2026-09-21): a verb that spoke and dispatched in one go had its pill drawn together with the
 * mirror's re-derivation, 1.5–8 s after the tap, and neither a microtask nor a timer between the
 * two changed that. So the order is a contract, not a scheduling hope: the pill reports its
 * layout (`onScreen`) and the door awaits `painted()` — released by that report, or by the bound,
 * whichever is first, because a sentence that never lays out may not hold an act hostage.
 */
export function paintGate(boundMs: number = PAINT_BOUND_MS): { onScreen(): void; painted(): Promise<void> } {
  const waiting = new Set<() => void>();
  return {
    onScreen() {
      for (const release of [...waiting]) release();
    },
    painted() {
      return new Promise<void>((resolve) => {
        const release = () => {
          waiting.delete(release);
          clearTimeout(bound);
          resolve();
        };
        const bound = setTimeout(release, boundMs);
        waiting.add(release);
      });
    },
  };
}
