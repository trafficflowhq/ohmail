/**
 * ONE FINGER ON ONE ROW, tracked: where it came down, whether it has claimed the row, how far it went. Pure, so the
 * list's layer is wiring and the cases are data. The claim is judged in the window's px (the phone's rule was
 * written in points); the travel and the fire in the page's, which is what the row is drawn in.
 */
import { swipeClaims, swipeOffset, swipeVerbFor, type SwipeVerb } from "./row-swipe.js";

export interface SwipeTrack {
  /** Where the finger came down, in the window's px. */
  readonly x: number;
  readonly y: number;
  /** The row is the finger's: from here on the list does not scroll under it. */
  readonly claimed: boolean;
  /** How far the finger has gone across since it came down, in the page's px. */
  readonly dx: number;
}

/** Which sides of the row carry a verb. A side without one is not drawn and fires nothing. */
export interface SwipeSides {
  readonly read: boolean;
  readonly later: boolean;
}

const BOTH: SwipeSides = { read: true, later: true };

export function swipeStart(x: number, y: number): SwipeTrack {
  return { x, y, claimed: false, dx: 0 };
}

/**
 * The finger moved to (x, y) in the window, `travel` across in the page. The claim is asked at every move until it
 * holds, as on the phone: there is no giving up, so a scroll that turns into a clean swipe is still a swipe.
 */
export function swipeMove(track: SwipeTrack, x: number, y: number, travel: number): SwipeTrack {
  const claimed = track.claimed || swipeClaims(x - track.x, y - track.y);
  return { ...track, claimed, dx: claimed ? travel : 0 };
}

const sideOf = (dx: number): keyof SwipeSides => (dx > 0 ? "read" : "later");

/** How far the row is drawn now, in the page's px: 0 until claimed, and 0 toward a side with no verb. */
export function swipeDrawn(track: SwipeTrack, has: SwipeSides = BOTH): number {
  if (!track.claimed || track.dx === 0 || !has[sideOf(track.dx)]) return 0;
  return swipeOffset(track.dx);
}

/** The finger let go (or the system took it): the verb it presses, or null. A cancel presses nothing. */
export function swipeEnd(track: SwipeTrack, cancelled: boolean, has: SwipeSides = BOTH): SwipeVerb | null {
  if (cancelled || !track.claimed) return null;
  const verb = swipeVerbFor(track.dx);
  return verb !== null && has[verb] ? verb : null;
}
