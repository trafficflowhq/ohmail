/**
 * APPEND DATES FOR THE RIG'S GREENMAIL. GreenMail 2.1.3 reads an APPEND date-time with a
 * twelve-hour pattern, so a 12:xx hour files at 00:xx (imapflow writes the date in UTC; pinned by
 * the FIXTURE case of packages/core/test/adapters/organizer-lease-compaction.imap.test.ts). A test
 * that APPENDs a date relative to the wall clock takes it from here (test/rig-append-date-census.test.ts).
 */

const HOUR = 3_600_000;
const inNoonHour = (t: number): boolean => new Date(t).getUTCHours() === 12;

/**
 * The instants `agoMs` before `now` (floored to the second: an IMAP date-time has no milliseconds),
 * moved back together just far enough that none falls in 12:00-12:59 UTC: order and spacing kept.
 */
export function rigAppendDates(agoMs: readonly number[], now: number = Date.now()): Date[] {
  const base = Math.floor(now / 1000) * 1000;
  for (let shift = 0; shift < 24 * HOUR;) {
    const at = agoMs.map((ago) => base - ago - shift);
    const deepest = Math.max(-1, ...at.filter(inNoonHour).map((t) => t % HOUR));
    if (deepest < 0) return at.map((t) => new Date(t));
    shift += deepest + 1000;
  }
  throw new Error("no shift under a day keeps these APPEND dates out of the 12:xx UTC hour");
}

/** One such instant. */
export const rigAppendDate = (agoMs: number, now: number = Date.now()): Date => rigAppendDates([agoMs], now)[0]!;
