/**
 * The calendar object: read and written without loss, edited one line at a time, refused by word
 * past a ceiling, and read into typed values that say what each writer meant.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { calendarInfo, newCalendar, readCalendar, readCalendars, withEvent, withNewEvent, writeCalendar, zonesOf, type CalObject } from "../src/ical/calendar.js";
import { writeComponent, type Component, type Property } from "../src/ical/component.js";
import { eventOf, newEventComponent, withPartstat, withSequence, withStatus, withText, withTimes } from "../src/ical/event.js";
import { makeParam, unfold } from "../src/ical/lines.js";
import { parseDuration } from "../src/ical/values.js";
import { vtimezoneFrom, zoneDefinitionOf } from "../src/ical/vtimezone.js";
import {
  DEFAULT_LIMITS, MAX_CALENDAR_TEXT_CHARS, MAX_COMPONENTS, MAX_CONTENT_LINES, MAX_NAME_CHARS, MAX_PARAMS_PER_LINE, MAX_PARAM_VALUE_CHARS, MAX_TEXT_PARTS, MAX_UID_CHARS, MAX_ZONE_NAME_CHARS, MAX_ZONE_ONSETS,
} from "../src/limits.js";
import { parseRRule } from "../src/recur/rrule.js";
import { expandSeries, seriesOf } from "../src/recur/series.js";
import { instantOf } from "../src/time/arith.js";
import { instant, plainDate, wall, zoned } from "../src/time/types.js";
import { fileZones, intlZones } from "../src/time/zones.js";
import { BENCH, icloud_wheel_class, radicale_wheel_class } from "./corpus/bench.js";
import { CORPUS } from "./corpus/index.js";
import { apple_event, evolution_event, exchange_request, feed_rfc7986, google_export, google_holidays, PROVIDERS, thunderbird_event } from "./corpus/providers.js";
import type { Fixture } from "./corpus/types.js";
import { at, iso, text, textOf } from "./support.js";

const platform = intlZones();
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(source: Fixture | string): CalObject {
  const result = readCalendar(typeof source === "string" ? source : text(source), DEFAULT_LIMITS);
  if (!result.ok) throw new Error(`not read: ${result.reason}`);
  return result.calendar;
}
const refusal = (source: string, limits = DEFAULT_LIMITS): string => {
  const result = readCalendar(source, limits);
  return result.ok ? "read" : result.reason;
};
const write = (calendar: CalObject): string => textOf(writeCalendar(calendar));
/** The logical lines two texts differ in, as [was, is] pairs by position. */
const changed = (before: string, after: string): [string | undefined, string | undefined][] => {
  const [a, b] = [unfold(before), unfold(after)];
  const out: [string | undefined, string | undefined][] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push([a[i], b[i]]);
  return out;
};

describe("reading and writing lose nothing", () => {
  it.each(CORPUS.map((f) => [f.name, f] as const))("%s comes back the same tree and the same lines", (_name, fixture) => {
    const original = text(fixture);
    const calendar = read(original);
    const written = write(calendar);
    expect(read(written).tree).toEqual(calendar.tree);
    expect(unfold(written)).toEqual(unfold(original));
    for (const physical of written.split("\r\n")) expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75);
    // The same text with bare LF line ends is the same calendar.
    expect(read(original.replace(/\r\n/g, "\n")).tree).toEqual(calendar.tree);
  });

  it.each(BENCH.map((f) => [f.name, f] as const))("%s, as a server stored it, comes back byte for byte", (_name, fixture) => {
    expect(write(read(fixture))).toBe(text(fixture));
  });

  it("keeps what it has no word for, where it was", () => {
    const apple = write(read(apple_event));
    expect(unfold(apple)).toContain('X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=70.58;X-APPLE-REFERENCEFRAME=1;X-TITLE="Winter market\\nHafenhalle, Uferweg 3":geo:47.000000,8.000000');
    expect(unfold(apple).filter((l) => l === "BEGIN:VALARM").length).toBe(2);
    const exchange = unfold(write(read(exchange_request)));
    expect(exchange.filter((l) => l.startsWith("X-MICROSOFT-")).length).toBe(9);
    expect(unfold(write(read(google_export)))).toContain("X-GOOGLE-CONFERENCE:https://meet.atelier.example/kiln-schedule");
    // iCloud's own zone definition stays after the events, where iCloud put it.
    const icloud = read(icloud_wheel_class);
    expect(icloud.tree.components.map((c) => c.name)).toEqual(["VEVENT", "VEVENT", "VTIMEZONE"]);
    expect(unfold(write(icloud))).toContain("X-LIC-LOCATION:Europe/Zurich");
    expect(read(radicale_wheel_class).tree.components.map((c) => c.name)).toEqual(["VTIMEZONE", "VEVENT", "VEVENT"]);
  });

  it("reads every calendar of a stream, and will not pick one of several unasked", () => {
    const two = text(google_holidays) + text(feed_rfc7986);
    const result = readCalendars(two, DEFAULT_LIMITS);
    expect(result.ok && result.calendars.map((c) => c.events.length)).toEqual([3, 2]);
    expect(refusal(two)).toBe("several_calendars");
  });
});

