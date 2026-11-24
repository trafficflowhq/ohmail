/**
 * WHICH REPEATS A WRITE MAY SEND: each rule a person can make has one shape, a rule outside the list
 * has none, and a shape is sendable only where its provider's row names it. A row is empty until a
 * recorded proof brings it. A series as written has its shape only from a start the rule names, with
 * an end told as its start is, and never at a clock time its zone skips.
 */
import {
  floating,
  instant,
  intlZones,
  parseRRule,
  plainDate,
  wall,
  zoned,
  type EventTime,
  type ZoneSource,
} from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import {
  BENCH_CALDAV_PLACE,
  PROVEN_REPEATS,
  proofPlaceOf,
  repeatProven,
  repeatShapeAt,
  repeatShapeOf,
  seriesProven,
} from "../src/repeat-shapes.js";
import {
  carriedExclusions,
  continuedSeries,
  endsBeforeDay,
  movedRule,
  offItsClock,
  storedObjectFacts,
  untilSkipped,
} from "../src/series.js";

const ZONES = intlZones();
/** Today, as these cases are held: 15 November 2026. */
const TODAY = Date.UTC(2026, 10, 15, 12);

const shape = (text: string) => repeatShapeOf(parseRRule(text)!);

describe("a repeat's shape", () => {
  it("names each repeat a person can make, with how it ends", () => {
    const rows: [string, string | null][] = [
      ["FREQ=DAILY", "daily/never"],
      ["FREQ=DAILY;INTERVAL=3;COUNT=10", "every_n_days/count"],
      ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "weekdays/never"],
      ["FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20270101T000000Z", "weekdays/until"],
      ["FREQ=WEEKLY", "weekly/never"],
      ["FREQ=WEEKLY;BYDAY=TU", "weekly/never"],
      ["FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6", "weeks_on_days/count"],
      ["FREQ=MONTHLY;BYMONTHDAY=15", "monthly_by_date/never"],
      ["FREQ=MONTHLY;BYMONTHDAY=31", "monthly_late_date/never"],
      ["FREQ=MONTHLY;BYDAY=2TU", "monthly_nth_weekday/never"],
      ["FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231", "monthly_last_weekday/until"],
      ["FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "yearly_by_date/never"],
      ["FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "yearly_by_weekday/never"],
      // Outside the list: no shape, sendable nowhere.
      ["FREQ=HOURLY", null],
      ["FREQ=DAILY;BYHOUR=9,17", null],
      ["FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2", null],
      ["FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,FR", null],
      ["FREQ=YEARLY;BYWEEKNO=20", null],
      ["FREQ=WEEKLY;WKST=SU;BYDAY=MO", null],
    ];
    expect(rows.map(([text]) => [text, shape(text)])).toEqual(rows);
  });

  it("is sendable only where its place's row names it, and a row is empty until a proof brings it", () => {
    // The bench's CalDAV server's row came with its recorded proof (`repeat-proof.test.ts` holds it to that record); the others have none yet.
    expect([PROVEN_REPEATS.google, PROVEN_REPEATS.microsoft, PROVEN_REPEATS.ics]).toEqual([[], [], []]);
    const weekly = parseRRule("FREQ=WEEKLY")!;
    expect(repeatProven("google", weekly)).toBe(false);
    expect(repeatProven("google", weekly, { ...PROVEN_REPEATS, google: ["weekly/never"] })).toBe(true);
    expect(repeatProven(BENCH_CALDAV_PLACE, weekly)).toBe(true);
    expect(repeatProven(BENCH_CALDAV_PLACE, weekly, { ...PROVEN_REPEATS, [BENCH_CALDAV_PLACE]: [] })).toBe(
      false,
    );
    expect(
      repeatProven("google", parseRRule("FREQ=HOURLY")!, { ...PROVEN_REPEATS, google: ["weekly/never"] }),
    ).toBe(false);
  });

  it("is proven at a CalDAV server only where the proof was run at that server, by the host its connection names", () => {
    const weekly = parseRRule("FREQ=WEEKLY;BYDAY=MO")!;
    const monday = zoned(wall(2026, 11, 23, 9), "Europe/Zurich");
    // The bench's own server, as a connection to it names its place.
    expect(proofPlaceOf("caldav", "http://127.0.0.1:8821/dav/")).toBe(BENCH_CALDAV_PLACE);
    expect(seriesProven(proofPlaceOf("caldav", "http://127.0.0.1:8821/"), weekly, monday, ZONES, TODAY)).toBe(
      true,
    );
    // Another server is another place, iCloud among them: no series is written there until its own proof has run.
    expect(proofPlaceOf("caldav", "https://caldav.icloud.com/")).toBe("caldav:caldav.icloud.com");
    expect(
      seriesProven(proofPlaceOf("caldav", "https://caldav.icloud.com/"), weekly, monday, ZONES, TODAY),
    ).toBe(false);
    expect(seriesProven(proofPlaceOf("caldav", "http://127.0.0.1:8822/"), weekly, monday, ZONES, TODAY)).toBe(
      false,
    );
    expect(
      seriesProven(
        proofPlaceOf("caldav", "https://dav.example.test/remote.php/dav/"),
        weekly,
        monday,
        ZONES,
        TODAY,
      ),
    ).toBe(false);
    // A connection with no address, or one that is none, has no place: proven nowhere.
    expect([proofPlaceOf("caldav", null), proofPlaceOf("caldav", "not an address")]).toEqual([null, null]);
    expect(seriesProven(null, weekly, monday, ZONES, TODAY)).toBe(false);
    // A word no row names, and a name an object holds by itself, are no place either.
    expect([
      repeatProven("caldav", weekly),
      repeatProven("constructor", weekly),
      repeatProven("__proto__", weekly),
    ]).toEqual([false, false, false]);
    expect(
      ["google", "microsoft", "ics"].map((p) => proofPlaceOf(p as "google" | "microsoft" | "ics", null)),
    ).toEqual(["google", "microsoft", "ics"]);
  });
});

describe("a series' shape as it is written, from its start", () => {
  const at = (rule: string, start: EventTime, now = TODAY, zones: ZoneSource = ZONES) =>
    repeatShapeAt(parseRRule(rule)!, start, zones, now);
  const nine = (y: number, m: number, d: number) => zoned(wall(y, m, d, 9), "Europe/Zurich");

  it("is the rule's shape only from a start the rule itself names", () => {
    // 23 November 2026 is a Monday, the 26th the fourth Thursday, the 27th the last Friday of the month.
    expect(at("FREQ=WEEKLY;BYDAY=MO", nine(2026, 11, 23))).toBe("weekly/never");
    expect(at("FREQ=WEEKLY;BYDAY=TU", nine(2026, 11, 23))).toBeNull();
    expect(at("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", nine(2026, 11, 28))).toBeNull();
    expect(at("FREQ=MONTHLY;BYMONTHDAY=15", nine(2026, 11, 23))).toBeNull();
    expect(at("FREQ=MONTHLY;BYDAY=4TH", nine(2026, 11, 26))).toBe("monthly_nth_weekday/never");
    expect(at("FREQ=MONTHLY;BYDAY=3TH", nine(2026, 11, 26))).toBeNull();
    expect(at("FREQ=MONTHLY;BYDAY=-1FR", nine(2026, 11, 27))).toBe("monthly_last_weekday/never");
    expect(at("FREQ=MONTHLY;BYDAY=-1FR", nine(2026, 11, 20))).toBeNull();
    expect(at("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", nine(2026, 11, 26))).toBe("yearly_by_weekday/never");
    expect(at("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=23", nine(2026, 11, 23))).toBeNull();
  });

  it("takes a monthly rule that keeps its start's day from the 29th on as the late date", () => {
    expect(at("FREQ=MONTHLY", nine(2027, 1, 31))).toBe("monthly_late_date/never");
    expect(at("FREQ=MONTHLY;COUNT=4", nine(2026, 11, 23))).toBe("monthly_by_date/count");
  });

  it("is no shape where the end is told otherwise than the start, or lies before it", () => {
    expect(at("FREQ=DAILY;UNTIL=20261130T225959Z", nine(2026, 11, 23))).toBe("daily/until");
    expect(at("FREQ=DAILY;UNTIL=20261130", nine(2026, 11, 23))).toBeNull();
    expect(at("FREQ=DAILY;UNTIL=20261130", plainDate(2026, 11, 23))).toBe("daily/until");
    expect(at("FREQ=DAILY;UNTIL=20261130T225959Z", plainDate(2026, 11, 23))).toBeNull();
    expect(at("FREQ=DAILY;UNTIL=20261120T000000Z", nine(2026, 11, 23))).toBeNull();
  });

  it("is no shape for a start in UTC or on no zone, nor for a clock time its zone skips within the series' days", () => {
    expect(at("FREQ=WEEKLY", instant(Date.UTC(2026, 10, 23, 8)))).toBeNull();
    expect(at("FREQ=WEEKLY", floating(wall(2026, 11, 23, 9)))).toBeNull();
    // Europe/Zurich skips 02:00 to 03:00 on 28 March 2027: a series at 02:30 that reaches that night is none; one that ends before is.
    expect(at("FREQ=DAILY", zoned(wall(2026, 11, 23, 2, 30), "Europe/Zurich"))).toBeNull();
    expect(at("FREQ=DAILY;UNTIL=20261231T235959Z", zoned(wall(2026, 11, 23, 2, 30), "Europe/Zurich"))).toBe(
      "daily/until",
    );
    expect(at("FREQ=DAILY", zoned(wall(2026, 11, 23, 3, 30), "Europe/Zurich"))).toBe("daily/never");
    expect(
      seriesProven(
        BENCH_CALDAV_PLACE,
        parseRRule("FREQ=DAILY")!,
        zoned(wall(2026, 11, 23, 2, 30), "Europe/Zurich"),
        ZONES,
        TODAY,
      ),
    ).toBe(false);
    expect(
      seriesProven(BENCH_CALDAV_PLACE, parseRRule("FREQ=DAILY")!, nine(2026, 11, 23), ZONES, TODAY),
    ).toBe(true);
  });

  it("is no shape only where one of the series' own days falls at a clock time its zone skips, from today to its end, or ten years on with no end", () => {
    const Z = "Europe/Zurich";
    const t = (tz: string, y: number, m: number, d: number, h: number, mi: number) =>
      zoned(wall(y, m, d, h, mi), tz);
    /** Europe/Zurich but for one thing: its clocks first jump (02:00 to 03:00) on 28 March 2038, never before. */
    const LATE: ZoneSource = {
      offsetAt: (tzid: string, ms: number) =>
        tzid === "Test/Late"
          ? ms < Date.UTC(2038, 2, 28, 1)
            ? 3_600_000
            : 7_200_000
          : ZONES.offsetAt(tzid, ms),
    };
    const rows: [string, string | null][] = [
      // The skipped hour falls on a day of the series: no shape.
      ["daily 02:30 from 1 April 2027, no end", at("FREQ=DAILY", t(Z, 2027, 4, 1, 2, 30))],
      [
        "daily 02:15 at Lord Howe, no end (a half hour skipped)",
        at("FREQ=DAILY", t("Australia/Lord_Howe", 2026, 11, 23, 2, 15)),
      ],
      [
        "daily 00:30 at Santiago, no end (its clocks jump at midnight)",
        at("FREQ=DAILY", t("America/Santiago", 2026, 11, 23, 0, 30)),
      ],
      // From today, not from the series' first day: a series from 1970 meets the skipped hour every March from now on.
      ["daily 02:30 from 1 January 1970, no end", at("FREQ=DAILY", t(Z, 1970, 1, 1, 2, 30))],
      // As far as the series runs, where it has an end: past ten years too.
      [
        "daily 02:30 where the zone first jumps in 2038, COUNT=5000",
        at("FREQ=DAILY;COUNT=5000", t("Test/Late", 2026, 11, 23, 2, 30), TODAY, LATE),
      ],
      [
        "daily 02:30 where the zone first jumps in 2038, UNTIL 2040",
        at("FREQ=DAILY;UNTIL=20400101T000000Z", t("Test/Late", 2026, 11, 23, 2, 30), TODAY, LATE),
      ],
      [
        "daily 02:30 where the zone first jumps in 2038, from 2030, no end",
        at("FREQ=DAILY", t("Test/Late", 2030, 1, 1, 2, 30), TODAY, LATE),
      ],
      // No day of the series falls in a skipped hour: a shape.
      [
        "weekly on Monday 02:30, no end (the skipped hour is a Sunday's)",
        at("FREQ=WEEKLY;BYDAY=MO", t(Z, 2026, 11, 23, 2, 30)),
      ],
      [
        "daily 02:30 from 20 March 2027, ending the day before the skipped one",
        at("FREQ=DAILY;UNTIL=20270327T235959Z", t(Z, 2027, 3, 20, 2, 30)),
      ],
      ["daily 02:30 from 28 October 2027, COUNT=6", at("FREQ=DAILY;COUNT=6", t(Z, 2027, 10, 28, 2, 30))],
      [
        "daily 02:30 from 28 October 2027, UNTIL 5 November 2027",
        at("FREQ=DAILY;UNTIL=20271105T235959Z", t(Z, 2027, 10, 28, 2, 30)),
      ],
      ["daily 02:45 at Lord Howe, no end", at("FREQ=DAILY", t("Australia/Lord_Howe", 2026, 11, 23, 2, 45))],
      [
        "daily 03:00, no end (the first time after the skipped hour)",
        at("FREQ=DAILY", t(Z, 2026, 11, 23, 3, 0)),
      ],
      // Days before today are not looked at: a series all in the past, whose days met the jump of 2011.
      [
        "daily 02:30 at Moscow in 2011, UNTIL 30 April 2011",
        at("FREQ=DAILY;UNTIL=20110430T000000Z", t("Europe/Moscow", 2011, 1, 1, 2, 30)),
      ],
      // Past ten years from today a series with no end is not looked at: the jump of 2038 is past them.
      [
        "daily 02:30 where the zone first jumps in 2038, from 2026, no end",
        at("FREQ=DAILY", t("Test/Late", 2026, 11, 23, 2, 30), TODAY, LATE),
      ],
    ];
    expect(rows).toEqual([
      ["daily 02:30 from 1 April 2027, no end", null],
      ["daily 02:15 at Lord Howe, no end (a half hour skipped)", null],
      ["daily 00:30 at Santiago, no end (its clocks jump at midnight)", null],
      ["daily 02:30 from 1 January 1970, no end", null],
      ["daily 02:30 where the zone first jumps in 2038, COUNT=5000", null],
      ["daily 02:30 where the zone first jumps in 2038, UNTIL 2040", null],
      ["daily 02:30 where the zone first jumps in 2038, from 2030, no end", null],
      ["weekly on Monday 02:30, no end (the skipped hour is a Sunday's)", "weekly/never"],
      ["daily 02:30 from 20 March 2027, ending the day before the skipped one", "daily/until"],
      ["daily 02:30 from 28 October 2027, COUNT=6", "daily/count"],
      ["daily 02:30 from 28 October 2027, UNTIL 5 November 2027", "daily/until"],
      ["daily 02:45 at Lord Howe, no end", "daily/never"],
      ["daily 03:00, no end (the first time after the skipped hour)", "daily/never"],
      ["daily 02:30 at Moscow in 2011, UNTIL 30 April 2011", "daily/until"],
      ["daily 02:30 where the zone first jumps in 2038, from 2026, no end", "daily/never"],
    ]);
  });
});

describe("a series' end when its first day moves, and the series its days from one on become", () => {
  const ny = (y: number, m: number, d: number, h: number) => zoned(wall(y, m, d, h), "America/New_York");
  const zh = (y: number, m: number, d: number, h: number) => zoned(wall(y, m, d, h), "Europe/Zurich");
  const tuesdays = parseRRule("FREQ=WEEKLY;BYDAY=TU;UNTIL=20270119T230000Z")!;
  const until = (r: ReturnType<typeof movedRule>) => (r === null ? null : r.until);

  it("moves an end on a day with a new time of the first day, so the last day stays the last", () => {
    const first = ny(2026, 11, 24, 18);
    const end = ny(2026, 11, 24, 19);
    // 19 January at 19:00 in New York is 00:00 UTC on the 20th; in Zurich, the same day at 18:00 is 17:00 UTC.
    expect(until(movedRule(tuesdays, first, end, first, ny(2026, 11, 24, 19), ZONES))).toEqual(
      instant(Date.UTC(2027, 0, 20, 0)),
    );
    expect(until(movedRule(tuesdays, first, end, first, zh(2026, 11, 24, 18), ZONES))).toEqual(
      instant(Date.UTC(2027, 0, 19, 17)),
    );
    // Whole days keep their last day as a day.
    const days = parseRRule("FREQ=DAILY;UNTIL=20261202")!;
    expect(
      until(
        movedRule(
          days,
          plainDate(2026, 11, 23),
          plainDate(2026, 11, 24),
          plainDate(2026, 11, 23),
          plainDate(2026, 11, 23),
          ZONES,
        ),
      ),
    ).toEqual(plainDate(2026, 12, 2));
  });

  it("leaves a rule with no end on a day, and a first day that does not move, as they are; refuses a first day moved to another day", () => {
    const first = ny(2026, 11, 24, 18);
    const end = ny(2026, 11, 24, 19);
    const counted = parseRRule("FREQ=WEEKLY;BYDAY=TU;COUNT=9")!;
    expect(movedRule(counted, first, end, first, ny(2026, 11, 24, 20), ZONES)).toBe(counted);
    expect(movedRule(tuesdays, first, end, first, first, ZONES)).toBe(tuesdays);
    // Where its last day went would be a guess: the repeat is named with the start.
    expect(movedRule(tuesdays, first, end, first, ny(2026, 11, 25, 18), ZONES)).toBeNull();
    expect(movedRule(tuesdays, first, end, first, instant(Date.UTC(2026, 10, 25, 0)), ZONES)).toBeNull();
  });

  it("goes on from a day with what is left of a count, or with its end moved with a new time", () => {
    const first = zh(2026, 11, 23, 9);
    const end = zh(2026, 11, 23, 10);
    const dec14 = Date.UTC(2026, 11, 14, 8);
    // Ten Mondays from 23 November: three come before 14 December, seven are left.
    const counted = continuedSeries(
      { first, firstEnd: end, rule: parseRRule("FREQ=WEEKLY;BYDAY=MO;COUNT=10")! },
      dec14,
      {},
      ZONES,
    );
    expect(counted).toEqual({
      start: zh(2026, 12, 14, 9),
      end: zh(2026, 12, 14, 10),
      rule: { ...parseRRule("FREQ=WEEKLY;BYDAY=MO")!, count: 7 },
    });
    const ended = parseRRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270125T080000Z")!;
    expect(continuedSeries({ first, firstEnd: end, rule: ended }, dec14, {}, ZONES)?.rule).toEqual(ended);
    expect(
      continuedSeries(
        { first, firstEnd: end, rule: ended },
        dec14,
        { start: zh(2026, 12, 14, 11), end: zh(2026, 12, 14, 12) },
        ZONES,
      )?.rule.until,
    ).toEqual(instant(Date.UTC(2027, 0, 25, 10)));
    expect(
      continuedSeries(
        { first, firstEnd: end, rule: ended },
        dec14,
        { start: zh(2026, 12, 15, 9), end: zh(2026, 12, 15, 10) },
        ZONES,
      ),
    ).toBeNull();
    // A count with nothing left from that day on is no series.
    expect(
      continuedSeries(
        { first, firstEnd: end, rule: parseRRule("FREQ=WEEKLY;BYDAY=MO;COUNT=3")! },
        dec14,
        {},
        ZONES,
      ),
    ).toBeNull();
  });

  it("splits a UTC series and keeps its final and excluded dates when the clock time changes", () => {
    const utc = (day: number, hour: number) => instant(Date.UTC(2026, 10, day, hour));
    const first = utc(16, 9);
    const firstEnd = utc(16, 10);
    const cut = utc(18, 9);
    const start = utc(18, 11);
    const end = utc(18, 12);
    const counted = parseRRule("FREQ=DAILY;COUNT=5")!;
    expect(continuedSeries({ first, firstEnd, rule: counted }, cut.epochMs, {}, ZONES)).toEqual({
      start: cut,
      end: utc(18, 10),
      rule: { ...counted, count: 3 },
    });
    const ended = parseRRule("FREQ=DAILY;UNTIL=20261120T090000Z")!;
    expect(
      continuedSeries({ first, firstEnd, rule: ended }, cut.epochMs, { start, end }, ZONES)?.rule.until,
    ).toEqual(utc(20, 11));
    expect(carriedExclusions(cut, [utc(17, 9), utc(19, 9)], start, ZONES)).toEqual([utc(19, 11)]);
  });

  it("keeps Graph's local end date on a same-day retiming and includes the whole final local day", () => {
    const first = ny(2026, 11, 23, 18);
    const firstEnd = ny(2026, 11, 23, 19);
    const rule = parseRRule("FREQ=DAILY;UNTIL=20261127")!;
    const moved = ny(2026, 11, 23, 20);
    expect(movedRule(rule, first, firstEnd, first, moved, ZONES)?.until).toEqual(plainDate(2026, 11, 27));
    expect(endsBeforeDay(rule, first, firstEnd, Date.UTC(2026, 10, 28, 1), ZONES)).toBe(false);
    expect(endsBeforeDay(rule, first, firstEnd, Date.UTC(2026, 10, 28, 5), ZONES)).toBe(true);
  });
});

describe("whose an event is, as its stored text shows it (the second recheck's third finding)", () => {
  const ANNA = "anna@example.test";
  const event = (
    lines: readonly string[],
    uid = "x@elsewhere.example.test",
    more: readonly string[] = [],
  ) => [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261113T120000Z",
    "DTSTART:20261214T080000Z",
    "DTEND:20261214T090000Z",
    ...more,
    ...lines,
    "SUMMARY:Glaze talk",
    "END:VEVENT",
  ];
  const object = (...events: (readonly string[])[]) =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//EN", ...events.flat(), "END:VCALENDAR", ""].join(
      "\r\n",
    );
  const changedDay = (lines: readonly string[]) =>
    event(lines, "x@elsewhere.example.test", ["RECURRENCE-ID:20261221T080000Z"]);
  const series = (lines: readonly string[]) =>
    event(lines, "x@elsewhere.example.test", ["RRULE:FREQ=WEEKLY"]);
  /** A component the reader leaves out of what it reads: its start told in a zone whose name is past any ceiling. */
  const leftOut = (lines: readonly string[]) =>
    lines.map((l) => (l.startsWith("DTSTART") ? `DTSTART;TZID=${"Z".repeat(300)}:20261221T090000` : l));

  it("names an address only where every ORGANIZER line, in any spelling, is one the reader takes and names that address; nobody only where no line and no unaddressed invitee says otherwise", () => {
    // null: names nobody (the account's own, unless it holds the account's answer); an address; "": someone else's.
    const cases: Record<string, [string, string | null]> = {
      "a plain line": [object(event([`ORGANIZER;CN=Anna:mailto:${ANNA}`])), ANNA],
      "the name in small letters": [object(event([`organizer;cn=Anna:mailto:${ANNA}`])), ANNA],
      "no ORGANIZER line": [object(event([])), null],
      "no ORGANIZER line, an invitee by mail address": [
        object(event([`ATTENDEE;CN=Giulia:mailto:giulia@example.test`])),
        null,
      ],
      "no colon at all": [object(event(["ORGANIZER;CN=Anna"])), ""],
      "the name alone": [object(event(["ORGANIZER"])), ""],
      "an opening quote never closed": [object(event([`ORGANIZER;CN="Anna:mailto:${ANNA}`])), ""],
      "one stray quote inside an unquoted name": [object(event([`ORGANIZER;CN=Anna "A:mailto:${ANNA}`])), ""],
      "a broken fold: the value on a line of its own": [
        object(event(["ORGANIZER;CN=Anna of the long name", `:mailto:${ANNA}`])),
        "",
      ],
      "a broken fold inside the parameters": [
        object(event(["ORGANIZER;CN=Anna of the long name;SCHEDULE-STATUS", `=1.1:mailto:${ANNA}`])),
        "",
      ],
      "a space before the colon": [object(event([`ORGANIZER :mailto:${ANNA}`])), ""],
      "a space before the parameters": [object(event([`ORGANIZER ;CN=Anna:mailto:${ANNA}`])), ""],
      "a tab after the name": [object(event([`ORGANIZER\t;CN=Anna:mailto:${ANNA}`])), ""],
      "a group before the name": [object(event([`item1.ORGANIZER;CN=Anna:mailto:${ANNA}`])), ""],
      "a control byte in the name": [object(event([`ORGANIZER\u0000;CN=Anna:mailto:${ANNA}`])), ""],
      "a zero-width space before the name": [object(event([`\u200bORGANIZER;CN=Anna:mailto:${ANNA}`])), ""],
      "a name past any ceiling that begins so": [
        object(event([`ORGANIZER${"X".repeat(300)}:mailto:${ANNA}`])),
        "",
      ],
      "a parameter with no value": [object(event([`ORGANIZER;CN:mailto:${ANNA}`])), ANNA],
      "a parameter with no name": [object(event([`ORGANIZER;=Anna:mailto:${ANNA}`])), ANNA],
      "an empty parameter (two semicolons)": [object(event([`ORGANIZER;;CN=Anna:mailto:${ANNA}`])), ANNA],
      "another name that begins so (X-ORGANIZER, ORGANIZERS)": [
        object(event([`X-ORGANIZER:mailto:${ANNA}`, `ORGANIZERS:mailto:${ANNA}`])),
        null,
      ],
      "inside an alarm of the event, none on the event": [
        object(
          event([
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "TRIGGER:-PT5M",
            `ORGANIZER:mailto:${ANNA}`,
            "END:VALARM",
          ]),
        ),
        null,
      ],
      "after the event's alarm": [
        object(
          event([
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "TRIGGER:-PT5M",
            "END:VALARM",
            `ORGANIZER;CN=Anna:mailto:${ANNA}`,
          ]),
        ),
        ANNA,
      ],
      "no ORGANIZER line, an invitee by a principal's path": [
        object(event(["ATTENDEE;CN=Mila:/principals/mila/"])),
        "",
      ],
      "no ORGANIZER line, an invitee by a urn": [
        object(event(["ATTENDEE;CN=Giulia:urn:uuid:5f6a0c1e-0000-4000-8000-00000000a44a"])),
        "",
      ],
      "no ORGANIZER line, an invitee's line with a space before its colon": [
        object(event(["ATTENDEE :mailto:giulia@example.test"])),
        "",
      ],
      "an ORGANIZER of the account's, beside an invitee by a principal's path": [
        object(event([`ORGANIZER:mailto:${ANNA}`, "ATTENDEE:/principals/bob/"])),
        ANNA,
      ],
      "the series names nobody, a changed day of it names Anna": [
        object(series([]), changedDay([`ORGANIZER:mailto:${ANNA}`])),
        ANNA,
      ],
      "the series and a changed day name the same address, once in capitals": [
        object(series([`ORGANIZER:mailto:${ANNA}`]), changedDay(["ORGANIZER:MAILTO:Anna@Example.Test"])),
        ANNA,
      ],
      "the series and a changed day name two addresses": [
        object(series([`ORGANIZER:mailto:${ANNA}`]), changedDay(["ORGANIZER:mailto:giulia@example.test"])),
        "",
      ],
      "a changed day names an invitee by a principal's path, nobody organizes": [
        object(series([]), changedDay(["ATTENDEE:/principals/mila/"])),
        "",
      ],
      // An object read with a component left out does not show whose it is, whatever the events that were read say.
      "the series names nobody, a changed day the reader leaves out (a zone's name past its ceiling) names Anna":
        [object(series([]), leftOut(changedDay([`ORGANIZER:mailto:${ANNA}`]))), ""],
      "the series names Anna, a changed day the reader leaves out names nobody": [
        object(series([`ORGANIZER:mailto:${ANNA}`]), leftOut(changedDay([]))),
        "",
      ],
      "nobody is named anywhere, and a changed day is left out": [
        object(series([]), leftOut(changedDay([]))),
        "",
      ],
    };
    const seen = Object.fromEntries(
      Object.entries(cases).map(([name, [text]]) => [name, storedObjectFacts(text, null).organizer]),
    );
    expect(seen).toEqual(Object.fromEntries(Object.entries(cases).map(([name, [, want]]) => [name, want])));
  });
});

