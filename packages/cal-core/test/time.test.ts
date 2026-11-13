/**
 * The time model: calendar arithmetic, the step from a clock time in a zone to an instant, the day a
 * person sees, and where zone rules come from. Expected instants are the corpus's (worked out from
 * the zones' published offsets, see corpus/nasty.ts and corpus/rfc5545.ts), never this package's.
 */
import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/ical/values.js";
import { parseRRule } from "../src/recur/rrule.js";
import {
  addDays, civilFromDays, dayOfYear, daysFromCivil, daysInMonth, instantOf, instantOfFloating, isLeapYear, isValidDate, localDay, resolveWall, wallFromSeconds, wallIn,
  wallSeconds, weekdayOf, weekOf, weeksInYear,
} from "../src/time/arith.js";
import { addDuration } from "../src/time/duration.js";
import { floating, instant, plainDate, wall, zoned, type Wall, type ZoneSource } from "../src/time/types.js";
import { MAX_ZONE_NAME_CHARS, MAX_ZONE_ONSETS, PLATFORM_ZONES_HELD, UNKNOWN_ZONE_NAMES_HELD, ZONE_ONSETS_HELD } from "../src/limits.js";
import { WINDOWS_ZONES } from "../src/time/windows-zones.js";
import { fileZones, firstOf, intlZones, platformZoneName, type Observance, type ZoneDefinition } from "../src/time/zones.js";
import { a_day_is_not_24_hours, file_zone, whole_day_west } from "./corpus/nasty.js";
import { RFC_LOCAL_TIME_CASES } from "./corpus/rfc5545.js";
import { at, iso } from "./support.js";

const platform = intlZones();
const nobody: ZoneSource = { offsetAt: () => null };
/** `20261004T023000` as clock fields. */
const w = (compact: string): Wall => wall(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)), Number(compact.slice(6, 8)), Number(compact.slice(9, 11)), Number(compact.slice(11, 13)), Number(compact.slice(13, 15)));
const resolved = (compact: string, tzid: string, zones: ZoneSource = platform): string | null => {
  const ms = resolveWall(w(compact), tzid, zones);
  return ms === null ? null : iso(ms);
};

describe("calendar arithmetic", () => {
  it("counts days both ways, across leap years and centuries", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(2000, 3, 1)).toBe(11_017);
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
    for (let d = daysFromCivil(1899, 12, 25); d <= daysFromCivil(2101, 1, 5); d += 13) {
      const c = civilFromDays(d);
      expect(daysFromCivil(c.year, c.month, c.day)).toBe(d);
      expect(isValidDate(c.year, c.month, c.day)).toBe(true);
    }
    expect([1900, 2000, 2024, 2026, 2100].map(isLeapYear)).toEqual([false, true, true, false, false]);
    expect([daysInMonth(2024, 2), daysInMonth(2026, 2), daysInMonth(2026, 11)]).toEqual([29, 28, 30]);
    expect(isValidDate(2026, 2, 29)).toBe(false);
    expect(dayOfYear(2026, 12, 31)).toBe(365);
    expect(dayOfYear(2024, 12, 31)).toBe(366);
    expect(addDays(plainDate(2026, 12, 31), 1)).toEqual(plainDate(2027, 1, 1));
    expect(addDays(plainDate(2024, 3, 1), -1)).toEqual(plainDate(2024, 2, 29));
  });

  it("knows the weekday", () => {
    // Monday is 0. 1 January 1970 was a Thursday, 29 February 2000 a Tuesday, 13 November 2026 a Friday.
    expect(weekdayOf(daysFromCivil(1970, 1, 1))).toBe(3);
    expect(weekdayOf(daysFromCivil(2000, 2, 29))).toBe(1);
    expect(weekdayOf(daysFromCivil(2026, 11, 13))).toBe(4);
    expect(weekdayOf(daysFromCivil(1601, 1, 1))).toBe(0);
  });

  it("numbers weeks as ISO 8601 does when the week begins on Monday", () => {
    const week = (y: number, m: number, d: number, start = 0) => weekOf(daysFromCivil(y, m, d), start);
    expect(week(2026, 1, 1)).toEqual({ weekYear: 2026, week: 1 });
    expect(week(2025, 12, 29)).toEqual({ weekYear: 2026, week: 1 });
    expect(week(2021, 1, 3)).toEqual({ weekYear: 2020, week: 53 });
    expect(week(2027, 1, 3)).toEqual({ weekYear: 2026, week: 53 });
    expect(week(2027, 1, 4)).toEqual({ weekYear: 2027, week: 1 });
    expect(week(1997, 5, 12)).toEqual({ weekYear: 1997, week: 20 });
    expect([2020, 2025, 2026, 2032].map((y) => weeksInYear(y, 0))).toEqual([53, 52, 53, 53]);
    // A week that begins on Sunday. 1 January 2025 is a Wednesday: the week of Sunday 29 December 2024 has four days in 2025.
    expect(week(2024, 12, 29, 6)).toEqual({ weekYear: 2025, week: 1 });
    expect(week(2024, 12, 28, 6)).toEqual({ weekYear: 2024, week: 52 });
    // 1 January 2026 is a Thursday: the week of Sunday 28 December 2025 has three days in 2026 and is the 53rd of 2025.
    expect(week(2025, 12, 28, 6)).toEqual({ weekYear: 2025, week: 53 });
  });

  it("turns a clock reading into seconds and back", () => {
    const reading = wall(2026, 11, 13, 23, 59, 58);
    expect(wallFromSeconds(wallSeconds(reading))).toEqual(reading);
    expect(wallFromSeconds(-1)).toEqual(wall(1969, 12, 31, 23, 59, 59));
  });
});

