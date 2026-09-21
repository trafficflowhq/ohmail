/**
 * The open message's action bar, as arithmetic. The box numbers live here rather than inline in
 * the JSX so a test can lay the row out at a phone's width — this workspace has no React Native
 * renderer, so the layout is only measurable where it is stated as data.
 *
 * The law is ONE ROW. A horizontal scroller clipped the fourth verb mid-glyph; wrapping showed
 * every verb but put a second row of capsules over the message on the iPhone 18 Pro. So the bar
 * MEASURES: a hidden copy of each capsule reports its width, the verbs are admitted greedily in
 * row order while they fit, and the tail stands behind ⋯ — in the row or in the sheet, never
 * both, never gone, never a second line. It is the glass ActionBar's law (`glass/fold.ts`),
 * which this module calls rather than restates.
 */
import { admitVerbs } from "./glass/fold";

/** The bar's own box: the wrapper's outer padding, the pill's side padding, the gap before More,
 *  and More's square. `outerPadH` is the `paddingHorizontal` of the view the bar stands in. */
export const BAR = { outerPadH: 8, padH: 12, gap: 7, moreBox: 36 } as const;

/** A `BarToggle` capsule: side padding, the icon and the gap after it. `minH` is the visual
 *  box; the reachable target is `HIT` (48), which `Tap` pays in `hitSlop`. */
export const PILL = { padH: 12, icon: 13, iconGap: 6, minH: 38, padV: 6 } as const;

/** `Button`'s box, from `base.tsx` — Reply rides the shared primitive, not a capsule of its
 *  own. Pinned against that file by `test/action-bar-fits.test.ts` so the two cannot drift. */
export const SOLID = { padH: 15, icon: 13, iconGap: 7 } as const;

/** The width one line of verbs gets inside a bar of this OUTER width — the wrapper's own
 *  measured box, which on a phone is the window: less both paddings and More's column. */
export function barLineWidth(boxDp: number): number {
  return boxDp - 2 * BAR.outerPadH - 2 * BAR.padH - BAR.gap - BAR.moreBox;
}

/** A capsule around a label of this text width. */
export function pillWidth(textDp: number): number {
  return 2 * PILL.padH + PILL.icon + PILL.iconGap + textDp;
}

/** The solid Reply button around a label of this text width. */
export function solidWidth(textDp: number): number {
  return 2 * SOLID.padH + SOLID.icon + SOLID.iconGap + textDp;
}

export interface BarFit {
  /** The verbs that stand, as indices into the input — always a prefix. */
  standing: number[];
  /** The tail, in row order, which the ⋯ sheet must carry. */
  overflow: number[];
}

/**
 * WHICH VERBS STAND ON THE ONE LINE. Greedy over row order — a later verb never stands while an
 * earlier one is folded — with Reply's solid button as the fixed cost and a gap before every
 * capsule. `fitOneLine` is the arithmetic; {@link compactFit} is what the bar calls, with the
 * hidden copy's measurements and the room it last read.
 */
export function fitOneLine(
  widths: readonly number[], lineWidth: number, fixedWidth = 0,
): BarFit {
  const admitted = admitVerbs(
    widths.map((w, i) => ({ id: String(i), width: w, seg: null })),
    lineWidth,
    fixedWidth,
    BAR.gap,
  );
  const all = widths.map((_, i) => i);
  return { standing: all.slice(0, admitted), overflow: all.slice(admitted) };
}

/**
 * The compact bar's whole admission. `widths` is the hidden copy's record — the verb ids plus
 * `__reply` — and `room` the wrapper's last measured width; either one missing is the FLOOR,
 * where Reply and ⋯ stand and every verb is in the sheet. A verb is never shown clipped and
 * never shown on a second row while the widths are still in flight.
 */
export function compactFit(args: {
  verbs: readonly string[];
  widths: Readonly<Record<string, number>> | null;
  room: number | null;
}): { standing: string[]; overflow: string[] } {
  const { verbs, widths, room } = args;
  if (widths === null || room === null) return { standing: [], overflow: [...verbs] };
  const fit = fitOneLine(
    verbs.map((id) => widths[id] ?? 0),
    barLineWidth(room),
    widths["__reply"] ?? 0,
  );
  return {
    standing: fit.standing.map((i) => verbs[i]),
    overflow: fit.overflow.map((i) => verbs[i]),
  };
}
