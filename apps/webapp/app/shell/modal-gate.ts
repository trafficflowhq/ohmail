"use client";

/**
 * Is a blocking dialog open? — the fact the keymap must ask before it dispatches. `inert` is not enough, which is why
 * this file exists: `inert` stops focus, hit-testing and events dispatched INTO its subtree, but does nothing about a
 * listener bound to `document` handling an event whose target is elsewhere — and the dialog's buttons are siblings of
 * `.app-root`, not descendants. So with the session dialog open, `e` still reached `KeymapProvider`'s document
 * listener and parked the focused message; two `d` presses ran the delete ceremony (a programmatic click is not
 * blocked by `inert` either). The keymap asks a fact about the APPLICATION, not a DOM attribute; `inert` stays for
 * the tab order and hit-testing. A COUNT, not a boolean: two dialogs can overlap for one commit while React swaps
 * them, and a boolean cleared by the first would re-arm under the second.
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
 * Hold the gate for as long as `active` is true and this component is mounted. The cleanup is what
 * makes it safe: a dialog that unmounts without its own effect running still releases, because React
 * runs cleanups on unmount. Taken IN the commit, not after it: as a passive `useEffect` there was a
 * window — dialog on screen, scrim drawn, button focused — where {@link modalIsOpen} still answered
 * `false` and the keymap dispatched a mailbox verb; `useLayoutEffect` runs inside the commit, so
 * nothing can observe the gap (the same correction `MailStateProvider`'s ownership ref carries).
 * Not a render-phase increment: a render may be discarded or double-invoked (StrictMode), and a
 * count incremented by a render React throws away is a gate that never reopens.
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

/* And the dialogs that never register. The count covers exactly the dialogs that opt in, and the
 * destructive keys met three that do not: the first-run card (no gate, Ohbox mounted underneath
 * with a live selection — ⌫ filed a message nobody could see), and the More menu and contact
 * popover, whose open state lives below the shell. Making each call `useModalGate` is a list again,
 * and the next surface added is one nobody remembers — so the destructive keys ALSO ask what is on
 * screen. Complementary, not redundant: the count knows dialogs whose markup this cannot recognise,
 * this knows markup that never registered; {@link isModalOpen} answers for both.
 */

/* The one exclusion is the reading sheet (`role="dialog"`, `aria-modal` at most widths): it IS the
 * reading surface, and Backspace on the message being read is the verb somebody meant. `matches`,
 * never `closest`: `closest` walks up from the match, so it excluded every dialog the sheet
 * CONTAINS — reader open, screening popover over it, and ⌫ filed the message underneath (found by a
 * second lane, 2026-09-06; `.senderm` is in the selector precisely so that popover gates). Read at
 * the press, never at render: a DOM query cannot be a `disabled` flag — the More menu opens without
 * the shell re-rendering — so consumers put it in a binding's `when`, and a `false` falls through
 * to the next binding rather than consuming the key.
 */

/**
 * What counts. `role="menu"` is here for the More menu and `alertdialog` for the delete confirm
 * and the session cards — the same three the zone model already names (`zone-nav.tsx`) — plus
 * `aria-modal` for anything that claims the page without taking a role this list knows. The two
 * popover CLASSES are belt: both already carry `role="dialog"` (`ContactPopover.tsx`,
 * `SenderMenu.tsx`), and they are named anyway because a popover that loses its role in a
 * refactor must not silently lose its gate with it.
 */
export const MODAL_SELECTOR =
  '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], .cpop, .senderm';

/** The reading sheet itself. See the header for why the exclusion is `matches` and not `closest`. */
export const READING_SURFACE = ".reader";

/**
 * Visible enough to be a question.
 *
 * Deliberately NOT `offsetParent`, which is null for everything in jsdom and would make every
 * guard in the test suite pass for the wrong reason. These three are what the app actually uses
 * to park an overlay without unmounting it, and each is readable in both environments.
 */
function showing(el: Element): boolean {
  if ((el as HTMLElement).hidden === true) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const view = el.ownerDocument?.defaultView;
  if (view) {
    const style = view.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/**
 * Is anything standing over the deck — registered OR merely on screen?
 *
 * The registered count is consulted first because it is the cheaper question and because a
 * dialog that took the gate is blocking whether or not its markup is one this file recognises.
 */
export function isModalOpen(doc: Document): boolean {
  if (modalIsOpen()) return true;
  for (const el of Array.from(doc.querySelectorAll(MODAL_SELECTOR))) {
    /* THE SHEET ITSELF, AND NOTHING INSIDE IT. `matches`, never `closest`: `closest` walks up and
       so excluded every dialog the sheet CONTAINS, which is the opposite of the rule this file
       states — and the popovers that open inside the reader are exactly the ones `.senderm` is in
       the selector for. See the header. */
    if (el.matches(READING_SURFACE)) continue;
    if (!showing(el)) continue;
    return true;
  }
  return false;
}
