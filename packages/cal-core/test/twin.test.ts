/**
 * Two readers of one format. The core package's invitation reader draws the event card and is in
 * the phone's engine; this package reads whole calendars and is not. They share no code, on purpose,
 * so this file is what notices if they drift: every text of the corpus through both, and every
 * Windows zone name through both.
 *
 * Where they differ by design, the difference is named here and nowhere hidden:
 *  - the card's reader drops seconds; times are compared to the minute;
 *  - the card's reader resolves a clock time the clock skips an hour early (see the last test).
 */
import { parseIcsEvent } from "@trafficflow/core/ics";
import { describe, expect, it } from "vitest";
import { readCalendar } from "../src/ical/calendar.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { recurrenceKeyOf, recurrenceKeyString } from "../src/recur/key.js";
import { dayNumber, resolveWall } from "../src/time/arith.js";
import { wall, type EventTime } from "../src/time/types.js";
import { WINDOWS_ZONES } from "../src/time/windows-zones.js";
import { intlZones } from "../src/time/zones.js";
import { CORPUS } from "./corpus/index.js";
import { iso, oneEvent, text } from "./support.js";

/** The card's reader knows the platform's zones only, so the comparison uses the same. */
const platform = intlZones();
const MINUTE = 60_000;
const toTheMinute = (ms: number | null): number | null => (ms === null ? null : Math.floor(ms / MINUTE) * MINUTE);

/** A start as the card's reader states it: the instant it claims (a day's UTC midnight for a whole day), or none. */
function claimed(t: EventTime | null): { epochMs: number | null; allDay: boolean } | null {
  if (t === null) return null;
  if (t.kind === "date") return { epochMs: dayNumber(t) * 86_400_000, allDay: true };
  if (t.kind === "floating") return { epochMs: null, allDay: false };
  return { epochMs: toTheMinute(t.kind === "instant" ? t.epochMs : resolveWall(t.wall, t.tzid, platform)), allDay: false };
}

describe("the invitation card's reader and this one agree", () => {
  it.each(CORPUS.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    const card = parseIcsEvent(text(fixture));
    const read = readCalendar(text(fixture), DEFAULT_LIMITS);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const first = read.calendar.events[0] ?? null;
    if (card === null) {
      // The card refuses an event with no start; this reader keeps it and says the start is missing.
      expect(first?.start ?? null).toBeNull();
      return;
    }
    expect(first).not.toBeNull();
    expect(first!.uid).toBe(card.uid);
    expect(first!.sequence).toBe(card.sequence);
    expect(first!.recurrenceId === null ? null : recurrenceKeyString(recurrenceKeyOf(first!.recurrenceId, platform))).toBe(card.recurrenceId);
    expect(claimed(first!.start)).toEqual({ epochMs: toTheMinute(card.start.epochMs), allDay: card.start.allDay });
    expect(read.calendar.method === null ? null : read.calendar.method).toBe(card.method);
    expect(first!.organizer?.email ?? null).toBe(card.organizer?.email ?? null);
    expect(first!.attendees.length).toBe(card.attendeeCount);
  });

  it("read the same instant from every Windows zone name, in winter and in summer", () => {
    let resolved = 0;
    for (const name of Object.keys(WINDOWS_ZONES)) {
      for (const [month, compact] of [[1, "20260115T120000"], [7, "20260715T120000"]] as const) {
        const card = parseIcsEvent(oneEvent([`DTSTART;TZID=${name}:${compact}`]));
        const mine = resolveWall(wall(2026, month, 15, 12, 0), name, platform);
        expect(card?.start.epochMs ?? null, `${name} in month ${month}`).toBe(mine);
        if (mine !== null) resolved++;
      }
    }
    // Nearly all of them are names the platform knows; a table that resolved nothing would agree about nothing.
    expect(resolved).toBeGreaterThan(250);
  });

  it("differ on a clock time the clock skips, and this is the difference", () => {
    // New York, 11 March 2007, 02:30: the clocks went from 02:00 to 03:00. RFC 5545 3.3.5 reads the time
    // "using the UTC offset before the gap": 07:30 UTC. The card's reader lands an hour early.
    const card = parseIcsEvent(oneEvent(["DTSTART;TZID=America/New_York:20070311T023000"]));
    expect(iso(resolveWall(wall(2007, 3, 11, 2, 30), "America/New_York", platform)!)).toBe("2007-03-11T07:30:00Z");
    expect(iso(card!.start.epochMs!)).toBe("2007-03-11T06:30:00Z");
    // A time the clock shows twice is the first of the two for both.
    const twice = parseIcsEvent(oneEvent(["DTSTART;TZID=America/New_York:20071104T013000"]));
    expect(twice!.start.epochMs).toBe(resolveWall(wall(2007, 11, 4, 1, 30), "America/New_York", platform));
  });
});
