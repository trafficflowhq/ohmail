/**
 * Recurrence rules: read, written, and walked. The walk is held against RFC 5545's own examples
 * (corpus/rfc5545.ts: every list is the RFC's printed result) and against the corpus's hard cases.
 */
import { describe, expect, it } from "vitest";
import { walkRule } from "../src/recur/expand.js";
import { formatRRule, parseRRule, type RRule } from "../src/recur/rrule.js";
import { resolveWall } from "../src/time/arith.js";
import { wall, type Wall } from "../src/time/types.js";
import { intlZones } from "../src/time/zones.js";
import { RFC_RULE_CASES, type RuleCase } from "./corpus/rfc5545.js";
import { iso } from "./support.js";

const platform = intlZones();
const w = (compact: string): Wall => wall(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)), Number(compact.slice(6, 8)), Number(compact.slice(9, 11) || 0), Number(compact.slice(11, 13) || 0), Number(compact.slice(13, 15) || 0));
const hours = Array.from({ length: 24 }, (_, i) => i).join(",");
const sixty = Array.from({ length: 60 }, (_, i) => i).join(",");
const stamp = (x: Wall): string => `${x.year}-${String(x.month).padStart(2, "0")}-${String(x.day).padStart(2, "0")}T${String(x.hour).padStart(2, "0")}:${String(x.minute).padStart(2, "0")}:${String(x.second).padStart(2, "0")}`;

/** The first `n` clock readings of a rule, as `2026-01-31T12:00:00`. */
function walls(ruleText: string, start: string, n: number, options: { dateOnly?: boolean; from?: string; to?: string; maxSteps?: number } = {}): string[] {
  const walk = walkRule(parseRRule(ruleText)!, w(start), {
    dateOnly: options.dateOnly ?? false,
    maxSteps: options.maxSteps ?? 1_000_000,
    maxPerPeriod: 20_000,
    ...(options.from ? { from: w(options.from) } : {}),
    ...(options.to ? { to: w(options.to) } : {}),
  });
  const out: string[] = [];
  for (let x = walk.next(); x !== null && out.length < n; x = walk.next()) out.push(stamp(x));
  return out;
}

/** An RFC example walked in New York: each clock reading resolved, the rule's own end and the excluded start applied. */
function instantsOf(c: RuleCase, ruleText: string): string[] {
  const rule = parseRRule(ruleText)!;
  const walk = walkRule(rule, w(c.dtstart), { dateOnly: false, maxSteps: 1_000_000, maxPerPeriod: 20_000 });
  const excluded = c.exdate ? resolveWall(w(c.exdate), "America/New_York", platform) : null;
  const out: string[] = [];
  for (let x = walk.next(); x !== null; x = walk.next()) {
    const ms = resolveWall(x, "America/New_York", platform)!;
    if (rule.until?.kind === "instant" && ms > rule.until.epochMs) break;
    if (ms !== excluded) out.push(iso(ms));
    if (c.open && out.length === c.expect.length) break;
  }
  return out;
}

describe("RFC 5545 section 3.8.5.3, example by example", () => {
  for (const c of RFC_RULE_CASES) {
    for (const ruleText of c.rules) {
      it(`${c.title}: ${ruleText}`, () => {
        expect(instantsOf(c, ruleText)).toEqual(c.expect);
      });
    }
  }
});

