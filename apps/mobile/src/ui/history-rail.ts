/**
 * THE YEAR RAIL'S COLUMN. The rail floats at History's right edge, over the list head, so the head
 * keeps the rail's MEASURED width clear on its right: the sentence and the link wrap beside the rail
 * instead of running under it, at every width and font scale. With no rail, or before it has laid
 * out, the head keeps its own padding.
 */

/** The head's own padding on each side. */
export const HISTORY_HEAD_PAD = 12;
/** Where the rail stands from the screen's right edge. */
export const HISTORY_RAIL_RIGHT = 2;
/** The room between the head's words and the rail. */
export const HISTORY_RAIL_GAP = 8;

export function historyHeadPadRight(railWidth: number | null): number {
  if (railWidth === null || !(railWidth > 0)) return HISTORY_HEAD_PAD;
  return Math.max(HISTORY_HEAD_PAD, Math.ceil(railWidth) + HISTORY_RAIL_RIGHT + HISTORY_RAIL_GAP);
}
