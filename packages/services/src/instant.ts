/**
 * ONE reading of a date string, TOTAL: the fields are checked against the calendar and the clock
 * and the instant is built from them — never `Date.parse`, which rolls February 30 into March 2
 * and reads a time with no offset in the server's zone, so a message left at a moment nobody
 * chose. Two refusals, named apart: `not_a_date` (no such day, or not a date at all) and
 * `not_a_moment` (a day, or a wall-clock time, that names no instant).
 */
export type InstantReading =
  | { ok: true; at: Date }
  | { ok: false; why: "not_a_date" | "not_a_moment" };

const SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : DAYS[month - 1]!;
}

export function readInstant(raw: string): InstantReading {
  const m = SHAPE.exec(raw);
  if (m === null) return { ok: false, why: "not_a_date" };
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  // Four-digit years from 1000: below that `Date.UTC` reads a two-digit year as 19xx.
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) {
    return { ok: false, why: "not_a_date" };
  }
  const hh = m[4], off = m[8];
  if (hh === undefined || off === undefined) return { ok: false, why: "not_a_moment" };
  const hour = Number(hh), minute = Number(m[5]), second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, why: "not_a_moment" };
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0").slice(0, 3));
  let offsetMin = 0;
  if (off !== "Z" && off !== "z") {
    const oh = Number(off.slice(1, 3)), om = Number(off.slice(-2));
    if (oh > 23 || om > 59) return { ok: false, why: "not_a_moment" };
    offsetMin = (off[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60_000);
  return { ok: true, at };
}

/** The refusal as a sentence about `field`, for the doors that answer 400 with it. */
export function instantRefusal(field: string, why: "not_a_date" | "not_a_moment"): string {
  return why === "not_a_date"
    ? `${field} is not a date`
    : `${field} is not a moment in time: a date-time needs its offset (Z or ±hh:mm)`;
}
