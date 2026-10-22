import { describe, it, expect } from "vitest";
import { calendarPartRank, distinctCalendarEvents, parseIcsEvent } from "../src/ics.js";
import {
  GOOGLE, THUNDERBIRD, TWO_EVENTS, UPDATE_SEQUENCE, ics, type InviteShape,
} from "./fixtures/invite-shapes.js";

/**
 * ONE MEETING, ONE CARD (owner report 2026-10-22: "sometimes I see the same one double"). Google
 * and Thunderbird carry the event twice, as the nameless alternative and as invite.ics, and the
 * reader drew a card per part. Cards are kept apart by the event's identity (UID, RECURRENCE-ID),
 * the newest SEQUENCE winning, never by filename or bytes.
 */

const partsOf = (shape: InviteShape) =>
  shape.parts.map((p) => ({ id: p.id, contentType: p.contentType, text: p.bytes }));

const cal = (lines: string[]): string => ["BEGIN:VCALENDAR", "METHOD:REQUEST", ...lines, "END:VCALENDAR"].join("\r\n");

describe("the event's identity is read from the first VEVENT only", () => {
  it("UID, RECURRENCE-ID and SEQUENCE come from the event, not from VTIMEZONE, VALARM or a second VEVENT", () => {
    const ev = parseIcsEvent(cal([
      "BEGIN:VTIMEZONE", "TZID:Europe/Zurich", "UID:zone-uid", "SEQUENCE:9",
      "BEGIN:STANDARD", "DTSTART:16010101T030000", "RECURRENCE-ID:16010101T030000Z", "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:event-uid@example.test", "SEQUENCE:2",
      "RECURRENCE-ID;TZID=Europe/Zurich:20261027T140000",
      "DTSTART;TZID=Europe/Zurich:20261027T150000",
      "BEGIN:VALARM", "UID:alarm-uid", "SEQUENCE:7", "TRIGGER:-PT15M", "END:VALARM",
      "END:VEVENT",
      "BEGIN:VEVENT", "UID:second-uid", "SEQUENCE:5", "RECURRENCE-ID:20261103T130000Z", "DTSTART:20261103T130000Z", "END:VEVENT",
    ]));
    expect(ev?.uid).toBe("event-uid@example.test");
    expect(ev?.sequence).toBe(2);
    expect(ev?.recurrenceId).toBe(String(Date.UTC(2026, 9, 27, 13, 0)));
  });

  it("absent or malformed identity is null", () => {
    const ev = parseIcsEvent(cal(["BEGIN:VEVENT", "SEQUENCE:-1", "DTSTART:20261027T130000Z", "END:VEVENT"]));
    expect(ev?.uid).toBeNull();
    expect(ev?.recurrenceId).toBeNull();
    expect(ev?.sequence).toBeNull();
    expect(parseIcsEvent(cal(["BEGIN:VEVENT", "SEQUENCE:99999999999", "DTSTART:20261027T130000Z", "END:VEVENT"]))?.sequence).toBeNull();
    expect(parseIcsEvent(cal(["BEGIN:VEVENT", "UID:   ", "DTSTART:20261027T130000Z", "END:VEVENT"]))?.uid).toBeNull();
  });

  it("an unresolvable RECURRENCE-ID keeps its zone, wall time and day form", () => {
    const ev = parseIcsEvent(cal([
      "BEGIN:VEVENT", "UID:u", "RECURRENCE-ID;TZID=Middle Earth Standard Time:20261027T140000", "DTSTART:20261027T130000Z", "END:VEVENT",
    ]));
    expect(ev?.recurrenceId).toBe("Middle Earth Standard Time|20261027T1400|false");
  });
});

describe("calendarPartRank: the iTIP part first", () => {
  it("text/calendar with method, then text/calendar, then application/ics", () => {
    expect(calendarPartRank("text/calendar; method=REQUEST")).toBe(0);
    expect(calendarPartRank("Text/Calendar; charset=utf-8")).toBe(1);
    expect(calendarPartRank("application/ics")).toBe(2);
  });
});

describe("distinctCalendarEvents: one card per event", () => {
  it("Google's alternative and invite.ics are one event", () => {
    const out = distinctCalendarEvents(partsOf(GOOGLE));
    expect(out).toHaveLength(1);
    expect(out[0]!.partId, "the iTIP part speaks for the event").toBe("google-alt");
  });

  it("Thunderbird's pair is one event", () => {
    expect(distinctCalendarEvents(partsOf(THUNDERBIRD))).toHaveLength(1);
  });

  it("two UIDs are two events, in the message's order", () => {
    const out = distinctCalendarEvents(partsOf(TWO_EVENTS));
    expect(out.map((e) => e.event.summary)).toEqual(["Workshop day one", "Workshop day two"]);
  });

  it("one UID with two RECURRENCE-IDs is two occurrences", () => {
    const base = ["UID:series@example.test", "SUMMARY:Series", "DTSTART:20261027T130000Z"];
    const a = cal(["BEGIN:VEVENT", ...base, "RECURRENCE-ID:20261027T130000Z", "END:VEVENT"]);
    const b = cal(["BEGIN:VEVENT", ...base, "RECURRENCE-ID:20261103T130000Z", "END:VEVENT"]);
    expect(distinctCalendarEvents([
      { id: "a", contentType: "text/calendar", text: a },
      { id: "b", contentType: "text/calendar", text: b },
    ])).toHaveLength(2);
  });

  it("the original and its update are one event, showing the update's time", () => {
    const out = distinctCalendarEvents(partsOf(UPDATE_SEQUENCE));
    expect(out).toHaveLength(1);
    expect(out[0]!.partId).toBe("update-updated");
    expect(out[0]!.event.start.wall.hour).toBe(16);
    // The order of the parts does not decide it.
    const reversed = distinctCalendarEvents([...partsOf(UPDATE_SEQUENCE)].reverse());
    expect(reversed.map((e) => e.partId)).toEqual(["update-updated"]);
  });

  it("without a UID, identical events are one, a different start is two", () => {
    const at = (start: string) => ics({ uid: null, summary: "No uid", start, end: "20261027T170000" });
    expect(distinctCalendarEvents([
      { id: "a", contentType: "text/calendar", text: at("20261027T150000") },
      { id: "b", contentType: "application/ics", text: at("20261027T150000") },
    ])).toHaveLength(1);
    expect(distinctCalendarEvents([
      { id: "a", contentType: "text/calendar", text: at("20261027T150000") },
      { id: "b", contentType: "text/calendar", text: at("20261027T160000") },
    ])).toHaveLength(2);
  });

  it("identity, never the filename: the input carries none, and same-named parts with two UIDs stay two", () => {
    // TWO_EVENTS' parts are both named invite.ics; Google's are named null and invite.ics.
    expect(TWO_EVENTS.parts.every((p) => p.filename === "invite.ics")).toBe(true);
    expect(distinctCalendarEvents(partsOf(TWO_EVENTS))).toHaveLength(2);
    expect(GOOGLE.parts.map((p) => p.filename)).toEqual([null, "invite.ics"]);
    expect(distinctCalendarEvents(partsOf(GOOGLE))).toHaveLength(1);
  });

  it("a part that does not parse is dropped", () => {
    expect(distinctCalendarEvents([
      { id: "x", contentType: "text/calendar", text: "BEGIN:VCALENDAR\r\nnothing\r\nEND:VCALENDAR" },
      ...partsOf(GOOGLE),
    ]).map((e) => e.partId)).toEqual(["google-alt"]);
  });
});
