/**
 * HOW MUCH OF A MESSAGE BODY ONE PHONE PAINT LAYS OUT — the desktop's bound, from the one helper
 * (`packages/ui/src/format/long-text.ts`). A body past one page is drawn a page per Text with a
 * press for the next; one page or less is the single Text it always was, which `pages: null` says.
 */
import { BODY_PAGE_CHARS, pageEnds } from "../../../../packages/ui/src/format/long-text";

export { BODY_PAGE_CHARS };

export interface BodyPagesPlan {
  /** The pages to draw, in order, or null when the body is one page and draws whole. */
  pages: string[] | null;
  /** The percent shown when a press for more is offered, else null. */
  more: number | null;
}

/** The plan for `asked` pages. A clamped caller draws the first page and is offered no press. */
export function bodyPages(text: string, asked: number, clamped = false): BodyPagesPlan {
  if (text.length <= BODY_PAGE_CHARS) return { pages: null, more: null };
  const ends = pageEnds(text, clamped ? 1 : Math.max(1, asked));
  const pages = ends.map((end, i) => text.slice(i === 0 ? 0 : ends[i - 1]!, end));
  const shown = ends[ends.length - 1] ?? 0;
  return { pages, more: !clamped && shown < text.length ? Math.floor((shown / text.length) * 100) : null };
}

/** How many pages are asked for `text`: a count kept for another message starts again at one. */
export function pagesAskedFor(kept: { text: string; pages: number }, text: string): number {
  return kept.text === text ? kept.pages : 1;
}
