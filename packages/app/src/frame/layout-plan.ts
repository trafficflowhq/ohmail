/**
 * ONE LAYOUT FROM THE SIZE CLASS. Pure: its inputs come only from the host's window. Under 700 wide one column
 * stands with the dock at its foot (a phone, and an unfolded phone that narrow, as the open Duo); from 700 on an
 * unfolded phone is two columns beside a rail of icons, upright or (from 840 on, under a finger) on its side; a fine
 * pointer from 840 on is the desktop, with words and its handles. A book (the window's posture) is two columns at
 * whatever width it holds them.
 */
import type { LayoutPlan, Posture, SizeClass, WindowFacts } from "./contract.js";

const MEDIUM = 600;
const EXPANDED = 840;
const SHORT = 480;
/**
 * Two columns stand side by side from 700 wide, the design's floor: the rail, a list and a letter at the reader's
 * width of 320 need about that much (studio `core/room.js`, FOLDABLES.md "Why 700"). The size class keeps its lines.
 */
const TWO_COLUMNS = 700;

function sizeOf(width: number): SizeClass {
  if (width < MEDIUM) return "compact";
  return width < EXPANDED ? "medium" : "expanded";
}

/** Every posture is named here; a new one is a compile error until it is laid out. */
function laidAsBook(posture: Posture): boolean {
  switch (posture) {
    case "flat":
      return false;
    case "book":
      return true;
    default:
      return posture satisfies never;
  }
}

export function layoutPlan(w: WindowFacts): LayoutPlan {
  const size = sizeOf(w.width);
  const common = { size, short: w.height < SHORT, pointer: w.pointer } as const;
  /* A book's fold stands between the two columns at any width it holds them, half open under 700 too: nothing is laid
     on the crease. Upright under 840, on its side from 840. */
  if (laidAsBook(w.posture))
    return {
      ...common,
      device: "fold",
      pose: w.width >= EXPANDED ? "land" : null,
      rail: "icons",
      columns: 2,
      handles: false,
    };
  if (w.width < TWO_COLUMNS)
    return { ...common, device: "phone", pose: null, rail: "dock", columns: 1, handles: false };
  if (size === "medium")
    return { ...common, device: "fold", pose: null, rail: "icons", columns: 2, handles: false };
  /* The unfolded phone on its side keeps the upright rail of icons, as its reference draws it: a rail of words there
     is the sidebar-icons setting turned off, which is Settings' to ask, never the frame's. */
  if (w.pointer === "coarse")
    return { ...common, device: "fold", pose: "land", rail: "icons", columns: 2, handles: false };
  return { ...common, device: "desktop", pose: null, rail: "words", columns: 2, handles: true };
}
