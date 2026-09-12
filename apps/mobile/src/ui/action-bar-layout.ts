/**
 * The open message's action bar, as arithmetic. The box numbers live here rather than inline in
 * the JSX so a test can lay the row out at a phone's width — this workspace has no React Native
 * renderer, so the layout is only measurable where it is stated as data.
 *
 * The law is WRAP, the law every other group of pills on this phone already follows. The bar
 * scrolled instead, and a horizontal ScrollView CLIPS: at 1080 px / 420 dpi the fourth verb was
 * cut mid-glyph. More is never inside the wrap, so it can neither overlap a pill nor land alone.
 */

/** The bar's own box: side padding, the gap before More, and More's square. */
export const BAR = { padH: 12, gap: 7, moreBox: 36 } as const;

/** A `BarToggle` capsule: side padding, the icon and the gap after it. `minH` is the visual
 *  box; the reachable target is `HIT` (48), which `Tap` pays in `hitSlop`. */
export const PILL = { padH: 12, icon: 13, iconGap: 6, minH: 38, padV: 6 } as const;

/** `Button`'s box, from `base.tsx` — Reply rides the shared primitive, not a capsule of its
 *  own. Pinned against that file by `test/action-bar-fits.test.ts` so the two cannot drift. */
export const SOLID = { padH: 15, icon: 13, iconGap: 7 } as const;

/** The width one line of verbs gets: the screen, less the bar's padding and More's column. */
export function barLineWidth(screenDp: number): number {
  return screenDp - 2 * BAR.padH - BAR.gap - BAR.moreBox;
}

/** A capsule around a label of this text width. */
export function pillWidth(textDp: number): number {
  return 2 * PILL.padH + PILL.icon + PILL.iconGap + textDp;
}

/** The solid Reply button around a label of this text width. */
export function solidWidth(textDp: number): number {
  return 2 * SOLID.padH + SOLID.icon + SOLID.iconGap + textDp;
}

/**
 * Where the verbs land under the wrap law: indices, line by line, filled left to right with
 * `BAR.gap` between neighbours. A verb wider than the whole line takes a line of its own and
 * its label wraps INSIDE the capsule — a second line of text, never an ellipsis and never a
 * shorter word.
 */
export function wrapLines(widths: readonly number[], lineWidth: number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const need = (line.length === 0 ? 0 : BAR.gap) + widths[i];
    if (line.length > 0 && used + need > lineWidth) {
      lines.push(line);
      line = [i];
      used = widths[i];
    } else {
      line.push(i);
      used += need;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}
