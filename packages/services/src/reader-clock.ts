/**
 * THE READER'S CLOCK, as a client states it — an IANA zone and a locale. Stored instants stay UTC;
 * these decide only how an instant is read: which calendar month History counts it in, and how a
 * forward's quoted header names the original's date. Absent means unstated and reads as UTC in
 * English, what every older client got. A malformed value is a 400; a well-formed zone this
 * runtime's tz data does not know reads as unstated, because refusing History over it would be
 * worse than counting in UTC.
 */
import { ServiceError } from "./errors.js";

/** The longest IANA name is 32 characters (`America/Argentina/ComodRivadavia`); twice that is the bound. */
export const READER_ZONE_MAX_CHARS = 64;
/** BCP 47 tags a runtime names itself with are short; 35 is the RFC 5646 minimum an implementation must accept. */
export const READER_LOCALE_MAX_CHARS = 35;

const ZONE_SHAPE = /^[A-Za-z0-9_+\-/]+$/;
const LOCALE_SHAPE = /^[A-Za-z0-9-]+$/;

/** The zone a client states, or `undefined` for none or one this runtime cannot read. */
export function parseReaderZone(raw: unknown, field = "zone"): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > READER_ZONE_MAX_CHARS || !ZONE_SHAPE.test(raw)) {
    throw new ServiceError("validation_failed", 400, `${field} must be an IANA time zone name`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return undefined;
  }
}

/** The locale a client states, canonicalized, or `undefined` for none. */
export function parseReaderLocale(raw: unknown, field = "locale"): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > READER_LOCALE_MAX_CHARS || !LOCALE_SHAPE.test(raw)) {
    throw new ServiceError("validation_failed", 400, `${field} must be a language tag`);
  }
  try {
    return Intl.getCanonicalLocales(raw)[0] ?? undefined;
  } catch {
    throw new ServiceError("validation_failed", 400, `${field} must be a language tag`);
  }
}

/**
 * A forwarded original's date as its sender reads it: weekday, day, month, year, a 24-hour clock
 * and the zone's short name ("Sat, 26 Sep 2026, 08:00 CEST"), in the sender's locale. The zone is
 * named because the header travels to recipients in other zones.
 */
export function forwardedDate(at: Date, zone = "UTC", locale = "en"): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    timeZone: zone, timeZoneName: "short",
  }).format(at);
}

/** One calendar month in a zone: its `YYYY-MM` name and the UTC instants it starts and ends at. */
export interface ZonedMonth { month: string; start: Date; end: Date }

const FIELDS = new Map<string, Intl.DateTimeFormat>();

/** An instant's wall clock in `zone`, as the UTC epoch of the same fields. */
function wallMs(atMs: number, zone: string): number {
  let fmt = FIELDS.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    FIELDS.set(zone, fmt);
  }
  const f: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(atMs))) if (p.type !== "literal") f[p.type] = Number(p.value);
  return Date.UTC(f.year!, f.month! - 1, f.day!, f.hour! === 24 ? 0 : f.hour!, f.minute!, f.second!);
}

/**
 * The first instant of a calendar month in `zone` — local midnight on the 1st, or the instant the
 * clock jumps to where that midnight does not exist. The offsets a day either side bracket any
 * transition near it; the earliest candidate reading as midnight on the 1st or later wins.
 */
function monthStart(year: number, month: number, zone: string): Date {
  const naive = Date.UTC(year, month - 1, 1);
  const day = 86_400_000;
  const candidates = [naive - (wallMs(naive - day, zone) - (naive - day)), naive - (wallMs(naive + day, zone) - (naive + day))]
    .sort((a, b) => a - b);
  for (const c of candidates) if (wallMs(c, zone) >= naive) return new Date(c);
  return new Date(candidates[candidates.length - 1]!);
}

/** The month `instant` falls in, read in `zone`, as `[year, month]` with `month` 1-12. */
export function zonedMonthOf(instant: Date, zone: string): [number, number] {
  const w = new Date(wallMs(instant.getTime(), zone));
  return [w.getUTCFullYear(), w.getUTCMonth() + 1];
}

/** The calendar month `[year, month]` in `zone` as a window of UTC instants. */
export function zonedMonth(year: number, month: number, zone: string): ZonedMonth {
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  return {
    month: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
    start: monthStart(year, month, zone),
    end: monthStart(y, m, zone),
  };
}
