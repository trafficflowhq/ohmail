/**
 * RFC 5545's own recurrence examples (section 3.8.5.3), each with the instances the RFC lists.
 *
 * HOW THE EXPECTED VALUES WERE MADE. Every list below is the RFC's printed result, copied by hand and
 * checked item by item against the RFC's text. The RFC prints local dates under a heading such as
 * "(1997 9:00 AM EDT)"; `ny()` turns that into instants with the one fact the heading states: EDT is
 * four hours behind UTC and EST five. Where the RFC elides the middle of a list ("2,4,6,8...24"), the
 * missing members are written out. Where its list ends in "..." the series goes on and `open` is true:
 * the test then asks for the window that ends at the last printed instance.
 *
 * One example is wrong in the RFC as printed and is here twice (erratum 3883, verified): "every 3
 * hours from 9:00 AM to 5:00 PM" carries UNTIL=19970902T170000Z, which is 1:00 PM in New York.
 */

const OFFSET_HOURS = { EDT: 4, EST: 5 } as const;
type NyZone = keyof typeof OFFSET_HOURS;

/** `from..to`, both ends included. */
export const range = (from: number, to: number, step = 1): number[] => {
  const out: number[] = [];
  for (let n = from; n <= to; n += step) out.push(n);
  return out;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** The UTC instants of these New York days at `time` (9:00 unless said), given the RFC's own zone label. */
export function ny(year: number, zone: NyZone, monthDays: Record<number, readonly number[]>, time = "09:00"): string[] {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const out: string[] = [];
  for (const [month, days] of Object.entries(monthDays)) {
    for (const day of days) {
      // Local wall time plus the zone's distance to UTC; Date.UTC carries an hour past midnight.
      out.push(new Date(Date.UTC(year, Number(month) - 1, day, h + OFFSET_HOURS[zone], m)).toISOString().replace(".000Z", "Z"));
    }
  }
  return out;
}

export interface RuleCase {
  /** The RFC's own caption. */
  readonly title: string;
  /** DTSTART's local value; the zone is America/New_York throughout. */
  readonly dtstart: string;
  /** One rule, or the forms the RFC gives as equal ("or"). */
  readonly rules: readonly string[];
  readonly exdate?: string;
  readonly expect: readonly string[];
  /** The RFC's list ends in "...": the series goes on past the last instance printed. */
  readonly open: boolean;
}

const D = "19970902T090000";

export const RFC_RULE_CASES: readonly RuleCase[] = [
  { title: "Daily for 10 occurrences", dtstart: D, rules: ["FREQ=DAILY;COUNT=10"], open: false, expect: ny(1997, "EDT", { 9: range(2, 11) }) },
  {
    title: "Daily until December 24, 1997",
    dtstart: D,
    rules: ["FREQ=DAILY;UNTIL=19971224T000000Z"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: range(2, 30), 10: range(1, 25) }), ...ny(1997, "EST", { 10: range(26, 31), 11: range(1, 30), 12: range(1, 23) })],
  },
  {
    title: "Every other day - forever",
    dtstart: D,
    rules: ["FREQ=DAILY;INTERVAL=2"],
    open: true,
    expect: [...ny(1997, "EDT", { 9: range(2, 30, 2), 10: range(2, 24, 2) }), ...ny(1997, "EST", { 10: [26, 28, 30], 11: range(1, 29, 2), 12: [1, 3] })],
  },
  { title: "Every 10 days, 5 occurrences", dtstart: D, rules: ["FREQ=DAILY;INTERVAL=10;COUNT=5"], open: false, expect: ny(1997, "EDT", { 9: [2, 12, 22], 10: [2, 12] }) },
  {
    title: "Every day in January, for 3 years",
    dtstart: "19980101T090000",
    rules: ["FREQ=YEARLY;UNTIL=20000131T140000Z;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA", "FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1"],
    open: false,
    expect: [...ny(1998, "EST", { 1: range(1, 31) }), ...ny(1999, "EST", { 1: range(1, 31) }), ...ny(2000, "EST", { 1: range(1, 31) })],
  },
  {
    title: "Weekly for 10 occurrences",
    dtstart: D,
    rules: ["FREQ=WEEKLY;COUNT=10"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [2, 9, 16, 23, 30], 10: [7, 14, 21] }), ...ny(1997, "EST", { 10: [28], 11: [4] })],
  },
  {
    title: "Weekly until December 24, 1997",
    dtstart: D,
    rules: ["FREQ=WEEKLY;UNTIL=19971224T000000Z"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [2, 9, 16, 23, 30], 10: [7, 14, 21] }), ...ny(1997, "EST", { 10: [28], 11: [4, 11, 18, 25], 12: [2, 9, 16, 23] })],
  },
  {
    title: "Every other week - forever",
    dtstart: D,
    rules: ["FREQ=WEEKLY;INTERVAL=2;WKST=SU"],
    open: true,
    expect: [...ny(1997, "EDT", { 9: [2, 16, 30], 10: [14] }), ...ny(1997, "EST", { 10: [28], 11: [11, 25], 12: [9, 23] }), ...ny(1998, "EST", { 1: [6, 20], 2: [3, 17] })],
  },
  {
    title: "Weekly on Tuesday and Thursday for five weeks",
    dtstart: D,
    rules: ["FREQ=WEEKLY;UNTIL=19971007T000000Z;WKST=SU;BYDAY=TU,TH", "FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH"],
    open: false,
    expect: ny(1997, "EDT", { 9: [2, 4, 9, 11, 16, 18, 23, 25, 30], 10: [2] }),
  },
  {
    title: "Every other week on Monday, Wednesday, and Friday until December 24, 1997, starting on Monday, September 1, 1997",
    dtstart: "19970901T090000",
    rules: ["FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [1, 3, 5, 15, 17, 19, 29], 10: [1, 3, 13, 15, 17] }), ...ny(1997, "EST", { 10: [27, 29, 31], 11: [10, 12, 14, 24, 26, 28], 12: [8, 10, 12, 22] })],
  },
  {
    title: "Every other week on Tuesday and Thursday, for 8 occurrences",
    dtstart: D,
    rules: ["FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH"],
    open: false,
    expect: ny(1997, "EDT", { 9: [2, 4, 16, 18, 30], 10: [2, 14, 16] }),
  },
  {
    title: "Monthly on the first Friday for 10 occurrences",
    dtstart: "19970905T090000",
    rules: ["FREQ=MONTHLY;COUNT=10;BYDAY=1FR"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [5], 10: [3] }), ...ny(1997, "EST", { 11: [7], 12: [5] }), ...ny(1998, "EST", { 1: [2], 2: [6], 3: [6], 4: [3] }), ...ny(1998, "EDT", { 5: [1], 6: [5] })],
  },
  {
    title: "Monthly on the first Friday until December 24, 1997",
    dtstart: "19970905T090000",
    rules: ["FREQ=MONTHLY;UNTIL=19971224T000000Z;BYDAY=1FR"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [5], 10: [3] }), ...ny(1997, "EST", { 11: [7], 12: [5] })],
  },
  {
    title: "Every other month on the first and last Sunday of the month for 10 occurrences",
    dtstart: "19970907T090000",
    rules: ["FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [7, 28] }), ...ny(1997, "EST", { 11: [2, 30] }), ...ny(1998, "EST", { 1: [4, 25], 3: [1, 29] }), ...ny(1998, "EDT", { 5: [3, 31] })],
  },
  {
    title: "Monthly on the second-to-last Monday of the month for 6 months",
    dtstart: "19970922T090000",
    rules: ["FREQ=MONTHLY;COUNT=6;BYDAY=-2MO"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [22], 10: [20] }), ...ny(1997, "EST", { 11: [17], 12: [22] }), ...ny(1998, "EST", { 1: [19], 2: [16] })],
  },
  {
    title: "Monthly on the third-to-the-last day of the month, forever",
    dtstart: "19970928T090000",
    rules: ["FREQ=MONTHLY;BYMONTHDAY=-3"],
    open: true,
    expect: [...ny(1997, "EDT", { 9: [28] }), ...ny(1997, "EST", { 10: [29], 11: [28], 12: [29] }), ...ny(1998, "EST", { 1: [29], 2: [26] })],
  },
  {
    title: "Monthly on the 2nd and 15th of the month for 10 occurrences",
    dtstart: D,
    rules: ["FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [2, 15], 10: [2, 15] }), ...ny(1997, "EST", { 11: [2, 15], 12: [2, 15] }), ...ny(1998, "EST", { 1: [2, 15] })],
  },
  {
    title: "Monthly on the first and last day of the month for 10 occurrences",
    dtstart: "19970930T090000",
    rules: ["FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [30], 10: [1] }), ...ny(1997, "EST", { 10: [31], 11: [1, 30], 12: [1, 31] }), ...ny(1998, "EST", { 1: [1, 31], 2: [1] })],
  },
  {
    title: "Every 18 months on the 10th thru 15th of the month for 10 occurrences",
    dtstart: "19970910T090000",
    rules: ["FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: range(10, 15) }), ...ny(1999, "EST", { 3: range(10, 13) })],
  },
  {
    title: "Every Tuesday, every other month",
    dtstart: D,
    rules: ["FREQ=MONTHLY;INTERVAL=2;BYDAY=TU"],
    open: true,
    expect: [...ny(1997, "EDT", { 9: [2, 9, 16, 23, 30] }), ...ny(1997, "EST", { 11: [4, 11, 18, 25] }), ...ny(1998, "EST", { 1: [6, 13, 20, 27], 3: [3, 10, 17, 24, 31] })],
  },
  {
    title: "Yearly in June and July for 10 occurrences",
    dtstart: "19970610T090000",
    rules: ["FREQ=YEARLY;COUNT=10;BYMONTH=6,7"],
    open: false,
    expect: [1997, 1998, 1999, 2000, 2001].flatMap((y) => ny(y, "EDT", { 6: [10], 7: [10] })),
  },
  {
    title: "Every other year on January, February, and March for 10 occurrences",
    dtstart: "19970310T090000",
    rules: ["FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3"],
    open: false,
    expect: [...ny(1997, "EST", { 3: [10] }), ...[1999, 2001, 2003].flatMap((y) => ny(y, "EST", { 1: [10], 2: [10], 3: [10] }))],
  },
  {
    title: "Every third year on the 1st, 100th, and 200th day for 10 occurrences",
    dtstart: "19970101T090000",
    rules: ["FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200"],
    open: false,
    expect: [
      ...ny(1997, "EST", { 1: [1] }), ...ny(1997, "EDT", { 4: [10], 7: [19] }),
      ...ny(2000, "EST", { 1: [1] }), ...ny(2000, "EDT", { 4: [9], 7: [18] }),
      ...ny(2003, "EST", { 1: [1] }), ...ny(2003, "EDT", { 4: [10], 7: [19] }),
      ...ny(2006, "EST", { 1: [1] }),
    ],
  },
  {
    title: "Every 20th Monday of the year, forever",
    dtstart: "19970519T090000",
    rules: ["FREQ=YEARLY;BYDAY=20MO"],
    open: true,
    expect: [...ny(1997, "EDT", { 5: [19] }), ...ny(1998, "EDT", { 5: [18] }), ...ny(1999, "EDT", { 5: [17] })],
  },
  {
    title: "Monday of week number 20 (where the default start of the week is Monday), forever",
    dtstart: "19970512T090000",
    rules: ["FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO"],
    open: true,
    expect: [...ny(1997, "EDT", { 5: [12] }), ...ny(1998, "EDT", { 5: [11] }), ...ny(1999, "EDT", { 5: [17] })],
  },
  {
    title: "Every Thursday in March, forever",
    dtstart: "19970313T090000",
    rules: ["FREQ=YEARLY;BYMONTH=3;BYDAY=TH"],
    open: true,
    expect: [...ny(1997, "EST", { 3: [13, 20, 27] }), ...ny(1998, "EST", { 3: [5, 12, 19, 26] }), ...ny(1999, "EST", { 3: [4, 11, 18, 25] })],
  },
  {
    title: "Every Thursday, but only during June, July, and August, forever",
    dtstart: "19970605T090000",
    rules: ["FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8"],
    open: true,
    expect: [
      ...ny(1997, "EDT", { 6: [5, 12, 19, 26], 7: [3, 10, 17, 24, 31], 8: [7, 14, 21, 28] }),
      ...ny(1998, "EDT", { 6: [4, 11, 18, 25], 7: [2, 9, 16, 23, 30], 8: [6, 13, 20, 27] }),
      ...ny(1999, "EDT", { 6: [3, 10, 17, 24], 7: [1, 8, 15, 22, 29], 8: [5, 12, 19, 26] }),
    ],
  },
  {
    title: "Every Friday the 13th, forever",
    dtstart: D,
    exdate: D,
    rules: ["FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13"],
    open: true,
    expect: [...ny(1998, "EST", { 2: [13], 3: [13], 11: [13] }), ...ny(1999, "EDT", { 8: [13] }), ...ny(2000, "EDT", { 10: [13] })],
  },
  {
    title: "The first Saturday that follows the first Sunday of the month, forever",
    dtstart: "19970913T090000",
    rules: ["FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13"],
    open: true,
    expect: [...ny(1997, "EDT", { 9: [13], 10: [11] }), ...ny(1997, "EST", { 11: [8], 12: [13] }), ...ny(1998, "EST", { 1: [10], 2: [7], 3: [7] }), ...ny(1998, "EDT", { 4: [11], 5: [9], 6: [13] })],
  },
  {
    title: "Every 4 years, the first Tuesday after a Monday in November, forever (U.S. Presidential Election day)",
    dtstart: "19961105T090000",
    rules: ["FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8"],
    open: true,
    expect: [...ny(1996, "EST", { 11: [5] }), ...ny(2000, "EST", { 11: [7] }), ...ny(2004, "EST", { 11: [2] })],
  },
  {
    title: "The third instance into the month of one of Tuesday, Wednesday, or Thursday, for the next 3 months",
    dtstart: "19970904T090000",
    rules: ["FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [4], 10: [7] }), ...ny(1997, "EST", { 11: [6] })],
  },
  {
    title: "The second-to-last weekday of the month",
    dtstart: "19970929T090000",
    rules: ["FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2"],
    open: true,
    expect: [...ny(1997, "EDT", { 9: [29] }), ...ny(1997, "EST", { 10: [30], 11: [27], 12: [30] }), ...ny(1998, "EST", { 1: [29], 2: [26], 3: [30] })],
  },
  {
    title: "Every 3 hours from 9:00 AM to 5:00 PM on a specific day (as printed: the UNTIL is 1:00 PM local)",
    dtstart: D,
    rules: ["FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T170000Z"],
    open: false,
    expect: [...ny(1997, "EDT", { 9: [2] }, "09:00"), ...ny(1997, "EDT", { 9: [2] }, "12:00")],
  },
  {
    title: "Every 3 hours from 9:00 AM to 5:00 PM on a specific day (erratum 3883: UNTIL at 5:00 PM local)",
    dtstart: D,
    rules: ["FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T210000Z"],
    open: false,
    expect: ["09:00", "12:00", "15:00"].flatMap((t) => ny(1997, "EDT", { 9: [2] }, t)),
  },
  {
    title: "Every 15 minutes for 6 occurrences",
    dtstart: D,
    rules: ["FREQ=MINUTELY;INTERVAL=15;COUNT=6"],
    open: false,
    expect: ["09:00", "09:15", "09:30", "09:45", "10:00", "10:15"].flatMap((t) => ny(1997, "EDT", { 9: [2] }, t)),
  },
  {
    title: "Every hour and a half for 4 occurrences",
    dtstart: D,
    rules: ["FREQ=MINUTELY;INTERVAL=90;COUNT=4"],
    open: false,
    expect: ["09:00", "10:30", "12:00", "13:30"].flatMap((t) => ny(1997, "EDT", { 9: [2] }, t)),
  },
  {
    title: "Every 20 minutes from 9:00 AM to 4:40 PM every day",
    dtstart: D,
    rules: ["FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,20,40", "FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10,11,12,13,14,15,16"],
    open: true,
    // Two days of 8 hours by 3 starts: 9:00, 9:20, 9:40 ... 16:00, 16:20, 16:40.
    expect: [2, 3].flatMap((day) => range(9, 16).flatMap((h) => [0, 20, 40].flatMap((m) => ny(1997, "EDT", { 9: [day] }, `${pad(h)}:${pad(m)}`)))),
  },
  {
    title: "An example where the days generated makes a difference because of WKST (WKST=MO)",
    dtstart: "19970805T090000",
    rules: ["FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO"],
    open: false,
    expect: ny(1997, "EDT", { 8: [5, 10, 19, 24] }),
  },
  {
    title: "changing only WKST from MO to SU, yields different results",
    dtstart: "19970805T090000",
    rules: ["FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU"],
    open: false,
    expect: ny(1997, "EDT", { 8: [5, 17, 19, 31] }),
  },
  {
    title: "An example where an invalid date (i.e., February 30) is ignored",
    dtstart: "20070115T090000",
    rules: ["FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5"],
    open: false,
    expect: [...ny(2007, "EST", { 1: [15, 30], 2: [15] }), ...ny(2007, "EDT", { 3: [15, 30] })],
  },
];

/**
 * Section 3.3.5's two local times that a clock change makes special, in the RFC's own words:
 * 2:30 on 11 March 2007 does not exist in New York and "is interpreted using the UTC offset before
 * the gap" (EST, five hours: 07:30 UTC, which the RFC calls 3:30 AM EDT); 1:30 on 4 November 2007
 * happens twice and "refers to the first occurrence" (EDT, four hours: 05:30 UTC).
 */
export const RFC_LOCAL_TIME_CASES = [
  { title: "a time the clock skips", tzid: "America/New_York", wall: "20070311T023000", expect: "2007-03-11T07:30:00Z" },
  { title: "a time the clock shows twice", tzid: "America/New_York", wall: "20071104T013000", expect: "2007-11-04T05:30:00Z" },
] as const;
