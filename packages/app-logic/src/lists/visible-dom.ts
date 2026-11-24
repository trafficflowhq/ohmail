/**
 * THE DOCUMENT HOLDS PILES NOBODY CAN SEE. News and Receipts stay mounted while the reader is on
 * another pile (`kept-piles.tsx`), hidden, with their rows, cards and verb strips still in the
 * DOM. A shell query that took the document's first match could land on a hidden pile's: the `d`
 * confirm clicked the first delete strip in the document, which could be a strip left open on a
 * message in a pile the reader had left. Every such query asks here instead, and a match inside a
 * hidden pile (`[data-pile]` without `data-pile-active`) is skipped. Overlays and chrome outside
 * the piles are matched as before. `apps/webapp/test/visible-dom-census.test.ts` refuses a new raw one.
 */

const HIDDEN_PILE = "[data-pile]:not([data-pile-active])";

/** Is this element inside a pile that is not on screen? */
export function inHiddenPile(el: Element): boolean {
  return el.closest(HIDDEN_PILE) !== null;
}

/** The first match outside every hidden pile, in document order. */
export function queryVisible<E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E | null {
  for (const el of root.querySelectorAll<E>(selector)) if (!inHiddenPile(el)) return el;
  return null;
}

/** Every match outside every hidden pile, in document order. */
export function queryAllVisible<E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E[] {
  return [...root.querySelectorAll<E>(selector)].filter((el) => !inHiddenPile(el));
}
