/**
 * Series and their occurrences, read from calendar text and expanded over a window. Every expected
 * value is the corpus's: the standard's printed lists, another provider's recorded answer, or the
 * arithmetic written beside each hard case in corpus/nasty.ts.
 */
import { describe, expect, it } from "vitest";
import { readCalendar, zonesOf, type CalObject } from "../src/ical/calendar.js";
import { writeComponent } from "../src/ical/component.js";
import { formatInstant } from "../src/ical/values.js";
import { DEFAULT_LIMITS, MAX_OCCURRENCES_PER_CALL, MAX_OCCURRENCES_PER_EXPANSION, MAX_RULES_PER_EVENT, MAX_STEPS_PER_EXPANSION, MAX_UID_CHARS, MAX_ZONE_NAME_CHARS, MAX_ZONE_ONSETS } from "../src/limits.js";
import { recurrenceKeyOf, recurrenceKeyString } from "../src/recur/key.js";
import { changedOccurrence } from "../src/recur/occurrence.js";
import { expandAll, expandSeries, occurrenceOf, occurrencesFromExpanded, seriesOf, type Expansion, type Occurrence } from "../src/recur/series.js";
import { instantOf, localDay } from "../src/time/arith.js";
import { instant, plainDate, wall, zoned, type EventTime, type ZoneSource } from "../src/time/types.js";
import { fileZones, firstOf, intlZones } from "../src/time/zones.js";
import { icloud_wheel_class, radicale_wheel_class } from "./corpus/bench.js";
import {
  apia_skipped_day, cancelled_and_utc_override, count_with_exdate, every_second, file_zone, hourly_through_the_gap, last_day_of_month, last_friday, last_weekday_of_year,
  leap_day, lord_howe, never_matches, orphan_override, rdate_periods, stale_zone_definition, the_31st, this_and_future, until_as_a_day, until_inclusive, until_one_second_short,
  week_53, week_one_mondays, whole_day_until, whole_day_west, zurich_autumn, zurich_spring, type Expanded,
} from "./corpus/nasty.js";
import { feed_rfc7986, google_export } from "./corpus/providers.js";
import { RFC_RULE_CASES } from "./corpus/rfc5545.js";
import type { Fixture } from "./corpus/types.js";
import { at, iso, oneEvent, text, textOf } from "./support.js";

const platform = intlZones();

function read(source: Fixture | string): CalObject {
  const result = readCalendar(typeof source === "string" ? source : text(source), DEFAULT_LIMITS);
  if (!result.ok) throw new Error(`not read: ${result.reason}`);
  return result.calendar;
}
/** What a reader of calendar text uses: the platform's rules for a zone it knows, the file's own for one it does not. */
const zonesFor = (calendar: CalObject): ZoneSource => zonesOf(calendar, platform);
const span = (window: readonly [string, string], viewer = "Europe/Zurich") => ({ startMs: at(window[0]), endMs: at(window[1]), viewerZone: viewer });

function expand(source: Fixture | string, window: readonly [string, string], viewer = "Europe/Zurich", series = 0, limits = DEFAULT_LIMITS): Expansion & { zones: ZoneSource } {
  const calendar = read(source);
  const zones = zonesFor(calendar);
  return { ...expandSeries(seriesOf(calendar.events, zones)[series]!, span(window, viewer), zones, limits), zones };
}
/** A zone source that counts what it is asked and keeps the earliest moment it was asked about. */
function counted(inner: ZoneSource): ZoneSource & { asked: number; earliest: number } {
  const counter = {
    asked: 0,
    earliest: Infinity,
    offsetAt(tzid: string, epochMs: number): number | null {
      counter.asked++;
      if (epochMs < counter.earliest) counter.earliest = epochMs;
      return inner.offsetAt(tzid, epochMs);
    },
  };
  return counter;
}
const dayText = (t: EventTime): string | null => (t.kind === "date" ? `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}` : null);
const moment = (t: EventTime, zones: ZoneSource): string | null => {
  if (t.kind === "date" || t.kind === "floating") return null;
  const resolved = instantOf(t, zones);
  return resolved === null ? null : iso(resolved.epochMs);
};
const starts = (e: Expansion & { zones: ZoneSource }): (string | null)[] => e.occurrences.map((o) => moment(o.start, e.zones));

describe("the hard cases", () => {
  const cases: Expanded[] = [
    zurich_spring, zurich_autumn, last_day_of_month, last_friday, the_31st, leap_day, last_weekday_of_year, week_one_mondays, week_53, count_with_exdate,
    until_inclusive, until_one_second_short, until_as_a_day, hourly_through_the_gap, apia_skipped_day, lord_howe,
  ];
  it.each(cases.map((c) => [c.fixture.name, c] as const))("%s", (_name, c) => {
    const expansion = expand(c.fixture, c.window, c.viewer);
    expect(starts(expansion)).toEqual(c.starts);
    expect(expansion.capped).toBe(false);
  });
});

describe("a whole-day series whose rule ends with a moment", () => {
  const cases = Object.entries(whole_day_until).flatMap(([name, c]) => ["Europe/London", "Europe/Zurich", "America/New_York", "Pacific/Auckland"].map((viewer) => [name, viewer, c] as const));
  it.each(cases)("%s, seen from %s, keeps its last day", (_name, viewer, c) => {
    const expansion = expand(c.fixture, c.window, viewer);
    expect(expansion.occurrences.map((o) => dayText(o.start))).toEqual(c.days);
    expect(expansion.capped).toBe(false);
  });

  it("still ends on the day the standard's own form names", () => {
    const calendar = oneEvent(["DTSTART;VALUE=DATE:20260601", "RRULE:FREQ=WEEKLY;UNTIL=20260629;BYDAY=MO"]);
    expect(expand(calendar, whole_day_until.mondays.window).occurrences.map((o) => dayText(o.start))).toEqual(whole_day_until.mondays.days);
  });

  it("is never cut at its own start by its rule's end", () => {
    // A rule that ends the day before it begins: the start is the first occurrence all the same, and the only one.
    const days = oneEvent(["DTSTART;VALUE=DATE:20260601", "RRULE:FREQ=DAILY;UNTIL=20260520T000000Z"]);
    expect(expand(days, whole_day_until.mondays.window).occurrences.map((o) => dayText(o.start))).toEqual(["2026-06-01"]);
    const timed = oneEvent(["DTSTART;TZID=Europe/Zurich:20260601T090000", "RRULE:FREQ=DAILY;UNTIL=20260520T000000Z"]);
    expect(starts(expand(timed, whole_day_until.mondays.window))).toEqual(["2026-06-01T07:00:00Z"]);
  });
});

describe("a zone the file and the platform both know", () => {
  it("is read by the platform's rules, so a definition older than the zone's law moves nothing", () => {
    const { fixture, in2020, in2026 } = stale_zone_definition;
    expect(starts(expand(fixture, in2020.window, "America/Mexico_City"))).toEqual([in2020.start]);
    expect(starts(expand(fixture, in2026.window, "America/Mexico_City"))).toEqual([in2026.start]);
    // Asked first, the file's own definition answers an hour early: the order a caller has to mean.
    const calendar = read(fixture);
    const fileFirst = firstOf(fileZones(calendar.timezones), platform);
    const e = expandSeries(seriesOf(calendar.events, fileFirst)[0]!, span(in2026.window, "America/Mexico_City"), fileFirst);
    expect(e.occurrences.map((o) => moment(o.start, fileFirst))).toEqual([in2026.byTheFileAlone]);
  });

  it("asks the file for a name the platform does not know", () => {
    const calendar = read(file_zone.defined);
    const zones = zonesOf(calendar, platform);
    expect(zones.offsetAt("Studio Time", at("2026-10-03T04:15:00Z"))).toBe(345 * 60_000);
    expect(zones.offsetAt("Europe/Zurich", at("2026-10-03T04:15:00Z"))).toBe(120 * 60_000);
    expect(zones.offsetAt("Nowhere/At_All", 0)).toBeNull();
  });
});

