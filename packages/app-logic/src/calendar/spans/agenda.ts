/**
 * THE AGENDA: days as groups from a day on, whole days first and then by the hour. A day with nothing is
 * left out, except today (and the first day, where the view asks). A run stands on each of its days.
 */
import type { ZoneSource } from "@ohmail/cal-core";
import {
  addDays,
  dayIdOf,
  dayNumberOf,
  firstOfMonth,
  monthOfDay,
  weekStartOf,
  type DayId,
  type Placed,
} from "./days.js";
import { layItems } from "./month.js";

export interface AgendaQuery<T extends Placed> {
  readonly from: DayId;
  /** How many days from `from` on. */
  readonly days: number;
  readonly today: DayId;
  readonly zone: string;
  /** The zone rules the view places by: the same for every view. */
  readonly zones: ZoneSource;
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  /** The day asked for stands even with nothing on it. */
  readonly keepFirst?: boolean;
}

export interface AgendaRowData<T> {
  readonly key: string;
  readonly item: T;
  readonly allDay: boolean;
  /** Minutes after midnight on the day it starts; null for a whole day, or a later day of a run. */
  readonly startMinute: number | null;
  /** Its end on the reader's clock, on its last day; null for a whole day. */
  readonly endMinute: number | null;
  /** The thing's first day is this one. */
  readonly first: boolean;
  /** Its last day, where it runs across days. */
  readonly lastDay: DayId;
}

export interface AgendaDay<T> {
  readonly day: DayId;
  readonly today: boolean;
  readonly rows: readonly AgendaRowData<T>[];
}

export interface AgendaData<T> {
  readonly days: readonly AgendaDay<T>[];
  /** What cannot be placed: its time zone is not known on this device. */
  readonly unplaced: number;
}

export function agendaDays<T extends Placed>(q: AgendaQuery<T>): AgendaData<T> {
  const { laid, unplaced } = layItems(q.items, q.keyOf, q.zone, q.zones);
  const from = dayNumberOf(q.from)!;
  const out: AgendaDay<T>[] = [];
  for (let n = from; n < from + q.days; n++) {
    const day = dayIdOf(n);
    const rows = laid
      .filter((x) => x.first <= n && x.last >= n)
      .map((x) => ({
        key: x.key,
        item: x.item,
        allDay: x.run && x.minute === null,
        startMinute: x.first === n ? x.minute : null,
        endMinute: x.endMinute,
        first: x.first === n,
        lastDay: dayIdOf(x.last),
      }))
      .sort((a, b) => (a.startMinute ?? -1) - (b.startMinute ?? -1));
    const today = day === q.today;
    if (rows.length || today || (q.keepFirst && n === from)) out.push({ day, today, rows });
  }
  return { days: out, unplaced };
}

export type SpanView = "day" | "week" | "month" | "year" | "agenda";

/** The days a view shows around its anchor day: its first and last. */
export function spanOfView(view: SpanView, anchor: DayId, weekStart: number): { first: DayId; last: DayId } {
  if (view === "week") {
    const first = weekStartOf(anchor, weekStart);
    return { first, last: addDays(first, 6) };
  }
  if (view === "month") {
    const first = firstOfMonth(monthOfDay(anchor));
    const next = `${monthOfDay(addDays(first, 31))}-01`;
    return { first, last: addDays(next, -1) };
  }
  if (view === "year") return { first: `${anchor.slice(0, 4)}-01-01`, last: `${anchor.slice(0, 4)}-12-31` };
  return { first: anchor, last: anchor };
}

/** The Agenda's first day: today while the span on screen holds today, else the span's first day. */
export const agendaFrom = (span: { first: DayId; last: DayId }, today: DayId): DayId =>
  span.first <= today && today <= span.last ? today : span.first;
