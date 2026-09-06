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

/* ══ AND THE DIALOGS THAT NEVER REGISTER — this lane's half ═══════════════════════════════════
 *
 * Everything above is a COUNT that a dialog takes by calling {@link useModalGate}, and the
 * dispatcher suspends every key while it is held. That is the right mechanism for the session
 * dialogs, and it closes a timing gap a DOM read cannot: the count is taken inside the commit.
 *
 * It covers exactly the dialogs that opt in, and the destructive keys met three that do not:
 *
 *   · the FIRST-RUN card — `AppShell` renders it and it takes no gate, and the route deliberately
 *     leaves the Ohbox mounted underneath with an earlier selection alive, so ⌫ pressed while
 *     focus sat on a first-run button filed a message nobody could see;
 *   · the message More MENU and the contact POPOVER — their open state lives inside the
 *     components, below the shell, so nothing above them can register on their behalf. Their
 *     buttons are not typing targets and their handlers do not claim ⌫, so the key reached the
 *     message underneath the open menu.
 *
 * Making each of them call `useModalGate` would work and would be a worse rule: it is a list
 * again, and the next surface added is one nobody remembers to put on it. So the destructive
 * keys ALSO ask what is actually on screen. The two are complementary rather than redundant —
 * the count knows about dialogs whose markup this cannot recognise, and this knows about markup
 * that never registered — and {@link isModalOpen} answers for both, so a caller gets the whole
 * answer from one question.
 *
 * ── THE ONE EXCLUSION, AND WHY IT IS `matches` ────────────────────────────────────────────
 *
 * The reading sheet is `role="dialog"` and, at every width but the Zero push tier, `aria-modal`
 * (`packages/ui/src/composites/Reader.tsx`). It is not a question standing over the deck: it IS
 * the reading surface, and Backspace on the message being read is precisely the verb somebody
 * meant. So the sheet is excluded — and ONLY the sheet.
 *
 * `matches`, never `closest`: `closest` walks UP from the match, so it excluded every dialog the
 * sheet CONTAINS along with the sheet. `.senderm` is in the selector precisely so the sender
 * popover gates, and that popover opens INSIDE the reader — reader open, screening open over it,
 * and ⌫ filed the message underneath. Found by a second lane wiring its own keys to this helper,
 * 2026-09-06; the guard written for it had asserted the defect under a name describing the fix.
 *
 * ── READ AT THE PRESS, NEVER AT RENDER ────────────────────────────────────────────────────
 *
 * A DOM query cannot be a `disabled` flag: `disabled` is computed while React renders, and the
 * More menu this exists to catch opens without the shell re-rendering at all. So the consumers
 * put it in a binding's `when` — a condition ON THE EVENT — and a `false` there falls through to
 * the next binding rather than consuming the key, so a press under an open dialog is not
 * `preventDefault`ed and the dialog's own handling is untouched.
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
