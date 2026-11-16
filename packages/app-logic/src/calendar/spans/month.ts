/**
 * THE MONTH: six weeks from the week of the first. Runs across days (and whole days) take lines first,
 * the longest first; timed events fill the lines left, by their start. A day shows four lines, or three
 * and how many more; the open event is never behind the count. Derived on each call: nothing is kept.
 */
import {
  dayNumberOf,
  monthOfDay,
  weekStartOf,
  addDays,
  daySpanOf,
  firstOfMonth,
  type DayId,
  type MonthId,
  type Placed,
} from "./days.js";
import { weekOf } from "@ohmail/cal-core";
import type { ZoneSource } from "@ohmail/cal-core";

export interface MonthQuery<T extends Placed> {
  readonly month: MonthId;
  /** Monday 0 to Sunday 6. */
  readonly weekStart: number;
  readonly today: DayId;
  readonly picked: DayId | null;
  readonly zone: string;
  /** The zone rules the view places by: the same for every view. */
  readonly zones: ZoneSource;
  readonly weekNumbers: boolean;
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  /** The open event's key: it takes the last line shown where its day has more than it shows. */
  readonly open: string | null;
  /** The weeks from this day's week on, where the month was scrolled; else the week of the first. */
  readonly top?: DayId | null;
  /** How many weeks; six fill the sheet. */
  readonly count?: number;
}

export interface MonthDay {
  readonly id: DayId;
  /** The date of the month. */
  readonly day: number;
  readonly month: MonthId;
  readonly outside: boolean;
  readonly today: boolean;
  readonly picked: boolean;
  /** How many of the day's events no line shows. */
  readonly more: number;
}

/** One line of a week: a run over columns `from` to `to` (0 to 6), or a timed event on its day. */
export interface MonthPiece<T> {
  readonly key: string;
  readonly item: T;
  readonly from: number;
  readonly to: number;
  /** The line, from 0. */
  readonly row: number;
  readonly run: boolean;
  readonly goesOnBefore: boolean;
  readonly goesOnAfter: boolean;
  /** A timed line's start on the reader's clock, in minutes; null for a run. */
  readonly startMinute: number | null;
}

export interface MonthWeek<T> {
  readonly id: DayId;
  readonly days: readonly MonthDay[];
  readonly number: { readonly week: number; readonly weekYear: number } | null;
  readonly pieces: readonly MonthPiece<T>[];
}

export interface MonthGridData<T> {
  readonly month: MonthId;
  readonly weeks: readonly MonthWeek<T>[];
  /** Items whose zone is not known here: not placed, and said. */
  readonly unplaced: number;
}

const LINES = 4;

interface Laid<T> {
  key: string;
  item: T;
  a: number;
  z: number;
  run: boolean;
  minute: number | null;
  endMinute: number | null;
  first: number;
  last: number;
}

