import type { ViewStyle } from "react-native";

/**
 * THE MODAL BELONGS TO THE WHOLE WINDOW, so its panel is bounded by the window on EVERY posture —
 * its height less the top inset — and the sheet scrolls inside that bound (ruling 159): a sheet
 * of more verbs than the window holds left its last verbs and its Cancel below the screen.
 */
export function sheetPanelBounds(
  w: number, h: number, top: number, hinge: { x: number; y: number; w: number; h: number } | null,
): ViewStyle {
  const tall = Math.max(0, h - top);
  if (hinge !== null && hinge.h >= hinge.w) {
    return { alignSelf: "flex-end", width: Math.max(320, w - (hinge.x + hinge.w)), maxHeight: tall };
  }
  if (hinge !== null) {
    return { alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: Math.min(tall, Math.max(280, h - (hinge.y + hinge.h))) };
  }
  return { alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: tall };
}