describe("RFC 5545's examples, through the whole reader", () => {
  for (const c of RFC_RULE_CASES) {
    for (const rule of c.rules) {
      it(`${c.title}: ${rule}`, () => {
        const calendar = oneEvent([`DTSTART;TZID=America/New_York:${c.dtstart}`, `RRULE:${rule}`, ...(c.exdate ? [`EXDATE;TZID=America/New_York:${c.exdate}`] : [])]);
        // From a year before the first instance to the last one printed: an open list is cut there, a closed one ends by itself.
        const window = ["1995-01-01T00:00:00Z", iso(at(c.expect[c.expect.length - 1]!) + 1000)] as const;
        expect(starts(expand(calendar, window, "America/New_York"))).toEqual(c.expect);
        if (!c.open) expect(starts(expand(calendar, ["1995-01-01T00:00:00Z", "2031-01-01T00:00:00Z"], "America/New_York"))).toEqual(c.expect);
      });
    }
  }
});

describe("a changed day", () => {
  /*
   * "Wheel class": Tuesdays 18:00 to 19:30 in Zurich, six times from 17 November 2026, the third
   * moved to Wednesday 2 December 19:00. Expected as Google listed the same series' instances when
   * it was planted there (ids `<event>_<original start>`, starts and ends with their offsets):
   *   _20261117T170000Z 18:00+01:00   _20261124T170000Z 18:00+01:00   _20261201T170000Z 2 Dec 19:00+01:00
   *   _20261208T170000Z 18:00+01:00   _20261215T170000Z 18:00+01:00   _20261222T170000Z 18:00+01:00
   */
  const google = [
    { was: "20261117T170000Z", start: "2026-11-17T17:00:00Z", end: "2026-11-17T18:30:00Z" },
    { was: "20261124T170000Z", start: "2026-11-24T17:00:00Z", end: "2026-11-24T18:30:00Z" },
    { was: "20261201T170000Z", start: "2026-12-02T18:00:00Z", end: "2026-12-02T19:30:00Z" },
    { was: "20261208T170000Z", start: "2026-12-08T17:00:00Z", end: "2026-12-08T18:30:00Z" },
    { was: "20261215T170000Z", start: "2026-12-15T17:00:00Z", end: "2026-12-15T18:30:00Z" },
    { was: "20261222T170000Z", start: "2026-12-22T17:00:00Z", end: "2026-12-22T18:30:00Z" },
  ];
  const november = ["2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z"] as const;

  it.each([icloud_wheel_class, radicale_wheel_class].map((f) => [f.name, f] as const))("%s gives the six occurrences another provider listed", (_name, fixture) => {
    const e = expand(fixture, november);
    expect(e.occurrences.map((o) => ({ was: o.key.kind === "instant" ? formatInstant(o.key.epochMs) : o.key.kind, start: moment(o.start, e.zones), end: moment(o.end, e.zones) }))).toEqual(google);
    expect(e.occurrences.map((o) => o.source)).toEqual(["rule", "rule", "override", "rule", "rule", "rule"]);
    // The third is on Wednesday 2 December at 19:00 by Zurich's clock, and nothing is left on Tuesday the 1st.
    expect(e.occurrences[2]!.start).toEqual(zoned(wall(2026, 12, 2, 19, 0), "Europe/Zurich"));
    expect(e.occurrences.map((o) => localDay(o.start, "Europe/Zurich", e.zones)?.day)).toEqual([17, 24, 2, 8, 15, 22]);
  });

  it("is on its new day only, whichever day is asked", () => {
    // Zurich's 1 and 2 December as instants: midnight there is 23:00 UTC the evening before.
    expect(expand(icloud_wheel_class, ["2026-11-30T23:00:00Z", "2026-12-01T23:00:00Z"]).occurrences).toEqual([]);
    const second = expand(icloud_wheel_class, ["2026-12-01T23:00:00Z", "2026-12-02T23:00:00Z"]);
    expect(second.occurrences.map((o) => [o.source, o.event.recurrenceId !== null])).toEqual([["override", true]]);
  });

  it("is found whether its occurrence is named by a clock time or by the instant", () => {
    const e = expand(cancelled_and_utc_override.fixture, cancelled_and_utc_override.window);
    expect(starts(e)).toEqual(cancelled_and_utc_override.starts);
    expect(e.occurrences.map((o) => o.event.summary)).toEqual(["Evening course", "Evening course (later)", "Evening course"]);
  });

  it("cancels every later occurrence with it when it says so", () => {
    // Five Mondays from 7 September 2026, 10:00 in Zurich (08:00 UTC); cancelled from the 21st on: the 7th and the 14th remain.
    const calendar = oneEvent([
      "DTSTART;TZID=Europe/Zurich:20260907T100000", "RRULE:FREQ=WEEKLY;COUNT=5", "END:VEVENT",
      "BEGIN:VEVENT", "UID:corpus-1@atelier.example", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Zurich:20260921T100000", "DTSTART;TZID=Europe/Zurich:20260921T100000", "STATUS:CANCELLED",
    ]);
    expect(starts(expand(calendar, ["2026-09-01T00:00:00Z", "2026-11-01T00:00:00Z"]))).toEqual(["2026-09-07T08:00:00Z", "2026-09-14T08:00:00Z"]);
  });

  it("stands alone when its series never arrived", () => {
    const e = expand(orphan_override.fixture, orphan_override.window);
    expect(starts(e)).toEqual([orphan_override.start]);
    expect(e.occurrences[0]).toMatchObject({ source: "override", key: { kind: "instant", epochMs: at(orphan_override.wasAt) } });
  });

  it("moves every later occurrence with it when it says so", () => {
    const e = expand(this_and_future.fixture, this_and_future.window);
    expect(e.occurrences.map((o) => [moment(o.start, e.zones), moment(o.end, e.zones), o.event.summary])).toEqual(this_and_future.spans);
    expect(e.occurrences.map((o) => o.source)).toEqual(["rule", "rule", "override", "override", "override"]);
    // Each keeps the key of the day the rule made, not of the hour it was moved to.
    expect(e.occurrences.map((o) => (o.key.kind === "instant" ? iso(o.key.epochMs) : ""))).toEqual(["2026-09-07T08:00:00Z", "2026-09-14T08:00:00Z", "2026-09-21T08:00:00Z", "2026-09-28T08:00:00Z", "2026-10-05T08:00:00Z"]);
  });
});

