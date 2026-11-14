import { describe, expect, it } from "vitest";
import { derivedRange, eventTimeOf, storedTimeOf, type EventRangeInput } from "../src/calendar/index.js";

/**
 * THE ONE PLACE A ROW'S RANGE IS WORKED OUT: exact for an instant and a known zone, a day or a
 * clock nobody named read as UTC, a series' end found by walking its rule, never guessed.
 */
const base: EventRangeInput = { start: { kind: "instant", value: "20261114T080000Z" }, end: null, duration: null, rules: [], added: [], recurrenceId: "" };
const iso = (d: Date | null | undefined) => (d == null ? null : d.toISOString());
const range = (over: Partial<EventRangeInput>) => {
  const r = derivedRange({ ...base, ...over });
  return r === null ? null : { startsAt: iso(r.startsAt), endsAt: iso(r.endsAt), occurrenceAt: iso(r.occurrenceAt) };
};

describe("a row's derived range", () => {
  it("an instant with an end, and one with a length", () => {
    expect(range({ end: { kind: "instant", value: "20261114T093000Z" } }))
      .toEqual({ startsAt: "2026-11-14T08:00:00.000Z", endsAt: "2026-11-14T09:30:00.000Z", occurrenceAt: null });
    expect(range({ duration: "PT45M" })?.endsAt).toBe("2026-11-14T08:45:00.000Z");
  });

  it("a clock time in a zone this host knows is exact; a floating one and an unknown zone are read as UTC", () => {
    expect(range({ start: { kind: "zoned", value: "20261114T090000", zone: "Europe/Zurich" } })?.startsAt).toBe("2026-11-14T08:00:00.000Z");
    expect(range({ start: { kind: "floating", value: "20261114T090000" } })?.startsAt).toBe("2026-11-14T09:00:00.000Z");
    expect(range({ start: { kind: "zoned", value: "20261114T090000", zone: "Nowhere/Unknown" } })?.startsAt).toBe("2026-11-14T09:00:00.000Z");
  });

  it("a day with no end lasts the day", () => {
    expect(range({ start: { kind: "date", value: "20261114" } }))
      .toEqual({ startsAt: "2026-11-14T00:00:00.000Z", endsAt: "2026-11-15T00:00:00.000Z", occurrenceAt: null });
  });

  it("a series ends with its last occurrence, by its count or its until; one with neither never ends", () => {
    expect(range({ duration: "PT1H", rules: ["FREQ=WEEKLY;COUNT=3"] })?.endsAt).toBe("2026-11-28T09:00:00.000Z");
    expect(range({ duration: "PT1H", rules: ["FREQ=MONTHLY;BYMONTHDAY=31;COUNT=2"], start: { kind: "instant", value: "20261231T080000Z" } })?.endsAt)
      .toBe("2027-01-31T09:00:00.000Z");
    expect(range({ duration: "PT1H", rules: ["FREQ=DAILY;UNTIL=20261120T080000Z"] })?.endsAt).toBe("2026-11-20T09:00:00.000Z");
    expect(range({ rules: ["FREQ=WEEKLY"] })?.endsAt).toBeNull();
    expect(range({ rules: ["NOT A RULE"] })?.endsAt).toBeNull();
  });

  it("an added date widens the range either way", () => {
    expect(range({ duration: "PT1H", added: [{ kind: "instant", value: "20261101T080000Z" }, { kind: "instant", value: "20261201T080000Z" }] }))
      .toMatchObject({ startsAt: "2026-11-01T08:00:00.000Z", endsAt: "2026-12-01T09:00:00.000Z" });
  });

  it("the occurrence a row replaces is placed from its key, and an unplaceable one is refused", () => {
    expect(range({ recurrenceId: String(Date.UTC(2026, 10, 21, 8)) })?.occurrenceAt).toBe("2026-11-21T08:00:00.000Z");
    expect(range({ recurrenceId: "|20261121T0900|false" })?.occurrenceAt).toBe("2026-11-21T09:00:00.000Z");
    expect(range({ recurrenceId: "garbage" })).toBeNull();
  });

  it("a start no writer of this product wrote is refused, never stored", () => {
    expect(range({ start: { kind: "instant", value: "20261114T080000" } })).toBeNull();
    expect(range({ start: { kind: "zoned", value: "20261114T080000" } })).toBeNull();
    expect(range({ start: { kind: "date", value: "2026-11-14" } })).toBeNull();
  });

  it("the stored form round-trips the core's times", () => {
    for (const t of [
      { kind: "date", value: "20261114" }, { kind: "instant", value: "20261114T080000Z" },
      { kind: "zoned", value: "20261114T090000", zone: "Europe/Zurich" }, { kind: "floating", value: "20261114T090000" },
    ] as const) {
      const core = eventTimeOf(t);
      expect(core).not.toBeNull();
      expect(storedTimeOf(core!)).toEqual(t);
    }
  });
});
