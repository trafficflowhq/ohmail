/**
 * A DATE THE PERSON READS, from an ISO instant the SERVER stated. The one formatter the wall and
 * its strips share, so a closure's date cannot read two ways on one screen.
 *
 * `locale` and `zone` are parameters, never read here: this app resolves both through
 * `i18n/locale.ts` and `Intl`, and a formatter that reached for them itself would be a function
 * no case can drive at a fixed reading. An unparseable or absent instant answers the em dash the
 * rest of this app uses for "no value" — never today's date, which would be a fact about the
 * phone's clock rather than about the account.
 */

/** What a date-shaped hole says. The same glyph the web wall's `dayStamp` answers. */
export const NO_DATE = "—";

export function dayStamp(iso: string | null | undefined, locale: string, zone?: string): string {
  if (!iso) return NO_DATE;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return NO_DATE;
  try {
    return at.toLocaleDateString(locale, {
      dateStyle: "medium",
      ...(zone ? { timeZone: zone } : {}),
    });
  } catch {
    /* A locale or zone this runtime will not take (Hermes ships a reduced ICU on some builds) is
       not a reason to show nothing: the instant is still a date, in the runtime's own default. */
    return at.toLocaleDateString();
  }
}

/**
 * A day with its month spelled out, "November 8, 2026": the day the plan's own storage limit applies
 * again, in the storage notice. A runtime that refuses the locale gets its own default.
 */
export function longDayStamp(iso: string, locale: string): string {
  const at = new Date(iso);
  try {
    return at.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return at.toLocaleDateString();
  }
}

/**
 * "2019-04" as the reader's month, "April 2019": the month text is kept from. Mid-month at noon UTC,
 * formatted in UTC, so no zone moves it. A runtime that refuses the locale gets the month as it came.
 */
export function monthStamp(yearMonth: string, locale: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  try {
    return new Date(Date.UTC(y!, m! - 1, 15, 12)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return yearMonth;
  }
}
