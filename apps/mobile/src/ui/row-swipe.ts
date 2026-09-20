/**
 * SWIPE ON A MAIL ROW — the arithmetic, pure and dependency-free, so the tests drive it as data
 * (`reader-verbs.ts`'s posture; the wiring in `MailRow.tsx` is thin). A swipe is a SHORTCUT: this
 * module only decides which of two verbs a drag lands on, and both stay on the row's sheet and in
 * its accessibility actions.
 *
 * NO NEW DEPENDENCY: `react-native-gesture-handler` is not in this app's dependencies and does not
 * resolve from it (measured), and it is a NATIVE module — a prebuild and a pod install on both
 * platforms for one gesture. `PanResponder` is React Native's own and behaves the same on both.
 */

/** Which verb a direction carries. The row's facts decide the read slot's face, never this. */
export type SwipeVerb = "read" | "later";

/**
 * How far a finger must travel before the row claims the gesture from the list's vertical scroll,
 * in points. Below it nothing moves: a list is scrolled far more often than a row is swiped, so
 * the threshold is generous and the horizontal intent has to be unambiguous.
 */
export const SWIPE_CLAIM_DX = 12;

/**
 * And how much more horizontal than vertical. A diagonal drag is a SCROLL that wandered — the
 * common case on a thumb — and treating it as a swipe takes the list out from under the reader.
 */
export const SWIPE_CLAIM_RATIO = 1.6;

/**
 * How far the row must end up for the verb to fire, in points. Short of it the row springs back
 * and nothing is pressed: a swipe that stops half way is a person changing their mind, and a
 * verb that fires there is a verb nobody chose.
 */
export const SWIPE_FIRE_DX = 76;

/**
 * Is this movement the row's, or the list's? Asked at every move until one of them wins, so it
 * takes the CURRENT offsets rather than a velocity: velocity on a slow deliberate drag reads as
 * noise, and a slow deliberate drag is exactly the gesture a one-handed triage makes.
 */
export function swipeClaims(dx: number, dy: number): boolean {
  const h = Math.abs(dx);
  return h >= SWIPE_CLAIM_DX && h >= Math.abs(dy) * SWIPE_CLAIM_RATIO;
}

/**
 * WHICH VERB THIS DRAG LANDS ON, or `null` for one that did not travel far enough.
 *
 * Leading (dragging right, `dx > 0`) is the read slot and trailing (left) is Later — the compact
 * bar's own order, left to right, so the gesture and the bar agree about which side a verb is on.
 */
export function swipeVerbFor(dx: number): SwipeVerb | null {
  if (Math.abs(dx) < SWIPE_FIRE_DX) return null;
  return dx > 0 ? "read" : "later";
}

/**
 * How far the row is drawn, given the finger — bounded, and with resistance past the firing
 * point. A row that follows a finger off the screen reads as a delete about to happen; stopping
 * it just past the point of commitment is what makes the gesture legible without a label.
 */
export const SWIPE_MAX_DX = 112;

export function swipeOffset(dx: number): number {
  const h = Math.min(Math.abs(dx), SWIPE_MAX_DX);
  if (h <= SWIPE_FIRE_DX) return dx > 0 ? h : -h;
  /* Past the firing point the row keeps moving, at a third of the speed: enough to feel the
     commitment, not enough to look like the row is leaving. */
  const over = SWIPE_FIRE_DX + (h - SWIPE_FIRE_DX) / 3;
  return dx > 0 ? over : -over;
}

/**
 * Which face the read slot is wearing for this row — the reader's own three-way rule
 * (`MessageActions.tsx`'s `readFace`), restated NOWHERE ELSE: both callers take it from here, so
 * the swipe cannot press a verb whose label the sheet is not showing.
 */
export type ReadFace = "done" | "markRead" | "markUnread";

export function readFaceOf(row: { pile: string | null; unread: boolean }): ReadFace {
  if (row.pile === "resurfaced") return "done";
  return row.unread ? "markRead" : "markUnread";
}
