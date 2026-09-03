"use client";

/**
 * ═══ IS A BLOCKING DIALOG OPEN? — the fact the keymap has to ask before it dispatches ══════
 *
 * ── WHY `inert` IS NOT ENOUGH, WHICH IS THE WHOLE REASON THIS FILE EXISTS ──────────────────
 *
 * The session dialogs declare `role="alertdialog"` with `aria-modal="true"` over a fixed,
 * scrimmed layer, and the first attempt at making that claim true set `inert` on `.app-root`.
 * `inert` does exactly what it says for the subtree it is on: no focus, no hit-testing, no
 * events dispatched INTO it. It does nothing about a listener bound to `document` handling an
 * event whose target is somewhere else — and the dialog's own buttons are exactly somewhere
 * else, being siblings of `.app-root` rather than descendants of it.
 *
 * So with the dialog open and focus correctly on its Try again button, `e` still reached
 * `KeymapProvider`'s document listener, the mailbox binding was still registered, and the
 * focused message was parked. Two `d` presses ran the delete ceremony, which finishes by
 * programmatically clicking its own danger button — and a programmatic click is not blocked by
 * `inert` either. A screen that says the session is in question could quietly delete mail.
 *
 * The keymap therefore asks a question instead of trusting a DOM attribute: is a modal open?
 * That is a fact about the application, not about a node, and it survives every difference
 * between where a listener is bound and where an event happened to originate.
 *
 * `inert` STAYS, and the two are not redundant: `inert` is what takes the background out of
 * the tab order and out of hit-testing, which this cannot do. This is what stops the keys.
 *
 * ── A COUNT, NOT A BOOLEAN ─────────────────────────────────────────────────────────────────
 *
 * Two dialogs can legitimately overlap for one commit while React swaps them, and a boolean
 * that the first one clears on unmount would re-arm the mailbox underneath the second. The
 * count closes only when the last dialog has gone.
 */

import { useEffect } from "react";

let open = 0;

/** Is a blocking dialog on screen right now? Read by the keymap before every dispatch. */
export function modalIsOpen(): boolean {
  return open > 0;
}

/**
 * Hold the gate for as long as `active` is true and this component is mounted.
 *
 * The cleanup is what makes it safe: a dialog that unmounts without its own effect running —
 * a route change, an error boundary — still releases, because React runs cleanups on unmount.
 */
export function useModalGate(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    open += 1;
    return () => {
      open = Math.max(0, open - 1);
    };
  }, [active]);
}

/** Test seam: put the gate back to its resting state between cases. */
export function resetModalGateForTests(): void {
  open = 0;
}