describe("a series at a clock time its zone skips on one of its nights (the second recheck's fourth finding)", () => {
  const zh = (y: number, m: number, d: number, h: number, min = 0) =>
    zoned(wall(y, m, d, h, min), "Europe/Zurich");

  it("names a day off its own clock only where the core places one of its days at another clock time than the series' own", () => {
    // Daily at 02:30 from 20 March 2026: 29 March has no 02:30; the core places that day at 01:30 UTC (03:30 summer time).
    const nightly = {
      first: zh(2026, 3, 20, 2, 30),
      firstEnd: zh(2026, 3, 20, 3),
      rule: parseRRule("FREQ=DAILY;COUNT=300")!,
    };
    expect(offItsClock(nightly, String(Date.UTC(2026, 2, 29, 1, 30)), ZONES)).toBe(true);
    // The nights before and after it are at 02:30; a moment that is no day of the series is another check's.
    expect(offItsClock(nightly, String(Date.UTC(2026, 2, 28, 1, 30)), ZONES)).toBe(false);
    expect(offItsClock(nightly, String(Date.UTC(2026, 2, 30, 0, 30)), ZONES)).toBe(false);
    expect(offItsClock(nightly, String(Date.UTC(2026, 2, 29, 1, 45)), ZONES)).toBe(false);
    // A series at 09:00, and one of whole days, have no such day.
    const mornings = {
      first: zh(2026, 3, 20, 9),
      firstEnd: zh(2026, 3, 20, 10),
      rule: parseRRule("FREQ=DAILY;COUNT=300")!,
    };
    expect(offItsClock(mornings, String(Date.UTC(2026, 2, 29, 7)), ZONES)).toBe(false);
    const days = {
      first: plainDate(2026, 3, 20),
      firstEnd: plainDate(2026, 3, 21),
      rule: parseRRule("FREQ=DAILY;COUNT=300")!,
    };
    expect(offItsClock(days, String(Date.UTC(2026, 2, 29)), ZONES)).toBe(false);
  });

  it("finds an end in the stretch between the two placings of a skipped night that the rule names, and nowhere else; a new time does not move it", () => {
    // Daily at 02:30 from 20 March 2027: 28 March's 02:30 is placed at 00:30 UTC with the offset after the jump, 01:30 by the core.
    const ending = (until: string) => ({
      first: zh(2027, 3, 20, 2, 30),
      firstEnd: zh(2027, 3, 20, 3),
      rule: parseRRule(`FREQ=DAILY;UNTIL=${until}`)!,
    });
    const seen = Object.fromEntries(
      [
        "20270328T002959Z",
        "20270328T003000Z",
        "20270328T010000Z",
        "20270328T012959Z",
        "20270328T013000Z",
        "20270327T013000Z",
      ].map((u) => [u, untilSkipped(ending(u), ZONES)]),
    );
    expect(seen).toEqual({
      "20270328T002959Z": false,
      "20270328T003000Z": true,
      "20270328T010000Z": true,
      "20270328T012959Z": true,
      "20270328T013000Z": false,
      "20270327T013000Z": false,
    });
    // A rule that does not name that night (Mondays; 28 March 2027 is a Sunday), and a series at 09:00, have no such end.
    expect(
      untilSkipped(
        { ...ending("20270328T010000Z"), rule: parseRRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270328T010000Z")! },
        ZONES,
      ),
    ).toBe(false);
    expect(
      untilSkipped(
        {
          first: zh(2027, 3, 20, 9),
          firstEnd: zh(2027, 3, 20, 10),
          rule: parseRRule("FREQ=DAILY;UNTIL=20270328T010000Z")!,
        },
        ZONES,
      ),
    ).toBe(false);
    // So the end is not moved with a new time (the core's last day would lose the server's); a new title keeps it as it is.
    const s = ending("20270328T010000Z");
    expect(movedRule(s.rule, s.first, s.firstEnd, s.first, zh(2027, 3, 20, 9), ZONES)).toBeNull();
    expect(movedRule(s.rule, s.first, s.firstEnd, s.first, s.first, ZONES)).toBe(s.rule);
    const outside = ending("20270327T013000Z");
    expect(
      movedRule(outside.rule, outside.first, outside.firstEnd, outside.first, zh(2027, 3, 20, 9), ZONES)
        ?.until,
    ).toEqual(instant(Date.UTC(2027, 2, 27, 8)));
  });
});
