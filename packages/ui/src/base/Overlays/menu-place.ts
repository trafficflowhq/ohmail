/** Where a menu stands: at its anchor or at a point, flipped and held inside the window. */

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
const EDGE = 8;
const GAP = { anchor: 8, point: 2 };
const FOOT = 12;

const between = (low: number, high: number, n: number) => Math.max(low, Math.min(high, n));

/**
 * The menu's corner in the window. It opens downwards at the anchor's left edge; upwards when it
 * would leave the window below and there is more room above; and it never comes nearer than 8 to
 * an edge.
 */
export function placeMenu(
  at: Edges | Point,
  menu: Size,
  stage: Size,
  how: { up?: boolean; right?: boolean } = {},
): { left: number; top: number; up: boolean } {
  const point = "x" in at;
  const r = point ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : at;
  const gap = point ? GAP.point : GAP.anchor;
  const up =
    how.up === true || (r.bottom + menu.height + FOOT > stage.height && r.top > stage.height - r.bottom);
  const left = between(EDGE, stage.width - menu.width - EDGE, how.right ? r.right - menu.width : r.left);
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
      open({ x: e.clientX, y: e.clientY });
    },
    onKeyDown: (e) => {
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
      e.preventDefault();
      open(e.currentTarget);
    },
  };
}
