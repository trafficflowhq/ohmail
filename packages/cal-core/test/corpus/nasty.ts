/**
 * The cases a calendar gets wrong. Each one says in its own comment how the expected values were
 * worked out, and none was worked out by this package: by the zone's published offsets and a
 * calendar in hand, by another provider's recorded answer, or by the standard's own words. The zone
 * arithmetic was also read back once from the system's zone database (version 2026e) through
 * Python's zoneinfo, and the rules through dateutil 2.8.2, an unrelated implementation.
 *
 * Zone facts used below (IANA, as published): Europe/Zurich is UTC+1 (CET) and UTC+2 (CEST) from the
 * last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC; in 2026 those are 29 March
 * and 25 October, in 2027 28 March and 31 October.
 */
import type { Fixture } from "./types.js";

const cal = (name: string, body: readonly string[], head: readonly string[] = []): Fixture => ({
  name,
  lines: ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//corpus//EN", ...head, ...body, "END:VCALENDAR"],
});
const event = (uid: string, lines: readonly string[]): string[] => ["BEGIN:VEVENT", `UID:${uid}@atelier.example`, "DTSTAMP:20261113T120000Z", ...lines, "END:VEVENT"];

export interface Expanded {
  readonly fixture: Fixture;
  /** The window asked, as UTC instants. */
  readonly window: readonly [string, string];
  /** The viewer's zone, for whole days and for times with no zone. */
  readonly viewer: string;
  /** Start instants, in order. */
  readonly starts: readonly string[];
}

/**
 * A REPEAT ACROSS A ZONE CHANGE, spring. Sundays 18:00 in Zurich from 15 March 2026, four times.
 * 15 and 22 March are CET: 18:00 is 17:00 UTC. The clocks change at 02:00 on the 29th, sixteen hours
 * before that evening's class, so 29 March and 5 April are CEST: 18:00 is 16:00 UTC. The class stays
 * at six in the evening; the instant moves by an hour.
 */
export const zurich_spring: Expanded = {
  fixture: cal("nasty/weekly-across-march", event("spring", ["DTSTART;TZID=Europe/Zurich:20260315T180000", "DTEND;TZID=Europe/Zurich:20260315T193000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Sunday class"])),
  window: ["2026-03-01T00:00:00Z", "2026-05-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-03-15T17:00:00Z", "2026-03-22T17:00:00Z", "2026-03-29T16:00:00Z", "2026-04-05T16:00:00Z"],
};

/** The same in autumn. Wednesdays 18:00: 14 and 21 October are CEST (16:00 UTC), 28 October is CET (17:00 UTC). */
export const zurich_autumn: Expanded = {
  fixture: cal("nasty/weekly-across-october", event("autumn", ["DTSTART;TZID=Europe/Zurich:20261014T180000", "DTEND;TZID=Europe/Zurich:20261014T193000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Wednesday class"])),
  window: ["2026-10-01T00:00:00Z", "2026-11-15T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-10-14T16:00:00Z", "2026-10-21T16:00:00Z", "2026-10-28T17:00:00Z"],
};

/**
 * THE LAST DAY OF THE MONTH, fourteen times from 31 January 2027, 08:00 in Zurich. The month ends
 * are 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31, then 31 January and 29 February 2028 (a leap
 * year). CET until 28 March 2027 and from 31 October 2027: 08:00 is 07:00 UTC; CEST between: 06:00.
 * 31 October 2027 is the day the clocks go back at 03:00, five hours before: already CET.
 */
export const last_day_of_month: Expanded = {
  fixture: cal("nasty/last-day-of-month", event("month-end", ["DTSTART;TZID=Europe/Zurich:20270131T080000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=14", "SUMMARY:Close the books"])),
  window: ["2027-01-01T00:00:00Z", "2028-04-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: [
    "2027-01-31T07:00:00Z", "2027-02-28T07:00:00Z", "2027-03-31T06:00:00Z", "2027-04-30T06:00:00Z", "2027-05-31T06:00:00Z", "2027-06-30T06:00:00Z", "2027-07-31T06:00:00Z",
    "2027-08-31T06:00:00Z", "2027-09-30T06:00:00Z", "2027-10-31T07:00:00Z", "2027-11-30T07:00:00Z", "2027-12-31T07:00:00Z", "2028-01-31T07:00:00Z", "2028-02-29T07:00:00Z",
  ],
};

