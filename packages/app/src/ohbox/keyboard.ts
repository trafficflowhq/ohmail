/**
 * THE KEYBOARD AT THE OHBOX'S LIST: where the list's parts stand in the frame, and the two rules that keep the
 * keyboard with the list (a verb that takes the focused row away leaves the focus on the row the cursor went to; a
 * layer the list opened gives the keyboard back) and move it with the cursor.
 *
 * The page is read through an element of the place's own (`page`): shared code touches no global.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

/** The document the place is drawn in; null until an element of it stands. */
export type Page = () => Document | null;

/** Where the list's parts stand, as the keyboard's rules find them. */
export interface OhboxAt {
  /** The list's column: its head, its rows, its foot. */
  readonly list: string;
  /** The reading column's focus and scroll target. */
  readonly reading: string;
  /** A layer the list opens over the page (a dialog, a menu): the keyboard comes back from it. */
  readonly layer: string;
}

/**
 * The frame's own two sections. The reading column's target is the reading sheet's scroller, which the reader finds
 * by the same name (its `read-dom.ts`) until the kit hands the part out. Where one column stands, the reading column
 * over the list is the layer a row opened, and gives the keyboard back to it.
 */
export const SEATED: OhboxAt = {
  list: "section.fr-list",
  reading: "section.fr-reading .oh-sheet-scroll",
  layer:
    'section.fr-reading[data-over], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]',
};

const ROW = `${SEATED.list} .oh-row[data-id]`;
const ROW_SLOT = `${SEATED.list} .oh-row-slot`;
const SCROLLER = `${SEATED.list} .ob-scroll`;
const OPEN_ROW = `${SEATED.list} .oh-row[data-open]`;

/** A letter's row in the list, by the id it carries (read off the rows: an id is never spelled into a selector). */
export function rowOf(doc: Document, id: string): HTMLElement | null {
  for (const row of doc.querySelectorAll<HTMLElement>(ROW)) if (row.dataset.id === id) return row;
  return null;
}

/** The keyboard back on the list: the row the cursor is on, else the list itself. */
function focusTheList(doc: Document): void {
  const to = doc.querySelector<HTMLElement>(OPEN_ROW) ?? doc.querySelector<HTMLElement>(SCROLLER);
  to?.focus({ preventScroll: true });
}

/** What the keeper remembers between two moves of the keyboard. */
interface Kept {
  /** The keyboard was in the list. */
  home: boolean;
  layerFromList: boolean;
  /** What held the keyboard when a layer opened over the list: where the layer gives it back. */
  opener: HTMLElement | null;
  /** What a closing layer gave the keyboard to while it is owed to the opener: it never becomes an opener itself. */
  standIn: HTMLElement | null;
  last: HTMLElement | null;
  /* A row's own verbs (its Done, its menu button), as they took the keyboard. One taken away is the frame's to land
     (`focus-follows`: the row after it, else the row before it): the keeper stands down. */
  readonly rowVerbs: WeakSet<HTMLElement>;
}

const frameLands = (k: Kept, was: HTMLElement | null): boolean =>
  was !== null && !was.isConnected && k.rowVerbs.has(was);

/** What held the keyboard was taken away, and the list is where it goes back to. */
function owed(k: Kept): boolean {
  const was = k.last;
  if (was === null || was.isConnected || frameLands(k, was)) return false;
  return k.home || (was.closest(SEATED.layer) !== null && k.layerFromList);
}

/**
 * Where the keyboard goes back to: the opener while a layer just closed and the opener is a control that stands;
 * the cursor's row otherwise (a row that opened a layer may no longer be the cursor's).
 */
function backTo(k: Kept, doc: Document): () => void {
  const was = k.last;
  const to = k.opener;
  const fromLayer = was !== null && !was.isConnected && was.closest(SEATED.layer) !== null;
  if (fromLayer && to !== null && to.isConnected && !to.matches(ROW))
    return () => to.focus({ preventScroll: true });
  return () => focusTheList(doc);
}

function onFocusIn(k: Kept, doc: Document, event: FocusEvent): void {
  const el = event.target instanceof HTMLElement && event.target !== doc.body ? event.target : null;
  if (el === null) return;
  if (!el.matches(ROW) && el.closest(ROW_SLOT) !== null) k.rowVerbs.add(el);
  if (owed(k) && !el.closest(SEATED.layer)) {
    const back = backTo(k, doc);
    const opened = k.opener;
    k.last = el;
    k.home = true;
    if (el === opened) return;
    k.standIn = el;
    /* A layer that opened in the same commit (an ask after its menu) holds the keyboard: the hand-on stands down. */
    queueMicrotask(() => {
      if (doc.activeElement?.closest(SEATED.layer) == null) back();
    });
    return;
  }
  const was = k.last;
  k.last = el;
  if (el.closest(SEATED.layer)) {
    const entering = was === null || !was.isConnected || was.closest(SEATED.layer) === null;
    if (entering) k.layerFromList = was === null || k.home;
    /* A layer opened from a layer that has gone (More's Delete opens the ask), or from the stand-in it left the
       keyboard on, keeps the first one's opener. */
    const fromControl = was === null || (was.closest(SEATED.layer) === null && was !== k.standIn);
    if (entering && fromControl) k.opener = was?.isConnected ? was : null;
    return;
  }
  k.standIn = null;
  k.home = el.closest(SEATED.list) !== null;
}

