/**
 * Where the composer's "Up to … total" hint stands. Beside the attach buttons it ends the row on the
 * right; when the row cannot hold it, it wraps, and a lone right-aligned fragment under the buttons
 * read as a stray (353 dp). Wrapped, it starts its line on the left, under the buttons it explains.
 * Decided from WIDTHS (the row's, each button's, the hint's), which the hint's margin never moves,
 * so the decision cannot feed back on itself; an unmeasured row keeps the hint inline.
 */
export const ATTACH_ROW_GAP = 8;

export function attachHintFits(rowWidth: number, itemWidths: readonly number[], hintWidth: number): boolean {
  if (!(rowWidth > 0) || !(hintWidth > 0) || itemWidths.some((w) => !(w > 0))) return true;
  return itemWidths.reduce((s, w) => s + w + ATTACH_ROW_GAP, 0) + hintWidth <= rowWidth;
}

export function attachHintStyle(fits: boolean): { marginLeft: "auto" | 0 } {
  return fits ? { marginLeft: "auto" } : { marginLeft: 0 };
}
