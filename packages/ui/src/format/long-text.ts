/**
 * HOW MUCH OF A MESSAGE BODY ONE PAINT LAYS OUT. A 2 MiB plain-text body drawn whole held the
 * window's main thread 0.8-1.0 s on WebKitGTK and built a 60,000-node accessibility tree on
 * Chromium, every time it was shown. A body is drawn a PAGE at a time and each further page is
 * asked for; 65,536 characters is the figure search reads of a body, and lays out in milliseconds.
 */
export const BODY_PAGE_CHARS = 65_536;

/**
 * Where the page that starts at `start` ends: at most `size` characters on, at the last paragraph
 * break, else the last line break, else the last space, inside the page's final eighth, and hard at
 * the bound when the text offers none. Always past `start`, so a caller's loop always advances.
 */
export function pageEnd(text: string, start: number, size: number = BODY_PAGE_CHARS): number {
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
