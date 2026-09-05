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

import { useEffect, useLayoutEffect } from "react";

/**
 * `useLayoutEffect` in a browser; `useEffect` where there is nothing to commit. The shell's own
 * idiom (`MailStateProvider`, `older-mail.ts`, `attachments.ts`), chosen at module scope for its
 * two reasons: hooks must be the same hook on every render, and a bare `useLayoutEffect` in a
 * server render is a `console.error` (Next pre-renders client components), which the
 * zero-console-errors rule refuses.
 */
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
 *
 * ── AND IT IS TAKEN IN THE COMMIT, NOT AFTER IT ────────────────────────────────────────────
 *
 * This was a passive `useEffect`, and a passive effect is scheduled AFTER the commit that
 * painted the dialog. So there was a window — one in which the dialog is on screen, its scrim
 * is drawn and its button is focused — where {@link modalIsOpen} still answered `false` and the
 * keymap dispatched a mailbox verb. The whole reason this file exists is that a screen saying
 * the session is in question must not park or delete mail, and a gate that opens one frame late
 * is that defect with a smaller window rather than without one.
 *
 * `useLayoutEffect` runs INSIDE the commit, in the same synchronous block as the render that
 * produced it, so nothing — not a key event, not a microtask — can observe the gap. The same
 * correction `MailStateProvider`'s ownership ref carries, for the same reason.
 *
 * Not a render-phase increment, which would be the only way to be earlier still: a render may be
 * discarded or double-invoked (StrictMode), and a count incremented by a render React throws
 * away is a gate that never reopens.
 */
export function useModalGate(active: boolean): void {
  useCommitEffect(() => {
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
