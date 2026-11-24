/** Where a menu stands: at its anchor or at a point, flipped and held inside the window. */
import { cssPoint } from "../ui-zoom.js";

export interface Point {
  x: number;
  y: number;
}
export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Size {
  width: number;
  height: number;
}

/* The room kept to the window's edge, and to the anchor or the point. Not tokens yet. */
/** The room every card that stands by itself keeps to the edge of what holds it. */
export const EDGE = 8;
const GAP = { anchor: 8, point: 2 };
const FOOT = 12;
const FIT_ROUNDING_PX = 1;

export type MenuFit = "whole" | "beside";

/** `n`, held between `low` and `high`; where the two cross, `low` wins. */
export const between = (low: number, high: number, n: number) => Math.max(low, Math.min(high, n));

/**
 * The menu's corner in the window. It opens downwards at the anchor's left edge; upwards when it
 * would leave the window below and there is more room above; and it never comes nearer than 8 to
 * an edge.
 */
export function placeMenu(
  at: Edges | Point,
  menu: Size,
  stage: Size,
  how: { up?: boolean; right?: boolean; fit?: MenuFit } = {},
): { left: number; top: number; up: boolean; maxHeight?: number } {
  const point = "x" in at;
  const r = point ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : at;
  const gap = point ? GAP.point : GAP.anchor;
  const left = between(EDGE, stage.width - menu.width - EDGE, how.right ? r.right - menu.width : r.left);
  if (how.fit) {
    const viewportHeight = Math.max(0, stage.height - EDGE * 2);
    const above = r.top - gap - EDGE;
    const below = stage.height - EDGE - r.bottom - gap;
    const allowance = how.fit === "beside" ? FIT_ROUNDING_PX : 0;
    const up =
      how.up === true ||
      (menu.height > below + allowance &&
        (menu.height <= above + allowance || (how.fit === "beside" && above > below)));
    const side = up ? above : below;
    const limit =
      how.fit === "beside" && side > 0 && menu.height > side + allowance
        ? Math.min(side, viewportHeight)
        : viewportHeight;
    const height = Math.min(menu.height, limit);
    const top = between(EDGE, stage.height - height - EDGE, up ? r.top - height - gap : r.bottom + gap);
    return { left, top, up, ...(height < menu.height ? { maxHeight: limit } : {}) };
  }
  const up =
    how.up === true || (r.bottom + menu.height + FOOT > stage.height && r.top > stage.height - r.bottom);
  const top = between(
    EDGE,
    stage.height - menu.height - EDGE,
    up ? r.top - menu.height - gap : r.bottom + gap,
  );
  return { left, top, up };
}

/**
 * What a thing with a context menu listens for: a right click opens at the pointer; the menu key
 * and Shift+F10 open at the thing itself. Spread it on the element.
 */
export function contextTrigger(open: (at: Point | Element) => void): {
  onContextMenu: (e: { preventDefault(): void; clientX: number; clientY: number }) => void;
  onKeyDown: (e: { key: string; shiftKey: boolean; currentTarget: Element; preventDefault(): void }) => void;
} {
  return {
    onContextMenu: (e) => {
      e.preventDefault();
      open(cssPoint(e));
    },
    onKeyDown: (e) => {
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
      e.preventDefault();
      open(e.currentTarget);
    },
  };
}
