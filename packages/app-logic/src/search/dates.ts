/** The windows a date filter offers, by the days they reach back from today. */
export const DATE_WINDOWS = [
  ["week", 7],
  ["month", 31],
  ["year", 366],
] as const;
export type DateWindow = (typeof DATE_WINDOWS)[number][0];

export const civilDay = (day: Date): string =>
  `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

/** A window as the days it spans, ending today in this window's zone. */
export function datesOf(window: DateWindow, today: Date): { from: string; to: string } {
  const days = DATE_WINDOWS.find(([value]) => value === window)![1];
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { from: civilDay(from), to: civilDay(today) };
}

/** Which offered window the two dates describe, if any. */
export function dateWindowOf(from: string | null, to: string | null, today: Date): DateWindow | null {
  if (from === null || to === null) return null;
  for (const [window] of DATE_WINDOWS) {
    const dates = datesOf(window, today);
    if (dates.from === from && dates.to === to) return window;
  }
  return null;
}

/** `YYYY-MM-DD` as this window's midnight, or null for a day that is not one. */
function localDay(day: string): Date | null {
  if (day.length !== 10 || day[4] !== "-" || day[7] !== "-") return null;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const at = new Date(y, m - 1, d, 0, 0, 0, 0);
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d ? at : null;
}

/** The first millisecond of a day and the last, as instants. */
export function dayBounds(day: string): { first: string; last: string } | null {
  const at = localDay(day);
  if (at === null) return null;
  const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 0, 0, 0, 0);
  return { first: at.toISOString(), last: new Date(next.getTime() - 1).toISOString() };
}
