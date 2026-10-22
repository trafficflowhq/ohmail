import { describe, it, expect } from "vitest";
import { distinctCalendarEvents, formatIcsWhen, icsDateGlyph, parseIcsEvent, type IcsTime } from "../src/ics.js";
import { icsWithDuration } from "./fixtures/invite-shapes.js";

/**
 * A CRAFTED INVITE CANNOT MAKE THE CARD THROW. With no DTEND, the end is derived from DURATION,
 * which takes any number of digits: P999999999D put the end past the range of a Date and
 * `Intl.DateTimeFormat` threw "Invalid time value" during render, taking the reader down. A derived
 * end outside that range is dropped (the start-only line), and the formatters skip any date they
 * cannot format.
 */

const opts = { locale: "en", zone: "Europe/Zurich", allDay: "All day" };

const HOSTILE: Array<[string, string, string]> = [
  ["zoned, days", "DTSTART;TZID=Europe/Zurich:20261027T140000", "P999999999D"],
  ["zoned, hours", "DTSTART;TZID=Europe/Zurich:20261027T140000", "PT99999999999H"],
  ["UTC, days", "DTSTART:20261027T130000Z", "P100000000D"],
  ["floating", "DTSTART:20261027T140000", "P999999999D"],
  ["400 digits", "DTSTART;TZID=Europe/Zurich:20261027T140000", `P${"9".repeat(400)}D`],
];

describe("a DURATION past the range of a Date", () => {
  for (const [name, dtstart, duration] of HOSTILE) {
    it(`${name}: the event parses, keeps no end, and its lines format`, () => {
      const ev = parseIcsEvent(icsWithDuration(dtstart, duration));
      expect(ev, "the event was dropped").not.toBeNull();
      expect(ev!.end, "an end outside the range of a Date was kept").toBeNull();
      const when = formatIcsWhen(ev!.start, ev!.end, opts);
      expect(when).toMatch(/2026/);
      expect(when).not.toMatch(/–/);
      expect(icsDateGlyph(ev!.start, opts).day).toBe("27");
      expect(distinctCalendarEvents([{ id: "p", contentType: "text/calendar", text: icsWithDuration(dtstart, duration) }])).toHaveLength(1);
    });
  }

  it("control: a sane DURATION still gives the end", () => {
    const ev = parseIcsEvent(icsWithDuration("DTSTART;TZID=Europe/Zurich:20261027T140000", "PT1H"));
    expect(ev!.end?.epochMs).toBe(ev!.start.epochMs! + 3600_000);
    expect(formatIcsWhen(ev!.start, ev!.end, opts)).toMatch(/2:00\s?PM – 3:00\s?PM/);
  });
});

describe("the formatters never throw on a date they cannot format", () => {
  const start: IcsTime = { epochMs: Date.UTC(2026, 9, 27, 13), wall: { year: 2026, month: 10, day: 27, hour: 14, minute: 0 }, allDay: false, tzid: "Europe/Zurich", utc: false };
  const beyond: IcsTime = { epochMs: 8.64e16, wall: { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN }, allDay: false, tzid: "Europe/Zurich", utc: false };

  it("an end beyond range: the start-only line", () => {
    expect(formatIcsWhen(start, beyond, opts)).toBe(formatIcsWhen(start, null, opts));
  });

  it("a floating end with no wall date: the start-only line", () => {
    const floatStart = { ...start, epochMs: null, tzid: null };
    expect(formatIcsWhen(floatStart, { ...beyond, epochMs: null, tzid: null }, opts)).toBe(formatIcsWhen(floatStart, null, opts));
  });

  it("a start beyond range: a string, never a throw", () => {
    expect(typeof formatIcsWhen(beyond, null, opts)).toBe("string");
    expect(icsDateGlyph(beyond, opts)).toEqual({ month: "", day: "" });
    expect(typeof formatIcsWhen({ ...beyond, allDay: true }, { ...beyond, allDay: true }, opts)).toBe("string");
  });
});
