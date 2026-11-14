/**
 * THE ONE GATE TO AN OFFER: only an event read from a letter's own calendar part or its own data may be offered; a
 * reading of its sentences, by the rules or checked from a model, is never shown while the tracked wrong readings
 * stand; a word the gate does not know is never offered.
 */
import { describe, expect, it } from "vitest";
import { intlZones, FOUND_EVIDENCE } from "@ohmail/cal-core";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarSuggestionRecord } from "@ohmail/wire";
import { OFFERED_EVIDENCE, foundCountOf, foundOf, mayOffer } from "../../../src/calendar/found/index.js";
import { ZURICH, calendarOf, event, suggestion } from "../invitations/fixtures.js";

const zones = intlZones();

function rowsOf(
  suggestions: readonly CalendarSuggestionRecord[],
  events: readonly EventWithWrites[] = [],
  calendars = [calendarOf()],
) {
  return foundOf({
    suggestions,
    events,
    calendars,
    todayKey: "2026-11-16",
    zone: ZURICH,
    zones,
  });
}

describe("which events found in mail may be offered", () => {
  it("lets through the letter's calendar part and its data, and neither reading of its sentences", () => {
    expect(FOUND_EVIDENCE.filter((e) => mayOffer({ evidence: e }))).toEqual(["calendar", "data"]);
    expect(mayOffer({ evidence: "sentence" })).toBe(false);
    expect(mayOffer({ evidence: "sentence_model" })).toBe(false);
    expect(mayOffer({ evidence: "rumour" })).toBe(false);
    expect(mayOffer({ evidence: "" })).toBe(false);
    expect([...OFFERED_EVIDENCE]).toEqual(["calendar", "data"]);
  });

  it("lists and counts only what the gate lets through", () => {
    const all = [
      suggestion("a", "calendar"),
      suggestion("b", "data"),
      suggestion("c", "sentence"),
      suggestion("d", "sentence_model"),
      suggestion("e", "Calendar"),
    ];
    expect(rowsOf(all).map((r) => r.id)).toEqual(["a", "b"]);
    expect(foundCountOf(rowsOf(all))).toBe(2);
  });

  it("offers nothing that starts before today, nor a time it cannot read", () => {
    const past = suggestion("past", "calendar", {
      proposed: { title: "Past", start: { kind: "date", value: "20261115" }, end: null, place: null },
    });
    const today = suggestion("today", "calendar", {
      proposed: { title: "Today", start: { kind: "date", value: "20261116" }, end: null, place: null },
    });
    const unread = suggestion("unread", "calendar", {
      proposed: {
        title: "Unread",
        start: { kind: "zoned", value: "next friday", zone: ZURICH },
        end: null,
        place: null,
      },
    });
    expect(rowsOf([past, today, unread]).map((r) => r.id)).toEqual(["today"]);
  });

  it("says an event already on a shown calendar at the same start and title is there, and leads to it", () => {
    const found = suggestion("a", "calendar", {
      proposed: {
        title: "Opening",
        start: { kind: "zoned", value: "20261120T190000", zone: ZURICH },
        end: null,
        place: null,
      },
    });
    const on = event("ev-9", "20261120", {
      title: "Opening",
      start: { kind: "instant", value: "20261120T180000Z" },
      end: { kind: "instant", value: "20261120T190000Z" },
    });
    const held = (r: typeof on): EventWithWrites => ({
      record: r,
      waiting: null,
      refusal: null,
      refusedWriteId: null,
    });
    expect(rowsOf([found], [held(on)])[0]!.alreadyOn).toEqual({
      event: "ev-9",
      occurrence: null,
      day: "2026-11-20",
    });
    expect(rowsOf([found], [held(on)], [calendarOf({ access: "busy" })])[0]!.alreadyOn).toBeNull();
    expect(rowsOf([found], [held({ ...on, title: "Another" })])[0]!.alreadyOn).toBeNull();
    expect(rowsOf([found], [held({ ...on, calendarId: "cal-hidden" })])[0]!.alreadyOn).toBeNull();
  });
});