describe("a clock time in a zone", () => {
  it.each(RFC_LOCAL_TIME_CASES)("RFC 5545 3.3.5: $title", ({ tzid, wall: reading, expect: expected }) => {
    expect(resolved(reading, tzid)).toBe(expected);
  });

  it("reads Zurich on both sides of both changes of 2026", () => {
    // 29 March: 02:00 becomes 03:00. 25 October: 03:00 becomes 02:00, so 02:30 comes twice and the first is CEST.
    expect(resolved("20260329T015959", "Europe/Zurich")).toBe("2026-03-29T00:59:59Z");
    expect(resolved("20260329T023000", "Europe/Zurich")).toBe("2026-03-29T01:30:00Z");
    expect(resolved("20260329T030000", "Europe/Zurich")).toBe("2026-03-29T01:00:00Z");
    expect(resolved("20261025T023000", "Europe/Zurich")).toBe("2026-10-25T00:30:00Z");
    expect(resolved("20261025T030000", "Europe/Zurich")).toBe("2026-10-25T02:00:00Z");
    expect(resolved("20261121T003000", "Europe/Zurich")).toBe(whole_day_west.firingAt);
  });

  it("reads the zones at the ends of the calendar and the ones off the hour", () => {
    // UTC+14, UTC-12, UTC+13:45 in summer, UTC+5:45, and Lord Howe's half hour of summer time.
    expect(resolved("20260101T000000", "Pacific/Kiritimati")).toBe("2025-12-31T10:00:00Z");
    expect(resolved("20260101T000000", "Etc/GMT+12")).toBe("2026-01-01T12:00:00Z");
    expect(resolved("20260101T120000", "Pacific/Chatham")).toBe("2025-12-31T22:15:00Z");
    expect(resolved("20260601T090000", "Asia/Kathmandu")).toBe("2026-06-01T03:15:00Z");
    expect(resolved("20260405T014500", "Australia/Lord_Howe")).toBe("2026-04-04T14:45:00Z");
    expect(resolved("20261004T021500", "Australia/Lord_Howe")).toBe("2026-10-03T15:45:00Z");
    // Samoa's missing 30 December 2011, and the days either side of it.
    expect(resolved("20111229T233000", "Pacific/Apia")).toBe("2011-12-30T09:30:00Z");
    expect(resolved("20111230T100000", "Pacific/Apia")).toBe("2011-12-30T20:00:00Z");
    expect(resolved("20111231T003000", "Pacific/Apia")).toBe("2011-12-30T10:30:00Z");
  });

  it("shows the clock of a zone at an instant", () => {
    expect(wallIn(at("2026-11-20T23:30:00Z"), "America/Los_Angeles", platform)).toEqual(wall(2026, 11, 20, 15, 30));
    expect(wallIn(at("2026-11-20T23:30:00Z"), "Pacific/Kiritimati", platform)).toEqual(wall(2026, 11, 21, 13, 30));
    expect(wallIn(at("2026-11-20T23:30:00Z"), "Nowhere/At_All", platform)).toBeNull();
  });

  it("never guesses a zone it is not told", () => {
    expect(resolved("20261126T140000", "Middle Earth Standard Time")).toBeNull();
    expect(resolved("20261126T140000", "x".repeat(200))).toBeNull();
    expect(resolved("20261126T140000", "Europe/Zurich", nobody)).toBeNull();
    expect(instantOf(zoned(w("20261126T140000"), "Middle Earth Standard Time"), platform)).toBeNull();
    expect(instantOf(instant(5), nobody)).toEqual(instant(5));
    expect(instantOfFloating(floating(w("20261205T100000")), "Nowhere/At_All", platform)).toBeNull();
  });

  it("asks the platform once about a name, known or not", () => {
    // A zone only its file defines is asked of the platform first, at every lookup: the platform's "no" is remembered like its "yes".
    const Platform = Intl.DateTimeFormat;
    let made = 0;
    class Counted extends Platform {
      constructor(...given: ConstructorParameters<typeof Platform>) {
        made++;
        super(...given);
      }
    }
    Intl.DateTimeFormat = Counted as typeof Platform;
    try {
      const zones = intlZones();
      for (let n = 0; n < 500; n++) expect(zones.offsetAt("Studio Time", at("2026-10-03T04:15:00Z") + n * 1000)).toBeNull();
      expect(made).toBe(1);
      for (let n = 0; n < 500; n++) expect(zones.offsetAt("Europe/Zurich", at("2026-10-03T04:15:00Z") + n * 1000)).toBe(7_200_000);
      expect(made).toBe(2);
      // More unknown names than are remembered: still answered, and still no guess.
      for (let n = 0; n < 600; n++) expect(zones.offsetAt(`Nowhere/Place_${n}`, 0)).toBeNull();
      expect(zones.offsetAt("Studio Time", 0)).toBeNull();
    } finally {
      Intl.DateTimeFormat = Platform;
    }
  });

  /*
   * WHAT A PLATFORM SOURCE REMEMBERS HAS A CEILING AND ONE SPELLING. It kept a formatter for every
   * spelling of a zone's name it was ever asked for, and the platform takes a name in any letter case:
   * 30,000 events naming one zone in 30,000 cases left 830 MiB outside the heap for as long as the
   * source lived. A formatter is kept under the name in one case. A formatter that is let go is not
   * given back at once either (the engine does not count what it weighs), so the ceiling,
   * `PLATFORM_ZONES_HELD`, is above the number of names the platform has and a zone's formatter is
   * made once; the bare offsets the platform also takes for zones, thousands of them, are not asked.
   * The names the platform does not know have a memory and a ceiling of their own. The platform's
   * formatters are counted as they are made.
   */
  const counted = <T,>(run: (made: () => number) => T): T => {
    const Platform = Intl.DateTimeFormat;
    let made = 0;
    class Counted extends Platform {
      constructor(...given: ConstructorParameters<typeof Platform>) {
        made++;
        super(...given);
      }
    }
    Intl.DateTimeFormat = Counted as typeof Platform;
    try {
      return run(() => made);
    } finally {
      Intl.DateTimeFormat = Platform;
    }
  };
  const winter = at("2026-01-15T12:00:00Z");

  it("keeps one formatter for a zone, in whatever letter case it is named", () => {
    /** The n-th spelling of a name: its letters in upper or lower case by the bits of n. */
    const spelled = (name: string, n: number): string => {
      let bits = n;
      return [...name].map((ch) => {
        if (!/[a-z]/i.test(ch)) return ch;
        const upper = (bits & 1) === 1;
        bits >>= 1;
        return upper ? ch.toUpperCase() : ch.toLowerCase();
      }).join("");
    };
    counted((made) => {
      const zones = intlZones();
      const answers = new Set<number | null>();
      for (let n = 0; n < 3000; n++) answers.add(zones.offsetAt(spelled("America/Argentina/ComodRivadavia", n), winter));
      expect([...answers]).toEqual([-3 * 3_600_000]);
      expect(made()).toBe(1);
      // Behind a vendor's prefix it is the same zone; and a Windows name is the zone it means, already held under that one's name.
      for (let n = 0; n < 100; n++) expect(zones.offsetAt(`/mozilla.org/20050126_1/${spelled("America/Argentina/ComodRivadavia", n)}`, winter)).toBe(-3 * 3_600_000);
      expect(made()).toBe(1);
      expect([zones.offsetAt("W. Europe Standard Time", winter), zones.offsetAt("europe/BERLIN", winter), made()]).toEqual([3_600_000, 3_600_000, 2]);
    });
  });

  it("makes a formatter for a zone once and keeps it, for every zone the platform has, and asks about no bare offset", () => {
    const names = Intl.supportedValuesOf("timeZone");
    counted((made) => {
      const zones = intlZones();
      // Every zone of the platform's own list, three times round: each is made once.
      for (let round = 0; round < 3; round++) for (const name of names) expect(zones.offsetAt(name, winter)).not.toBeNull();
      expect([names.length > 400, names.length < PLATFORM_ZONES_HELD, made()]).toEqual([true, true, names.length]);
      // A bare offset is a zone to the platform and to no calendar; a name in brackets is Exchange's own for a zone, and the platform's for none.
      const before = made();
      expect(["+01:00", "-05:30", "+0100", "(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna"].map((name) => zones.offsetAt(name, winter))).toEqual([null, null, null, null]);
      expect([made() - before, platformZoneName("+01:00"), platformZoneName("Etc/GMT+1"), platformZoneName("UTC+12")]).toEqual([0, null, "Etc/GMT+1", "Etc/GMT-12"]);
    });
  });

  it("holds no more formatters than its ceiling, and lets go of the one used longest ago", () => {
    // A platform that takes every name for a zone an hour ahead of UTC: the real one has fewer zones than a source holds formatters for.
    const Platform = Intl.DateTimeFormat;
    const utc = new Platform("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    let made = 0;
    class Any {
      constructor() {
        made++;
      }
      formatToParts(ms: number): Intl.DateTimeFormatPart[] {
        return utc.formatToParts(ms + 3_600_000);
      }
    }
    Intl.DateTimeFormat = Any as unknown as typeof Platform;
    try {
      const zones = intlZones();
      const ask = (n: number): number => {
        const before = made;
        expect(zones.offsetAt(`Made/Zone_${n}`, winter)).toBe(3_600_000);
        return made - before;
      };
      const all = Array.from({ length: PLATFORM_ZONES_HELD }, (_, n) => n);
      // As many zones as it holds: each made once, and none again however often they are all asked.
      expect(all.map(ask).every((n) => n === 1)).toBe(true);
      for (let round = 0; round < 3; round++) expect(all.map(ask).every((n) => n === 0)).toBe(true);
      // The first is used again, then one more zone than it holds arrives: the second, now the one used longest ago, goes.
      expect([ask(0), ask(PLATFORM_ZONES_HELD), ask(0), ask(1)]).toEqual([0, 1, 0, 1]);
    } finally {
      Intl.DateTimeFormat = Platform;
    }
  });

  it("remembers no more unknown names than its ceiling, the one asked longest ago going first", () => {
    counted((made) => {
      const zones = intlZones();
      const ask = (name: string): number => {
        const before = made();
        expect(zones.offsetAt(name, winter)).toBeNull();
        return made() - before;
      };
      const names = Array.from({ length: UNKNOWN_ZONE_NAMES_HELD + 1 }, (_, n) => `Nowhere/Place_${n}`);
      expect(names.slice(0, UNKNOWN_ZONE_NAMES_HELD).map(ask).every((n) => n === 1)).toBe(true);
      expect(names.slice(0, UNKNOWN_ZONE_NAMES_HELD).map(ask).every((n) => n === 0)).toBe(true);
      expect([ask(names[0]!), ask(names[UNKNOWN_ZONE_NAMES_HELD]!), ask(names[0]!), ask(names[1]!)]).toEqual([0, 1, 0, 1]);
      // A flood of names nobody knows takes no zone that is known out of the memory.
      expect(zones.offsetAt("Europe/Zurich", winter)).toBe(3_600_000);
      const before = made();
      for (let n = 0; n < 3 * UNKNOWN_ZONE_NAMES_HELD; n++) zones.offsetAt(`Elsewhere/Place_${n}`, winter);
      expect(made() - before).toBe(3 * UNKNOWN_ZONE_NAMES_HELD);
      expect([zones.offsetAt("Europe/Zurich", winter), made() - before]).toEqual([3_600_000, 3 * UNKNOWN_ZONE_NAMES_HELD]);
    });
  });

  it("asks nobody about a name longer than a zone's name may be, and takes no word of the language for a Windows name", () => {
    const [full, over] = [`Nowhere/${"z".repeat(MAX_ZONE_NAME_CHARS - 8)}`, `Nowhere/${"z".repeat(MAX_ZONE_NAME_CHARS - 7)}`];
    counted((made) => {
      const zones = intlZones();
      expect([zones.offsetAt(over, winter), zones.offsetAt(`/mozilla.org/x/${"Europe/Zurich".padEnd(MAX_ZONE_NAME_CHARS, "z")}`, winter), platformZoneName(over), made()]).toEqual([null, null, null, 0]);
      // A real zone behind a vendor's prefix that makes the name too long is not looked for behind it.
      const behind = `/mozilla.org/${"1".repeat(MAX_ZONE_NAME_CHARS)}/Europe/Zurich`;
      expect([zones.offsetAt(behind, winter), platformZoneName(behind), made()]).toEqual([null, null, 0]);
      expect(zones.offsetAt(`/mozilla.org/${"1".repeat(MAX_ZONE_NAME_CHARS - 27)}/Europe/Zurich`, winter)).toBe(3_600_000);
      expect([zones.offsetAt(full, winter), platformZoneName("Europe/Zurich".padEnd(MAX_ZONE_NAME_CHARS, "z"))]).toEqual([null, null]);
    });
    // A file's source does not know such a name either, though a definition handed to it carries it.
    const always = (tzid: string): ZoneDefinition => ({ tzid, observances: [{ start: w("19700101T000000"), offsetFrom: 3600, offsetTo: 3600, rule: null, extra: [], daylight: false, name: null }] });
    const file = fileZones([always(over), always(full)]);
    expect([file.offsetAt(over, winter), file.offsetAt(full, winter)]).toEqual([null, 3_600_000]);
    // The table of Windows names is asked for its own rows only.
    for (const word of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(platformZoneName(word)).toBe(word);
      expect(platform.offsetAt(word, winter)).toBeNull();
    }
    expect([platformZoneName("__proto__"), platform.offsetAt("__proto__", winter)]).toEqual([null, null]);
  });

  it("reads a Windows name and a vendor's prefix as the zone they mean", () => {
    expect(resolved("20261126T140000", "W. Europe Standard Time")).toBe("2026-11-26T13:00:00Z");
    expect(resolved("20261204T183000", "/freeassociation.sourceforge.net/Europe/Berlin")).toBe("2026-12-04T17:30:00Z");
    expect(resolved("20261204T183000", "/mozilla.org/20050126_1/Europe/Berlin")).toBe("2026-12-04T17:30:00Z");
    expect(platformZoneName("Eastern Standard Time")).toBe("America/New_York");
    expect(platformZoneName("Europe/Zurich")).toBe("Europe/Zurich");
    expect(Object.keys(WINDOWS_ZONES).length).toBe(132);
  });

  it("reads a zoneless time on the viewer's own clock", () => {
    // 10:00 with no zone on 5 December 2026: 09:00 UTC for a viewer in Zurich, 18:00 UTC for one in Los Angeles.
    const course = floating(w("20261205T100000"));
    expect(iso(instantOfFloating(course, "Europe/Zurich", platform)!.epochMs)).toBe("2026-12-05T09:00:00Z");
    expect(iso(instantOfFloating(course, "America/Los_Angeles", platform)!.epochMs)).toBe("2026-12-05T18:00:00Z");
  });
});

describe("the day a person sees", () => {
  const market = plainDate(2026, 11, 21);
  const firing = zoned(w("20261121T003000"), "Europe/Zurich");
  const day = (s: string) => plainDate(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));

  it.each(Object.entries(whole_day_west.days))("in %s", (viewer, expected) => {
    expect(localDay(market, viewer, platform)).toEqual(day(expected.market));
    expect(localDay(firing, viewer, platform)).toEqual(day(expected.firing));
  });

  it("is the written day for a date and for a zoneless time, whoever looks and whatever is known", () => {
    expect(localDay(market, "Nowhere/At_All", nobody)).toEqual(market);
    expect(localDay(floating(w("20261205T233000")), "Pacific/Kiritimati", nobody)).toEqual(plainDate(2026, 12, 5));
  });

  it("is not said when the time's zone or the viewer's is unknown", () => {
    expect(localDay(zoned(w("20261121T003000"), "Studio Time"), "Europe/Zurich", platform)).toBeNull();
    expect(localDay(firing, "Nowhere/At_All", platform)).toBeNull();
  });
});

