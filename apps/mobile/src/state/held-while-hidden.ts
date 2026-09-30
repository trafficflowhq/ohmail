/**
 * A SCREEN NOBODY SEES DERIVES NOTHING. A list screen that stays mounted under a pushed reader
 * would re-derive its lists on every change the reader makes — the read, the hold's release — for
 * a frame nobody draws. While hidden it keeps what it last showed; shown again, it reads once.
 * `read` is called only when the screen is shown or has never been drawn.
 */
export function heldWhileHidden<T>(shown: boolean, last: T | null, read: () => T): T {
  return shown || last === null ? read() : last;
}
