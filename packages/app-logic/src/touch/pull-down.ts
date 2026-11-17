/**
 * PULL NEW MAIL, BY FINGER: a list pulled down at its top. The design's arithmetic (the simulation's `pullDraw`): past
 * a slop of 12 the list follows the finger at 0.55 of its way, at most 120 down, and a release from 64 down pulls.
 */

/** How far down a finger goes before the pull is the list's, in px. */
export const PULL_SLOP = 12;
/** How much of the finger's way the list follows. */
export const PULL_RATE = 0.55;
/** The furthest the list is drawn down. */
export const PULL_MAX = 120;
/** How far the list must be drawn for a release to pull. */
export const PULL_FIRE = 64;

/** Is this movement a pull? Down past the slop, and more down than across. */
export function pullClaims(dx: number, dy: number): boolean {
  return dy > PULL_SLOP && dy > Math.abs(dx);
}

/** How far the list is drawn down for a finger `dy` down. */
export function pullOffset(dy: number): number {
  return Math.min(PULL_MAX, Math.max(0, dy - PULL_SLOP) * PULL_RATE);
}

/** Does a release here pull? */
export function pullFires(dy: number): boolean {
  return pullOffset(dy) >= PULL_FIRE;
}
