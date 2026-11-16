/**
 * THE YEAR: twelve months of six weeks. A day with something is busy (in its own month only); a run of
 * two days or more is a line under its days, broken at each week's edge.
 */
import { weekOf, type ZoneSource } from "@ohmail/cal-core";
import {
  addDays,
  dayIdOf,
  dayNumberOf,
  firstOfMonth,
  monthOfDay,
  weekStartOf,
  type DayId,
  type MonthId,
  type Placed,
} from "./days.js";
import { layItems } from "./month.js";

export interface YearQuery<T extends Placed> {
  readonly year: number;
  readonly weekStart: number;
  readonly today: DayId;
  readonly picked: DayId | null;
  readonly zone: string;
  /** The zone rules the view places by: the same for every view. */
  readonly zones: ZoneSource;
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
}

export interface YearRun {
  readonly key: string;
  /** The run's first day, or the first of its week here. */
  readonly first: boolean;
  /** The run's last day, or the last of its week here. */
  readonly last: boolean;
}

export interface YearDay {
  readonly id: DayId;
  readonly day: number;
  readonly outside: boolean;
  readonly today: boolean;
  readonly picked: boolean;
  readonly busy: boolean;
  readonly run: YearRun | null;
}

export interface YearMonth {
  readonly month: MonthId;
  /** It holds today. */
  readonly hot: boolean;
  /** Six weeks, 42 days. */
  readonly days: readonly YearDay[];
  /** Each of its six rows: its first day and the week's number. */
  readonly rows: readonly { readonly first: DayId; readonly week: number }[];
}

export interface YearData {
  readonly year: number;
  readonly months: readonly YearMonth[];
  readonly unplaced: number;
}

export function yearMonths<T extends Placed>(q: YearQuery<T>): YearData {
  const { laid, unplaced } = layItems(q.items, q.keyOf, q.zone, q.zones);
  const busy = new Set<number>();
  /* The first run that covers a day, the longest first: one line under a day. */
  const runOn = new Map<number, { key: string; first: number; last: number }>();
  const runs = laid
    .filter((x) => x.last > x.first)
    .sort((a, b) => b.last - b.first - (a.last - a.first) || a.first - b.first);
  for (const x of laid) for (let d = x.first; d <= x.last; d++) busy.add(d);
  for (const r of runs) for (let d = r.first; d <= r.last; d++) if (!runOn.has(d)) runOn.set(d, r);
  const months: YearMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${String(q.year).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    const start = weekStartOf(firstOfMonth(month), q.weekStart);
    const s = dayNumberOf(start)!;
    const days: YearDay[] = [];
    for (let i = 0; i < 42; i++) {
      const n = s + i;
      const id = dayIdOf(n);
      const outside = monthOfDay(id) !== month;
      const r = outside ? undefined : runOn.get(n);
      days.push({
        id,
        day: Number(id.slice(8, 10)),
        outside,
        today: id === q.today,
        picked: id === q.picked && id !== q.today,
        busy: !outside && busy.has(n),
        run: r
          ? { key: r.key, first: n === r.first || i % 7 === 0, last: n === r.last || i % 7 === 6 }
          : null,
      });
    }
    months.push({
      month,
      hot: monthOfDay(q.today) === month,
      days,
      rows: Array.from({ length: 6 }, (_, w) => ({
        first: addDays(start, w * 7),
        week: weekOf(s + w * 7, q.weekStart).week,
      })),
    });
  }
  return { year: q.year, months, unplaced };
}