describe("an edit changes one line", () => {
  it("renames the changed day of a series and leaves the rest as the server wrote it", () => {
    const calendar = read(icloud_wheel_class);
    const moved = calendar.events[1]!;
    const edited = withEvent(calendar, moved, withText(moved, "SUMMARY", "Wheel class; glazing, part 2"));
    expect(changed(text(icloud_wheel_class), write(edited))).toEqual([["SUMMARY:Wheel class", "SUMMARY:Wheel class\\; glazing\\, part 2"]]);
    expect(edited.events[1]!.summary).toBe("Wheel class; glazing, part 2");
    expect(edited.events[0]!.component).toBe(calendar.events[0]!.component);
  });

  it("sets one invitee's answer", () => {
    const calendar = read(google_export);
    const series = calendar.events[0]!;
    const edited = withEvent(calendar, series, withPartstat(series, "Giulia.Ferrari@lichtgrat.example", "ACCEPTED")!);
    const lines = changed(text(google_export), write(edited));
    expect(lines.length).toBe(1);
    expect(lines[0]![0]).toContain("PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=giulia.ferrari@lichtgrat.example");
    expect(lines[0]![1]).toBe(lines[0]![0]!.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED"));
    expect(withPartstat(series, "nobody@atelier.example", "ACCEPTED")).toBeNull();
  });

  it("moves an event and keeps the form its times were written in", () => {
    const calendar = read(exchange_request);
    const event = calendar.events[0]!;
    const zone = "W. Europe Standard Time";
    const later = withTimes(event, zoned(wall(2026, 11, 27, 9, 30), zone), zoned(wall(2026, 11, 27, 10, 30), zone));
    expect(changed(text(exchange_request), write(withEvent(calendar, event, later)))).toEqual([
      ["DTSTART;TZID=W. Europe Standard Time:20261126T140000", "DTSTART;TZID=W. Europe Standard Time:20261127T093000"],
      ["DTEND;TZID=W. Europe Standard Time:20261126T150000", "DTEND;TZID=W. Europe Standard Time:20261127T103000"],
    ]);
    const bumped = withStatus(withSequence(event, 1), "CANCELLED");
    expect(changed(text(exchange_request), write(withEvent(calendar, event, bumped)))).toEqual([["STATUS:CONFIRMED", "STATUS:CANCELLED"], ["SEQUENCE:0", "SEQUENCE:1"]]);
  });

  it("adds a line that was not there, and takes an event out", () => {
    const calendar = read(google_holidays);
    const first = calendar.events[0]!;
    const withPlace = withEvent(calendar, first, withText(first, "LOCATION", "Everywhere"));
    expect(unfold(write(withPlace)).length).toBe(unfold(text(google_holidays)).length + 1);
    expect(withEvent(calendar, first, null).events.map((e) => e.summary)).toEqual(["Christmas Day", "New Year's Day"]);
    expect(withEvent(calendar, withText(first, "SUMMARY", "not in this calendar"), null).events.length).toBe(3);
  });
});

describe("ceilings and refusals", () => {
  const event = "BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n";
  const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;

  it("refuses a text past each ceiling by its own word", () => {
    expect(refusal(wrap(event), { ...DEFAULT_LIMITS, maxTextChars: 40 })).toBe("too_large");
    expect(refusal(wrap(event.repeat(5)), { ...DEFAULT_LIMITS, maxComponents: 5 })).toBe("too_many_components");
    expect(refusal(wrap(event.repeat(4)), { ...DEFAULT_LIMITS, maxComponents: 5 })).toBe("read");
    expect(refusal(wrap("BEGIN:A\r\nBEGIN:B\r\nBEGIN:C\r\nEND:C\r\nEND:B\r\nEND:A\r\n"), { ...DEFAULT_LIMITS, maxDepth: 3 })).toBe("too_deep");
    expect(refusal(wrap("BEGIN:A\r\nBEGIN:B\r\nEND:B\r\nEND:A\r\n"), { ...DEFAULT_LIMITS, maxDepth: 3 })).toBe("read");
    expect(refusal(wrap(`X-LONG:${"a".repeat(100)}\r\n`), { ...DEFAULT_LIMITS, maxLineChars: 100 })).toBe("line_too_long");
    // Folded or not, it is the logical line that is measured.
    expect(refusal(wrap(`X-LONG:${"a".repeat(60)}\r\n ${"a".repeat(60)}\r\n`), { ...DEFAULT_LIMITS, maxLineChars: 100 })).toBe("line_too_long");
  });

  it("reads a feed of twenty thousand events and refuses one past the count of components", () => {
    const big = read(wrap(event.repeat(20_000)));
    expect(big.events.length).toBe(20_000);
    expect(refusal(wrap(event.repeat(MAX_COMPONENTS)))).toBe("too_many_components");
  });

  it("counts lines before it holds them, and a folded line once", () => {
    // The wrapper is three lines and an event three more.
    expect(refusal(wrap(event.repeat(2)), { ...DEFAULT_LIMITS, maxLines: 9 })).toBe("read");
    expect(refusal(wrap(event.repeat(2)), { ...DEFAULT_LIMITS, maxLines: 8 })).toBe("too_many_lines");
    expect(refusal(wrap("X-A:1\r\n 2\r\n\t3\r\n\r\n"), { ...DEFAULT_LIMITS, maxLines: 4 })).toBe("read");
    expect(refusal(wrap("X-A:1\nX-B:2\rX-C:3\r\n"), { ...DEFAULT_LIMITS, maxLines: 5 })).toBe("too_many_lines");
    // Six hundred thousand two-character lines are 2.4 million characters, well under the ceiling of text.
    expect(refusal(wrap("A:\r\n".repeat(MAX_CONTENT_LINES + 100_000)))).toBe("too_many_lines");
  });

  it("counts the parameters of a line, and the values they list, before it holds them", () => {
    const few = { ...DEFAULT_LIMITS, maxParams: 3 };
    expect(refusal(wrap("X;A=1;B=2;C=3:v\r\n"), few)).toBe("read");
    expect(refusal(wrap("X;A=1;B=2;C=3;D=4:v\r\n"), few)).toBe("too_many_parameters");
    expect(refusal(wrap("X;A=1,2,3,4:v\r\n"), few)).toBe("too_many_parameters");
    // A semicolon or a comma inside quotes, and anything after the colon, is no parameter.
    expect(refusal(wrap('X;A="1;2,3;4";B=2:v;w,x;y,z\r\n'), few)).toBe("read");
    expect(refusal(wrap(`X${";".repeat(MAX_PARAMS_PER_LINE)}:v\r\n`))).toBe("read");
    expect(refusal(wrap(`X${";".repeat(MAX_PARAMS_PER_LINE + 1)}:v\r\n`))).toBe("too_many_parameters");
    // A megabyte of semicolons, which would be a million parameters.
    expect(refusal(wrap(`X${";".repeat(1024 * 1024)}:v\r\n`))).toBe("too_many_parameters");
  });

  it("takes a zone definition past its ceiling of onsets for no definition", () => {
    const stamp = (n: number): string => new Date(Date.UTC(2020, 0, 2 + n)).toISOString().slice(0, 10).replace(/-/g, "");
    const listed = (dates: number): string =>
      wrap(["BEGIN:VTIMEZONE", "TZID:Listed", "BEGIN:STANDARD", "DTSTART:20200101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", `RDATE:${Array.from({ length: dates }, (_, n) => `${stamp(n)}T000000`).join(",")}`, "END:STANDARD", "END:VTIMEZONE", ""].join("\r\n"));
    // The block's own start is one onset; the dates it lists are the rest.
    expect(read(listed(MAX_ZONE_ONSETS - 1)).timezones.map((z) => [z.tzid, z.observances[0]!.extra.length])).toEqual([["Listed", MAX_ZONE_ONSETS - 1]]);
    expect(read(listed(MAX_ZONE_ONSETS)).timezones).toEqual([]);
    const blocks = (count: number): string =>
      wrap(["BEGIN:VTIMEZONE", "TZID:Blocks", ...Array.from({ length: count }, (_, n) => ["BEGIN:STANDARD", `DTSTART:${stamp(n)}T000000`, "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:STANDARD"]).flat(), "END:VTIMEZONE", ""].join("\r\n"));
    expect(read(blocks(MAX_ZONE_ONSETS)).timezones.map((z) => z.observances.length)).toEqual([MAX_ZONE_ONSETS]);
    expect(read(blocks(MAX_ZONE_ONSETS + 1)).timezones).toEqual([]);
    // With no definition the zone is not known: a time in it has no instant, and nothing is guessed.
    const calendar = read(listed(MAX_ZONE_ONSETS));
    expect(instantOf(zoned(wall(2026, 1, 5, 9, 0), "Listed"), zonesOf(calendar, platform))).toBeNull();
  });

  /*
   * EVERY STRING A STRANGER WROTE HAS A CEILING BY ITS KIND, held where the text is read. A UID, a
   * zone's name or a component's name past its ceiling spoils the event it stands in: that event is
   * left out, the read says which kind of component and why, and the rest of the calendar reads. In
   * the calendar's own lines there is no event to leave out, and the text is refused by the same word.
   */
  const kept = "BEGIN:VEVENT\r\nUID:kept@atelier.example\r\nDTSTART:20261110T090000Z\r\nEND:VEVENT\r\n";
  const readWith = (body: string): [(string | null)[], unknown] => {
    const result = readCalendar(wrap(body), DEFAULT_LIMITS);
    if (!result.ok) throw new Error(`not read: ${result.reason}`);
    return [result.calendar.events.map((e) => e.uid), result.dropped];
  };
  const eventWith = (...lines: string[]): string => ["BEGIN:VEVENT", ...lines, "END:VEVENT", ""].join("\r\n");

  it("leaves out the one event whose UID, zone name or component name is longer than its kind may be, and says so", () => {
    const [uid, long] = ["u".repeat(MAX_UID_CHARS), "u".repeat(MAX_UID_CHARS + 1)];
    expect(readWith(kept + eventWith(`UID:${uid}`))).toEqual([["kept@atelier.example", uid], []]);
    expect(readWith(eventWith(`UID:${long}`) + kept)).toEqual([["kept@atelier.example"], [{ name: "VEVENT", reason: "uid_too_long" }]]);

    const [zone, far] = ["Z".repeat(MAX_ZONE_NAME_CHARS), "Z".repeat(MAX_ZONE_NAME_CHARS + 1)];
    const inZone = readCalendar(wrap(eventWith("UID:a", `DTSTART;TZID=${zone}:20261110T090000`)), DEFAULT_LIMITS);
    expect(inZone.ok && [inZone.calendar.events[0]!.start, inZone.dropped]).toEqual([zoned(wall(2026, 11, 10, 9, 0), zone), []]);
    const spoilt = { name: "VEVENT", reason: "zone_name_too_long" };
    // On the start, on a listed date, quoted, on a line of an alarm inside the event, and as a parameter with more text than a parameter may have.
    expect(readWith(eventWith("UID:a", `DTSTART;TZID=${far}:20261110T090000`) + kept)).toEqual([["kept@atelier.example"], [spoilt]]);
    expect(readWith(kept + eventWith("UID:a", "DTSTART:20261110T090000Z", `EXDATE;TZID="${far}":20261111T090000`))).toEqual([["kept@atelier.example"], [spoilt]]);
    expect(readWith(kept + eventWith("UID:a", "BEGIN:VALARM", `TRIGGER;tzid=${far}:20261110T090000`, "END:VALARM"))).toEqual([["kept@atelier.example"], [spoilt]]);
    expect(readWith(kept + eventWith("UID:a", `DTSTART;TZID=${"Z".repeat(MAX_PARAM_VALUE_CHARS + 1)}:20261110T090000`))).toEqual([["kept@atelier.example"], [spoilt]]);
    // A zone definition of that name is left out as an event is; one of a name at the ceiling is read.
    const definition = (name: string): string => ["BEGIN:VTIMEZONE", `TZID:${name}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:STANDARD", "END:VTIMEZONE", ""].join("\r\n");
    const defined = readCalendar(wrap(definition(far) + definition(zone) + kept), DEFAULT_LIMITS);
    expect(defined.ok && [defined.calendar.timezones.map((z) => z.tzid), defined.dropped]).toEqual([[zone], [{ name: "VTIMEZONE", reason: "zone_name_too_long" }]]);
    // A definition made by hand under such a name is none either.
    const byHand = (name: string): Component => ({ name: "VTIMEZONE", properties: [{ name: "TZID", params: [], value: name }], components: [] });
    expect([zoneDefinitionOf(byHand(zone))?.tzid, zoneDefinitionOf(byHand(far))]).toEqual([zone, null]);

    // A component's name: a block inside the event takes its event with it; an event-level block of such a name is left out without its name.
    const [block, wide] = ["B".repeat(MAX_NAME_CHARS), "B".repeat(MAX_NAME_CHARS + 1)];
    expect(readWith(kept + eventWith("UID:a", `BEGIN:${block}`, `END:${block}`))).toEqual([["kept@atelier.example", "a"], []]);
    expect(readWith(kept + eventWith("UID:a", `BEGIN:${wide}`, "UID:inside", `END:${wide}`))).toEqual([["kept@atelier.example"], [{ name: "VEVENT", reason: "name_too_long" }]]);
    expect(readWith(`BEGIN:${wide}\r\nUID:inside\r\n${kept}END:${wide}\r\n${kept}`)).toEqual([["kept@atelier.example"], [{ name: "", reason: "name_too_long" }]]);

    // Every spoilt one is named, in the order written, and what is written back is the calendar without them.
    const several = readCalendar(wrap(eventWith(`UID:${long}`) + kept + eventWith("UID:b", `DTEND;TZID=${far}:20261110T100000`) + "X-AFTER:the events\r\n"), DEFAULT_LIMITS);
    expect(several.ok && several.dropped.map((d) => d.reason)).toEqual(["uid_too_long", "zone_name_too_long"]);
    expect(several.ok && write(several.calendar)).toBe(wrap(`${kept}X-AFTER:the events\r\n`));
  });

  it("refuses a calendar that breaks such a ceiling in its own lines", () => {
    const long = "u".repeat(MAX_UID_CHARS + 1);
    const far = "Z".repeat(MAX_ZONE_NAME_CHARS + 1);
    const wide = "B".repeat(MAX_NAME_CHARS + 1);
    expect(refusal(wrap(`UID:${long}\r\n${kept}`))).toBe("uid_too_long");
    expect(refusal(wrap(`TZID:${far}\r\n${kept}`))).toBe("zone_name_too_long");
    expect(refusal(wrap(`X-WR-RELCALID;TZID=${far}:x\r\n${kept}`))).toBe("zone_name_too_long");
    expect(refusal(`BEGIN:${wide}\r\n${kept}END:${wide}\r\n`)).toBe("name_too_long");
    // At the ceiling each is read. The zone a calendar says it is meant for is a zone's name too, and one that long is none.
    expect(refusal(wrap(`UID:${long.slice(1)}\r\nTZID:${far.slice(1)}\r\n${kept}`))).toBe("read");
    expect(calendarInfo(read(wrap(`X-WR-TIMEZONE:${far.slice(1)}\r\n${kept}`))).timezone).toBe(far.slice(1));
    expect(calendarInfo(read(wrap(`X-WR-TIMEZONE:${far}\r\n${kept}`))).timezone).toBeNull();
  });

  it("hands on no string longer than its kind may be, whatever the text holds", () => {
    // Six hundred texts: events whose lines carry a string of some length, on either side of every ceiling, in each place a string can stand.
    let seed = 20261114;
    const next = (below: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // The high bits: the low ones of such a sequence repeat after a few steps.
      return Math.floor((seed / 2 ** 32) * below);
    };
    const sizes = [1, 40, MAX_NAME_CHARS, MAX_NAME_CHARS + 1, MAX_ZONE_NAME_CHARS, MAX_ZONE_NAME_CHARS + 1, MAX_UID_CHARS, MAX_UID_CHARS + 1, MAX_PARAM_VALUE_CHARS, MAX_PARAM_VALUE_CHARS + 1, 20_000];
    const junk = (): string => "abcXYZ"[next(6)]!.repeat(sizes[next(sizes.length)]!);
    const shapes: (() => string)[] = [
      () => `UID:${junk()}`, () => `uid:${junk()}`, () => `TZID:${junk()}`, () => `${junk()}:v`, () => `X;${junk()}=1:v`, () => `X;${junk()}:v`, () => `X;A=${junk()}:v`, () => `ATTENDEE;CN="${junk()}":mailto:a@atelier.example`,
      () => `DTSTART;TZID=${junk()}:20261110T090000`, () => `RECURRENCE-ID;tzid="${junk()}":20261110T090000`, () => `EXDATE;TZID=${junk()},${junk()}:20261110T090000`, () => `SUMMARY:${junk()}`, () => "DTSTART:20261110T090000Z",
    ];
    const line = (): string => shapes[next(shapes.length)]!();
    const block = (depth: number): string[] => {
      const name = next(8) === 0 ? junk() : ["VEVENT", "VTIMEZONE", "VALARM", "STANDARD"][next(4)]!;
      const inside = Array.from({ length: next(4) }, () => (depth < 3 && next(4) === 0 ? block(depth + 1) : [line()])).flat();
      return [`BEGIN:${name}`, ...inside, `END:${name}`];
    };
    const tooLong: string[] = [];
    const walk = (c: Component): void => {
      if (c.name.length > MAX_NAME_CHARS) tooLong.push(`component ${c.name.length}`);
      for (const p of c.properties) {
        if (p.name.length > MAX_NAME_CHARS) tooLong.push(`name ${p.name.length}`);
        if (p.name.toUpperCase() === "UID" && p.value.length > MAX_UID_CHARS) tooLong.push(`UID ${p.value.length}`);
        if (p.name.toUpperCase() === "TZID" && p.value.length > MAX_ZONE_NAME_CHARS) tooLong.push(`TZID ${p.value.length}`);
        for (const param of p.params) {
          if (param.name.length > MAX_NAME_CHARS) tooLong.push(`parameter name ${param.name.length}`);
          for (const v of param.values) if (v.length > (param.name.toUpperCase() === "TZID" ? MAX_ZONE_NAME_CHARS : MAX_PARAM_VALUE_CHARS)) tooLong.push(`${param.name} ${v.length}`);
        }
      }
      c.components.forEach(walk);
    };
    let [readWhole, left, refused] = [0, 0, 0];
    for (let n = 0; n < 600; n++) {
      const own = next(4) === 0 ? [line()] : [];
      const source = ["BEGIN:VCALENDAR", "VERSION:2.0", ...own, ...Array.from({ length: 1 + next(4) }, () => block(2)).flat(), "END:VCALENDAR", ""].join("\r\n");
      const result = readCalendar(source, DEFAULT_LIMITS);
      if (!result.ok) {
        expect(["uid_too_long", "zone_name_too_long", "name_too_long"], source.slice(0, 200)).toContain(result.reason);
        refused++;
        continue;
      }
      walk(result.calendar.tree);
      for (const e of result.calendar.events) {
        if ((e.uid ?? "").length > MAX_UID_CHARS) tooLong.push(`event uid ${e.uid!.length}`);
        for (const t of [e.start, e.end, e.recurrenceId, ...e.excluded]) if (t !== null && t.kind === "zoned" && t.tzid.length > MAX_ZONE_NAME_CHARS) tooLong.push(`time in ${t.tzid.length}`);
      }
      for (const z of result.calendar.timezones) if (z.tzid.length > MAX_ZONE_NAME_CHARS) tooLong.push(`zone ${z.tzid.length}`);
      // What is left out is counted, and what is kept and what is left out are together what was written.
      const written = source.split("\r\n").filter((l) => l.startsWith("BEGIN:")).length;
      const count = (c: Component): number => 1 + c.components.reduce((sum, k) => sum + count(k), 0);
      if (result.dropped.length === 0) expect(count(result.calendar.tree)).toBe(written);
      else expect(count(result.calendar.tree)).toBeLessThan(written);
      result.dropped.length === 0 ? readWhole++ : left++;
    }
    expect(tooLong).toEqual([]);
    // All three outcomes are met many times over.
    expect([readWhole > 100, left > 100, refused > 25]).toEqual([true, true, true]);
  });

  /*
   * A LINE'S PARAMETERS ARE ASKED ONCE, however many dates the line lists. A listed date was read by
   * asking the line's parameters for VALUE and TZID again for each one, so a line cost its dates times
   * its parameters: five lines of 104,000 dates and 255 parameters each took eight seconds to read.
   */
  it("asks a line's parameters once, however many dates it lists", () => {
    let asked = 0;
    const params = [{ name: "X-A", values: [], raw: "", bare: true as const }, { name: "TZID", values: ["Europe/Zurich"], raw: "Europe/Zurich" }];
    const listing = (name: string, dates: number): Property => {
      const value = Array.from({ length: dates }, (_, n) => `2026${String(1 + (n % 12)).padStart(2, "0")}${String(1 + (n % 28)).padStart(2, "0")}T090000`).join(",");
      return Object.defineProperty({ name, value } as Property, "params", { enumerable: true, get: () => (asked++, params) });
    };
    const start: Property = { name: "DTSTART", params: [], value: "20260101T090000Z" };
    // And a line the view has no word for is looked at once, not once for each name the view knows.
    let looked = 0;
    const note = Object.defineProperty({ params: [], value: "v" } as unknown as Property, "name", { enumerable: true, get: () => (looked++, "X-NOTE") });
    const eventOfDates = (dates: number) => eventOf({ name: "VEVENT", properties: [start, note, listing("EXDATE", dates), listing("RDATE", dates)], components: [] });
    const few = eventOfDates(2);
    expect([few.excluded, few.added.length]).toEqual([[zoned(wall(2026, 1, 1, 9, 0), "Europe/Zurich"), zoned(wall(2026, 2, 2, 9, 0), "Europe/Zurich")], 2]);
    const forTwo = asked;
    expect(looked).toBe(1);
    asked = 0;
    const many = eventOfDates(3000);
    expect([many.excluded.length, many.added.length]).toEqual([3000, 3000]);
    expect(asked).toBe(forTwo);
  });

  it("says what is not a calendar", () => {
    expect(refusal("<html><body>Please sign in to see this calendar</body></html>")).toBe("not_a_calendar");
    expect(refusal("BEGIN:VCARD\r\nFN:Mila Brunner\r\nEND:VCARD\r\n")).toBe("not_a_calendar");
    expect(refusal(wrap("BEGIN:VEVENT\r\nUID:cut off in the middle\r\n").replace("END:VCALENDAR\r\n", ""))).toBe("unbalanced");
    expect(refusal(undefined as unknown as string)).toBe("not_a_calendar");
  });

  /*
   * THE PARTS OF A WHOLE TEXT. A line, a parameter and each further value a parameter lists become an
   * object or a string apiece, about a hundred bytes each: a text of nothing but parameters, every
   * line at its own ceiling of 256, was held in a hundred times its size. They are counted together
   * over the whole text, on the text, before the first of them is made.
   */
  it("counts the parts of a whole text, lines and parameters and their values together, before it holds any", () => {
    // The wrapper is three lines, so three parts. `X;A=1;B=2,3:v` is the line, two parameters and one more value: four.
    const line = "X;A=1;B=2,3:v\r\n";
    const few = { ...DEFAULT_LIMITS, maxParts: 3 + 4 + 4 };
    expect(refusal(wrap(line.repeat(2)), few)).toBe("read");
    expect(refusal(wrap(`${line.repeat(2)}Y:w\r\n`), few)).toBe("too_many_parts");
    // Inside quotes and after the colon nothing is a parameter (two parts), a line with no colon is one part, a folded line is counted once.
    const other = 'Y;A="1;2,3":v;w,x\r\nno colon; here, at all\r\nZ:1\r\n';
    expect(refusal(wrap(line + other), few)).toBe("read");
    expect(refusal(wrap(`${line + other}Z:2\r\n`), few)).toBe("too_many_parts");
    expect(refusal(wrap(`X;A=1;\r\n B=2,\r\n\t3:v\r\n${line}`), few)).toBe("read");
    // The count of lines is still asked first, and a line past its own ceiling of parameters is still refused as that.
    expect(refusal(wrap(line.repeat(3)), { ...few, maxLines: 5 })).toBe("too_many_lines");
    expect(refusal(wrap("X;A=1;B=2;C=3;D=4:v\r\n"), { ...few, maxParams: 3 })).toBe("too_many_parameters");
    // Every line at its own ceiling: 257 parts a line. As many of them as the ceiling of parts has room for are read, one more is not.
    const full = `X${";".repeat(MAX_PARAMS_PER_LINE)}:v\r\n`;
    const room = Math.floor((MAX_TEXT_PARTS - 3) / (MAX_PARAMS_PER_LINE + 1));
    expect(read(wrap(full.repeat(room))).tree.properties.length).toBe(1 + room);
    expect(refusal(wrap(full.repeat(room + 1)))).toBe("too_many_parts");
  });

  /** Every VEVENT of the corpus's stored objects and exports, over and over, each under a UID of its own: a busy subscription. */
  const subscription = (events: number): string => {
    const blocks: (readonly string[])[] = [];
    for (const fixture of [...BENCH, ...PROVIDERS]) {
      let open = -1;
      fixture.lines.forEach((l, i) => {
        if (l === "BEGIN:VEVENT") open = i;
        else if (l === "END:VEVENT") blocks.push(fixture.lines.slice(open, i + 1));
      });
    }
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//corpus//EN", "X-WR-CALNAME:Everything at the atelier"];
    for (let n = 0; n < events; n++) for (const l of blocks[n % blocks.length]!) lines.push(l.startsWith("UID:") ? `UID:subscription-${n}@atelier.example` : l);
    return [...lines, "END:VCALENDAR", ""].join("\r\n");
  };

  it("reads a subscription of five thousand events whole", () => {
    const source = subscription(5000);
    expect(source.length).toBeGreaterThan(2 * 1024 * 1024);
    const calendar = read(source);
    expect(calendar.events.length).toBe(5000);
    expect(new Set(calendar.events.map((e) => e.uid)).size).toBe(5000);
    expect(calendarInfo(calendar).name).toBe("Everything at the atelier");
    // Every line of it comes back.
    expect(unfold(write(calendar))).toEqual(unfold(source));
  });

  /*
   * IN A PROCESS OF ITS OWN, WITH A HEAP OF 128 MiB. Three texts are read there. A stranger's: 32,140
   * lines of 256 parameters each between the calendar's own two, 8,388,572 characters, under the
   * ceilings of text, of lines and of a line's parameters, and 8.26 million parts; read into a tree
   * it killed a process with four times this heap. The subscription of five thousand events. And the
   * costliest text the ceilings admit, as far as it is known (limits.ts says how it was found), at
   * one eighth of every ceiling so that it fits: a fifth of its lines begin and end events, three
   * fifths are invitees, the parts that are left are bare parameters, the rest is listed dates.
   * What that one holds for each character of its text is the measure limits.ts gives.
   */
  it("refuses a text of nothing but parameters, reads the subscription, and holds no text in more than its measure, in a process with a small heap", async () => {
    const program = `
      import { readFileSync } from "node:fs";
      import { DEFAULT_LIMITS, MAX_CALENDAR_TEXT_CHARS, readCalendar } from "./src/index.ts";
      const read = (text, limits) => {
        const r = readCalendar(text, limits);
        return r.ok ? { read: "read", events: r.calendar.events.length } : { read: r.reason, events: 0 };
      };
      const stranger = () => {
        const [head, tail, one] = ["BEGIN:VCALENDAR\\r\\n", "END:VCALENDAR\\r\\n", "X" + ";".repeat(DEFAULT_LIMITS.maxParams) + ":v\\r\\n"];
        const lines = Math.floor((MAX_CALENDAR_TEXT_CHARS - head.length - tail.length) / one.length);
        const text = head + one.repeat(lines) + tail;
        return { chars: text.length, lines, read: read(text, DEFAULT_LIMITS).read };
      };
      const costliest = () => {
        const eighth = { ...DEFAULT_LIMITS, maxTextChars: DEFAULT_LIMITS.maxTextChars / 8, maxLines: DEFAULT_LIMITS.maxLines / 8, maxParts: DEFAULT_LIMITS.maxParts / 8, maxComponents: DEFAULT_LIMITS.maxComponents / 8 };
        const events = Math.floor((eighth.maxLines - 600) / 5);
        const loaded = Math.floor((eighth.maxParts - 5 * events - 200) / 251);
        let text = "BEGIN:VCALENDAR\\n" + ("BEGIN:VEVENT\\n" + "ATTENDEE:\\n".repeat(3) + "END:VEVENT\\n").repeat(events - 1) + "BEGIN:VEVENT\\n" + ("ATTENDEE" + ";".repeat(250) + ":\\n").repeat(loaded);
        const dates = Math.floor((eighth.maxTextChars - text.length - 60) / 9);
        text += "RDATE;VALUE=DATE:" + "20260101,".repeat(dates - 1) + "20260101\\nEND:VEVENT\\nEND:VCALENDAR\\n";
        // A collection that finds one already under way only ends that one, and what was made meanwhile outlives it: the reading is taken after a second and a third.
        const inUse = () => {
          for (let n = 0; n < 3; n++) globalThis.gc();
          return process.memoryUsage().heapUsed;
        };
        const before = inUse();
        const held = readCalendar(text, eighth);
        const bytes = inUse() - before;
        return { read: held.ok ? "read" : held.reason, events: held.ok ? held.calendar.events.length : 0, fills: text.length / eighth.maxTextChars, bytesACharacter: bytes / text.length };
      };
      // The measure first, while the process holds nothing else.
      const measured = costliest();
      console.log(JSON.stringify({ stranger: stranger(), honest: read(readFileSync(process.argv[2], "utf8"), DEFAULT_LIMITS), costliest: measured }));
    `;
    const built = await build({ stdin: { contents: program, resolveDir: PKG, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
    const dir = mkdtempSync(join(tmpdir(), "cal-core-heap-"));
    try {
      writeFileSync(join(dir, "read.mjs"), built.outputFiles[0]!.text);
      writeFileSync(join(dir, "subscription.ics"), subscription(5000));
      const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--expose-gc", join(dir, "read.mjs"), join(dir, "subscription.ics")], { encoding: "utf8" });
      // A process that ran out of heap is killed and says nothing; this one ended by itself and said what it read.
      expect([child.status, child.signal]).toEqual([0, null]);
      const said = JSON.parse(child.stdout) as { stranger: unknown; honest: unknown; costliest: { read: string; events: number; fills: number; bytesACharacter: number } };
      expect(said.stranger).toEqual({ chars: 8_388_572, lines: 32_140, read: "too_many_parts" });
      expect(said.honest).toEqual({ read: "read", events: 5000 });
      expect([said.costliest.read, said.costliest.events]).toEqual(["read", (MAX_CONTENT_LINES / 8 - 600) / 5]);
      expect(said.costliest.fills).toBeGreaterThan(0.999);
      // 25 bytes for each character where it was measured. A third more would be a part of the tree or of an event's view grown dearer, or a costlier text found.
      expect(said.costliest.bytesACharacter).toBeGreaterThan(20);
      expect(said.costliest.bytesACharacter).toBeLessThan(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("what a text's own words weigh once read", () => {
  /*
   * IN A PROCESS OF ITS OWN, WITH A HEAP OF 128 MiB. A text value with an escape in it was put
   * together one character at a time, and what the event held was that chain of pieces: 58 bytes for
   * each character of a text of letters outside Latin-1, 464 MiB at the ceiling of text, which killed
   * a process with four times this heap. A feed that looked honest (a summary, a description of four
   * lines with their escaped line breaks and commas, a place) held 40 bytes a character in kana and
   * was not read at 3 MiB. A value is now unescaped by whole slices joined once, and what is held is
   * one more copy of the text and the tree.
   */
  it("reads text values as long as lines may be, and a feed in kana, and holds a few bytes for each character", async () => {
    const program = `
      import { DEFAULT_LIMITS, MAX_CALENDAR_TEXT_CHARS, MAX_LINE_CHARS, MAX_PARAM_VALUE_CHARS, readCalendar, writeCalendar } from "./src/index.ts";
      const inUse = () => {
        for (let n = 0; n < 3; n++) globalThis.gc();
        return process.memoryUsage().heapUsed;
      };
      const measured = (text, writeBack, words = (e) => [e.description, e.summary, e.location]) => {
        const before = inUse();
        const held = readCalendar(text, DEFAULT_LIMITS);
        const bytes = inUse() - before;
        const events = held.ok ? held.calendar.events : [];
        const said = events.flatMap(words);
        const unescaped = said.reduce((sum, word) => sum + (word ?? "").length, 0);
        // Written back, every line folded: a line folded a character at a time is a chain of its characters until the text is put together.
        const written = held.ok && writeBack ? writeCalendar(held.calendar) : null;
        const longest = written !== null && written.ok ? written.text.split("\\r\\n").reduce((most, line) => Math.max(most, Buffer.byteLength(line)), 0) : 0;
        return { read: held.ok ? "read" : held.reason, events: events.length, chars: text.length, words: said.length, unescaped, begins: said.length > 0 ? JSON.stringify((said[0] ?? "").slice(0, 3)) : "", bytesACharacter: bytes / text.length, written: written !== null && written.ok ? written.text.length : 0, longest };
      };
      // Two events of three text lines each as long as the text has room for, one escaped line break at the head of every value, letters outside Latin-1.
      const long = () => {
        const [head, tail] = ["BEGIN:VCALENDAR\\n", "END:VCALENDAR\\n"];
        let body = "";
        for (;;) {
          const each = Math.min(MAX_LINE_CHARS, Math.floor((MAX_CALENDAR_TEXT_CHARS - head.length - tail.length - body.length - 40) / 3));
          if (each < 100) break;
          body += "BEGIN:VEVENT\\n" + ["SUMMARY", "DESCRIPTION", "LOCATION"].map((name) => name + ":\\\\n" + "\u4f1a".repeat(each - name.length - 4) + "\\n").join("") + "END:VEVENT\\n";
        }
        return head + body + tail;
      };
      // Events as a busy feed writes them, in kana.
      const feed = (events) => {
        const kana = Array.from({ length: 80 }, (_, i) => String.fromCharCode(0x3042 + i)).join("");
        const pick = (n, k) => Array.from({ length: n }, (_, i) => kana[(k * 7 + i * 3) % 80]).join("");
        let body = "";
        for (let k = 0; k < events; k++) {
          const day = "2026" + String(1 + (k % 12)).padStart(2, "0") + String(1 + (k % 28)).padStart(2, "0");
          body += "BEGIN:VEVENT\\nUID:feed-" + k + "@example.org\\nDTSTAMP:20260101T000000Z\\nDTSTART;TZID=Asia/Tokyo:" + day + "T090000\\nDTEND;TZID=Asia/Tokyo:" + day + "T100000\\n"
            + "SUMMARY:" + pick(18, k) + "\\\\, " + pick(8, k + 5) + "\\nDESCRIPTION:" + pick(60, k) + "\\\\n" + pick(80, k + 1) + "\\\\, " + pick(70, k + 2) + "\\\\n\\\\n" + pick(90, k + 3) + "\\nLOCATION:" + pick(14, k + 9) + "\\\\, " + pick(10, k + 4) + "\\nEND:VEVENT\\n";
        }
        return "BEGIN:VCALENDAR\\n" + body + "END:VCALENDAR\\n";
      };
      // One event with three CATEGORIES lines as long as a line may be: a member a line, an escaped line break at its head, letters outside Latin-1.
      const categories = () => "BEGIN:VCALENDAR\\nBEGIN:VEVENT\\n" + ("CATEGORIES:\\\\n" + "会".repeat(MAX_LINE_CHARS - 14) + "\\n").repeat(3) + "END:VEVENT\\nEND:VCALENDAR\\n";
      // One event with as many invitee lines as the text has room for: each name quoted and as long as a parameter may be, a caret's line break (RFC 6868) at its head.
      const invitees = () => {
        const line = 'ATTENDEE;CN="^n' + "会".repeat(MAX_PARAM_VALUE_CHARS - 4) + '":mailto:reto.frei@atelier.example\\n';
        return "BEGIN:VCALENDAR\\nBEGIN:VEVENT\\n" + line.repeat(Math.floor((MAX_CALENDAR_TEXT_CHARS - 100) / line.length)) + "END:VEVENT\\nEND:VCALENDAR\\n";
      };
      const kana = measured(feed(6900), true);
      const lengthy = measured(long(), false);
      const listed = measured(categories(), false, (e) => e.categories);
      console.log(JSON.stringify({ kana, long: lengthy, categories: listed, invitees: measured(invitees(), false, (e) => e.attendees.map((a) => a.name)) }));
    `;
    const built = await build({ stdin: { contents: program, resolveDir: PKG, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
    const dir = mkdtempSync(join(tmpdir(), "cal-core-heap-"));
    try {
      writeFileSync(join(dir, "read.mjs"), built.outputFiles[0]!.text);
      const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--expose-gc", join(dir, "read.mjs")], { encoding: "utf8" });
      expect([child.status, child.signal]).toEqual([0, null]);
      type Measured = { read: string; events: number; chars: number; words: number; unescaped: number; begins: string; bytesACharacter: number; written: number; longest: number };
      const said = JSON.parse(child.stdout) as { kana: Measured; long: Measured; categories: Measured; invitees: Measured };
      // The feed: 6,900 events in 3.8 million characters, every value there with its line breaks and commas unescaped.
      expect([said.kana.read, said.kana.events, said.kana.begins]).toEqual(["read", 6900, JSON.stringify("\u3042\u3045\u3048")]);
      expect(said.kana.chars).toBeGreaterThan(3_700_000);
      // Written back whole, in lines of no more than 75 octets: 25 kana, or a space and 24.
      expect([said.kana.written > said.kana.chars, said.kana.longest]).toEqual([true, 75]);
      // The long values: the text to its ceiling, all of it but the names and the escapes in six values.
      expect([said.long.read, said.long.events, said.long.begins]).toEqual(["read", 2, JSON.stringify("\n\u4f1a\u4f1a")]);
      expect(said.long.chars).toBeGreaterThan(MAX_CALENDAR_TEXT_CHARS - 100);
      expect(said.long.unescaped).toBeGreaterThan(said.long.chars - 200);
      // The list: three members, each a line's whole value with its line break unescaped.
      expect([said.categories.read, said.categories.events, said.categories.words, said.categories.begins]).toEqual(["read", 1, 3, JSON.stringify("\n会会")]);
      expect(said.categories.unescaped).toBeGreaterThan(said.categories.chars - 200);
      // The invitees: the text to its ceiling, every name read whole (a longer one would have been read as none), the caret's line break at its head.
      expect([said.invitees.read, said.invitees.events, said.invitees.begins]).toEqual(["read", 1, JSON.stringify("\n会会")]);
      expect(said.invitees.chars).toBeGreaterThan(MAX_CALENDAR_TEXT_CHARS - MAX_PARAM_VALUE_CHARS - 200);
      expect([said.invitees.words > 2000, said.invitees.unescaped]).toEqual([true, said.invitees.words * (MAX_PARAM_VALUE_CHARS - 3)]);
      // Measured (Node 22, 2026-11): 8.7 and 4.0 bytes for each character, where a chain of pieces held 40 and 58. A third more would be a value held twice.
      expect(said.kana.bytesACharacter).toBeLessThan(12);
      expect(said.long.bytesACharacter).toBeLessThan(6);
      // 4.0 and 3.3 for the list and the names. Cut or decoded a character at a time, either is a chain of pieces at 58 bytes a character: the list's runs this heap out while it is cut, the names' stay held.
      expect(said.categories.bytesACharacter).toBeLessThan(6);
      expect(said.invitees.bytesACharacter).toBeLessThan(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("what each writer meant", () => {
  it("Google's export: the people, the rule, the alarm, the call", () => {
    const calendar = read(google_export);
    expect([calendar.prodid, calendar.version, calendar.method]).toEqual(["-//Google Inc//Google Calendar 70.9054//EN", "2.0", "PUBLISH"]);
    expect(calendar.timezones.map((z) => [z.tzid, z.observances.length])).toEqual([["Europe/Zurich", 2]]);
    const [series, movedDay, closed] = calendar.events;
    expect(series).toMatchObject({
      uid: "0c5h7q1v9t3k2m8n4b6x0z1a2s@google.example", sequence: 1, status: "CONFIRMED", transparency: "OPAQUE", summary: "Kiln schedule", location: "Studio, back room",
      start: zoned(wall(2026, 3, 2, 9, 30), "Europe/Zurich"), end: zoned(wall(2026, 3, 2, 10, 0), "Europe/Zurich"), recurrenceId: null,
      dtstamp: instant(at("2026-11-13T12:00:00Z")), created: instant(at("2026-02-20T08:15:00Z")), lastModified: instant(at("2026-03-01T19:00:00Z")),
      excluded: [zoned(wall(2026, 4, 6, 9, 30), "Europe/Zurich")],
      organizer: { name: "Mila Brunner", email: "mila.brunner@atelier.example" },
    });
    expect(series!.description).toBe("Weekly look at the kiln schedule.\n\nWho fires what, and when; bring the firing log.\nJoin: https://meet.atelier.example/kiln-schedule");
    expect(series!.rules.map((r) => [r.text, r.rule?.freq, r.rule?.until])).toEqual([["FREQ=WEEKLY;WKST=MO;UNTIL=20260427T215959Z;BYDAY=MO", "WEEKLY", instant(at("2026-04-27T21:59:59Z"))]]);
    expect(series!.attendees.map((a) => [a.email, a.name, a.role, a.partstat, a.rsvp, a.kind])).toEqual([
      ["mila.brunner@atelier.example", "Mila Brunner", "REQ-PARTICIPANT", "ACCEPTED", false, "INDIVIDUAL"],
      ["giulia.ferrari@lichtgrat.example", "giulia.ferrari@lichtgrat.example", "REQ-PARTICIPANT", "NEEDS-ACTION", true, "INDIVIDUAL"],
      ["reto.frei@atelier.example", "Reto Frei", "OPT-PARTICIPANT", "TENTATIVE", false, "INDIVIDUAL"],
    ]);
    expect(series!.alarms.map((a) => [a.action, a.trigger])).toEqual([["DISPLAY", { kind: "relative", duration: parseDuration("-PT10M"), to: "START" }]]);
    expect(movedDay).toMatchObject({ recurrenceId: zoned(wall(2026, 3, 23, 9, 30), "Europe/Zurich"), thisAndFuture: false, sequence: 2 });
    expect(closed).toMatchObject({ start: plainDate(2026, 5, 1), end: plainDate(2026, 5, 2), transparency: "TRANSPARENT", attendees: [], organizer: null });
  });

  it("Exchange's request: a Windows zone, a name with a comma, a class and an alarm", () => {
    const [event] = read(exchange_request).events;
    expect(event).toMatchObject({ summary: "Catalogue page order", location: "Meeting room 2", classification: "PUBLIC", start: zoned(wall(2026, 11, 26, 14, 0), "W. Europe Standard Time") });
    expect(event!.attendees.map((a) => [a.name, a.email, a.role])).toEqual([["Mila Brunner", "mila.brunner@atelier.example", "REQ-PARTICIPANT"], ["Arnold, Ben", "ben.arnold@lichtgrat.example", "OPT-PARTICIPANT"]]);
    expect(event!.alarms[0]!.trigger).toEqual({ kind: "relative", duration: parseDuration("-PT15M"), to: "START" });
    expect(event!.description).toBe("Spring catalogue: the final page order.\n\nPlease bring the proofs; we go page by page.\n");
    // 14:00 in "W. Europe Standard Time" on 26 November is CET: 13:00 UTC, by the platform's rules and by the file's own 1601 definition alike.
    const start = event!.start as ReturnType<typeof zoned>;
    expect(iso(instantOf(start, platform)!.epochMs)).toBe("2026-11-26T13:00:00Z");
    expect(iso(instantOf(start, fileZones(read(exchange_request).timezones))!.epochMs)).toBe("2026-11-26T13:00:00Z");
    // A summer day in the same file's definition: 14:00 is CEST, 12:00 UTC.
    expect(iso(instantOf(zoned(wall(2026, 7, 15, 14, 0), "W. Europe Standard Time"), fileZones(read(exchange_request).timezones))!.epochMs)).toBe("2026-07-15T12:00:00Z");
  });

  it("Apple's event: a place over two lines, a link, an alarm before and an alarm that is none", () => {
    const [event] = read(apple_event).events;
    expect(event).toMatchObject({ summary: "Stall at the winter market 🏺", location: "Winter market\nHafenhalle, Uferweg 3", url: "https://market.atelier.example/winter", uid: "6E1F0C2A-7B3D-4E5F-9A1B-2C3D4E5F6A7B" });
    expect(event!.alarms.map((a) => [a.action, a.trigger?.kind])).toEqual([["DISPLAY", "relative"], ["NONE", "absolute"]]);
    expect(event!.alarms[1]!.trigger).toEqual({ kind: "absolute", at: instant(at("1976-04-01T00:55:45Z")) });
  });

  it("Thunderbird's categories and a zone under a vendor's prefix", () => {
    expect(read(thunderbird_event).events[0]).toMatchObject({ summary: "Glaze tests; blue, green", categories: ["Studio", "Kiln, small", "Tests"] });
    const calendar = read(evolution_event);
    const start = calendar.events[0]!.start as ReturnType<typeof zoned>;
    expect(start.tzid).toBe("/freeassociation.sourceforge.net/Europe/Berlin");
    // 18:30 in Berlin on 4 December is CET: 17:30 UTC, from the file's definition under the same long name and from the platform under the short one.
    expect(iso(instantOf(start, fileZones(calendar.timezones))!.epochMs)).toBe("2026-12-04T17:30:00Z");
    expect(iso(instantOf(start, platform)!.epochMs)).toBe("2026-12-04T17:30:00Z");
  });

  it("a feed's own name and how often it wants to be asked", () => {
    expect(calendarInfo(read(feed_rfc7986))).toEqual({
      name: "Course dates", description: "Every course at the wheel, as planned.", color: "turquoise", refreshInterval: parseDuration("PT12H"),
      source: "https://atelier.example/courses.ics", url: "https://atelier.example/courses", timezone: null,
    });
    expect(calendarInfo(read(google_holidays))).toEqual({
      name: "Holidays in Switzerland", description: "Holidays and Observances in Switzerland", color: null, refreshInterval: null, source: null, url: null, timezone: "UTC",
    });
    const [course, glazing] = read(feed_rfc7986).events;
    expect(course).toMatchObject({ start: { kind: "floating" }, end: null, duration: parseDuration("PT2H30M") });
    expect(glazing).toMatchObject({ start: instant(at("2026-12-12T09:00:00Z")) });
  });
});

describe("a calendar written new", () => {
  it("writes a zone definition that says what the platform says, over the span asked", () => {
    const span = { startMs: at("2026-01-10T00:00:00Z"), endMs: at("2027-12-20T00:00:00Z") };
    const definition = vtimezoneFrom("Europe/Zurich", platform, span)!;
    // The offset when the span begins, then the four changes of 2026 and 2027, each on the clock in force before it.
    expect(definition.components.map((b) => [b.name, ...b.properties.map((p) => p.value)])).toEqual([
      ["STANDARD", "20260109T010000", "+0100", "+0100"],
      ["DAYLIGHT", "20260329T020000", "+0100", "+0200"],
      ["STANDARD", "20261025T030000", "+0200", "+0100"],
      ["DAYLIGHT", "20270328T020000", "+0100", "+0200"],
      ["STANDARD", "20271031T030000", "+0200", "+0100"],
    ]);
    const file = fileZones([zoneDefinitionOf(definition)!]);
    for (let ms = span.startMs; ms < span.endMs; ms += 3_600_000 * 7) expect(file.offsetAt("Europe/Zurich", ms)).toBe(platform.offsetAt("Europe/Zurich", ms));
    expect(vtimezoneFrom("Studio Time", platform, span)).toBeNull();
    // A series with no end gets ten years of it, not a century.
    const long = vtimezoneFrom("Europe/Zurich", platform, { startMs: at("2026-01-10T00:00:00Z"), endMs: at("2126-01-10T00:00:00Z") })!;
    expect(long.components.length).toBe(21);
  });

  it("writes an event that reads back as it was meant", () => {
    const zone = "Europe/Zurich";
    const start = zoned(wall(2026, 12, 9, 18, 0), zone);
    const component = newEventComponent({
      uid: "new-1@atelier.example", dtstamp: instant(at("2026-11-13T12:00:00Z")), start, end: zoned(wall(2026, 12, 9, 19, 30), zone), summary: "Glazing; first, second",
      description: "Bring an apron.\nAnd a towel.", location: "Studio, back room", rule: parseRRule("FREQ=WEEKLY;COUNT=4;BYDAY=WE")!, organizer: { email: "mila.brunner@atelier.example", name: "Brunner, Mila" },
      attendees: [{ email: "reto.frei@atelier.example", name: "Reto Frei", role: "REQ-PARTICIPANT", rsvp: true }], status: "CONFIRMED", transparency: "OPAQUE",
    });
    const definition = vtimezoneFrom(zone, platform, { startMs: at("2026-12-09T17:00:00Z"), endMs: at("2026-12-30T18:30:00Z") })!;
    const written = write(newCalendar({ prodid: "-//ohmail//test//EN", timezones: [definition], events: [component] }));
    expect(unfold(written).slice(0, 4)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//test//EN", "BEGIN:VTIMEZONE"]);
    expect(unfold(written)).toContain('ORGANIZER;CN="Brunner, Mila":mailto:mila.brunner@atelier.example');
    const back = read(written);
    expect(back.events[0]).toMatchObject({
      uid: "new-1@atelier.example", sequence: 0, start, summary: "Glazing; first, second", description: "Bring an apron.\nAnd a towel.", location: "Studio, back room", status: "CONFIRMED",
      organizer: { name: "Brunner, Mila", email: "mila.brunner@atelier.example" },
    });
    expect(back.events[0]!.attendees.map((a) => [a.email, a.partstat, a.rsvp])).toEqual([["reto.frei@atelier.example", "NEEDS-ACTION", true]]);
    expect(back.events[0]!.rules[0]!.rule).toEqual(parseRRule("FREQ=WEEKLY;COUNT=4;BYDAY=WE"));
    expect(iso(instantOf(start, fileZones(back.timezones))!.epochMs)).toBe("2026-12-09T17:00:00Z");
  });

  /*
   * Mondays 09:00 in Zurich, five times from 2 March 2026. The clocks go forward on the 29th: the
   * first four are 08:00 UTC, the fifth (the 30th) is 07:00 UTC.
   */
  const MONDAYS = ["2026-03-02T08:00:00Z", "2026-03-09T08:00:00Z", "2026-03-16T08:00:00Z", "2026-03-23T08:00:00Z", "2026-03-30T07:00:00Z"];
  const mondays = (span: { startMs: number; endMs: number }): CalObject => {
    const component = newEventComponent({ uid: "new-2@atelier.example", dtstamp: instant(at("2026-02-20T12:00:00Z")), start: zoned(wall(2026, 3, 2, 9, 0), "Europe/Zurich"), rule: parseRRule("FREQ=WEEKLY;COUNT=5")! });
    return read(write(newCalendar({ prodid: "-//ohmail//test//EN", timezones: [vtimezoneFrom("Europe/Zurich", platform, span)!], events: [component] })));
  };
  const startsOf = (calendar: CalObject, zones = zonesOf(calendar, platform)): (string | null)[] =>
    expandSeries(seriesOf(calendar.events, zones)[0]!, { startMs: at("2026-03-01T00:00:00Z"), endMs: at("2026-05-01T00:00:00Z"), viewerZone: "Europe/Zurich" }, zones).occurrences.map((o) =>
      o.start.kind === "zoned" ? iso(instantOf(o.start, zones)!.epochMs) : null,
    );

  it("writes a zone definition that carries a series across a clock change when its span covers the series", () => {
    const whole = mondays({ startMs: at("2026-03-02T08:00:00Z"), endMs: at("2026-03-30T08:00:00Z") });
    expect(startsOf(whole)).toEqual(MONDAYS);
    // The definition alone says the same: a reader with no zone data of its own is not misled.
    expect(startsOf(whole, fileZones(whole.timezones))).toEqual(MONDAYS);
  });

  it("is not misled by a definition written for less than the series: the platform is asked first", () => {
    const short = mondays({ startMs: at("2026-03-02T08:00:00Z"), endMs: at("2026-03-02T09:00:00Z") });
    expect(startsOf(short)).toEqual(MONDAYS);
    // The definition alone ends before the change and would hold winter time for the fifth Monday.
    expect(startsOf(short, fileZones(short.timezones))[4]).toBe("2026-03-30T08:00:00Z");
  });

  it("refuses to write a line that holds a line break or another control character", () => {
    const stamp = instant(at("2026-11-13T12:00:00Z"));
    const start = instant(at("2026-12-09T17:00:00Z"));
    const calendarOf = (event: Parameters<typeof newEventComponent>[0], prodid = "-//ohmail//test//EN") => writeCalendar(newCalendar({ prodid, events: [newEventComponent(event)] }));
    // A link and an address that each bring a line of their own: an invitee nobody set, a property nobody wrote.
    const smuggled = calendarOf({ uid: "new-3@atelier.example", dtstamp: stamp, start, url: "https://atelier.example/x\r\nATTENDEE:mailto:added@atelier.example", organizer: { email: "mila.brunner@atelier.example\r\nX-INJECTED:1" } });
    expect(smuggled).toEqual({ ok: false, reason: "control_character" });
    for (const broken of ["a\nb", "a\rb", "a\u0000b", "a\u000bb", "a\u007fb"]) {
      expect(calendarOf({ uid: "new-3@atelier.example", dtstamp: stamp, start, url: broken })).toEqual({ ok: false, reason: "control_character" });
      expect(calendarOf({ uid: "new-3@atelier.example", dtstamp: stamp, start }, broken)).toEqual({ ok: false, reason: "control_character" });
    }
    // A tree built by hand is held to the same: a name, a parameter's name or text, a value, a component's own name.
    const tree = (over: Partial<{ component: string; name: string; param: string; raw: string; value: string }>): Component => ({
      name: over.component ?? "VEVENT",
      properties: [{ name: over.name ?? "X-NOTE", params: [{ name: over.param ?? "X-P", values: [], raw: over.raw ?? "1" }], value: over.value ?? "v" }],
      components: [],
    });
    expect(writeComponent(tree({}))).toEqual({ ok: true, text: "BEGIN:VEVENT\r\nX-NOTE;X-P=1:v\r\nEND:VEVENT\r\n" });
    for (const over of [{ component: "VEVENT\r\nX" }, { name: "X\nY" }, { param: "P\rQ" }, { raw: "1\r\nZ:1" }, { value: "v\r\nATTENDEE:mailto:added@atelier.example" }]) {
      expect(writeComponent(tree(over))).toEqual({ ok: false, reason: "control_character" });
    }
    // Text and a parameter's value are escaped, not refused, and a tab is no control character here.
    const fine = calendarOf({ uid: "new-3@atelier.example", dtstamp: stamp, start, summary: "Glazing\nsecond\tround", organizer: { email: "mila.brunner@atelier.example", name: "Mila\nBrunner" } });
    expect(fine.ok && unfold(fine.text).filter((l) => /^(SUMMARY|ORGANIZER)/.test(l))).toEqual(["SUMMARY:Glazing\\nsecond\tround", "ORGANIZER;CN=Mila^nBrunner:mailto:mila.brunner@atelier.example"]);
    expect(makeParam("CN", ["Mila\nBrunner"]).raw).toBe("Mila^nBrunner");
  });

  it("takes one more event beside the ones it has", () => {
    const calendar = read(icloud_wheel_class);
    const extra = read(text(google_holidays)).events[0]!;
    const more = withNewEvent(calendar, extra);
    // iCloud writes its zone definition after the events: the new event goes after the last event, before it.
    expect(more.tree.components.map((c) => c.name)).toEqual(["VEVENT", "VEVENT", "VEVENT", "VTIMEZONE"]);
    expect(more.events[2]!.component).toBe(extra.component);
    expect(unfold(write(more)).length).toBe(unfold(text(icloud_wheel_class)).length + unfold(textOf(writeComponent(extra.component))).length);
  });
});