/** THE LAST FRIDAY of each month, six times from 30 January 2026, 16:00 in Zurich: 30 Jan, 27 Feb, 27 Mar (CET, 15:00 UTC), 24 Apr, 29 May, 26 Jun (CEST, 14:00 UTC). */
export const last_friday: Expanded = {
  fixture: cal("nasty/last-friday", event("last-friday", ["DTSTART;TZID=Europe/Zurich:20260130T160000", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=6", "SUMMARY:Kiln cleaning"])),
  window: ["2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-01-30T15:00:00Z", "2026-02-27T15:00:00Z", "2026-03-27T15:00:00Z", "2026-04-24T14:00:00Z", "2026-05-29T14:00:00Z", "2026-06-26T14:00:00Z"],
};

/**
 * THE 31ST. A monthly rule that starts on 31 January 2026 and names no day. RFC 5545 3.3.10: a rule
 * may produce "an invalid date (e.g., February 30)" and such instances "MUST be ignored": February,
 * April, June, September and November have no 31st and are skipped, never moved to the 28th or 30th.
 * Seven instances: 31 Jan, 31 Mar, 31 May, 31 Jul, 31 Aug, 31 Oct, 31 Dec, at noon in Zurich
 * (11:00 UTC in CET, 10:00 UTC in CEST; 31 October 2026 is after the change of the 25th: CET).
 */
export const the_31st: Expanded = {
  fixture: cal("nasty/the-31st", event("the-31st", ["DTSTART;TZID=Europe/Zurich:20260131T120000", "RRULE:FREQ=MONTHLY;COUNT=7", "SUMMARY:Rent"])),
  window: ["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-01-31T11:00:00Z", "2026-03-31T10:00:00Z", "2026-05-31T10:00:00Z", "2026-07-31T10:00:00Z", "2026-08-31T10:00:00Z", "2026-10-31T11:00:00Z", "2026-12-31T11:00:00Z"],
};

/** A LEAP DAY, yearly, three times from 29 February 2024: 2024, 2028, 2032, and no year between. Noon CET is 11:00 UTC. */
export const leap_day: Expanded = {
  fixture: cal("nasty/leap-day", event("leap-day", ["DTSTART;TZID=Europe/Zurich:20240229T120000", "RRULE:FREQ=YEARLY;COUNT=3", "SUMMARY:Leap day"])),
  window: ["2024-01-01T00:00:00Z", "2033-01-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2024-02-29T11:00:00Z", "2028-02-29T11:00:00Z", "2032-02-29T11:00:00Z"],
};

/**
 * THE YEAR'S ENDS. The last weekday of the year (BYSETPOS=-1 over every weekday of the year): 31
 * December 2026 is a Thursday, 31 December 2027 a Friday, 31 December 2028 a Sunday, so 29 December.
 */
export const last_weekday_of_year: Expanded = {
  fixture: cal("nasty/last-weekday-of-year", event("year-end", ["DTSTART;TZID=Europe/Zurich:20261231T090000", "RRULE:FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "SUMMARY:Stocktaking"])),
  window: ["2026-01-01T00:00:00Z", "2029-01-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-12-31T08:00:00Z", "2027-12-31T08:00:00Z", "2028-12-29T08:00:00Z"],
};

/**
 * WEEK ONE BELONGS TO TWO YEARS. Monday of week 1: the week that holds 4 January. For 2026 that week
 * begins on Monday 29 December 2025; 2026 itself has no Monday in its week 1 (1 to 4 January are
 * Thursday to Sunday). Then 4 January 2027, 3 January 2028, 1 January 2029. Each Monday once.
 */
export const week_one_mondays: Expanded = {
  fixture: cal("nasty/week-one-mondays", event("week-one", ["DTSTART;TZID=Europe/Zurich:20251229T090000", "RRULE:FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO;COUNT=4", "SUMMARY:First Monday meeting"])),
  window: ["2025-01-01T00:00:00Z", "2030-01-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2025-12-29T08:00:00Z", "2027-01-04T08:00:00Z", "2028-01-03T08:00:00Z", "2029-01-01T08:00:00Z"],
};

/** WEEK 53 exists only in a year that begins on a Thursday, or a leap year that begins on a Wednesday: 2020, 2026, 2032. Its Thursday is 31 Dec, 31 Dec, 30 Dec. */
export const week_53: Expanded = {
  fixture: cal("nasty/week-53", event("week-53", ["DTSTART;TZID=Europe/Zurich:20201231T090000", "RRULE:FREQ=YEARLY;BYWEEKNO=53;BYDAY=TH;COUNT=3", "SUMMARY:Long year"])),
  window: ["2020-01-01T00:00:00Z", "2033-01-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2020-12-31T08:00:00Z", "2026-12-31T08:00:00Z", "2032-12-30T08:00:00Z"],
};

/**
 * COUNT, THEN EXDATE. Five daily instances from 1 June 2026, 07:00 in Zurich (CEST: 05:00 UTC), the
 * third excluded. RFC 5545 3.8.5.1: the excluded dates are taken from the set the rule made. So four
 * remain, 1, 2, 4 and 5 June, and there is no sixth day to make up the number.
 */
export const count_with_exdate: Expanded = {
  fixture: cal("nasty/count-with-exdate", event("count-exdate", ["DTSTART;TZID=Europe/Zurich:20260601T070000", "RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=Europe/Zurich:20260603T070000", "SUMMARY:Open the kiln"])),
  window: ["2026-05-01T00:00:00Z", "2026-07-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-06-01T05:00:00Z", "2026-06-02T05:00:00Z", "2026-06-04T05:00:00Z", "2026-06-05T05:00:00Z"],
};

/**
 * UNTIL AT THE BOUNDARY. Daily at 09:00 in Zurich from 5 January 2026 (CET: 08:00 UTC). RFC 5545
 * 3.3.10: UNTIL "bounds the recurrence rule in an inclusive manner". `inclusive` ends exactly on the
 * fourth instance and keeps it; `one_second_short` ends a second earlier and loses it.
 */
export const until_inclusive: Expanded = {
  fixture: cal("nasty/until-inclusive", event("until-a", ["DTSTART;TZID=Europe/Zurich:20260105T090000", "RRULE:FREQ=DAILY;UNTIL=20260108T080000Z", "SUMMARY:Morning round"])),
  window: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-01-05T08:00:00Z", "2026-01-06T08:00:00Z", "2026-01-07T08:00:00Z", "2026-01-08T08:00:00Z"],
};
export const until_one_second_short: Expanded = {
  fixture: cal("nasty/until-one-second-short", event("until-b", ["DTSTART;TZID=Europe/Zurich:20260105T090000", "RRULE:FREQ=DAILY;UNTIL=20260108T075959Z", "SUMMARY:Morning round"])),
  window: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-01-05T08:00:00Z", "2026-01-06T08:00:00Z", "2026-01-07T08:00:00Z"],
};
/** A rule's end written as a day, on a series of clock times (some writers do): the whole of that day in the series' own zone still counts. */
export const until_as_a_day: Expanded = {
  fixture: cal("nasty/until-as-a-day", event("until-c", ["DTSTART;TZID=Europe/Zurich:20260105T090000", "RRULE:FREQ=DAILY;UNTIL=20260108", "SUMMARY:Morning round"])),
  window: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-01-05T08:00:00Z", "2026-01-06T08:00:00Z", "2026-01-07T08:00:00Z", "2026-01-08T08:00:00Z"],
};

/**
 * HOURLY THROUGH THE HOUR THAT DOES NOT EXIST. Four hourly instances from 00:30 on 29 March 2026 in
 * Zurich: wall times 00:30, 01:30, 02:30, 03:30. 00:30 and 01:30 are CET (23:30 and 00:30 UTC). 02:30
 * is skipped by the clocks; RFC 5545 3.3.5 reads it with the offset before the gap, which makes it
 * 01:30 UTC. 03:30 CEST is 01:30 UTC as well. Two wall times, one instant: one occurrence, so three.
 */
export const hourly_through_the_gap: Expanded = {
  fixture: cal("nasty/hourly-through-the-gap", event("gap", ["DTSTART;TZID=Europe/Zurich:20260329T003000", "RRULE:FREQ=HOURLY;COUNT=4", "SUMMARY:Kiln check"])),
  window: ["2026-03-28T00:00:00Z", "2026-03-30T00:00:00Z"],
  viewer: "Europe/Zurich",
  starts: ["2026-03-28T23:30:00Z", "2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"],
};

/**
 * A DAY THAT NEVER HAPPENED. Samoa moved across the date line at the end of 29 December 2011: UTC-10
 * became UTC+14 at 10:00 UTC on the 30th, and 30 December did not exist in Apia. Daily at 10:00 from
 * the 29th, four times: the 29th is 20:00 UTC that day; the 30th, read with the offset before the
 * gap, is 20:00 UTC on the 30th; the 31st at UTC+14 is that same instant; 1 January is 20:00 UTC on
 * the 31st. Three occurrences.
 */
export const apia_skipped_day: Expanded = {
  fixture: cal("nasty/apia-skipped-day", event("apia", ["DTSTART;TZID=Pacific/Apia:20111229T100000", "RRULE:FREQ=DAILY;COUNT=4", "SUMMARY:Market"])),
  window: ["2011-12-25T00:00:00Z", "2012-01-05T00:00:00Z"],
  viewer: "Pacific/Apia",
  starts: ["2011-12-29T20:00:00Z", "2011-12-30T20:00:00Z", "2011-12-31T20:00:00Z"],
};

/**
 * HALF AN HOUR OF SUMMER TIME. Lord Howe Island is UTC+11 in summer and UTC+10:30 in winter; on 5
 * April 2026 its clocks go from 02:00 back to 01:30. Daily at 01:45 from 4 April, three times: the
 * 4th is UTC+11 (14:45 UTC on the 3rd); the 5th shows 01:45 twice and the first is still UTC+11
 * (14:45 UTC on the 4th); the 6th is UTC+10:30 (15:15 UTC on the 5th).
 */
export const lord_howe: Expanded = {
  fixture: cal("nasty/lord-howe-half-hour", event("lord-howe", ["DTSTART;TZID=Australia/Lord_Howe:20260404T014500", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Night watch"])),
  window: ["2026-04-01T00:00:00Z", "2026-04-10T00:00:00Z"],
  viewer: "Australia/Lord_Howe",
  starts: ["2026-04-03T14:45:00Z", "2026-04-04T14:45:00Z", "2026-04-05T15:15:00Z"],
};

/**
 * ADDED DATES, ONE WITH ITS OWN LENGTH. An event of half an hour at 09:00 UTC on 10 January 2026 with
 * no rule and three added dates: a period with an explicit end (10:00 to 11:30 the same day), a
 * period with a length (12 January 10:00, 45 minutes) and a plain time (15 January 09:00), which
 * takes the event's own half hour.
 */
export const rdate_periods = {
  fixture: cal("nasty/rdate-periods", event("rdate", [
    "DTSTART:20260110T090000Z", "DTEND:20260110T093000Z",
    "RDATE;VALUE=PERIOD:20260110T100000Z/20260110T113000Z,20260112T100000Z/PT45M", "RDATE:20260115T090000Z", "SUMMARY:Firing slots",
  ])),
  window: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"] as const,
  viewer: "Europe/Zurich",
  spans: [
    ["2026-01-10T09:00:00Z", "2026-01-10T09:30:00Z"],
    ["2026-01-10T10:00:00Z", "2026-01-10T11:30:00Z"],
    ["2026-01-12T10:00:00Z", "2026-01-12T10:45:00Z"],
    ["2026-01-15T09:00:00Z", "2026-01-15T09:30:00Z"],
  ] as const,
};

/**
 * A CHANGED DAY WITH NO SERIES. Only the override arrived (an invitation to one occurrence, or a
 * provider that hands changed days over as records of their own): it stands for the occurrence that
 * was at 08:00 UTC on 18 May 2026 and is held at 09:00 UTC on the 19th. One occurrence, on the 19th.
 */
export const orphan_override = {
  fixture: cal("nasty/orphan-override", event("orphan", ["RECURRENCE-ID:20260518T080000Z", "DTSTART:20260519T090000Z", "DTEND:20260519T093000Z", "SUMMARY:Glaze delivery (moved)"])),
  window: ["2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z"] as const,
  viewer: "Europe/Zurich",
  start: "2026-05-19T09:00:00Z",
  wasAt: "2026-05-18T08:00:00Z",
};

/**
 * THIS AND EVERY LATER ONE. Mondays 10:00 to 11:00 in Zurich, five times from 7 September 2026 (all
 * CEST: 08:00 UTC). An override for 21 September with RANGE=THISANDFUTURE holds it at 12:30 to 14:00.
 * RFC 5545 3.8.4.4: "all subsequent instances are also rescheduled by the same time difference" and
 * take "this same duration". So the 7th and 14th stay; the 21st, the 28th and 5 October start two and
 * a half hours later (10:30 UTC), last ninety minutes, and carry the override's title.
 */
export const this_and_future = {
  fixture: cal("nasty/this-and-future", [
    ...event("taf", ["DTSTART;TZID=Europe/Zurich:20260907T100000", "DTEND;TZID=Europe/Zurich:20260907T110000", "RRULE:FREQ=WEEKLY;COUNT=5", "SUMMARY:Studio meeting"]),
    ...event("taf", ["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Zurich:20260921T100000", "DTSTART;TZID=Europe/Zurich:20260921T123000", "DTEND;TZID=Europe/Zurich:20260921T140000", "SUMMARY:Studio meeting (after lunch)"]),
  ]),
  window: ["2026-09-01T00:00:00Z", "2026-11-01T00:00:00Z"] as const,
  viewer: "Europe/Zurich",
  spans: [
    ["2026-09-07T08:00:00Z", "2026-09-07T09:00:00Z", "Studio meeting"],
    ["2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z", "Studio meeting"],
    ["2026-09-21T10:30:00Z", "2026-09-21T12:00:00Z", "Studio meeting (after lunch)"],
    ["2026-09-28T10:30:00Z", "2026-09-28T12:00:00Z", "Studio meeting (after lunch)"],
    ["2026-10-05T10:30:00Z", "2026-10-05T12:00:00Z", "Studio meeting (after lunch)"],
  ] as const,
};

/**
 * ONE DAY CANCELLED, AND ONE NAMED IN UTC. Tuesdays 18:00 in Zurich, four times from 3 November 2026
 * (CET: 17:00 UTC). The second is cancelled by an override that says so; the third is moved an hour
 * by an override that names its occurrence as an instant (17:00 UTC on the 17th), as Exchange does.
 */
export const cancelled_and_utc_override = {
  fixture: cal("nasty/cancelled-and-utc-override", [
    ...event("mixed", ["DTSTART;TZID=Europe/Zurich:20261103T180000", "DTEND;TZID=Europe/Zurich:20261103T190000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Evening course"]),
    ...event("mixed", ["RECURRENCE-ID;TZID=Europe/Zurich:20261110T180000", "DTSTART;TZID=Europe/Zurich:20261110T180000", "DTEND;TZID=Europe/Zurich:20261110T190000", "STATUS:CANCELLED", "SUMMARY:Evening course"]),
    ...event("mixed", ["RECURRENCE-ID:20261117T170000Z", "DTSTART;TZID=Europe/Zurich:20261117T190000", "DTEND;TZID=Europe/Zurich:20261117T200000", "SUMMARY:Evening course (later)"]),
  ]),
  window: ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"] as const,
  viewer: "Europe/Zurich",
  starts: ["2026-11-03T17:00:00Z", "2026-11-17T18:00:00Z", "2026-11-24T17:00:00Z"] as const,
};

/**
 * A WHOLE DAY, READ WEST OF ITS WRITER. A market on 21 November 2026 written as a date, and a night
 * firing at 00:30 on the same day in Zurich (23:30 UTC on the 20th). In Los Angeles (UTC-8 then) the
 * firing is at 15:30 on the 20th; the market is still the 21st, because a date is not an instant.
 * In Kiritimati (UTC+14) the firing is at 13:30 on the 21st.
 */
export const whole_day_west = {
  fixture: cal("nasty/whole-day-read-west", [
    ...event("market", ["DTSTART;VALUE=DATE:20261121", "DTEND;VALUE=DATE:20261122", "SUMMARY:Market day"]),
    ...event("firing", ["DTSTART;TZID=Europe/Zurich:20261121T003000", "DTEND;TZID=Europe/Zurich:20261121T013000", "SUMMARY:Night firing"]),
  ]),
  firingAt: "2026-11-20T23:30:00Z",
  days: {
    "America/Los_Angeles": { market: "2026-11-21", firing: "2026-11-20" },
    "Europe/Zurich": { market: "2026-11-21", firing: "2026-11-21" },
    "Pacific/Kiritimati": { market: "2026-11-21", firing: "2026-11-21" },
  },
  /** The Los Angeles viewer's 20 and 21 November, as instants (midnight there is 08:00 UTC). */
  laDays: { nov20: ["2026-11-20T08:00:00Z", "2026-11-21T08:00:00Z"], nov21: ["2026-11-21T08:00:00Z", "2026-11-22T08:00:00Z"] },
} as const;

/**
 * A ZONE THE FILE DEFINES ITSELF. "Studio Time" exists nowhere else: UTC+5:45 in its winter and
 * UTC+6:45 from the first Sunday of October at 02:00 to the first Sunday of March at 03:00. Daily at
 * 10:00 from 3 October 2026, three times. The 3rd is still winter: 04:15 UTC. The first Sunday of
 * October 2026 is the 4th, and the change at 02:00 comes before 10:00: 03:15 UTC on the 4th and 5th.
 * `gap` (02:30 on the 4th, skipped) is read with the offset before the gap: 20:45 UTC on the 3rd.
 * `twice` (02:30 on 7 March 2027, the first Sunday of March, shown twice) is the first, still
 * UTC+6:45: 19:45 UTC on the 6th. `before` lies before the definition begins and takes the offset
 * the first change comes from, UTC+6:45: 10:00 on 1 June 2019 is 03:15 UTC.
 * Without the definition nobody knows the zone, and no instant is claimed.
 */
const STUDIO_ZONE = [
  "BEGIN:VTIMEZONE", "TZID:Studio Time",
  "BEGIN:STANDARD", "DTSTART:20200301T030000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=1SU", "TZOFFSETFROM:+0645", "TZOFFSETTO:+0545", "TZNAME:STD", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:20201004T020000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU", "TZOFFSETFROM:+0545", "TZOFFSETTO:+0645", "TZNAME:DST", "END:DAYLIGHT",
  "END:VTIMEZONE",
];
const STUDIO_EVENT = event("studio-time", ["DTSTART;TZID=Studio Time:20261003T100000", "DTEND;TZID=Studio Time:20261003T110000", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Morning throw"]);
export const file_zone = {
  defined: cal("nasty/zone-defined-in-the-file", [...STUDIO_ZONE, ...STUDIO_EVENT]),
  undefined: cal("nasty/zone-nobody-defines", STUDIO_EVENT),
  tzid: "Studio Time",
  window: ["2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z"] as const,
  starts: ["2026-10-03T04:15:00Z", "2026-10-04T03:15:00Z", "2026-10-05T03:15:00Z"] as const,
  gap: { wall: "20261004T023000", expect: "2026-10-03T20:45:00Z" },
  twice: { wall: "20270307T023000", expect: "2027-03-06T19:45:00Z" },
  before: { wall: "20190601T100000", expect: "2019-06-01T03:15:00Z" },
  /** The two changes of 2026 and 2027 as instants, and the offset in minutes after each. */
  changes: [["2026-10-03T20:15:00Z", 405], ["2027-03-06T20:15:00Z", 345]] as const,
} as const;

/**
 * A DAY IS NOT TWENTY-FOUR HOURS. An event that starts at noon on 28 March 2026 in Zurich, the day
 * before the clocks go forward. RFC 5545 3.3.6: weeks and days are nominal, "the number of days MUST
 * be added first", hours and minutes are exact. One day ends at noon on the 29th by the clock (CEST:
 * 10:00 UTC, twenty-three hours on). Twenty-four hours end twenty-four hours on (11:00 UTC, 13:00 by
 * the clock). A day and an hour is a day by the clock and then an hour: 13:00 by the clock, 11:00
 * UTC. A week is seven days by the clock. The day lengths carry the plus sign the grammar allows.
 */
export const a_day_is_not_24_hours = {
  start: "2026-03-28T11:00:00Z",
  cases: [
    { duration: "+P1D", end: "2026-03-29T10:00:00Z" },
    { duration: "PT24H", end: "2026-03-29T11:00:00Z" },
    { duration: "+P1DT1H", end: "2026-03-29T11:00:00Z" },
    { duration: "+P1W", end: "2026-04-04T10:00:00Z" },
  ],
  fixtureFor: (duration: string): Fixture => cal(`nasty/duration-${duration}`, event("dur", ["DTSTART;TZID=Europe/Zurich:20260328T120000", `DURATION:${duration}`, "SUMMARY:Long firing"])),
} as const;

/**
 * A RULE WITH NO END, EVERY SECOND. From midnight UTC on 1 January 2026. A day holds 86,400 of them;
 * the expansion stops at its ceiling, says so, and what it returned are the first seconds in order.
 */
export const every_second = {
  fixture: cal("nasty/every-second-for-ever", event("secondly", ["DTSTART:20260101T000000Z", "RRULE:FREQ=SECONDLY", "SUMMARY:Tick"])),
  window: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"] as const,
  first: "2026-01-01T00:00:00Z",
};

/**
 * A rule that can never match: every day that is the 30th of February, for ever. The walk looks at
 * one day after another and ends by its count of them, with nothing found and saying it stopped.
 */
export const never_matches = {
  fixture: cal("nasty/thirtieth-of-february", event("never", ["DTSTART:20260101T090000Z", "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", "SUMMARY:Never"])),
  window: ["2027-01-01T00:00:00Z", "9000-01-01T00:00:00Z"] as const,
};

/**
 * A WHOLE-DAY SERIES ENDED BY A MOMENT. Outlook ends a rule with a date-time even where the series
 * is whole days: "the time of the last instance", which for a whole day is that day's midnight on
 * the writer's own clock, said in UTC (the MS-OXCICAL specification, section 2.1.3.2.1.10). East of
 * UTC that is the evening before the last day. Every expected day is worked out from the writer's
 * offset, and is the same for every viewer: a whole day is not an instant.
 *
 * `one_day`: a person's export as quoted on a public forum (forum.magicmirror.builders, topic 19637;
 * a writer in the United Kingdom in summer, one hour ahead of UTC). One birthday on 5 May 2025; the
 * rule ends at 23:00 UTC on the 4th, which is midnight of the 5th there. One day: 5 May.
 * `mondays`: the same way for a writer in Zurich in June, two hours ahead. Mondays from 1 June 2026,
 * the last on the 29th, whose midnight there is 22:00 UTC on the 28th. Five days: 1, 8, 15, 22, 29.
 * `mondays_west`: a writer in New York, four hours behind. Midnight of the 29th there is 04:00 UTC on
 * the 29th. The same five.
 * `daily`: every day from 1 June 2026, the last on the 5th, written in Zurich: midnight of the 5th
 * there is 22:00 UTC on the 4th. Five days, and the 6th is not one: a daily rule has an instance on
 * the very day after its last, which a weekly one has not.
 * `end_of_day` and `end_of_day_utc`: a writer that ends its rule on the last second of the last day
 * instead: 23:59:59 on the 5th, on Zurich's clock (21:59:59 UTC) or on UTC's own. The same five.
 */
export interface ExpandedDays {
  readonly fixture: Fixture;
  readonly window: readonly [string, string];
  /** `2026-06-29`, in order. */
  readonly days: readonly string[];
}
const JUNE_MONDAYS = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"];
const FIRST_OF_JUNE = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"];
const SUMMER_2026 = ["2026-05-01T00:00:00Z", "2026-08-01T00:00:00Z"] as const;
export const whole_day_until = {
  one_day: {
    fixture: cal("outlook/whole-day-until-one-day", event("until-day", ["DTSTART;VALUE=DATE:20250505", "DTEND;VALUE=DATE:20250506", "RRULE:FREQ=YEARLY;UNTIL=20250504T230000Z;INTERVAL=1;BYMONTHDAY=5;BYMONTH=5", "SUMMARY:Birthday"])),
    window: ["2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    days: ["2025-05-05"],
  },
  mondays: {
    fixture: cal("outlook/whole-day-until-east", event("until-east", ["DTSTART;VALUE=DATE:20260601", "DTEND;VALUE=DATE:20260602", "RRULE:FREQ=WEEKLY;UNTIL=20260628T220000Z;BYDAY=MO", "SUMMARY:Stall rota"])),
    window: SUMMER_2026,
    days: JUNE_MONDAYS,
  },
  mondays_west: {
    fixture: cal("outlook/whole-day-until-west", event("until-west", ["DTSTART;VALUE=DATE:20260601", "DTEND;VALUE=DATE:20260602", "RRULE:FREQ=WEEKLY;UNTIL=20260629T040000Z;BYDAY=MO", "SUMMARY:Stall rota"])),
    window: SUMMER_2026,
    days: JUNE_MONDAYS,
  },
  daily: {
    fixture: cal("outlook/whole-day-until-daily", event("until-daily", ["DTSTART;VALUE=DATE:20260601", "DTEND;VALUE=DATE:20260602", "RRULE:FREQ=DAILY;UNTIL=20260604T220000Z", "SUMMARY:Market week"])),
    window: SUMMER_2026,
    days: FIRST_OF_JUNE,
  },
  end_of_day: {
    fixture: cal("nasty/whole-day-until-end-of-day", event("until-late", ["DTSTART;VALUE=DATE:20260601", "DTEND;VALUE=DATE:20260602", "RRULE:FREQ=DAILY;UNTIL=20260605T215959Z", "SUMMARY:Market week"])),
    window: SUMMER_2026,
    days: FIRST_OF_JUNE,
  },
  end_of_day_utc: {
    fixture: cal("nasty/whole-day-until-end-of-day-utc", event("until-late-utc", ["DTSTART;VALUE=DATE:20260601", "DTEND;VALUE=DATE:20260602", "RRULE:FREQ=DAILY;UNTIL=20260605T235959Z", "SUMMARY:Market week"])),
    window: SUMMER_2026,
    days: FIRST_OF_JUNE,
  },
} as const satisfies Record<string, ExpandedDays>;

/**
 * A DEFINITION OLDER THAN THE ZONE'S LAW. Mexico ended summer time with 30 October 2022, and Mexico
 * City has been six hours behind UTC the year round since (the IANA database from its release of
 * October 2022 on). A file written before that still carries the old rule: summer time from the first
 * Sunday of April to the last Sunday of October. Yearly at 10:00 on 1 June, from 2020.
 * By hand: in 2020 the old rule was the law, five hours behind: 15:00 UTC. In 2026 it is six hours
 * behind: 16:00 UTC. The file's own definition says 15:00 UTC for 2026 as well, an hour early.
 */
export const stale_zone_definition = {
  fixture: cal("nasty/zone-definition-older-than-the-law", [
    "BEGIN:VTIMEZONE", "TZID:America/Mexico_City",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "TZNAME:CDT", "DTSTART:19700405T020000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "TZNAME:CST", "DTSTART:19701025T020000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
    ...event("mexico", ["DTSTART;TZID=America/Mexico_City:20200601T100000", "DTEND;TZID=America/Mexico_City:20200601T110000", "RRULE:FREQ=YEARLY", "SUMMARY:Kiln inspection"]),
  ]),
  in2020: { window: ["2020-05-25T00:00:00Z", "2020-06-08T00:00:00Z"], start: "2020-06-01T15:00:00Z" },
  in2026: { window: ["2026-05-25T00:00:00Z", "2026-06-08T00:00:00Z"], start: "2026-06-01T16:00:00Z", byTheFileAlone: "2026-06-01T15:00:00Z" },
} as const;

export const NASTY: readonly Fixture[] = [
  ...Object.values(whole_day_until).map((c) => c.fixture), stale_zone_definition.fixture,
  zurich_spring.fixture, zurich_autumn.fixture, last_day_of_month.fixture, last_friday.fixture, the_31st.fixture, leap_day.fixture,
  last_weekday_of_year.fixture, week_one_mondays.fixture, week_53.fixture, count_with_exdate.fixture, until_inclusive.fixture,
  until_one_second_short.fixture, until_as_a_day.fixture, hourly_through_the_gap.fixture, apia_skipped_day.fixture, lord_howe.fixture,
  rdate_periods.fixture, orphan_override.fixture, this_and_future.fixture, cancelled_and_utc_override.fixture, whole_day_west.fixture,
  file_zone.defined, file_zone.undefined, every_second.fixture, never_matches.fixture,
  ...a_day_is_not_24_hours.cases.map((c) => a_day_is_not_24_hours.fixtureFor(c.duration)),
];