describe("a zone the file defines", () => {
  // "Studio Time", as corpus/nasty.ts defines it: UTC+5:45, and UTC+6:45 from the first Sunday of October to the first Sunday of March.
  const rule = (text: string) => parseRRule(text)!;
  const studio: ZoneDefinition = {
    tzid: "Studio Time",
    observances: [
      { start: w("20200301T030000"), offsetFrom: 24_300, offsetTo: 20_700, rule: rule("FREQ=YEARLY;BYMONTH=3;BYDAY=1SU"), extra: [], daylight: false, name: "STD" },
      { start: w("20201004T020000"), offsetFrom: 20_700, offsetTo: 24_300, rule: rule("FREQ=YEARLY;BYMONTH=10;BYDAY=1SU"), extra: [], daylight: true, name: "DST" },
    ],
  };
  const file = fileZones([studio]);

  it("takes its offsets from the definition's own onsets", () => {
    for (const [instantText, minutesAfter] of file_zone.changes) {
      expect(file.offsetAt("Studio Time", at(instantText))).toBe(minutesAfter * 60_000);
      expect(file.offsetAt("Studio Time", at(instantText) - 1000)).toBe((minutesAfter === 405 ? 345 : 405) * 60_000);
    }
    expect(resolved("20261003T100000", "Studio Time", file)).toBe(file_zone.starts[0]);
    expect(resolved("20261004T100000", "Studio Time", file)).toBe(file_zone.starts[1]);
    expect(resolved(file_zone.gap.wall, "Studio Time", file)).toBe(file_zone.gap.expect);
    expect(resolved(file_zone.twice.wall, "Studio Time", file)).toBe(file_zone.twice.expect);
    expect(resolved(file_zone.before.wall, "Studio Time", file)).toBe(file_zone.before.expect);
  });

  it("knows only the names it defines, letter for letter", () => {
    expect(file.offsetAt("Europe/Zurich", 0)).toBeNull();
    expect(file.offsetAt("studio time", 0)).toBeNull();
    expect(fileZones([]).offsetAt("Studio Time", 0)).toBeNull();
    expect(fileZones([{ tzid: "Empty", observances: [] }]).offsetAt("Empty", 0)).toBeNull();
  });

  it("asks the sources in the order given", () => {
    // A file that defines "Europe/Zurich" its own way (always UTC+5:45) wins or loses by its place in the list.
    const odd = fileZones([{ tzid: "Europe/Zurich", observances: [{ start: w("19700101T000000"), offsetFrom: 20_700, offsetTo: 20_700, rule: null, extra: [], daylight: false, name: null }] }]);
    expect(resolved("20261126T140000", "Europe/Zurich", firstOf(odd, platform))).toBe("2026-11-26T08:15:00Z");
    expect(resolved("20261126T140000", "Europe/Zurich", firstOf(platform, odd))).toBe("2026-11-26T13:00:00Z");
    expect(resolved("20261003T100000", "Studio Time", firstOf(platform, file))).toBe(file_zone.starts[0]);
    expect(resolved("20261003T100000", "Studio Time", firstOf(platform))).toBeNull();
  });

  /*
   * A zone that changes every day: block n begins at midnight of 1 January 2020 plus n days, on the
   * clock in force before it, and goes from UTC+1 to UTC+2 when n is even and back when n is odd.
   * At noon UTC of day n the latest onset is block n's: UTC+2 for an even day, UTC+1 for an odd one.
   * Before the first block the zone has what that block comes from: UTC+1.
   */
  const daily = (n: number): Observance => ({ start: wallFromSeconds((daysFromCivil(2020, 1, 1) + n) * 86_400), offsetFrom: n % 2 === 0 ? 3600 : 7200, offsetTo: n % 2 === 0 ? 7200 : 3600, rule: null, extra: [], daylight: n % 2 === 0, name: null });
  const noonOf = (n: number): number => at("2020-01-01T12:00:00Z") + n * 86_400_000;

  it("finds the latest of two thousand onsets, and knows no zone in a definition that holds more", () => {
    const full = fileZones([{ tzid: "Daily", observances: Array.from({ length: MAX_ZONE_ONSETS }, (_, n) => daily(n)) }]);
    expect([0, 1, 2, 777, 1998, 1999, 5000].map((n) => full.offsetAt("Daily", noonOf(n)))).toEqual([7_200_000, 3_600_000, 7_200_000, 3_600_000, 7_200_000, 3_600_000, 3_600_000]);
    expect(full.offsetAt("Daily", noonOf(-1))).toBe(3_600_000);
    // The onset itself: block 4 begins at midnight on the UTC+1 clock, 23:00 UTC the evening before.
    expect([full.offsetAt("Daily", at("2020-01-04T22:59:59Z")), full.offsetAt("Daily", at("2020-01-04T23:00:00Z"))]).toEqual([3_600_000, 7_200_000]);
    const over = fileZones([{ tzid: "Daily", observances: Array.from({ length: MAX_ZONE_ONSETS + 1 }, (_, n) => daily(n)) }]);
    expect(over.offsetAt("Daily", noonOf(3))).toBeNull();
    // The dates a block lists count as its own start does.
    const listing = (dates: number): ZoneSource => fileZones([{ tzid: "Listed", observances: [{ ...daily(0), extra: Array.from({ length: dates }, (_, n) => daily(n + 1).start) }] }]);
    expect(listing(MAX_ZONE_ONSETS - 1).offsetAt("Listed", noonOf(3))).toBe(7_200_000);
    expect(listing(MAX_ZONE_ONSETS).offsetAt("Listed", noonOf(3))).toBeNull();
    // A rule that ends, and whose onsets alone are more than a definition may hold: daily for twenty years.
    const endless = fileZones([{ tzid: "Rule", observances: [{ ...daily(0), rule: rule("FREQ=DAILY;UNTIL=20400101T000000Z") }] }]);
    expect(endless.offsetAt("Rule", noonOf(3))).toBeNull();
  });

  it("reads a definition once: a lookup costs the same however many blocks it has", () => {
    let reads = 0;
    const watched = <T extends object>(o: T): T => new Proxy(o, { get: (target, key, receiver) => (reads++, Reflect.get(target, key, receiver)) });
    const blocks = [...Array.from({ length: 1500 }, (_, n) => daily(n)), ...studio.observances].map(watched);
    const file = fileZones([{ tzid: "Busy", observances: blocks }]);
    expect(file.offsetAt("Busy", noonOf(10))).toBe(7_200_000);
    const once = reads;
    expect(once).toBeGreaterThan(0);
    // A thousand more lookups over nine years, through the listed onsets and the two yearly rules: the definition is not read again.
    for (let n = 0; n < 1000; n++) file.offsetAt("Busy", noonOf(n * 3));
    expect(reads).toBe(once);
    // The rules are still followed: "Studio Time" changes on the first Sunday of October 2026 and of March 2027.
    for (const [instantText, minutesAfter] of file_zone.changes) expect(file.offsetAt("Busy", at(instantText))).toBe(minutesAfter * 60_000);
  });

  it("reads onsets given as a list and a rule that has ended", () => {
    // UTC+1 until 1 June 2021 02:00, UTC+2 for that summer only (to 1 September 03:00), by two listed onsets and no rule.
    const listed = fileZones([{
      tzid: "One Summer",
      observances: [
        { start: w("20210601T020000"), offsetFrom: 3600, offsetTo: 7200, rule: null, extra: [], daylight: true, name: null },
        { start: w("20210901T030000"), offsetFrom: 7200, offsetTo: 3600, rule: null, extra: [w("20220901T030000")], daylight: false, name: null },
      ],
    }]);
    expect(listed.offsetAt("One Summer", at("2021-05-01T00:00:00Z"))).toBe(3_600_000);
    expect(listed.offsetAt("One Summer", at("2021-07-01T00:00:00Z"))).toBe(7_200_000);
    expect(listed.offsetAt("One Summer", at("2026-07-01T00:00:00Z"))).toBe(3_600_000);
    // A summer rule that ended with 1995 (UNTIL in UTC, as the standard asks): 2026 has no summer time left.
    const ended = fileZones([{
      tzid: "Ended",
      observances: [
        { start: w("19810329T020000"), offsetFrom: 3600, offsetTo: 7200, rule: rule("FREQ=YEARLY;UNTIL=19950326T010000Z;BYMONTH=3;BYDAY=-1SU"), extra: [], daylight: true, name: null },
        { start: w("19810927T030000"), offsetFrom: 7200, offsetTo: 3600, rule: rule("FREQ=YEARLY;UNTIL=19950924T010000Z;BYMONTH=9;BYDAY=-1SU"), extra: [], daylight: false, name: null },
      ],
    }]);
    expect(ended.offsetAt("Ended", at("1990-07-01T00:00:00Z"))).toBe(7_200_000);
    expect(ended.offsetAt("Ended", at("1995-07-01T00:00:00Z"))).toBe(7_200_000);
    expect(ended.offsetAt("Ended", at("2026-07-01T00:00:00Z"))).toBe(3_600_000);
  });

  /*
   * WHAT AN ANSWER COSTS, AND WHO PAYS. Reading a definition into its table and following its rules
   * around a year is work a stranger's file sets the size of. An asker that hands in the steps it has
   * left pays for that work out of them: a step for each onset laid out, and for each rule walked a
   * step for the rule, one for each member of its lists and the steps of its walk. When they do not
   * cover it the source takes what is left, answers `null`, says so on the count handed in and
   * remembers nothing, so the next asker with enough gets its answer.
   */
  it("takes what reading a definition costs from the steps of whoever asks", () => {
    // A thousand blocks, each its own start and a rule that ends after that start: the start laid out, the rule set up, the start handed back by its walk. Three steps a block.
    const blocks = Array.from({ length: 1000 }, (_, n) => ({ ...daily(n), rule: rule("FREQ=DAILY;COUNT=1") }));
    const busy = fileZones([{ tzid: "Busy", observances: blocks }]);
    const poor = { steps: 1500 };
    expect(busy.offsetAt("Busy", noonOf(10), poor)).toBeNull();
    expect(poor).toEqual({ steps: 0, unpaid: true });
    const rich = { steps: 5000 };
    expect(busy.offsetAt("Busy", noonOf(10), rich)).toBe(7_200_000);
    expect(rich).toEqual({ steps: 5000 - 3 * 1000 });
    // Read once: the next answer costs nothing, whoever asks and with whatever.
    expect(busy.offsetAt("Busy", noonOf(11), rich)).toBe(3_600_000);
    expect(busy.offsetAt("Busy", noonOf(12), { steps: 0 })).toBe(7_200_000);
    expect(rich.steps).toBe(2000);
    // A name the source does not define, and the platform's own answer, cost nothing.
    const untouched = { steps: 7 };
    expect([busy.offsetAt("Elsewhere", 0, untouched), platform.offsetAt("Europe/Zurich", at("2026-07-01T00:00:00Z"), untouched), untouched]).toEqual([null, 7_200_000, { steps: 7 }]);
  });

  it("takes what following a zone's rules costs, once for each year looked at", () => {
    const studioTime = (): ZoneSource => fileZones([studio]);
    const summer = at("2026-12-01T00:00:00Z");
    // The two blocks' own starts. Then each rule: itself and the two members of its lists (a month, a weekday), and its walk over 2025, 2026
    // and 2027, each year its month's 31 days asked and its one onset handed back.
    const table = 2;
    const look = 2 * (3 + 3 * (31 + 1));
    const left = { steps: 1000 };
    const zones = studioTime();
    expect(zones.offsetAt("Studio Time", summer, left)).toBe(405 * 60_000);
    expect(left).toEqual({ steps: 1000 - table - look });
    // The same year again is free; another year is another look.
    expect(zones.offsetAt("Studio Time", summer + 86_400_000, left)).toBe(405 * 60_000);
    expect(left.steps).toBe(1000 - table - look);
    expect(zones.offsetAt("Studio Time", at("2031-06-01T00:00:00Z"), left)).toBe(345 * 60_000);
    expect(left.steps).toBe(1000 - table - 2 * look);
    // Too few steps for a look: no answer, nothing remembered against the zone, and the next asker is answered.
    const poor = { steps: table + look - 1 };
    const fresh = studioTime();
    expect(fresh.offsetAt("Studio Time", summer, poor)).toBeNull();
    expect(poor).toEqual({ steps: 0, unpaid: true });
    expect(fresh.offsetAt("Studio Time", summer)).toBe(405 * 60_000);
    // Through `firstOf` the steps go to whichever source has to work.
    const both = { steps: 1000 };
    expect(firstOf(platform, studioTime()).offsetAt("Studio Time", summer, both)).toBe(405 * 60_000);
    expect(both.steps).toBe(1000 - table - look);
  });

  /*
   * WHAT A FILE'S SOURCE REMEMBERS HAS A CEILING TOO: the onsets it holds over every definition it
   * has read and every year it has looked at. Past it the zone asked longest ago is forgotten, and
   * reading it again is paid for again by whoever asks.
   */
  it("holds no more onsets than its ceiling over all the zones it has read, and forgets the zone asked longest ago", () => {
    const fit = ZONE_ONSETS_HELD / MAX_ZONE_ONSETS;
    const full = (k: number): ZoneDefinition => ({ tzid: `Full ${k}`, observances: Array.from({ length: MAX_ZONE_ONSETS }, (_, n) => daily(n)) });
    const file = fileZones(Array.from({ length: fit + 2 }, (_, k) => full(k)));
    /** What a question about zone k costs: the definition's 2,000 onsets when it has to be read, nothing when it is held. */
    const price = (k: number): number => {
      const left = { steps: 1_000_000 };
      expect(file.offsetAt(`Full ${k}`, noonOf(10), left)).toBe(7_200_000);
      return 1_000_000 - left.steps;
    };
    const all = Array.from({ length: fit }, (_, k) => k);
    expect(all.map(price)).toEqual(all.map(() => MAX_ZONE_ONSETS));
    for (let round = 0; round < 3; round++) expect(all.map(price)).toEqual(all.map(() => 0));
    // Zone 0 is asked again, then one more than fit arrives: zone 1, asked longest ago, is the one forgotten.
    expect([price(0), price(fit), price(0), price(2), price(1)]).toEqual([0, MAX_ZONE_ONSETS, 0, 0, MAX_ZONE_ONSETS]);
    // Small definitions do not push each other out: four hundred zones of two blocks are all held.
    const small = fileZones(Array.from({ length: 400 }, (_, k) => ({ tzid: `Small ${k}`, observances: [daily(0), daily(1)] })));
    const cost = (k: number): number => {
      const left = { steps: 1000 };
      small.offsetAt(`Small ${k}`, noonOf(10), left);
      return 1000 - left.steps;
    };
    const every = Array.from({ length: 400 }, (_, k) => k);
    expect([every.map(cost).every((n) => n === 2), every.map(cost).every((n) => n === 0)]).toEqual([true, true]);
  });

  it("knows no zone in a definition whose rule names more clock readings for a day than a rule may", () => {
    const all = (n: number): string => Array.from({ length: n }, (_, i) => i).join(",");
    // A rule with no end and one that ends, each with every second of the day in its lists.
    const open = fileZones([{ tzid: "Dense", observances: [{ ...daily(0), rule: rule(`FREQ=YEARLY;BYHOUR=${all(24)};BYMINUTE=${all(60)};BYSECOND=${all(60)}`) }] }]);
    const ending = fileZones([{ tzid: "Dense", observances: [{ ...daily(0), rule: rule(`FREQ=YEARLY;UNTIL=20300101T000000Z;BYHOUR=${all(24)};BYMINUTE=${all(60)};BYSECOND=${all(60)}`) }] }]);
    const left = { steps: 1000 };
    expect([open.offsetAt("Dense", noonOf(3), left), ending.offsetAt("Dense", noonOf(3), left)]).toEqual([null, null]);
    // What it cost to find out, for each: the block's own start laid out, the rule and the 144 members of its lists, and the start handed back by the walk that then stopped.
    expect(left).toEqual({ steps: 1000 - 2 * (1 + 145 + 1) });
  });
});