/**
 * The keyboard let go (a blur to the page, the element still standing): nothing holds it, and the walk that follows
 * moves the cursor only, never the focus.
 */
function onFocusOut(k: Kept, doc: Document, event: FocusEvent): void {
  const el = event.target;
  if (!(el instanceof HTMLElement) || event.relatedTarget !== null) return;
  queueMicrotask(() => {
    const now = doc.activeElement;
    if (!el.isConnected || k.last !== el || (now !== null && now !== doc.body)) return;
    k.last = null;
    k.home = false;
    k.layerFromList = false;
  });
}

/**
 * What held the keyboard outside the list was taken away (a report's Undo, pressed or its window ended) and the
 * focus fell to the page: it lands on the cursor's row, else on the list, as `focus-follows` does. Its own return (a
 * surface back to its opener) and a standing modal go first.
 */
function onTakenAway(k: Kept, doc: Document): void {
  const was = k.last;
  if (was === null || was.isConnected || frameLands(k, was)) return;
  queueMicrotask(() => {
    const now = doc.activeElement;
    if ((now !== null && now !== doc.body) || k.last !== was) return;
    if (doc.querySelector('[aria-modal="true"]') !== null) return;
    k.home = true;
    focusTheList(doc);
  });
}

/**
 * THE LIST KEEPS THE KEYBOARD (the frame's one focus rule, for the list's own rows). While the keyboard was in the
 * list, a verb that takes the focused row away (`e`, `a`, a re-filing `u`) leaves the focus on the row the cursor
 * went to, or on the list where no cursor stands, never on the page. A row's own verb taken away (its Done) is the
 * frame's to land: the row after it, else the row before it. A layer opened from the list or from nothing (the
 * letter over the list on one column, a menu) gives the keyboard back when it closes: to the control in the list's
 * column that opened it (the head's menu button, the selection's More, Move or Tag), as the kit's menus do, and to
 * the cursor's row where a row or nothing opened it. Focus that comes back to the opener stays there; it is moved
 * only when it fell to the page or to an element that is not the opener (the foot a menu anchors on), and not once a
 * layer holds the keyboard again (More's Delete opens the ask). A layer opened from that stand-in keeps the opener.
 * A person's own move elsewhere ends it.
 */
export function useListKeepsKeyboard(page: Page): void {
  const kept = useRef<Kept>({
    home: false,
    layerFromList: false,
    opener: null,
    standIn: null,
    last: null,
    rowVerbs: new WeakSet(),
  });
  useEffect(() => {
    const doc = page();
    if (doc === null) return;
    const k = kept.current;
    const focusIn = (event: FocusEvent): void => onFocusIn(k, doc, event);
    const focusOut = (event: FocusEvent): void => onFocusOut(k, doc, event);
    doc.addEventListener("focusin", focusIn);
    doc.addEventListener("focusout", focusOut);
    const lost = new MutationObserver(() => onTakenAway(k, doc));
    lost.observe(doc.body, { childList: true, subtree: true });
    return () => {
      doc.removeEventListener("focusin", focusIn);
      doc.removeEventListener("focusout", focusOut);
      lost.disconnect();
    };
  }, [page]);
  /* After every commit: a focused row or layer this commit removed left the focus on the page. */
  useLayoutEffect(() => {
    const doc = page();
    if (doc === null) return;
    const k = kept.current;
    const cur = doc.activeElement;
    if (cur instanceof HTMLElement && cur !== doc.body && cur.isConnected) return;
    if (frameLands(k, k.last)) return;
    if (!k.home && !owed(k)) return;
    const back = backTo(k, doc);
    k.home = true;
    back();
  });
}

/**
 * FOCUS FOLLOWS THE CURSOR while it stands on a row or on the list: `j` moved the open row, so a focused row (or the
 * list a verb left it on) hands its focus to the new one. Focus elsewhere (a field, the reading column, the body) is
 * never taken.
 */
export function useRowFocusFollow(openId: string | null, page: Page): void {
  useEffect(() => {
    const doc = page();
    if (openId === null || doc === null) return;
    const cur = doc.activeElement;
    if (!(cur instanceof HTMLElement) || !(cur.matches(ROW) || cur.matches(SCROLLER))) return;
    if (cur.dataset.id === openId) return;
    const next = rowOf(doc, openId);
    if (next && next !== cur) next.focus({ preventScroll: true });
  }, [openId, page]);
}
