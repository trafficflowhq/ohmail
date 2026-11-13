/**
 * WHAT A DAY'S HOURS SAY BESIDE THE EVENTS: what lies out of sight above and below the hours in view, and, for the
 * day alone, the free stretch between two events an hour or more apart.
 */
import type { GridItem, Segment } from "./place.js";

export interface OutOfSight<T extends GridItem = GridItem> {
  /** Wholly above the view, the nearest first. */
  readonly above: readonly Segment<T>[];
  /** Wholly below it, the nearest first. */
  readonly below: readonly Segment<T>[];
}

/**
 * What of one day's segments lies wholly outside the minutes in view (`from` to `to`). An event is reckoned as tall
 * as it is drawn: no shorter than `shortest` minutes.
 */
export function outOfSight<T extends GridItem>(
  segments: readonly Segment<T>[],
  view: { from: number; to: number },
  shortest: number,
): OutOfSight<T> {
  const foot = (s: Segment<T>): number => Math.max(s.to, s.from + shortest);
  return {
    above: segments.filter((s) => foot(s) <= view.from).sort((a, b) => foot(b) - foot(a)),
    below: segments.filter((s) => s.from >= view.to).sort((a, b) => a.from - b.from),
  };
}

/** The free stretch between two events: its middle minute, where its words stand, and how long it is. */
export interface FreeStretch {
  readonly at: number;
  readonly minutes: number;
}

const FREE_FROM = 60;

/** The free stretches of one day of an hour or more, between events (each segment counts to its end). */
export function freeStretches(segments: readonly Segment[]): FreeStretch[] {
  const out: FreeStretch[] = [];
  let busyTo: number | null = null;
  for (const s of [...segments].sort((a, b) => a.from - b.from)) {
    if (busyTo !== null && s.from - busyTo >= FREE_FROM)
      out.push({ at: (busyTo + s.from) / 2, minutes: s.from - busyTo });
    busyTo = Math.max(busyTo ?? 0, s.to);
  }
  return out;
}
