/**
 * THE HISTORY SLOT IS A MEASURED ROW. History draws the store's total as equal slots, so a scroll offset is a slot
 * and a year jump lands without measuring every row. The slot's height is read off the rows as they lay out, never
 * a constant: a constant fits one font scale, and 84 cut every row's folder chip to a sliver. It only
 * grows, so a taller row (a larger font, a second badge line) widens every slot instead of being cut by it.
 */

/** The slot before any row has laid out — first paint and the loading placeholders only; the first row replaces it. */
export const HISTORY_SLOT_FIRST_PAINT = 84;

/** The slot once a row reports `measured` (its laid-out height): the larger of the two, in whole dp. */
export function grownSlot(current: number, measured: number): number {
  return Number.isFinite(measured) && measured > current ? Math.ceil(measured) : current;
}