describe("a series as a provider's export writes it", () => {
  /*
   * Google's export of "Kiln schedule": Mondays 09:30 in Zurich from 2 March 2026 until 27 April
   * (UNTIL 21:59:59 UTC that day), 6 April excluded, 23 March moved to Tuesday the 24th at 14:00.
   * Mondays: 2, 9, 16, 23, 30 March, 6, 13, 20, 27 April. CET to 28 March (08:30 UTC), CEST from the
   * 29th (07:30 UTC). The moved one is at 14:00 CET: 13:00 UTC.
   */
  it("expands with its excluded day and its moved day", () => {
    const calendar = read(google_export);
    const zones = zonesFor(calendar);
    const all = seriesOf(calendar.events, zones);
    expect(all.map((s) => [s.master?.summary, s.overrides.size])).toEqual([["Kiln schedule", 1], ["Studio closed", 0]]);
    const e = expandSeries(all[0]!, { startMs: at("2026-01-01T00:00:00Z"), endMs: at("2027-01-01T00:00:00Z"), viewerZone: "Europe/Zurich" }, zones);
    expect(e.occurrences.map((o) => moment(o.start, zones))).toEqual([
      "2026-03-02T08:30:00Z", "2026-03-09T08:30:00Z", "2026-03-16T08:30:00Z", "2026-03-24T13:00:00Z", "2026-03-30T07:30:00Z", "2026-04-13T07:30:00Z", "2026-04-20T07:30:00Z", "2026-04-27T07:30:00Z",
    ]);
    const closed = expandSeries(all[1]!, { startMs: at("2026-04-30T22:00:00Z"), endMs: at("2026-05-01T22:00:00Z"), viewerZone: "Europe/Zurich" }, zones);
    expect(closed.occurrences.map((o) => [o.source, o.start, o.end])).toEqual([["single", plainDate(2026, 5, 1), plainDate(2026, 5, 2)]]);
  });

  it("keeps the newer of two components for one occurrence", () => {
    const calendar = read(oneEvent(["DTSTART:20260105T090000Z", "SEQUENCE:1", "SUMMARY:old", "END:VEVENT", "BEGIN:VEVENT", "UID:corpus-1@atelier.example", "DTSTART:20260105T100000Z", "SEQUENCE:2", "SUMMARY:new"]));
    expect(seriesOf(calendar.events, platform).map((s) => s.master?.summary)).toEqual(["new"]);
    // The same version twice: the later stamp is the newer, whichever comes first in the text; with nothing to tell them apart, the later in the text.
    const twice = (first: readonly string[], second: readonly string[]) =>
      seriesOf(read(["BEGIN:VCALENDAR", "VERSION:2.0", ...[first, second].flatMap((lines) => ["BEGIN:VEVENT", "UID:same@atelier.example", "DTSTART:20260105T090000Z", "SEQUENCE:2", ...lines, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n")).events, platform).map((s) => s.master?.summary);
    const [morning, evening] = [["DTSTAMP:20261113T080000Z", "SUMMARY:stamped in the morning"], ["DTSTAMP:20261113T200000Z", "SUMMARY:stamped in the evening"]];
    expect(twice(morning, evening)).toEqual(["stamped in the evening"]);
    expect(twice(evening, morning)).toEqual(["stamped in the evening"]);
    expect(twice(["SUMMARY:first"], ["SUMMARY:second"])).toEqual(["second"]);
  });
});

describe("the other kinds of time", () => {
  it("gives an added period its own length and an added time the event's", () => {
    const e = expand(rdate_periods.fixture, rdate_periods.window);
    expect(e.occurrences.map((o) => [moment(o.start, e.zones), moment(o.end, e.zones)])).toEqual(rdate_periods.spans);
  });

  it("puts a whole day on the viewer's day and an instant where it falls", () => {
    const names = (window: readonly [string, string]) =>
      [0, 1].flatMap((series) => expand(whole_day_west.fixture, window, "America/Los_Angeles", series).occurrences.map((o) => o.event.summary));
    expect(names(whole_day_west.laDays.nov20)).toEqual(["Night firing"]);
    expect(names(whole_day_west.laDays.nov21)).toEqual(["Market day"]);
  });

  it("reads a zoneless time on the viewer's clock", () => {
    // 10:00 with no zone on 5 December, two and a half hours: 09:00 UTC in Zurich, 18:00 UTC in Los Angeles.
    const inWindow = (viewer: string, window: readonly [string, string]) => expand(feed_rfc7986, window, viewer).occurrences.length;
    expect(inWindow("Europe/Zurich", ["2026-12-05T09:00:00Z", "2026-12-05T09:00:01Z"])).toBe(1);
    expect(inWindow("Europe/Zurich", ["2026-12-05T11:30:00Z", "2026-12-05T12:00:00Z"])).toBe(0);
    expect(inWindow("America/Los_Angeles", ["2026-12-05T09:00:00Z", "2026-12-05T09:00:01Z"])).toBe(0);
    expect(inWindow("America/Los_Angeles", ["2026-12-05T20:29:59Z", "2026-12-05T21:00:00Z"])).toBe(1);
  });

  it("uses a zone the file defines, and claims no instant for one nobody defines", () => {
    const defined = expand(file_zone.defined, file_zone.window);
    expect(starts(defined)).toEqual(file_zone.starts);
    const unknown = expand(file_zone.undefined, file_zone.window);
    expect(starts(unknown)).toEqual([null, null, null]);
    expect(unknown.occurrences.map((o) => (o.start.kind === "zoned" ? [o.start.tzid, o.start.wall.day, o.start.wall.hour] : []))).toEqual([["Studio Time", 3, 10], ["Studio Time", 4, 10], ["Studio Time", 5, 10]]);
    expect(unknown.occurrences.map((o) => o.key.kind)).toEqual(["wall", "wall", "wall"]);
    // It is still shown near where its clock time says, and not a week away from it.
    expect(expand(file_zone.undefined, ["2026-10-12T00:00:00Z", "2026-10-20T00:00:00Z"]).occurrences).toEqual([]);
  });

  it("keeps an event that began before the window and has not ended, and drops one that just has", () => {
    const calendar = oneEvent(["DTSTART:20260105T090000Z", "DTEND:20260105T100000Z"]);
    expect(expand(calendar, ["2026-01-05T09:59:59Z", "2026-01-05T12:00:00Z"]).occurrences.length).toBe(1);
    expect(expand(calendar, ["2026-01-05T10:00:00Z", "2026-01-05T12:00:00Z"]).occurrences.length).toBe(0);
    expect(expand(calendar, ["2026-01-05T08:00:00Z", "2026-01-05T09:00:00Z"]).occurrences.length).toBe(0);
    const moment0 = oneEvent(["DTSTART:20260105T090000Z"]);
    expect(expand(moment0, ["2026-01-05T09:00:00Z", "2026-01-05T09:00:01Z"]).occurrences.length).toBe(1);
  });

  it("shows an event once when its rule cannot be followed", () => {
    const e = expand(oneEvent(["DTSTART:20260105T090000Z", "RRULE:FREQ=FORTNIGHTLY"]), ["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"]);
    expect(starts(e)).toEqual(["2026-01-05T09:00:00Z"]);
  });
});

describe("ceilings", () => {
  it("stops a rule with no end at the ceiling and says so", () => {
    const e = expand(every_second.fixture, every_second.window);
    expect(e.capped).toBe(true);
    expect(e.occurrences.length).toBe(MAX_OCCURRENCES_PER_EXPANSION);
    expect(starts(e).slice(0, 3)).toEqual(["2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z", "2026-01-01T00:00:02Z"]);
  });

  it("stops at the ceiling whatever the occurrences come from", () => {
    // Eight added dates and a ceiling of five: five come back, in order, and the expansion says it stopped.
    const dates = ["06", "07", "08", "09", "10", "11", "12", "13"].map((d) => `202601${d}T090000Z`).join(",");
    const calendar = read(oneEvent(["DTSTART:20260105T090000Z", `RDATE:${dates}`]));
    const window = { startMs: at("2026-01-01T00:00:00Z"), endMs: at("2026-02-01T00:00:00Z"), viewerZone: "Europe/Zurich" };
    const e = expandSeries(seriesOf(calendar.events, platform)[0]!, window, platform, { ...DEFAULT_LIMITS, maxOccurrences: 5 });
    expect(e.capped).toBe(true);
    expect(e.occurrences.map((o) => moment(o.start, platform))).toEqual(["2026-01-05T09:00:00Z", "2026-01-06T09:00:00Z", "2026-01-07T09:00:00Z", "2026-01-08T09:00:00Z", "2026-01-09T09:00:00Z"]);
    expect(expandSeries(seriesOf(calendar.events, platform)[0]!, window, platform).occurrences.length).toBe(9);
  });

  it("stops a rule that never matches by its count of steps, over a window with no end in sight", () => {
    const calendar = read(never_matches.fixture);
    const window = span(never_matches.window);
    const e = expandSeries(seriesOf(calendar.events, platform)[0]!, window, platform, { ...DEFAULT_LIMITS, maxSteps: 5000 });
    expect(e.occurrences).toEqual([]);
    expect(e.capped).toBe(true);
    expect(e.spent).toBeLessThanOrEqual(5000 + 1);
    expect(expandSeries(seriesOf(calendar.events, platform)[0]!, window, platform).capped).toBe(true);
  });

  it("walks a rule that began long ago straight to the window", () => {
    // Daily since 1900, asked for one day of 2026. Two days of slack either side of the window: the days from the 11th to
    // the 16th are asked (6) and handed back (6), and the series itself is one step. Thirteen, far under any ceiling.
    const e = expand(oneEvent(["DTSTART:19000101T090000Z", "RRULE:FREQ=DAILY"]), ["2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z"], "Europe/Zurich", 0, { ...DEFAULT_LIMITS, maxSteps: 20 });
    expect(starts(e)).toEqual(["2026-11-13T09:00:00Z"]);
    expect(e.capped).toBe(false);
    expect(e.spent).toBe(13);
  });

  /*
   * A RULE THAT CAN MATCH NO DAY. Every month and every day of the year named, and for weekdays only
   * numbered ones no month has (the sixth to the fifty-third of each, counted from either end). The
   * walk must end with the window, not with the calendar's last year, and a day must cost one step
   * however long the rule's lists are.
   */
  const numbered = (from: number, to: number, weekdays: readonly string[]): string => {
    const parts: string[] = [];
    for (let n = from; n <= to; n++) for (const d of weekdays) parts.push(`${n}${d}`, `-${n}${d}`);
    return parts.join(",");
  };
  const list = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => from + i).join(",");
  const NO_DAY_LONG = `FREQ=YEARLY;BYMONTH=${list(1, 12)};BYYEARDAY=${list(1, 366)};BYDAY=${numbered(6, 53, ["MO", "TU", "WE", "TH", "FR", "SA", "SU"])}`;
  const NO_DAY_SHORT = `FREQ=YEARLY;BYMONTH=${list(1, 12)};BYDAY=${numbered(6, 17, ["MO", "TU", "WE", "TH"])}`;
  const WEEK = ["2026-11-09T00:00:00Z", "2026-11-16T00:00:00Z"] as const;
  const never = (rules: readonly string[]): string => oneEvent(["DTSTART:20260101T090000Z", ...rules.map((r) => `RRULE:${r}`)]);

  it("ends a rule that never matches with the window, at one step a day whatever its lists hold", () => {
    expect(NO_DAY_LONG.length).toBeGreaterThan(5000);
    // One week of November 2026: the walk opens at the year 2026 and looks at its 365 days; 2027 begins after the window. The series is one step more.
    for (const rule of [NO_DAY_LONG, NO_DAY_SHORT]) {
      const e = expand(never([rule]), WEEK);
      expect([e.occurrences.length, e.capped, e.spent]).toEqual([0, false, 366]);
    }
    // A hundred years: 2026 to 2126 are 101 years, 24 of them leap years (2100 is none): 101 x 365 + 24 days.
    const century = expand(never([NO_DAY_LONG]), ["2026-06-01T00:00:00Z", "2126-06-01T00:00:00Z"]);
    expect([century.occurrences.length, century.capped, century.spent]).toEqual([0, false, 101 * 365 + 24 + 1]);
    // The 30th of February, yearly: only February is asked, 28 days of it in 2026.
    const february = expand(never(["FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"]), WEEK);
    expect([february.occurrences.length, february.capped, february.spent]).toEqual([0, false, 29]);
  });

  it("spends one allowance over every rule line of an event, and walks no more lines than the ceiling", () => {
    // The same line twice costs twice the days, out of the same allowance.
    expect(expand(never([NO_DAY_SHORT, NO_DAY_SHORT]), WEEK).spent).toBe(2 * 365 + 1);
    const tight = expand(never([NO_DAY_SHORT, NO_DAY_SHORT]), WEEK, "Europe/Zurich", 0, { ...DEFAULT_LIMITS, maxSteps: 500 });
    expect([tight.capped, tight.spent]).toEqual([true, 365 + 1 + 365]);
    // Four hundred lines: the first eight are walked, and the expansion says it stopped.
    const many = expand(never(Array.from({ length: 400 }, () => NO_DAY_SHORT)), WEEK);
    expect([many.capped, many.spent]).toEqual([true, MAX_RULES_PER_EVENT * 365 + 1]);
    // Eight lines of a rule with no end, and room for three of them: the days come back once, and the count holds.
    const daily = oneEvent(["DTSTART:20260101T090000Z", ...Array.from({ length: 8 }, () => "RRULE:FREQ=DAILY")]);
    const days = expand(daily, ["2026-03-01T00:00:00Z", "2026-03-11T00:00:00Z"], "Europe/Zurich", 0, { ...DEFAULT_LIMITS, maxSteps: 100 });
    expect(days.occurrences.length).toBe(10);
    expect(days.capped).toBe(true);
    expect(days.spent).toBeLessThanOrEqual(100 + 2);
  });

  it("asks the zone about nothing that lies before the window", () => {
    // Every half hour of every day since 1970, with an end far off: November 2026 has 30 days of 48.
    const hours = list(0, 23);
    const calendar = read(oneEvent(["DTSTART;TZID=Europe/Zurich:19700101T000000", `RRULE:FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${hours};BYMINUTE=0,30;UNTIL=99991231T235959Z`]));
    const zones = counted(platform);
    const window = span(["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"]);
    const e = expandSeries(seriesOf(calendar.events, zones)[0]!, window, zones);
    expect([e.occurrences.length, e.capped]).toEqual([30 * 48, false]);
    // Two days of slack, a day the zone is probed either side of a reading, and the zone's own distance from UTC.
    expect(zones.earliest).toBeGreaterThanOrEqual(window.startMs - 4 * 86_400_000);
  });

  it("looks at listed dates and changed days far from the window without asking the zone", () => {
    // Five thousand added dates and as many excluded ones, a day apart from 2000 on; the window holds 9 and 10 November 2026.
    const stamp = (n: number): string => new Date(Date.UTC(2000, 0, 1 + n, 9)).toISOString().replace(/[-:]|\.000Z/g, "");
    const dates = Array.from({ length: 5000 }, (_, n) => stamp(n * 2));
    const out = Array.from({ length: 5000 }, (_, n) => stamp(n * 2 + 1));
    const calendar = read(oneEvent(["DTSTART;TZID=Europe/Zurich:20000101T090000", `RDATE;TZID=Europe/Zurich:${dates.join(",")}`, `EXDATE;TZID=Europe/Zurich:${out.join(",")}`]));
    const zones = counted(platform);
    const [series] = seriesOf(calendar.events, zones);
    zones.asked = 0;
    const e = expandSeries(series!, span(["2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z"]), zones);
    // 9 November 2026 is 9,809 days after 1 January 2000: an odd number, so the 9th is excluded and the 10th added.
    expect(e.occurrences.map((o) => moment(o.start, platform))).toEqual(["2026-11-10T08:00:00Z"]);
    expect(zones.asked).toBeLessThan(200);
    // The series, its 5,000 added and its 5,000 excluded dates: one step each.
    expect(e.spent).toBe(10_001);
  });

  it("refuses a rule that names both a count and an end, and shows the event once", () => {
    const e = expand(oneEvent(["DTSTART:20260105T090000Z", "RRULE:FREQ=DAILY;COUNT=1000000;UNTIL=99991231T235959Z"]), ["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"]);
    expect(starts(e)).toEqual(["2026-01-05T09:00:00Z"]);
  });
});

describe("a calendar's series, expanded together", () => {
  it("come back in one order, as each alone would", () => {
    const calendar = read(google_export);
    const zones = zonesFor(calendar);
    const all = seriesOf(calendar.events, zones);
    const window = span(["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"]);
    const together = expandAll(all, window, zones);
    const apart = all.flatMap((s) => expandSeries(s, window, zones).occurrences);
    // The kiln schedule's eight Mondays (one moved, one excluded), then the whole day of 1 May: by start, across the two series.
    expect(together.occurrences.map((o) => moment(o.start, zones) ?? dayText(o.start))).toEqual([
      "2026-03-02T08:30:00Z", "2026-03-09T08:30:00Z", "2026-03-16T08:30:00Z", "2026-03-24T13:00:00Z", "2026-03-30T07:30:00Z", "2026-04-13T07:30:00Z", "2026-04-20T07:30:00Z", "2026-04-27T07:30:00Z", "2026-05-01",
    ]);
    expect(together.occurrences).toEqual(apart);
    expect(together.capped).toBe(false);
    // What the two cost apart is what they cost together.
    expect(together.spent).toBe(all.reduce((sum, s) => sum + expandSeries(s, window, zones).spent, 0));
  });

  it("share one allowance, and say so when it is spent", () => {
    // Five hundred events, each every minute of a 30 February: a month's window is 34 days of 1,440 minutes for each of them.
    const lines = Array.from({ length: 500 }, (_, n) => ["BEGIN:VEVENT", `UID:never-${n}@atelier.example`, "DTSTAMP:20261113T120000Z", "DTSTART:20260101T090000Z", "RRULE:FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30", "END:VEVENT"]).flat();
    const calendar = read(["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR", ""].join("\r\n"));
    const all = seriesOf(calendar.events, platform);
    const window = span(["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"]);
    const one = expandSeries(all[0]!, window, platform);
    expect([one.capped, one.spent]).toEqual([false, 34 * 1440 + 1 + 1]);
    const e = expandAll(all, window, platform);
    expect(e.occurrences).toEqual([]);
    expect(e.capped).toBe(true);
    expect(e.spent).toBeLessThanOrEqual(MAX_STEPS_PER_EXPANSION + 2);
  });
});

describe("what one expansion may cost", () => {
  const list = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, i) => from + i).join(",");
  const [HOURS, SIXTY] = [list(0, 23), list(0, 59)];
  const YEAR = ["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"] as const;
  const NOVEMBER = ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"] as const;
  const event = (n: number, lines: readonly string[]): string[] => ["BEGIN:VEVENT", `UID:cost-${n}@atelier.example`, "DTSTAMP:20261113T120000Z", ...lines, "END:VEVENT"];
  const calendar = (parts: readonly (readonly string[])[]): CalObject => read(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//corpus//EN", ...parts.flat(), "END:VCALENDAR", ""].join("\r\n"));
  const eight = (line: string): string[] => Array.from({ length: 8 }, () => line);

  /*
   * THREE SMALL TEXTS THAT EACH HELD A CALL FOR SECONDS. A step was a day asked or an instance handed
   * back, and a line's lists could make one step lay out thousands of clock readings: 3,600 for every
   * hour, 18,720 for every day, 86,400 before the first day was asked. A line whose lists name more
   * readings for a day than `MAX_CLOCK_READINGS_PER_DAY` is not walked: the event's start is shown,
   * the expansion says which ceiling it met, and what it spent is counted in single steps.
   */
  it("leaves alone a rule line whose lists make a day more readings than the ceiling, and says so", () => {
    // Every second of every hour, of which BYSETPOS keeps the first: one line, a year.
    const hourly = `RRULE:FREQ=HOURLY;BYMINUTE=${SIXTY};BYSECOND=${SIXTY};BYSETPOS=1`;
    const one = expand(oneEvent(["DTSTART:20260101T000000Z", hourly]), YEAR);
    expect(starts(one)).toEqual(["2026-01-01T00:00:00Z"]);
    // The series is one step and its start, handed back, another.
    expect([one.capped, one.stoppedBy, one.spent]).toEqual([true, ["rule_too_dense"], 2]);
    // Eight such lines: each hands the start back, and it is shown once.
    const lines = expand(oneEvent(["DTSTART:20260101T000000Z", ...eight(hourly)]), YEAR);
    expect(starts(lines)).toEqual(["2026-01-01T00:00:00Z"]);
    expect([lines.capped, lines.stoppedBy, lines.spent]).toEqual([true, ["rule_too_dense"], 1 + 8]);

    // 18,720 readings a day (24 hours, 60 minutes, 13 seconds), one kept: three events of eight lines, expanded together over a month.
    const daily = `RRULE:FREQ=DAILY;BYHOUR=${HOURS};BYMINUTE=${SIXTY};BYSECOND=${list(0, 12)};BYSETPOS=1`;
    const three = calendar(Array.from({ length: 3 }, (_, n) => event(n, ["DTSTART:20261101T000000Z", ...eight(daily)])));
    const together = expandAll(seriesOf(three.events, platform), span(NOVEMBER), platform);
    expect(together.occurrences.map((o) => [o.uid, moment(o.start, platform)])).toEqual([0, 1, 2].map((n) => [`cost-${n}@atelier.example`, "2026-11-01T00:00:00Z"]));
    expect([together.capped, together.stoppedBy, together.spent]).toEqual([true, ["rule_too_dense"], 3 * (1 + 8)]);

    // Every second of the day, sixteen lines in two events that began before the window: nothing is handed back, and each series is its one step.
    const clock = `RRULE:FREQ=DAILY;BYHOUR=${HOURS};BYMINUTE=${SIXTY};BYSECOND=${SIXTY}`;
    const two = calendar(Array.from({ length: 2 }, (_, n) => event(n, ["DTSTART:20261110T000000Z", ...eight(clock)])));
    const window = span(["2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z"]);
    const day = expandAll(seriesOf(two.events, platform), window, platform);
    expect([day.occurrences.length, day.capped, day.stoppedBy, day.spent]).toEqual([0, true, ["rule_too_dense"], 2]);
    // None of the three needs more than a handful of steps to say so.
    const tight = { ...DEFAULT_LIMITS, maxSteps: 10 };
    expect(expand(oneEvent(["DTSTART:20260101T000000Z", ...eight(hourly)]), YEAR, "Europe/Zurich", 0, tight).spent).toBe(9);
    expect(expandAll(seriesOf(two.events, platform), window, platform, tight).spent).toBe(2);

    // Four hundred of them in one event: eight are looked at, and both ceilings are named.
    const many = expand(oneEvent(["DTSTART:20260101T000000Z", ...Array.from({ length: 400 }, () => hourly)]), YEAR);
    expect([starts(many), many.stoppedBy, many.spent]).toEqual([["2026-01-01T00:00:00Z"], ["rule_too_dense", "too_many_rules"], 1 + MAX_RULES_PER_EVENT]);
  });

  it("walks a line at the ceiling, every minute of the day, and counts each reading it hands back", () => {
    // 1,440 readings a day by the lists. Two days asked for; with two days of slack either side the walk is asked for six days and a seventh that begins at its end.
    const e = expand(oneEvent(["DTSTART:20260101T000000Z", `RRULE:FREQ=DAILY;BYHOUR=${HOURS};BYMINUTE=${SIXTY}`]), ["2026-03-01T00:00:00Z", "2026-03-03T00:00:00Z"]);
    expect([e.occurrences.length, e.capped, e.stoppedBy]).toEqual([2 * 1440, false, []]);
    expect([starts(e)[0], starts(e)[2 * 1440 - 1]]).toEqual(["2026-03-01T00:00:00Z", "2026-03-02T23:59:00Z"]);
    // Seven days asked; six days of readings and the one that lies past the end handed back; the series.
    expect(e.spent).toBe(7 + (6 * 1440 + 2) + 1);
    // The last minute of each day alone: the day asked, the one place worked out, nothing else made.
    const last = expand(oneEvent(["DTSTART:20260101T000000Z", `RRULE:FREQ=DAILY;BYHOUR=${HOURS};BYMINUTE=${SIXTY};BYSETPOS=-1`]), ["2026-03-01T00:00:00Z", "2026-03-03T00:00:00Z"]);
    expect(starts(last)).toEqual(["2026-03-01T23:59:00Z", "2026-03-02T23:59:00Z"]);
    expect([last.capped, last.spent]).toEqual([false, 7 + 7 + 1]);
  });

  it("names the ceiling that stopped it", () => {
    expect(expand(every_second.fixture, every_second.window).stoppedBy).toEqual(["too_many_occurrences"]);
    expect(expand(never_matches.fixture, never_matches.window).stoppedBy).toEqual(["out_of_steps"]);
    const none = expand(oneEvent(["DTSTART:20260105T090000Z", "RRULE:FREQ=DAILY;COUNT=3"]), YEAR);
    expect([none.capped, none.stoppedBy]).toEqual([false, []]);
    // A year of every day at every hour is 8,760 instances in one period of a yearly rule, within its ceiling; with every minute too it is 525,600 and past it.
    const period = expand(oneEvent(["DTSTART:20260101T000000Z", `RRULE:FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${HOURS};BYMINUTE=${SIXTY}`]), NOVEMBER);
    expect([period.occurrences.length, period.stoppedBy]).toEqual([0, ["too_many_in_a_period"]]);
    // A series that was never looked at because the steps were gone says the same as one that ran out of them.
    const two = calendar([event(0, ["DTSTART:20260101T090000Z", "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30"]), event(1, ["DTSTART:20261105T090000Z"])]);
    const cut = expandAll(seriesOf(two.events, platform), span(NOVEMBER), platform, { ...DEFAULT_LIMITS, maxSteps: 20 });
    expect([cut.occurrences.length, cut.stoppedBy]).toEqual([0, ["out_of_steps"]]);
  });

  /*
   * WHAT THE ALLOWANCE BUYS. A weekly series over a year's window: with two days of slack either side
   * and an hour's length the walk is asked for 55 weeks of seven days and hands back 55 Mondays (385
   * and 55 steps, and one for the series: 441); 53 of them lie where the zone is asked, and the year
   * has 52. Two thousand such series, a large calendar, are 882,000 steps and 106,000 times.
   */
  it("has room for two thousand weekly series over a year", () => {
    const weekly = calendar(Array.from({ length: 2000 }, (_, n) => event(n, ["DTSTART:20200106T090000Z", "DTEND:20200106T100000Z", "RRULE:FREQ=WEEKLY"])));
    const all = seriesOf(weekly.events, platform);
    const one = expandSeries(all[0]!, span(YEAR), platform);
    expect([one.occurrences.length, one.spent, one.resolved, one.capped]).toEqual([52, 441, 53, false]);
    const e = expandAll(all, span(YEAR), platform);
    expect([e.occurrences.length, e.spent, e.resolved, e.capped, e.stoppedBy]).toEqual([2000 * 52, 2000 * 441, 2000 * 53, false, []]);
    expect([e.spent <= MAX_STEPS_PER_EXPANSION, e.resolved <= MAX_OCCURRENCES_PER_CALL]).toEqual([true, true]);
    // The other rows of the table in limits.ts, each alone over the same year: steps and times.
    const row = (...lines: string[]): number[] => {
      const r = expand(oneEvent(["DTSTART;TZID=Europe/Zurich:20200106T090000", "DTEND;TZID=Europe/Zurich:20200106T100000", ...lines]), YEAR);
      return [r.spent, r.resolved];
    };
    expect([row("RRULE:FREQ=MONTHLY"), row("RRULE:FREQ=WEEKLY"), row("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"), row("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), row("RRULE:FREQ=DAILY"), row("RRULE:FREQ=HOURLY")]).toEqual([
      [442, 12], [441, 53], [549, 159], [657, 265], [747, 371], [17_823, 8911],
    ]);
    // An event of June that does not repeat, and a birthday: January's 31 days asked in each of three years, three handed back, the series.
    const once = expand(oneEvent(["DTSTART;TZID=Europe/Zurich:20260605T090000", "DTEND;TZID=Europe/Zurich:20260605T100000"]), YEAR);
    const birthday = expand(oneEvent(["DTSTART;VALUE=DATE:20200106", "RRULE:FREQ=YEARLY"]), YEAR);
    expect([[once.spent, once.resolved], [birthday.spent, birthday.resolved]]).toEqual([[1, 1], [3 * 31 + 3 + 1, 1]]);
    // One series alone still stops at its own ceiling, and a call at the call's: seven events of every second, a day and a half of them wanted.
    const seconds = calendar(Array.from({ length: 7 }, (_, n) => event(n, ["DTSTART:20260101T000000Z", "RRULE:FREQ=SECONDLY"])));
    const ticking = expandAll(seriesOf(seconds.events, platform), span(["2026-01-01T00:00:00Z", "2026-01-02T12:00:00Z"]), platform);
    expect([ticking.occurrences.length, ticking.stoppedBy]).toEqual([MAX_OCCURRENCES_PER_CALL, ["too_many_occurrences"]]);
    expect(ticking.occurrences.filter((o) => o.uid === "cost-0@atelier.example").length).toBe(MAX_OCCURRENCES_PER_EXPANSION);
    expect(MAX_OCCURRENCES_PER_CALL).toBe(6 * MAX_OCCURRENCES_PER_EXPANSION);
  });

  /*
   * THE LENGTH OF A NAME WAS OUTSIDE EVERY COUNT. One event every minute in a zone nobody knows,
   * named with 17,000 characters: every occurrence's key carried the whole name and was looked up in
   * what the series had seen, and a string that long is not told from another by its content at a
   * glance, so each look compared the names whole. 5,821 times took 65 seconds, on 11,643 steps. A
   * zone's name and a UID have their ceilings at the reader: the event is left out and the read says
   * so, and what is expanded holds no key, and puts no two UIDs in order, past those lengths.
   */
  it("expands nothing whose zone name or UID is longer than its kind may be, and at the ceiling works as for any name", () => {
    const hour = ["2026-11-10T00:00:00Z", "2026-11-10T01:00:00Z"] as const;
    const minutely = (zone: string, uid = "cost-0@atelier.example"): string =>
      ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:${uid}`, `DTSTART;TZID=${zone}:20261101T000000`, "RRULE:FREQ=MINUTELY", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    const whole = (source: string) => {
      const result = readCalendar(source, DEFAULT_LIMITS);
      if (!result.ok) throw new Error(`not read: ${result.reason}`);
      const e = expandAll(seriesOf(result.calendar.events, platform), span(hour), platform);
      return { dropped: result.dropped.map((d) => d.reason), occurrences: e.occurrences, spent: e.spent, resolved: e.resolved, stoppedBy: e.stoppedBy };
    };
    expect(whole(minutely("Z".repeat(17_000)))).toEqual({ dropped: ["zone_name_too_long"], occurrences: [], spent: 0, resolved: 0, stoppedBy: [] });
    expect(whole(minutely("Europe/Zurich", "U".repeat(MAX_UID_CHARS + 1)))).toMatchObject({ dropped: ["uid_too_long"], occurrences: [] });
    // At the ceiling: the same counted work as under a short name nobody knows, and every key no longer than the name and its clock time.
    const [far, near] = [whole(minutely("Z".repeat(MAX_ZONE_NAME_CHARS), "U".repeat(MAX_UID_CHARS))), whole(minutely("Studio Time"))];
    expect([far.dropped, far.stoppedBy, far.spent, far.resolved, far.occurrences.length]).toEqual([[], [], near.spent, near.resolved, near.occurrences.length]);
    expect(far.occurrences.length).toBeGreaterThan(60);
    expect(Math.max(...far.occurrences.map((o) => recurrenceKeyString(o.key).length))).toBe(MAX_ZONE_NAME_CHARS + "|20261110T0000|false".length);
    expect(Math.max(...far.occurrences.map((o) => o.uid.length))).toBe(MAX_UID_CHARS);
  });

  /*
   * A ZONE ONLY THE FILE DEFINES, IN 2,000 BLOCKS. Each block has its own start and a rule that
   * gives that start and nothing more. A definition is read the first time its zone is asked for,
   * and what that costs comes out of the asker's steps: for each block a step for its start, one
   * for its rule and each member of the rule's lists, and one for the instance the rule hands back.
   * With clock lists of 86,400 readings in every rule, reading it laid the lists out once a block,
   * 8 ms each and 20 s in all, before a step was counted.
   */
  it("pays for reading a zone's definition out of the same steps", () => {
    const day = (k: number): string => new Date(Date.UTC(2020, 0, 2 + k)).toISOString().slice(0, 10).replace(/-/g, "");
    const zone = (blocks: number, rule: string): string[] => [
      "BEGIN:VTIMEZONE", "TZID:Busy",
      ...Array.from({ length: blocks }, (_, k) => ["BEGIN:STANDARD", `DTSTART:${day(k)}T000000`, "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", rule, "END:STANDARD"]).flat(),
      "END:VTIMEZONE",
    ];
    const daily = event(0, ["DTSTART;TZID=Busy:20261101T090000", "RRULE:FREQ=DAILY"]);
    const window = ["2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z"] as const;
    const text = (blocks: number, rule = "RRULE:FREQ=DAILY;COUNT=1"): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...zone(blocks, rule), ...daily, "END:VCALENDAR", ""].join("\r\n");
    // Two days asked for: seven days asked of the rule (from the 7th to the 13th), seven instances handed back, the series: 15 steps without the zone.
    const small = expand(text(1), window);
    expect(starts(small)).toEqual(["2026-11-09T08:00:00Z", "2026-11-10T08:00:00Z"]);
    expect([small.capped, small.spent]).toEqual([false, 15 + 3]);
    const full = expand(text(MAX_ZONE_ONSETS), window);
    expect(starts(full)).toEqual(["2026-11-09T08:00:00Z", "2026-11-10T08:00:00Z"]);
    expect([full.capped, full.spent]).toEqual([false, 15 + 3 * MAX_ZONE_ONSETS]);
    // With fewer steps than the definition costs it is not read: nothing is placed by a zone half known, and the call says it stopped.
    const short = expand(text(MAX_ZONE_ONSETS), window, "Europe/Zurich", 0, { ...DEFAULT_LIMITS, maxSteps: 3000 });
    expect([short.occurrences.length, short.capped, short.stoppedBy, short.spent]).toEqual([0, true, ["out_of_steps"], 3000]);

    // The same 2,000 blocks with every second of the day in each rule's lists: 144 members a rule, 147 steps a block. A zone's rules that end may
    // cost 75,000 steps to read, which 513 blocks stay under; the 514th passes it, the definition is given up as none, and what was spent on it is the call's.
    const dense = expand(text(MAX_ZONE_ONSETS, `RRULE:FREQ=DAILY;COUNT=1;BYHOUR=${HOURS};BYMINUTE=${SIXTY};BYSECOND=${SIXTY}`), window);
    // A zone nobody knows: no instant is claimed, and the days that could fall in the window under any zone are shown (the 11th could, at UTC+14).
    expect(dense.occurrences.map((o) => [o.key.kind, moment(o.start, dense.zones), o.start.kind === "zoned" && o.start.wall.day])).toEqual([["wall", null, 9], ["wall", null, 10], ["wall", null, 11]]);
    expect([dense.capped, dense.spent]).toEqual([false, 15 + 513 * 147 + 146]);
    expect(expand(text(MAX_ZONE_ONSETS, `RRULE:FREQ=DAILY;COUNT=1;BYHOUR=${HOURS};BYMINUTE=${SIXTY};BYSECOND=${SIXTY}`), window, "Europe/Zurich", 0, { ...DEFAULT_LIMITS, maxSteps: 3000 }).stoppedBy).toEqual(["out_of_steps"]);
  });

  it("pays for following a zone's rules, once for each year it looks at", () => {
    // "Studio Time" has two yearly rules, each naming a month and a weekday. A look at a year sets both up (the rule and its two list members:
    // three steps) and walks each over the year before, the year itself and the year after: the month's 31 days asked and one onset handed
    // back, three times. The two blocks' own starts are two more.
    const window = ["2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z"] as const;
    const all = file_zone.defined.lines;
    const studio = all.slice(all.indexOf("BEGIN:VTIMEZONE"), all.indexOf("END:VTIMEZONE") + 1);
    const inStudio = (rule: string): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...studio, ...event(0, ["DTSTART;TZID=Studio Time:20261101T090000", rule]), "END:VCALENDAR", ""].join("\r\n");
    const defined = expand(inStudio("RRULE:FREQ=DAILY"), window);
    // Nine in the morning at UTC+6:45 in November. The series costs its 15 steps, as in any zone.
    expect(starts(defined)).toEqual(["2026-11-09T02:15:00Z", "2026-11-10T02:15:00Z"]);
    expect([defined.capped, defined.spent]).toEqual([false, 15 + 2 + 2 * (3 + 3 * (31 + 1))]);
    // The first of November over ten years, in one call: the definition is read once, and each year is looked at once.
    const decade = expand(inStudio("RRULE:FREQ=YEARLY"), ["2026-11-01T00:00:00Z", "2035-11-02T00:00:00Z"]);
    expect(decade.occurrences.length).toBe(10);
    // Ten years asked of the yearly rule, November's 30 days each, ten instances handed back, the series; then the zone.
    expect(decade.spent).toBe(10 * 30 + 10 + 1 + 2 + 10 * 2 * (3 + 3 * (31 + 1)));
  });
});

describe("what grouping a file's events may cost", () => {
  /*
   * A CHANGED DAY IS KEYED BY ITS MOMENT, and for one written in a zone only the file defines that
   * means reading the definition. Six such zones, each with a summer rule that ran for two hundred
   * years, and a changed day in each: `seriesOf` reads the definitions on one allowance of steps,
   * as an expansion does. The days it can no longer afford are keyed by their clock time, as days
   * in a zone nobody knows are, and their definitions are left unread.
   */
  const zone = (k: number): string[] => [
    "BEGIN:VTIMEZONE", `TZID:Works ${k}`,
    "BEGIN:DAYLIGHT", "DTSTART:18000330T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;UNTIL=19991231T000000Z", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "END:DAYLIGHT",
    "END:VTIMEZONE",
  ];
  const changed = (k: number): string[] => ["BEGIN:VEVENT", "UID:works@atelier.example", "DTSTAMP:20261113T120000Z", `RECURRENCE-ID;TZID=Works ${k}:2026010${k + 1}T090000`, `DTSTART;TZID=Works ${k}:2026010${k + 1}T100000`, "END:VEVENT"];
  const six = [0, 1, 2, 3, 4, 5];
  const source = ["BEGIN:VCALENDAR", "VERSION:2.0", ...six.flatMap(zone), ...six.flatMap(changed), "END:VCALENDAR", ""].join("\r\n");
  const kinds = (series: readonly { overrides: ReadonlyMap<string, unknown> }[]): string[] => [...series[0]!.overrides.keys()].map((key) => (/^\d+$/.test(key) ? "moment" : "clock"));
  /** What the first question about a zone costs a source that has not read its definition, and nothing if it has. */
  const priceOf = (zones: ZoneSource, k: number): number => {
    const left = { steps: 1_000_000 };
    zones.offsetAt(`Works ${k}`, at("2026-01-01T00:00:00Z"), left);
    return 1_000_000 - left.steps;
  };

  it("reads a file's zone definitions on one allowance of steps, and keys by clock time what that no longer covers", () => {
    const calendar = read(source);
    // One definition: its block's start, its rule set up, and two centuries of a month's days asked with the onsets they hand back.
    const price = priceOf(zonesFor(calendar), 0);
    expect(price).toBeGreaterThan(200 * 31);
    expect(price).toBeLessThan(200 * 33);
    // With the default allowance all six are read: every changed day is keyed by its moment.
    expect(kinds(seriesOf(calendar.events, zonesFor(calendar)))).toEqual(["moment", "moment", "moment", "moment", "moment", "moment"]);
    // With steps for three definitions and a little, three are read. The fourth is given up part read, the fifth and sixth are not begun.
    const zones = zonesFor(calendar);
    expect(kinds(seriesOf(calendar.events, zones, { ...DEFAULT_LIMITS, maxSteps: 3 * price + 100 }))).toEqual(["moment", "moment", "moment", "clock", "clock", "clock"]);
    expect(six.map((k) => priceOf(zones, k))).toEqual([0, 0, 0, price, price, price]);
  });
});

describe("one occurrence of a series", () => {
  const calendar = read(radicale_wheel_class);
  const zones = zonesFor(calendar);
  const [series] = seriesOf(calendar.events, zones);

  it("is found by the time it replaces, however that is written", () => {
    const byClock = occurrenceOf(series!, zoned(wall(2026, 11, 24, 18, 0), "Europe/Zurich"), zones);
    expect(byClock).toMatchObject({ source: "rule", start: zoned(wall(2026, 11, 24, 18, 0), "Europe/Zurich"), end: zoned(wall(2026, 11, 24, 19, 30), "Europe/Zurich") });
    expect(occurrenceOf(series!, instant(at("2026-11-24T17:00:00Z")), zones)).toEqual(byClock);
    // The moved day is found by the day it was on, and is where it was moved to.
    expect(occurrenceOf(series!, instant(at("2026-12-01T17:00:00Z")), zones)).toMatchObject({ source: "override", start: zoned(wall(2026, 12, 2, 19, 0), "Europe/Zurich") });
    // A Wednesday the class never had, and the week after its last.
    expect(occurrenceOf(series!, zoned(wall(2026, 11, 25, 18, 0), "Europe/Zurich"), zones)).toBeNull();
    expect(occurrenceOf(series!, zoned(wall(2026, 12, 29, 18, 0), "Europe/Zurich"), zones)).toBeNull();
  });

  it("becomes a component of its own: the series' lines, its own day, and no rule", () => {
    const changed = changedOccurrence(occurrenceOf(series!, instant(at("2026-11-24T17:00:00Z")), zones)!, zones);
    expect(changed).toMatchObject({
      uid: series!.uid, recurrenceId: zoned(wall(2026, 11, 24, 18, 0), "Europe/Zurich"), thisAndFuture: false, summary: "Wheel class", rules: [], added: [], excluded: [],
      start: zoned(wall(2026, 11, 24, 18, 0), "Europe/Zurich"), end: zoned(wall(2026, 11, 24, 19, 30), "Europe/Zurich"),
    });
    // Beside its series it takes that one day's place and no other.
    const both = seriesOf([...calendar.events, changed], zones)[0]!;
    const e = expandSeries(both, span(["2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z"]), zones);
    expect(e.occurrences.map((o) => o.source)).toEqual(["rule", "override", "override", "rule", "rule", "rule"]);
    expect(e.occurrences.map((o) => moment(o.start, zones))).toEqual(["2026-11-17T17:00:00Z", "2026-11-24T17:00:00Z", "2026-12-02T18:00:00Z", "2026-12-08T17:00:00Z", "2026-12-15T17:00:00Z", "2026-12-22T17:00:00Z"]);
    // A day that is a component of its own already is that component.
    const moved = occurrenceOf(series!, instant(at("2026-12-01T17:00:00Z")), zones)!;
    expect(changedOccurrence(moved, zones)).toBe(moved.event);
  });

  it("is named by its instant where the series' own clock shows a year no text can write", () => {
    // The last second of the year 9999 in UTC is 00:59:59 on 1 January of the year 10000 in Zurich.
    const late = read(oneEvent(["DTSTART;TZID=Europe/Zurich:20261119T090000", "RDATE:99991231T235959Z"]));
    const last = occurrenceOf(seriesOf(late.events, platform)[0]!, instant(at("9999-12-31T23:59:59Z")), platform)!;
    const own = changedOccurrence(last, platform);
    expect(own.recurrenceId).toEqual(instant(at("9999-12-31T23:59:59Z")));
    // Written and read again it is still that occurrence, and not a series of its own.
    const back = read(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${textOf(writeComponent(own.component))}END:VCALENDAR\r\n`);
    expect(back.events[0]!.recurrenceId).toEqual(own.recurrenceId);
  });
});

describe("days a provider expanded itself", () => {
  it("land on the key their series gives the same occurrence", () => {
    const calendar = read(radicale_wheel_class);
    const zones = zonesFor(calendar);
    const [series] = seriesOf(calendar.events, zones);
    const fromSeries = expandSeries(series!, { startMs: at("2026-11-01T00:00:00Z"), endMs: at("2027-01-01T00:00:00Z"), viewerZone: "Europe/Zurich" }, zones).occurrences;
    // The moved day as a provider that expands hands it over: its own times, and the start it had, as instants.
    const expanded = occurrencesFromExpanded(
      [{ uid: series!.uid, originalStart: instant(at("2026-12-01T17:00:00Z")), start: instant(at("2026-12-02T18:00:00Z")), end: instant(at("2026-12-02T19:30:00Z")), event: series!.master! }],
      zones,
    );
    const moved = fromSeries[2] as Occurrence;
    expect(expanded[0]!.source).toBe("expanded");
    expect(recurrenceKeyString(expanded[0]!.key)).toBe(recurrenceKeyString(moved.key));
    expect(recurrenceKeyString(recurrenceKeyOf(zoned(wall(2026, 12, 1, 18, 0), "Europe/Zurich"), zones))).toBe(String(at("2026-12-01T17:00:00Z")));
  });

  it("takes the occurrences a provider reports as cancelled", () => {
    const calendar = read(radicale_wheel_class);
    const zones = zonesFor(calendar);
    const [series] = seriesOf(calendar.events, zones);
    const cancelled = new Set([String(at("2026-12-08T17:00:00Z"))]);
    const e = expandSeries({ ...series!, cancelled }, { startMs: at("2026-11-01T00:00:00Z"), endMs: at("2027-01-01T00:00:00Z"), viewerZone: "Europe/Zurich" }, zones);
    expect(e.occurrences.length).toBe(5);
  });

  it("writes a key for every kind of time", () => {
    expect(recurrenceKeyString(recurrenceKeyOf(plainDate(2026, 11, 21), platform))).toBe(String(at("2026-11-21T00:00:00Z")));
    expect(recurrenceKeyString(recurrenceKeyOf({ kind: "floating", wall: wall(2026, 12, 5, 10, 0) }, platform))).toBe("|20261205T1000|false");
    expect(recurrenceKeyString(recurrenceKeyOf(zoned(wall(2026, 10, 3, 10, 0, 30), "Studio Time"), platform))).toBe("Studio Time|20261003T100030|false");
  });
});
