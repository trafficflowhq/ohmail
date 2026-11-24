/**
 * THE LANE ABOVE THE HOURS: whole-day events, and runs across days. A run takes the first row free from its first
 * day on; an earlier start comes first, and of two that start together the longer. A whole day is a date, the same
 * for every reader; its end is the day after its last (a calendar writes the end exclusive).
 */
import { dayNumber, type PlainDate } from "@ohmail/cal-core";
import type { GridItem } from "./place.js";

export interface Pill<T extends GridItem = GridItem> {
  readonly item: T;
  /** The first and last of the days shown it stands on, as indexes into the days handed in. */
  readonly first: number;
  readonly last: number;
  /** Its row in the lane, from 0. */
  readonly row: number;
  /** It began before the first day shown, or goes on after the last. */
  readonly before: boolean;
  readonly after: boolean;
}

export interface AllDayLane<T extends GridItem = GridItem> {
  readonly pills: readonly Pill<T>[];
  readonly rows: number;
}

/** The days a whole-day item covers, as day numbers: the last one inclusive. `null` for an item that is no whole day. */
export function daysCovered(item: GridItem): { from: number; to: number } | null {
  if (item.start.kind !== "date") return null;
  const from = dayNumber(item.start);
  const end = item.end.kind === "date" ? dayNumber(item.end) : from + 1;
  return { from, to: Math.max(from, end - 1) };
}

/** The lane for the days handed in (consecutive, as a week or a day shows them). */
export function allDayLane<T extends GridItem>(
  items: readonly T[],
  days: readonly PlainDate[],
): AllDayLane<T> {
  if (days.length === 0) return { pills: [], rows: 0 };
  const shownFrom = dayNumber(days[0]!);
  const shownTo = dayNumber(days[days.length - 1]!);
  const runs = items
    .map((item) => ({ item, span: daysCovered(item) }))
    .filter(
      (r): r is { item: T; span: { from: number; to: number } } =>
        r.span !== null && r.span.to >= shownFrom && r.span.from <= shownTo,
    )
    .map((r) => ({ ...r, a: Math.max(r.span.from, shownFrom), z: Math.min(r.span.to, shownTo) }))
    .sort((p, q) => p.a - q.a || q.z - p.z || (p.item.id < q.item.id ? -1 : p.item.id > q.item.id ? 1 : 0));
  const rowEnds: number[] = [];
  const pills = runs.map((r) => {
    let row = 0;
    while (rowEnds[row] !== undefined && rowEnds[row]! >= r.a) row++;
    rowEnds[row] = r.z;
    return {
      item: r.item,
      first: r.a - shownFrom,
      last: r.z - shownFrom,
      row,
      before: r.span.from < shownFrom,
      after: r.span.to > shownTo,
    };
  });
  return { pills, rows: rowEnds.length };
}