describe("what a rule leaves unsaid, and what cannot be", () => {
  it("skips a day that does not exist and never moves it", () => {
    expect(walls("FREQ=MONTHLY", "20260131T120000", 4)).toEqual(["2026-01-31T12:00:00", "2026-03-31T12:00:00", "2026-05-31T12:00:00", "2026-07-31T12:00:00"]);
    expect(walls("FREQ=YEARLY", "20240229T120000", 3)).toEqual(["2024-02-29T12:00:00", "2028-02-29T12:00:00", "2032-02-29T12:00:00"]);
    expect(walls("FREQ=MONTHLY;BYMONTHDAY=-1", "20270131T080000", 3)).toEqual(["2027-01-31T08:00:00", "2027-02-28T08:00:00", "2027-03-31T08:00:00"]);
    expect(walls("FREQ=YEARLY;BYYEARDAY=-1", "20261231T230000", 3)).toEqual(["2026-12-31T23:00:00", "2027-12-31T23:00:00", "2028-12-31T23:00:00"]);
    expect(walls("FREQ=YEARLY;BYYEARDAY=366", "20240101T000000", 3)).toEqual(["2024-01-01T00:00:00", "2024-12-31T00:00:00", "2028-12-31T00:00:00"]);
  });

  it("counts the start as the first instance even when the rule would not name it", () => {
    // 2 September 1997 is a Tuesday; the rule names Fridays.
    expect(walls("FREQ=WEEKLY;BYDAY=FR;COUNT=3", "19970902T090000", 9)).toEqual(["1997-09-02T09:00:00", "1997-09-05T09:00:00", "1997-09-12T09:00:00"]);
  });

  it("takes the weekday, the day and the month from the start", () => {
    // Week 20 with no weekday named: the start's Monday. A yearly rule with only a day of the month: that day in every month.
    expect(walls("FREQ=YEARLY;BYWEEKNO=20", "19970512T090000", 3)).toEqual(["1997-05-12T09:00:00", "1998-05-11T09:00:00", "1999-05-17T09:00:00"]);
    expect(walls("FREQ=YEARLY;BYMONTHDAY=15", "20260115T090000", 3)).toEqual(["2026-01-15T09:00:00", "2026-02-15T09:00:00", "2026-03-15T09:00:00"]);
    expect(walls("FREQ=MONTHLY;BYDAY=2TU", "20261110T190000", 4)).toEqual(["2026-11-10T19:00:00", "2026-12-08T19:00:00", "2027-01-12T19:00:00", "2027-02-09T19:00:00"]);
  });

  it("ignores the clock parts of a rule whose start is a date", () => {
    expect(walls("FREQ=DAILY;BYHOUR=9,17;COUNT=3", "20260105", 9, { dateOnly: true })).toEqual(["2026-01-05T00:00:00", "2026-01-06T00:00:00", "2026-01-07T00:00:00"]);
    expect(walls("FREQ=HOURLY;COUNT=5", "20260105", 9, { dateOnly: true })).toEqual(["2026-01-05T00:00:00"]);
  });

  it("starts where it is told to and finds what a walk from the start finds", () => {
    const all = walls("FREQ=MONTHLY;BYDAY=-1FR", "20260130T160000", 300);
    const late = walls("FREQ=MONTHLY;BYDAY=-1FR", "20260130T160000", 5, { from: "20400615T000000" });
    expect(late).toEqual(all.filter((x) => x >= "2040-06").slice(0, 5));
    expect(late[0]).toBe("2040-06-29T16:00:00");
    // Every other week, far ahead: the walk lands on a week of the rule, not on the week asked for.
    expect(walls("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "19970902T090000", 2, { from: "20261117T000000" })).toEqual(
      walls("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "19970902T090000", 2000).filter((x) => x >= "2026-11-10").slice(0, 2),
    );
    // A rule with a count is walked from its start whatever is asked: the count is of all of them.
    expect(walls("FREQ=DAILY;COUNT=3", "20260105T090000", 9, { from: "20260107T000000" })).toEqual(["2026-01-05T09:00:00", "2026-01-06T09:00:00", "2026-01-07T09:00:00"]);
  });

  it("ends by its count of steps when the rule never matches or never ends", () => {
    // The 30th of February, yearly: the start is one step, then February's days of each year, 28 or 29. After 2026 to 2042
    // (17 years, 4 of them leap) 1 + 17 x 28 + 4 = 481 are spent; 2043 makes 509, and the walk stops before 2044.
    const never = walkRule(parseRRule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30")!, w("20260101T090000"), { dateOnly: false, maxSteps: 500, maxPerPeriod: 20_000 });
    expect(never.next()).toEqual(w("20260101T090000"));
    expect(never.next()).toBeNull();
    expect([never.capped, never.steps]).toEqual([true, 509]);
    const everySecond = walkRule(parseRRule("FREQ=SECONDLY")!, w("20260101T000000"), { dateOnly: false, maxSteps: 1000, maxPerPeriod: 20_000 });
    let n = 0;
    while (everySecond.next() !== null) n++;
    // A thousand steps: the start is one, its own second asked again is one, and each later second is two (asked, handed back).
    expect(n).toBe(500);
    expect([everySecond.capped, everySecond.steps]).toEqual([true, 1000]);
    const done = walkRule(parseRRule("FREQ=DAILY;COUNT=2")!, w("20260101T000000"), { dateOnly: false, maxSteps: 1000, maxPerPeriod: 20_000 });
    while (done.next() !== null);
    // The start; its own day asked again; the next day asked and handed back.
    expect([done.capped, done.steps]).toEqual([false, 4]);
  });

  it("ends where it is told to, whether or not it found anything", () => {
    // The 30th of February to the end of 2030: five Februaries looked at (2026 to 2030, one of 29 days), nothing found, no ceiling met.
    const never = walkRule(parseRRule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30")!, w("20260101T090000"), { dateOnly: false, to: w("20301231T235959"), maxSteps: 1_000_000, maxPerPeriod: 20_000 });
    expect(never.next()).toEqual(w("20260101T090000"));
    expect(never.next()).toBeNull();
    expect([never.capped, never.steps]).toEqual([false, 1 + 4 * 28 + 29]);
    // A period that begins at the end is still looked at; the one after is not.
    expect(walls("FREQ=DAILY", "20260105T090000", 99, { to: "20260107T000000" })).toEqual(["2026-01-05T09:00:00", "2026-01-06T09:00:00", "2026-01-07T09:00:00"]);
    expect(walls("FREQ=MONTHLY;COUNT=5", "20260105T090000", 99, { to: "20260301T000000" })).toEqual(["2026-01-05T09:00:00", "2026-02-05T09:00:00", "2026-03-05T09:00:00"]);
  });

  it("asks a day once, however many parts the rule's lists have", () => {
    // Every weekday named 106 times over (every number a year allows, from both ends) costs a year its 365 days, as one name does.
    const numbers = Array.from({ length: 53 }, (_, i) => i + 1).flatMap((k) => [`${k}`, `-${k}`]);
    const everyDay = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].flatMap((d) => numbers.map((k) => `${k}${d}`)).join(",");
    const stepsOf = (ruleText: string): number => {
      const walk = walkRule(parseRRule(ruleText)!, w("20260101T090000"), { dateOnly: false, to: w("20261231T235959"), maxSteps: 1_000_000, maxPerPeriod: 20_000 });
      let found = 0;
      while (walk.next() !== null) found++;
      expect(found).toBe(365);
      return walk.steps;
    };
    // The start, the year's 365 days asked, and the 364 after the start handed back.
    expect(stepsOf(`FREQ=YEARLY;BYDAY=${everyDay}`)).toBe(1 + 365 + 364);
    expect(stepsOf("FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU")).toBe(1 + 365 + 364);
  });

  it("ends by its count when one period would hold more instances than anybody asked for", () => {
    // Every second of every day of a year is 31,536,000 instances in one period: refused by the count, never built.
    const dense = walkRule(parseRRule(`FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${hours};BYMINUTE=${sixty};BYSECOND=${sixty};BYSETPOS=-1`)!, w("20260101T000000"), { dateOnly: false, maxSteps: 100_000, maxPerPeriod: 20_000 });
    expect(dense.next()).toEqual(w("20260101T000000"));
    expect(dense.next()).toBeNull();
    expect(dense.capped).toBe(true);
    // The same shape within the count is walked: the last weekday of each month is one instance a month.
    expect(walls("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "20260130T090000", 3)).toEqual(["2026-01-30T09:00:00", "2026-02-27T09:00:00", "2026-03-31T09:00:00"]);
  });

  it("stops at the last year a calendar has", () => {
    expect(walls("FREQ=YEARLY", "99980101T000000", 9)).toEqual(["9998-01-01T00:00:00", "9999-01-01T00:00:00"]);
  });
});

describe("what a walk does is what it counts", () => {
  const options = { dateOnly: false, maxSteps: 1_000_000, maxPerPeriod: 20_000 };
  const thirteen = Array.from({ length: 13 }, (_, i) => i).join(",");
  const start = w("20260101T000000");

  it("does not walk a line whose lists name more clock readings for a day than the ceiling", () => {
    // Every minute of the day, written three ways: 1,440 readings a day by its lists, sixty, or none. All three are walked.
    const minutes = ["2026-01-01T00:00:00", "2026-01-01T00:01:00", "2026-01-01T00:02:00"];
    expect(walls(`FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${sixty}`, "20260101T000000", 3)).toEqual(minutes);
    expect(walls(`FREQ=HOURLY;BYMINUTE=${sixty}`, "20260101T000000", 3)).toEqual(minutes);
    expect(walls("FREQ=MINUTELY", "20260101T000000", 3)).toEqual(minutes);
    // Past it (3,600, 18,720 and 2,880 readings by the lists) the start is handed back, as it always is, and the line is left alone.
    const dense = [`FREQ=HOURLY;BYMINUTE=${sixty};BYSECOND=${sixty};BYSETPOS=1`, `FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${sixty};BYSECOND=${thirteen};BYSETPOS=1`, `FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${sixty};BYSECOND=0,30`];
    for (const text of dense) {
      const walk = walkRule(parseRRule(text)!, start, options);
      expect(walk.next()).toEqual(start);
      expect(walk.next()).toBeNull();
      expect([walk.capped, walk.stoppedBy, walk.steps], text).toEqual([true, "rule_too_dense", 1]);
    }
    // Asked from later than its start it hands back nothing and spends nothing.
    const late = walkRule(parseRRule(dense[0]!)!, start, { ...options, from: w("20260601T000000") });
    expect(late.next()).toBeNull();
    expect([late.capped, late.stoppedBy, late.steps]).toEqual([true, "rule_too_dense", 0]);
    // The ceiling is the asker's to lower, and a walk that met none names none.
    const twice = walkRule(parseRRule("FREQ=DAILY;BYHOUR=9,17;COUNT=4")!, w("20260101T090000"), { ...options, maxPerDay: 1 });
    expect([twice.next(), twice.next(), twice.stoppedBy]).toEqual([w("20260101T090000"), null, "rule_too_dense"]);
    const plain = walkRule(parseRRule("FREQ=DAILY;BYHOUR=9,17;COUNT=4")!, w("20260101T090000"), options);
    while (plain.next() !== null);
    expect([plain.capped, plain.stoppedBy]).toEqual([false, null]);
    // A start that is a date has no clock, so its rule's clock lists name nothing and it is walked.
    expect(walls(`FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${sixty};BYSECOND=${sixty}`, "20260101", 3, { dateOnly: true })).toEqual(["2026-01-01T00:00:00", "2026-01-02T00:00:00", "2026-01-03T00:00:00"]);
  });

  it("looks at a rule's lists once, whatever they multiply to and however far it walks", () => {
    let looked = 0;
    const watched = (list: readonly number[]): readonly number[] =>
      new Proxy(list, { get: (target, key, receiver) => (typeof key === "string" && /^\d+$/.test(key) && looked++, Reflect.get(target, key, receiver)) });
    const rule = (text: string): RRule => {
      const r = parseRRule(text)!;
      return { ...r, byHour: watched(r.byHour), byMinute: watched(r.byMinute), bySecond: watched(r.bySecond) };
    };
    // Twenty-four hours, sixty minutes and sixty seconds are 144 members of three lists and 86,400 readings: told by the lengths of the lists, and not one member looked at.
    const dense = walkRule(rule(`FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${sixty};BYSECOND=${sixty}`), start, options);
    while (dense.next() !== null);
    expect([dense.stoppedBy, looked]).toEqual(["rule_too_dense", 0]);
    // A line that is walked has each member looked at as it is set up, a few times each, and no reading made that is not handed back.
    const everyMinute = walkRule(rule(`FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${sixty}`), start, { ...options, to: w("20260101T235959") });
    let minutesFound = 0;
    while (everyMinute.next() !== null) minutesFound++;
    expect(minutesFound).toBe(1440);
    expect(looked).toBeGreaterThan(0);
    expect(looked).toBeLessThanOrEqual(4 * 84);
    // Sixty minutes and twenty-four seconds an hour, 1,440 readings and so within the ceiling: three hours of them are walked, and the lists are not looked at again.
    looked = 0;
    const hourly = walkRule(rule(`FREQ=HOURLY;BYMINUTE=${sixty};BYSECOND=${hours}`), start, { ...options, to: w("20260101T025959") });
    expect(hourly.next()).toEqual(start);
    const once = looked;
    let found = 1;
    while (hourly.next() !== null) found++;
    expect(found).toBe(3 * 1440);
    expect(looked).toBe(once);
    // The start; three hours asked; every reading but the start's own handed back.
    expect([hourly.capped, hourly.steps]).toEqual([false, 1 + 3 + (3 * 1440 - 1)]);
  });

  it("counts a step for every place BYSETPOS names in a period, whether or not the period has it", () => {
    // The fifth Monday of the month. January 2026 has four (5, 12, 19, 26) and so has February; March has five, the last on the 30th.
    const fifth = walkRule(parseRRule("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=5")!, w("20260105T090000"), { ...options, to: w("20260331T235959") });
    const found: string[] = [];
    for (let x = fifth.next(); x !== null; x = fifth.next()) found.push(stamp(x));
    expect(found).toEqual(["2026-01-05T09:00:00", "2026-03-30T09:00:00"]);
    // The start; then each month its days asked and the one place looked for, found or not.
    expect([fifth.capped, fifth.steps]).toEqual([false, 1 + (31 + 1) + (28 + 1) + (31 + 1)]);
    // Every place a year can have, counted from both ends, named for a daily rule: a day holds one reading and costs its question and the 732 places.
    const every = Array.from({ length: 366 }, (_, i) => `${i + 1},-${i + 1}`).join(",");
    const all = walkRule(parseRRule(`FREQ=DAILY;BYSETPOS=${every}`)!, w("20260101T090000"), { ...options, maxSteps: 10_000 });
    let n = 0;
    while (all.next() !== null) n++;
    // The start is one step. Thirteen days are 9,529 more, so a fourteenth is opened and paid for, and the fifteenth is not. The first of them is the start's own.
    expect([all.capped, all.stoppedBy, all.steps, n]).toEqual([true, "out_of_steps", 1 + 14 * 733, 14]);
  });

  it("finds the same instances as a walk that lays every period out", () => {
    // The places BYSETPOS names are worked out, never picked from a list: held here against the lists written out by hand.
    // The last two working days of each month and the first, from a start in the middle of one.
    expect(walls("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-2,-1", "20260115T090000", 7)).toEqual([
      "2026-01-15T09:00:00", "2026-01-29T09:00:00", "2026-01-30T09:00:00", "2026-02-02T09:00:00", "2026-02-26T09:00:00", "2026-02-27T09:00:00", "2026-03-02T09:00:00",
    ]);
    // Two clock readings a day on two days a week, the second and the last of each week's four.
    expect(walls("FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=9,17;BYSETPOS=2,-1", "20260106T090000", 5)).toEqual([
      "2026-01-06T09:00:00", "2026-01-06T17:00:00", "2026-01-08T17:00:00", "2026-01-13T17:00:00", "2026-01-15T17:00:00",
    ]);
    // Hours, minutes and seconds listed out of order and twice over come back in order and once.
    expect(walls("FREQ=DAILY;BYHOUR=17,9,17;BYMINUTE=30,0;BYSECOND=15,0", "20260101T090000", 9)).toEqual([
      "2026-01-01T09:00:00", "2026-01-01T09:00:15", "2026-01-01T09:30:00", "2026-01-01T09:30:15", "2026-01-01T17:00:00", "2026-01-01T17:00:15", "2026-01-01T17:30:00", "2026-01-01T17:30:15", "2026-01-02T09:00:00",
    ]);
    // A start in the middle of its own day's readings: the earlier ones are not instances.
    expect(walls("FREQ=DAILY;BYHOUR=6,9,12,18", "20260101T120000", 4)).toEqual(["2026-01-01T12:00:00", "2026-01-01T18:00:00", "2026-01-02T06:00:00", "2026-01-02T09:00:00"]);
    // The last second of each hour's listed minutes, and every twentieth minute's two seconds.
    expect(walls("FREQ=HOURLY;BYMINUTE=0,20,40;BYSECOND=0,30;BYSETPOS=-1", "20260101T000000", 3)).toEqual(["2026-01-01T00:00:00", "2026-01-01T00:40:30", "2026-01-01T01:40:30"]);
    expect(walls("FREQ=MINUTELY;INTERVAL=20;BYSECOND=30,0", "20260101T000000", 4)).toEqual(["2026-01-01T00:00:00", "2026-01-01T00:00:30", "2026-01-01T00:20:00", "2026-01-01T00:20:30"]);
  });
});

describe("a rule as text", () => {
  it("reads every part and writes it back in the standard's order", () => {
    const rule = parseRRule("freq=monthly;wkst=su;byday=-1FR,2tu;interval=2;bysetpos=-1;count=12")!;
    expect(rule).toMatchObject({ freq: "MONTHLY", interval: 2, count: 12, weekStart: "SU", bySetPos: [-1], byDay: [{ ordinal: -1, weekday: "FR" }, { ordinal: 2, weekday: "TU" }] });
    expect(formatRRule(rule)).toBe("FREQ=MONTHLY;INTERVAL=2;COUNT=12;BYDAY=-1FR,2TU;BYSETPOS=-1;WKST=SU");
    for (const text of ["FREQ=WEEKLY;UNTIL=20260427T215959Z;BYDAY=MO", "FREQ=DAILY;UNTIL=20260108", "FREQ=YEARLY;BYWEEKNO=1,-1;BYMONTH=1,12", "FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10", "FREQ=DAILY;UNTIL=20260107T090000"]) {
      expect(formatRRule(parseRRule(text)!)).toBe(text);
    }
    expect(parseRRule("FREQ=WEEKLY;")?.freq).toBe("WEEKLY");
    expect(parseRRule(`FREQ=WEEKLY;BYDAY=${"MO,".repeat(5000)}TU`)?.byDay).toEqual([{ ordinal: 0, weekday: "MO" }, { ordinal: 0, weekday: "TU" }]);
    expect(parseRRule("RSCALE=GREGORIAN;FREQ=YEARLY;SKIP=OMIT")?.freq).toBe("YEARLY");
  });

  it("refuses a rule it cannot follow exactly", () => {
    for (const text of [
      "", "FREQ=FORTNIGHTLY", "INTERVAL=2", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;COUNT=many", "FREQ=DAILY;FREQ=WEEKLY", "FREQ=DAILY;X-NEW=1",
      "FREQ=WEEKLY;BYDAY=2TU", "FREQ=YEARLY;BYWEEKNO=20;BYDAY=1MO", "FREQ=MONTHLY;BYDAY=0MO", "FREQ=MONTHLY;BYMONTHDAY=0", "FREQ=MONTHLY;BYMONTHDAY=32",
      "FREQ=YEARLY;BYMONTH=13", "FREQ=DAILY;BYHOUR=24", "FREQ=DAILY;UNTIL=tomorrow", "FREQ=DAILY;WKST=XX", "FREQ=YEARLY;RSCALE=CHINESE", "FREQ=DAILY;BYDAY=",
      // "The UNTIL or COUNT rule parts are OPTIONAL, but they MUST NOT occur in the same 'recur'" (RFC 5545 section 3.3.10).
      "FREQ=DAILY;COUNT=5;UNTIL=20260110T090000Z", "FREQ=DAILY;UNTIL=20260110;COUNT=5",
    ]) {
      expect(parseRRule(text), text).toBeNull();
    }
  });
});
