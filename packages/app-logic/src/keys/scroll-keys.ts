/**
 * The keys with which the browser itself scrolls a focused scroller.
 *
 * Deliberately NOT the app's navigation letters. `j`/`k` in Reads and
 * Receipts move the cursor and then call `scrollTo` on the stream, so
 * treating a keypress as scroll intent would let a j-sweep mark every card
 * it flew past — the same defect through a different door.
 */
export const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "PageDown",
  "PageUp",
  "Home",
  "End",
  "ArrowDown",
  "ArrowUp",
  " ",
  "Spacebar",
]);