function weekOfItems<T>(
  laid: readonly Laid<T>[],
  start: number,
  open: string | null,
): { pieces: MonthPiece<T>[]; more: number[] } {
  const end = start + 6;
  const inWeek = laid.filter((x) => x.first <= end && x.last >= start);
  const runs = inWeek
    .filter((x) => x.run)
    .map((x) => ({ x, a: Math.max(0, x.first - start), z: Math.min(6, x.last - start) }))
    .sort((p, q) => q.z - q.a - (p.z - p.a) || p.a - q.a || p.x.first - q.x.first);
  const slots: boolean[][] = Array.from({ length: 7 }, () => []);
  const total = Array.from({ length: 7 }, () => 0);
  const placedRuns = runs.map((r) => {
    let s = 0;
    for (;;) {
      let free = true;
      for (let k = r.a; k <= r.z; k++) if (slots[k]![s]) free = false;
      if (free) break;
      s++;
    }
    for (let k = r.a; k <= r.z; k++) {
      slots[k]![s] = true;
      total[k]!++;
    }
    return { ...r, row: s };
  });
  const timed: Laid<T>[][] = Array.from({ length: 7 }, () => []);
  for (const x of inWeek) if (!x.run) timed[x.first - start]!.push(x);
  for (let k = 0; k < 7; k++) {
    timed[k]!.sort((p, q) => (p.minute ?? -1) - (q.minute ?? -1));
    total[k]! += timed[k]!.length;
  }
  const room = total.map((t) => (t > LINES ? LINES - 1 : LINES));
  const pieces: MonthPiece<T>[] = [];
  const shown = Array.from({ length: 7 }, () => 0);
  const shownSlots: boolean[][] = Array.from({ length: 7 }, () => []);
  for (const r of placedRuns) {
    let hidden = false;
    for (let k = r.a; k <= r.z; k++) if (r.row >= room[k]!) hidden = true;
    if (hidden) continue;
    for (let k = r.a; k <= r.z; k++) {
      shown[k]!++;
      shownSlots[k]![r.row] = true;
    }
    pieces.push({
      key: r.x.key,
      item: r.x.item,
      from: r.a,
      to: r.z,
      row: r.row,
      run: true,
      goesOnBefore: r.x.first < start,
      goesOnAfter: r.x.last > end,
      startMinute: null,
    });
  }
  for (let k = 0; k < 7; k++) {
    const list = timed[k]!.slice();
    const free = room[k]! - shown[k]!;
    const at = open === null ? -1 : list.findIndex((x) => x.key === open);
    if (free > 0 && at >= free) list.splice(free - 1, 0, list.splice(at, 1)[0]!);
    let s = 0;
    for (const x of list) {
      while (shownSlots[k]![s]) s++;
      if (s >= room[k]!) break;
      shownSlots[k]![s] = true;
      shown[k]!++;
      pieces.push({
        key: x.key,
        item: x.item,
        from: k,
        to: k,
        row: s,
        run: false,
        goesOnBefore: false,
        goesOnAfter: false,
        startMinute: x.minute,
      });
    }
  }
  pieces.sort((p, q) => p.from - q.from || p.row - q.row);
  return { pieces, more: total.map((t, k) => t - shown[k]!) };
}

/** Lays every item once: its days in the reader's zone; a whole day or one across days is a run. */
export function layItems<T extends Placed>(
  items: readonly T[],
  keyOf: (item: T) => string,
  zone: string,
  zones: ZoneSource,
): { laid: Laid<T>[]; unplaced: number } {
  const laid: Laid<T>[] = [];
  let unplaced = 0;
  for (const item of items) {
    const s = daySpanOf(item, zone, zones);
    if (s === null) {
      unplaced++;
      continue;
    }
    const first = dayNumberOf(s.first)!;
    const last = dayNumberOf(s.last)!;
    laid.push({
      key: keyOf(item),
      item,
      a: first,
      z: last,
      first,
      last,
      run: s.allDay || last > first,
      minute: s.startMinute,
      endMinute: s.endMinute,
    });
  }
  return { laid, unplaced };
}

export function monthWeeks<T extends Placed>(q: MonthQuery<T>): MonthGridData<T> {
  const { laid, unplaced } = layItems(q.items, q.keyOf, q.zone, q.zones);
  const first = weekStartOf(q.top ?? firstOfMonth(q.month), q.weekStart);
  const weeks: MonthWeek<T>[] = [];
  for (let w = 0; w < (q.count ?? 6); w++) {
    const id = addDays(first, w * 7);
    const start = dayNumberOf(id)!;
    const { pieces, more } = weekOfItems(laid, start, q.open);
    const days: MonthDay[] = Array.from({ length: 7 }, (_, k) => {
      const d = addDays(id, k);
      return {
        id: d,
        day: Number(d.slice(8, 10)),
        month: monthOfDay(d),
        outside: monthOfDay(d) !== q.month,
        today: d === q.today,
        picked: d === q.picked && d !== q.today,
        more: more[k]!,
      };
    });
    weeks.push({ id, days, number: q.weekNumbers ? weekOf(start, q.weekStart) : null, pieces });
  }
  return { month: q.month, weeks, unplaced };
}
