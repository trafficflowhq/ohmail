import type { ViewStyle } from "react-native";

/** The room a pane-anchored sheet leaves above itself, under the top inset. */
export const SHEET_TOP_ROOM = 12;

/**
 * THE MODAL BELONGS TO THE WHOLE WINDOW, so its panel is bounded by the window on EVERY posture —
 * its height less the top inset — and the sheet scrolls inside that bound (ruling 159). On a
 * two-pane posture the panel stands over the DETAIL PANE (`pane`, from `detailPaneRect`) at the
 * pane's own x and width, so it never straddles the list nor reaches under a side inset. A horizontal hinge
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
    return { alignSelf: "flex-start", marginLeft: pane.x, width: pane.w, maxHeight: Math.max(0, tall - SHEET_TOP_ROOM) };
  }
  /* No pane beside a vertical hinge: the reading side, never a floor that reaches back over the crease. */
  if (hinge !== null) {
    return { alignSelf: "flex-end", width: Math.max(0, w - (hinge.x + hinge.w)), maxHeight: tall };
  }
  return { alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: tall };
}

/**
 * THE ROOM A SHEET RISES IN: the window under the status bar, above the keyboard. The panel's own
 * `maxHeight` is the window less the top inset, which binds only while the keyboard is down; with it
 * up the room is the window less the keyboard, measured from y=0, and at accessibility text sizes the
 * reply sheet's head rose under the clock. The top inset is the room's own padding, so
 * it holds on both platforms whatever lifts the foot. Over a crease (tabletop, `creaseAcross`) the
 * keyboard takes the lower half, and the sheet then ends above the crease, never with its buttons on it.
 */
export function sheetRoom(
  top: number,
  keyboardLift: number,
  crease: { y: number } | null = null,
  windowH = 0,
): ViewStyle {
  const foot = keyboardLift > 0 && crease !== null ? Math.max(keyboardLift, windowH - crease.y) : keyboardLift;
  return { flex: 1, justifyContent: "flex-end", paddingTop: Math.max(0, top), paddingBottom: foot };
}
