import type { ViewStyle } from "react-native";
import { design } from "@ohmail/tokens/design";

const menuEdge = Number.parseFloat(design.faces.paper.phone.s2);
const phoneMenuMax = 460;
const anchorMenuWidth = 232;

type Rect = { x: number; y: number; width: number; height: number };
export type SheetAnchor = Rect & { host?: Rect };

/** A sheet falls back to the foot when it has no measurable trigger. */
export function phoneMenuBounds(
  window: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number },
  keyboardHeight: number,
  hinge: { x: number; y: number; w: number; h: number } | null,
  options: {
    anchor?: SheetAnchor;
    align: "start" | "end";
    side: "above" | "below";
    contentHeight: number;
  },
): ViewStyle {
  const { anchor } = options;
  const host = anchor?.host ?? { x: 0, y: 0, ...window };
  let left = Math.max(host.x + menuEdge, insets.left + menuEdge);
  let right = Math.min(host.x + host.width, window.width - insets.right) - menuEdge;
  let top = Math.max(host.y, insets.top) + menuEdge;
  let bottom = Math.min(host.y + host.height - menuEdge, window.height - Math.max(insets.bottom, keyboardHeight + menuEdge));
  if (hinge !== null) {
    if (hinge.h < hinge.w) {
      if ((anchor && anchor.y + anchor.height / 2 < hinge.y) || bottom <= hinge.y + hinge.h) {
        bottom = Math.min(bottom, hinge.y - menuEdge);
      } else {
        top = Math.max(top, hinge.y + hinge.h + menuEdge);
      }
    } else if (anchor && anchor.x + anchor.width / 2 < hinge.x) {
      right = Math.min(right, hinge.x - menuEdge);
    } else {
      left = Math.max(left, hinge.x + hinge.w + menuEdge);
    }
  }
  const room = Math.max(0, right - left);
  const hostBottom = host.y + host.height;
  if (!anchor) {
    const width = Math.min(room, phoneMenuMax);
    return {
      width, left: left + (room - width) / 2 - host.x,
      bottom: hostBottom - bottom, maxHeight: Math.max(0, bottom - top),
    };
  }
  const width = Math.min(room, anchorMenuWidth);
  const aligned = options.align === "end" ? anchor.x + anchor.width - width : anchor.x;
  const above = Math.min(anchor.y - menuEdge, bottom);
  const below = Math.max(anchor.y + anchor.height + menuEdge, top);
  const headroom = above - top;
  const footroom = bottom - below;
  const aboveFirst = options.side === "above";
  const up = aboveFirst
    ? headroom >= options.contentHeight || headroom >= footroom
    : footroom < options.contentHeight && headroom > footroom;
  return {
    width,
    left: Math.max(left, Math.min(aligned, right - width)) - host.x,
    ...(up ? { bottom: hostBottom - above, maxHeight: Math.max(0, headroom) }
      : { top: below - host.y, maxHeight: Math.max(0, footroom) }),
  };
}

/** The room a pane-anchored sheet leaves above itself, under the top inset. */
export const SHEET_TOP_ROOM = 12;

/**
 * THE MODAL BELONGS TO THE WHOLE WINDOW, so its panel is bounded by the window on EVERY posture —
 * its height less the top inset — and the sheet scrolls inside that bound (ruling 159). On a
 * two-pane posture the panel stands over the DETAIL PANE (`pane`, from `detailPaneRect`) at the
 * pane's own x and width, so it never straddles the list nor reaches under a side inset, and ends at the
 * pane's foot (`foot`: the pair's gutter under it, all four corners round). A horizontal hinge
 * (tabletop) keeps the lower segment and wins; a vertical one with no pane keeps the reading half.
 * One pane: the thumb sheet, with a gutter on the mail surface.
 */
export function sheetPanelBounds(
  w: number,
  h: number,
  top: number,
  pane: { x: number; w: number } | null,
  hinge: { x: number; y: number; w: number; h: number } | null,
  foot: { gutter: number; radius: number; inset?: number } = { gutter: 0, radius: 0 },
): ViewStyle {
  const tall = Math.max(0, h - top);
  if (hinge !== null && hinge.h < hinge.w) {
    return { alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: Math.min(tall, Math.max(280, h - (hinge.y + hinge.h))) };
  }
  /* In flow (flex-start + a left margin), never absolute: the keyboard's lift is the modal's bottom
     padding, which an absolutely placed panel would ignore. */
  if (pane !== null) {
    return {
      alignSelf: "flex-start", marginLeft: pane.x, width: pane.w, maxHeight: Math.max(0, tall - SHEET_TOP_ROOM - foot.gutter),
      marginBottom: foot.gutter, borderBottomLeftRadius: foot.radius, borderBottomRightRadius: foot.radius,
    };
  }
  /* No pane beside a vertical hinge: the reading side, never a floor that reaches back over the crease. */
  if (hinge !== null) {
    return { alignSelf: "flex-end", width: Math.max(0, w - (hinge.x + hinge.w)), maxHeight: tall };
  }
  const inset = foot.inset ?? 0;
  if (inset > 0) {
    return {
      alignSelf: "center", width: Math.max(0, w - 2 * inset), maxWidth: 560,
      maxHeight: Math.max(0, tall - inset), marginBottom: inset,
      borderBottomLeftRadius: foot.radius, borderBottomRightRadius: foot.radius,
    };
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
