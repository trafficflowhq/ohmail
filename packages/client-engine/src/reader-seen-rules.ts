/**
 * SCROLL-TO-READ'S NUMBERS AND ITS DWELL DECISION, one copy for the web reader and the phone's
 * (`apps/webapp/app/shell/reader-seen.ts`, `apps/mobile/src/ui/reader-seen.ts`). Pure: each core
 * hands in its panels' boxes in one coordinate system and gets back what the dwell reads. The
 * END-OF-READER rule lives here: at the reader's scroll end a member that can never pass or span
 * the line is read once it is wholly in view, after the same dwell.
 */

/** The reading line, as a fraction of the viewport's height from its top. */
export const READING_LINE = 0.33;
/** Rule B's dwell after the last scroll the person made. */
export const DWELL_MS = 2000;
/** A scroll counts only when the person's input precedes it by at most this. */
export const EVIDENCE_WINDOW_MS = 1000;

export interface PanelBox {
  id: string;
  top: number;
  bottom: number;
}

/** Can the reader scroll no further down? A pixel of rounding is the end. */
export function atScrollEnd(offset: number, viewport: number, content: number): boolean {
  return offset + viewport >= content - 1;
}

/**
 * What the dwell reads: the one panel spanning the line, and at the scroll end every panel wholly
 * in view as well. `panels` are the unread candidates only, in order; the result keeps that order.
 */
export function dwellCommits(
  panels: readonly PanelBox[],
  view: { top: number; bottom: number; line: number },
  atEnd: boolean,
): string[] {
  const out: string[] = [];
  for (const p of panels) {
    const spans = p.top <= view.line && p.bottom > view.line;
    const whole = atEnd && p.top >= view.top - 1 && p.bottom <= view.bottom + 1;
    if (spans || whole) out.push(p.id);
  }
  return atEnd ? out : out.slice(0, 1);
}
