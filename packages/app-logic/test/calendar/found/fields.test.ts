/**
 * WHAT ADD WRITES for an event found in a letter: a whole day ends the next day; a start with no end lasts the
 * default length, worked out on the event's own clock across a change of hour; nothing of the letter's words goes
 * into the event.
 */
import { describe, expect, it } from "vitest";
import { FOUND_DEFAULT_LENGTH_MINUTES, intlZones } from "@ohmail/cal-core";
import { fieldsOf } from "../../../src/calendar/found/index.js";
import { ZURICH, suggestion } from "../invitations/fixtures.js";

const zones = intlZones();

describe("the event an offer makes", () => {
  it("makes a whole day end on the next day", () => {
    const s = suggestion("a", "data", {
      proposed: { title: "Fair", start: { kind: "date", value: "20261121" }, end: null, place: "Messe" },
    });
    expect(fieldsOf(s, zones)).toMatchObject({
      title: "Fair",
      start: { kind: "date", value: "20261121" },
      end: { kind: "date", value: "20261122" },
      place: "Messe",
    });
  });

  it("keeps the end the letter gave", () => {
    const s = suggestion("a", "calendar");
    expect(fieldsOf(s, zones)).toMatchObject({
      start: { kind: "zoned", value: "20261120T190000", zone: ZURICH },
      end: { kind: "zoned", value: "20261120T210000", zone: ZURICH },
    });
  });

  it("gives a start with no end the default length, as time passes across the change of hour", () => {
    expect(FOUND_DEFAULT_LENGTH_MINUTES).toBe(60);
    const s = suggestion("a", "calendar", {
      proposed: {
        title: "Night train",
        start: { kind: "zoned", value: "20270328T013000", zone: ZURICH },
        end: null,
        place: null,
      },
    });
    /* At two the clocks go to three: an hour after half past one reads half past three. */
    expect(fieldsOf(s, zones)?.end).toEqual({ kind: "zoned", value: "20270328T033000", zone: ZURICH });
    const plain = suggestion("b", "calendar", {
      proposed: {
        title: "Talk",
        start: { kind: "zoned", value: "20261120T190000", zone: ZURICH },
        end: null,
        place: null,
      },
    });
    expect(fieldsOf(plain, zones)?.end).toEqual({ kind: "zoned", value: "20261120T200000", zone: ZURICH });
  });

  it("writes no word of the letter into the event, and makes no event of a time it cannot read", () => {
    const s = suggestion("a", "calendar", { sourceWords: "Friday at 7pm, bring the keys" });
    const fields = fieldsOf(s, zones)!;
    expect(fields).toMatchObject({ notes: null, invitees: [], repeat: null, callLink: null });
    expect(JSON.stringify(fields)).not.toContain("bring the keys");
    const unread = suggestion("b", "calendar", {
      proposed: { title: "x", start: { kind: "zoned", value: "soon", zone: ZURICH }, end: null, place: null },
    });
    expect(fieldsOf(unread, zones)).toBeNull();
  });
});
