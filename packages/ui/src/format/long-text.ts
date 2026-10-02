/**
 * HOW MUCH OF A MESSAGE BODY ONE PAINT LAYS OUT. A 2 MiB plain-text body drawn whole held the
 * window's main thread 0.8-1.0 s on WebKitGTK and built a 60,000-node accessibility tree on
 * Chromium, every time it was shown. A body is drawn a PAGE at a time and each further page is
 * asked for; 65,536 characters is the figure search reads of a body, and lays out in milliseconds.
 */
export const BODY_PAGE_CHARS = 65_536;

/**
 * And at most this many lines: a page of one-word lines is 9,000 lines in 65,536 characters and
 * read a 19,180-node accessibility tree. A letter's 70-character lines meet the character bound first.
 */
export const BODY_PAGE_LINES = 2_048;

/**
 * Where the page that starts at `start` ends: after its `lines`-th line break when that comes first,
 * else at most `size` characters on, at the last paragraph
 * break, else the last line break, else the last space, inside the page's final eighth, and hard at
 * the bound when the text offers none. Always past `start`, so a caller's loop always advances.
 */
export function pageEnd(text: string, start: number, size: number = BODY_PAGE_CHARS, lines: number = BODY_PAGE_LINES): number {
  let at = start;
  for (let k = 0; k < lines && at !== -1; k++) {
    const nl = text.indexOf("\n", at);
    at = nl === -1 || nl >= start + size ? -1 : nl + 1;
  }
  if (at !== -1 && at < text.length) return at;
  const hard = start + size;
  if (hard >= text.length) return text.length;
  const floor = hard - Math.max(1, size >> 3);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = text.lastIndexOf(sep, hard - sep.length);
    if (at >= floor && at > start) return at + sep.length;
  }
  return hard;
}

/** The ends of the first `pages` pages of `text` — the last one is `text.length` once it is all shown. */
export function pageEnds(text: string, pages: number, size: number = BODY_PAGE_CHARS): number[] {
  const ends: number[] = [];
  let at = 0;
  while (ends.length < pages && at < text.length) {
    at = pageEnd(text, at, size);
    ends.push(at);
  }
  return ends;
}