describe("adding a length of time", () => {
  const start = zoned(w("20260328T120000"), "Europe/Zurich");

  it.each(a_day_is_not_24_hours.cases)("$duration across the change of 29 March 2026", ({ duration, end }) => {
    const moved = addDuration(start, parseDuration(duration)!, platform);
    expect(moved?.kind).toBe("zoned");
    expect(iso(instantOf(moved as typeof start, platform)!.epochMs)).toBe(end);
  });

  it("adds the days first, by the clock, and then the hours as hours", () => {
    // A day and two hours from 01:30 on 28 March 2026: a day on is 01:30 on the 29th (CET, 00:30 UTC); two hours later the clocks
    // have gone forward and show 04:30 (02:30 UTC). Hours first would end at 03:30 by the clock, an hour early.
    const early = zoned(w("20260328T013000"), "Europe/Zurich");
    const moved = addDuration(early, parseDuration("+P1DT2H")!, platform);
    expect(moved).toEqual(zoned(w("20260329T043000"), "Europe/Zurich"));
    expect(iso(instantOf(moved as typeof early, platform)!.epochMs)).toBe("2026-03-29T02:30:00Z");
  });

  it("moves each kind in its own way", () => {
    expect(addDuration(plainDate(2026, 12, 31), parseDuration("+P1D")!, nobody)).toEqual(plainDate(2027, 1, 1));
    expect(addDuration(instant(at("2026-03-28T11:00:00Z")), parseDuration("+P1DT1H")!, nobody)).toEqual(instant(at("2026-03-29T12:00:00Z")));
    expect(addDuration(floating(w("20260328T120000")), parseDuration("PT24H")!, nobody)).toEqual(floating(w("20260329T120000")));
    expect(addDuration(start, parseDuration("-PT30M")!, platform)).toEqual(zoned(w("20260328T113000"), "Europe/Zurich"));
    // With no rules for the zone, the clock is all there is: twenty-four hours on is the same reading a day later.
    expect(addDuration(zoned(w("20260328T120000"), "Studio Time"), parseDuration("PT24H")!, platform)).toEqual(zoned(w("20260329T120000"), "Studio Time"));
    expect(addDuration(plainDate(9999, 12, 31), parseDuration("P999999999D")!, nobody)).toBeNull();
  });
});
