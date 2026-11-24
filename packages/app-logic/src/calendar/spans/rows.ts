/**
 * What stands where a list row's time does: the hours, "until 10:00" while it is on now, "all day", or,
 * for a day inside a run, "until" its last day or its end.
 */
import type { DayId } from "./days.js";

export type RowTime =
  | { readonly kind: "allDay" }
  | { readonly kind: "at"; readonly from: number; readonly to: number | null }
  | { readonly kind: "until"; readonly minute: number }
  | { readonly kind: "untilDay"; readonly day: DayId };

export interface RowTimeInput {
  readonly day: DayId;
  readonly allDay: boolean;
  readonly startMinute: number | null;
  readonly endMinute: number | null;
  readonly first: boolean;
  readonly lastDay: DayId;
}

/** The row's time, and whether it is on now (its time drawn hot). */
export function rowTime(r: RowTimeInput, today: DayId, nowMinute: number): { time: RowTime; now: boolean } {
  const last = r.day === r.lastDay;
  const before = r.day < r.lastDay;
  if (r.allDay)
    return {
      time: before && !r.first ? { kind: "untilDay", day: r.lastDay } : { kind: "allDay" },
      now: false,
    };
  if (!r.first) {
    if (last && r.endMinute !== null)
      return {
        time: { kind: "until", minute: r.endMinute },
        now: r.day === today && nowMinute < r.endMinute,
      };
    return { time: { kind: "untilDay", day: r.lastDay }, now: r.day === today };
  }
  const from = r.startMinute ?? 0;
  const to = last ? r.endMinute : null;
  const on = r.day === today && from <= nowMinute && (to === null ? before : nowMinute < to);
  if (on && to !== null) return { time: { kind: "until", minute: to }, now: true };
  return { time: { kind: "at", from, to: to !== null && to !== from ? to : null }, now: on };
}
