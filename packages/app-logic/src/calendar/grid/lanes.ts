/**
 * EVENTS THAT OVERLAP IN ONE DAY. Two whose starts are far enough apart: the later one is set in and laps over the
 * earlier, which keeps only the room above the lap for its words. Closer starts, or three and more at once: side by
 * side, each in a column of its own. All in minutes; the view turns them into pixels with the hour's height.
 */
import type { GridItem, Segment } from "./place.js";

export interface Laned<T extends GridItem = GridItem> extends Segment<T> {
  /** Of `columns` side by side, which one, from 0. */
  readonly column: number;
  readonly columns: number;
  /** Set in, lapping over the earlier one. */
  readonly lap: boolean;
  /** Minutes of this event above a later one that laps over it; `null` when nothing laps over it. */
  readonly room: number | null;
}

export interface LaneLimits {
  /** The shortest an event is reckoned as, in minutes: what its drawn height takes. */
  readonly shortest: number;
  /** How far apart two starts must be for the later one to lap over the earlier. */
  readonly lapApart: number;
  /** The shortest an event is drawn, in px. */
  readonly shortestPx: number;
}

/** The limits at an hour's height: an event is drawn no lower than half an hour, between 16 and 22 px; a lap needs room for a line of words. */
export function laneLimits(hourPx: number): LaneLimits {
  const shortestPx = Math.min(22, Math.max(16, hourPx / 2));
  return {
    shortestPx,
    shortest: Math.min(30, Math.round((shortestPx / hourPx) * 60) + 2),
    lapApart: Math.max(30, Math.ceil((18.25 / hourPx) * 60)),
  };
}

interface Working<T extends GridItem> {
  readonly seg: Segment<T>;
  column: number;
  columns: number;
  lap: boolean;
  room: number | null;
}

const overlaps = <T extends GridItem>(a: Working<T>, b: Working<T>): boolean =>
  a.seg.from < b.seg.to && a.seg.to > b.seg.from;

/** One day's segments (in order of start, as `placeDays` gives them) set out side by side or lapping. */
export function lanesOf<T extends GridItem>(segments: readonly Segment<T>[], limits: LaneLimits): Laned<T>[] {
  const all: Working<T>[] = [];
  let cluster: Working<T>[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    const n = columnEnds.length;
    for (const w of cluster) w.columns = n;
    if (n === 2) {
      for (const w of cluster) {
        if (w.column !== 1) continue;
        /* It laps only where every event under it started far enough before it: one that starts after it is never covered. */
        const unders = cluster.filter((u) => u.column === 0 && overlaps(u, w));
        w.lap = unders.length > 0 && unders.every((u) => w.seg.from - u.seg.from >= limits.lapApart);
      }
      if (cluster.every((w) => w.column === 0 || w.lap)) {
        for (const w of cluster) if (!w.lap) Object.assign(w, { columns: 1, column: 0 });
      } else for (const w of cluster) w.lap = false;
    }
    cluster = [];
    columnEnds = [];
    clusterEnd = -1;
  };
  for (const seg of segments) {
    const end = Math.max(seg.to, seg.from + limits.shortest);
    if (cluster.length > 0 && seg.from >= clusterEnd) flush();
    let column = 0;
    while (columnEnds[column] !== undefined && columnEnds[column]! > seg.from) column++;
    columnEnds[column] = end;
    const w: Working<T> = { seg, column, columns: 1, lap: false, room: null };
    cluster.push(w);
    all.push(w);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  // An event another laps over keeps only the minutes that stand above the lap.
  for (const w of all) {
    if (!w.lap) continue;
    const under = all.find((u) => u.column === 0 && !u.lap && overlaps(u, w));
    if (under !== undefined) under.room = Math.min(under.room ?? Infinity, w.seg.from - under.seg.from);
  }
  return all.map((w) => ({ ...w.seg, column: w.column, columns: w.columns, lap: w.lap, room: w.room }));
}
