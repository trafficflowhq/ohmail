/**
 * THE CALENDAR BESIDE MAIL'S ROW, as a type: one event on the rest of today or on what comes up with one person, and
 * now on the reader's clock that both lists are read at.
 */
import type { ZoneSource } from "@ohmail/cal-core";
import type { DayId } from "../spans/days.js";

/** One event on a list beside mail. */
export interface TodayRow {
  /** Unique on the list: the event, and the day of its series where it repeats. */
  readonly id: string;
  /** What a press opens: the event, its occurrence's key, the day the calendar goes to. */
  readonly ref: { readonly event: string; readonly occurrence: string | null; readonly day: DayId };
  /** Its title; null on a calendar that shows busy times only. */
  readonly title: string | null;
  readonly hue: number | "neutral";
  /** Its first day on the reader's clock. */
  readonly day: DayId;
  /** Its start in minutes on that day; null for a whole day, or one that began before today. */
  readonly startMinute: number | null;
  readonly allDay: boolean;
  /** It is on now. */
  readonly now: boolean;
  /** It waits for the person's answer. */
  readonly toAnswer: boolean;
}

/** Now on the reader's clock, and the zone rules it is read by. */
export interface ReaderNow {
  readonly day: DayId;
  readonly minute: number;
  readonly zone: string;
  readonly zones: ZoneSource;
}
