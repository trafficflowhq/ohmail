/**
 * THE MONTH RAIL'S STEPS, laid out for the room: with a pointer the years, and the months of the year on show; under a
 * finger the years alone. A step's id says what it is: `y:2026`, `m:2026-11`, `m:none` (the letters with no date).
 */
import type { HistoryMonth } from "@ohmail/app-logic/history";
import type { MonthRailEntry } from "@ohmail/ui/mail";

/** The years the list holds, newest first. */
export function yearsOf(months: readonly HistoryMonth[]): string[] {
  const out: string[] = [];
  for (const m of months) {
    const year = m.month?.slice(0, 4);
    if (year !== undefined && !out.includes(year)) out.push(year);
  }
  return out;
}

/** The month a step goes to: a year goes to its newest month. Undefined: no such step. */
export function monthAt(months: readonly HistoryMonth[], id: string): string | null | undefined {
  if (id === "m:none") return null;
  if (id.startsWith("m:")) return id.slice(2);
  const year = id.slice(2);
  return months.find((m) => m.month?.startsWith(year))?.month;
}

/* Mid-month, midday UTC: the same month in every zone its name may be written in. */
const middle = (month: string): Date =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 15, 12));

export function railOf(
  months: readonly HistoryMonth[],
  shown: string | null,
  o: { years: boolean; locale: string; undated: string },
): { entries: MonthRailEntry[]; current: string | undefined } {
  const year = shown?.slice(0, 4);
  const short = new Intl.DateTimeFormat(o.locale, { month: "short", timeZone: "UTC" });
  const long = new Intl.DateTimeFormat(o.locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const entries: MonthRailEntry[] = [];
  for (const y of yearsOf(months)) {
    entries.push({ id: `y:${y}`, label: y, year: true });
    if (o.years || y !== year) continue;
    for (const m of months)
      if (m.month?.startsWith(y))
        entries.push({
          id: `m:${m.month}`,
          label: short.format(middle(m.month)),
          title: long.format(middle(m.month)),
        });
  }
  if (!o.years && months.some((m) => m.month === null)) entries.push({ id: "m:none", label: o.undated });
  if (entries.length < 2) return { entries: [], current: undefined };
  const current = o.years ? (year === undefined ? undefined : `y:${year}`) : `m:${shown ?? "none"}`;
  return { entries, current };
}
