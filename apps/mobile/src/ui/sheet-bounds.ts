import type { ViewStyle } from "react-native";

/** The room a pane-anchored sheet leaves above itself, under the top inset. */
export const SHEET_TOP_ROOM = 12;

/**
 * THE MODAL BELONGS TO THE WHOLE WINDOW, so its panel is bounded by the window on EVERY posture —
 * its height less the top inset — and the sheet scrolls inside that bound (ruling 159). On a
 * two-pane posture the panel stands over the DETAIL PANE (`pane`, from `detailPaneRect`): its left
 * edge the pane's, its right edge the window's, so it never straddles the list. A horizontal hinge
 * (tabletop) keeps the lower segment and wins; a vertical one with no pane keeps the reading half.
 * One pane: the full-width thumb sheet, bounded and centred on a wide window.
 */
export function sheetPanelBounds(
  w: number,
  h: number,
  top: number,
  pane: { x: number; w: number } | null,
  hinge: { x: number; y: number; w: number; h: number } | null,
): ViewStyle {
  const tall = Math.max(0, h - top);
  if (hinge !== null && hinge.h < hinge.w) {
    return { alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: Math.min(tall, Math.max(280, h - (hinge.y + hinge.h))) };
  }
  /* In flow (flex-start + a left margin), never absolute: the keyboard's lift is the modal's bottom
     padding, which an absolutely placed panel would ignore. */
  if (pane !== null) {
    return { alignSelf: "flex-start", marginLeft: pane.x, width: Math.max(0, w - pane.x), maxHeight: Math.max(0, tall - SHEET_TOP_ROOM) };
  }
  if (hinge !== null) {
    return { alignSelf: "flex-end", width: Math.max(320, w - (hinge.x + hinge.w)), maxHeight: tall };
  }
  return { alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: tall };
}
