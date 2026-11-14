/**
 * THE CALENDAR'S SPAN AS A SERVER STATES IT on a snapshot page (`SyncSnapshotPage.calendarWindow`),
 * read at the wire's edge field by field: whole numbers, all three, or nothing. A page without it
 * is a page the server did not serve this account's calendar on.
 */
import type { CalendarWindow } from "@ohmail/wire";

export function calendarWindowOf(raw: unknown): { calendarWindow: CalendarWindow } | null {
  const w = raw as Partial<Record<keyof CalendarWindow, unknown>> | null | undefined;
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!w || typeof w !== "object" || !whole(w.daysBack) || !whole(w.daysAhead) || !whole(w.maxRows)) return null;
  return { calendarWindow: { daysBack: w.daysBack, daysAhead: w.daysAhead, maxRows: w.maxRows } };
}
