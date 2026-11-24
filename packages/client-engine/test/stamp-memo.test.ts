import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it, vi } from "vitest";
import { messageDisplayTime } from "../src/selectors.js";
import { messageStamp } from "../src/stamp.js";

/**
 * A ROW IS STAMPED ONCE PER READER DAY. `messageDisplayTime` memoises per entity object, keyed on
 * the reader's day, zone and language: a list re-derived within a day formats nothing again, the
 * day moving (or the zone, or the language) stamps again, and every memoised answer equals the
 * unmemoised rule's.
 */

const ZONE = "Europe/Zurich";
const DAY = 86_400_000;
const NOW = new Date("2026-09-29T09:00:00.000Z");

function rows(n: number): Array<Pick<EngineMessage, "time" | "date">> {
  // 30 to 120 days old: every row takes the dated band, whose month name is `Intl`-formatted.
  return Array.from({ length: n }, (_, i) => ({ date: new Date(NOW.getTime() - (30 + (i % 90)) * DAY - i * 1000).toISOString() }));
}

describe("messageDisplayTime's per-entity memo", () => {
  it("many rows stamped twice in one day format once; the next day formats again", () => {
    const list = rows(10_000);
    // `format` is an accessor returning a bound function: each read of it is one call site's use.
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype as unknown as { format: unknown }, "format", "get");
    try {
      const first = list.map((m) => messageDisplayTime(m, NOW, ZONE, "en"));
      const formattedFirst = spy.mock.calls.length;
      expect(formattedFirst).toBeGreaterThanOrEqual(list.length);
      spy.mockClear();
      const again = list.map((m) => messageDisplayTime(m, new Date(NOW.getTime() + 3_600_000), ZONE, "en"));
      expect(spy.mock.calls.length, "a warm run in the same day formatted").toBe(0);
      expect(again).toEqual(first);
      spy.mockClear();
      const tomorrow = new Date(NOW.getTime() + DAY);
      list.map((m) => messageDisplayTime(m, tomorrow, ZONE, "en"));
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(list.length);
    } finally {
      spy.mockRestore();
    }
  });

  it("equals the unmemoised rule across days, zones, languages and bands", () => {
    const list = [
      ...rows(40),
      { date: new Date(NOW.getTime() - 3_600_000).toISOString() },
      { date: new Date(NOW.getTime() - 3 * DAY).toISOString() },
      { date: new Date(NOW.getTime() + 2 * DAY).toISOString() },
      { date: null },
      { date: "not a date" },
      { time: "pinned", date: NOW.toISOString() },
    ];
    for (const zone of [ZONE, "America/New_York", "Pacific/Chatham"]) {
      for (const locale of ["en", "de"]) {
        for (const now of [NOW, new Date(NOW.getTime() + DAY), new Date("2027-01-01T00:30:00Z")]) {
          for (const m of list) expect(messageDisplayTime(m, now, zone, locale)).toBe(messageStamp(m, now, zone, locale));
        }
      }
    }
  });
});
