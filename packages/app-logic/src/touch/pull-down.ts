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
/** How far the list stands down while a pull it asked for runs. */
export const PULL_HOLD = 48;
/** A running request can outlast its waiting mark. */
export const PULL_HOLD_CAP_MS = 15_000;

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

export interface PullTrack {
  readonly x: number;
  readonly y: number;
  readonly claimed: boolean;
  readonly offset: number;
}

/** Only a finger that came down at the top can pull. */
export function pullStart(x: number, y: number, atTop: boolean): PullTrack | null {
  return atTop ? { x, y, claimed: false, offset: 0 } : null;
}

/** Yield to a scroll or row swipe before claim. Keep a claimed pull through a reversal. */
export function pullMove(track: PullTrack | null, x: number, y: number, atTop: boolean): PullTrack | null {
  if (track === null || (!track.claimed && !atTop)) return null;
  const dx = x - track.x;
  const dy = y - track.y;
  if (track.claimed || pullClaims(dx, dy)) return { ...track, claimed: true, offset: pullOffset(dy) };
  return Math.max(Math.abs(dx), Math.abs(dy)) > PULL_SLOP ? null : track;
}

/** Clear the track on release. An armed release can hold a running request's mark or start a new request. */
export function pullEnd(track: PullTrack | null, cancelled: boolean, busy: boolean) {
  const claimed = track?.claimed === true;
  const hold = claimed && !cancelled && track.offset >= PULL_FIRE;
  return { claimed, hold, run: hold && !busy };
}
