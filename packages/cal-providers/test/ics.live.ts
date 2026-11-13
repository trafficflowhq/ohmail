/**
 * LIVE: two public holiday feeds, read through the request port a hosted server uses, with the
 * platform's own lookup. No account and no secret: both are public files, asked once each and once
 * more with the token. It prints statuses, counts and booleans, and nothing of a body.
 *
 *   npx vitest run --config packages/cal-providers/vitest.live.config.ts packages/cal-providers/test/ics.live.ts
 */
import { intlZones } from "@ohmail/cal-core";
import { nodeHostResolver } from "@trafficflow/core/net";
import { describe, expect, it } from "vitest";
import { makeCalendarProviders } from "../src/index.js";
import type { Connection, ProviderWord } from "../src/port.js";

const FEEDS: [string, string][] = [
  ["a mail program's Swiss holidays", "https://www.thunderbird.net/media/caldata/autogen/SwissHolidays.ics"],
  ["Google's holidays, typed as webcal", "webcal://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics"],
];
const providers = makeCalendarProviders({ clock: { now: () => Date.now() }, zones: intlZones(), resolver: nodeHostResolver, policy: { kind: "cloud" }, enabled: new Set<ProviderWord>(["ics"]), microsoft: null });
const reader = providers.get("ics")!.reader;
const page = { limit: 250, cursor: null, window: null };

describe("a public holiday feed, live", () => {
  for (const [name, address] of FEEDS) {
    it(`is read whole: ${name}`, async () => {
      const subscription: Connection = { provider: "ics", credential: { kind: "address", url: () => address }, start: null };
      const signal = new AbortController().signal;
      const first = await reader.readChanges(subscription, { id: "subscription" }, null, page, signal);
      if (!first.ok) console.log(`${name}: refused ${first.reason}${first.read === undefined ? "" : ` (${first.read})`}`);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const events = first.value.items.filter((item) => item.kind === "upsert");
      const wholeDays = events.filter((item) => item.kind === "upsert" && item.event.start?.kind === "date").length;
      const token = first.value.cursor.kind === "end" ? first.value.cursor.token : null;
      const again = await reader.readChanges(subscription, { id: "subscription" }, token, page, signal);
      const listed = await reader.listCalendars(subscription, signal);
      console.log(`${name}: events ${events.length} | whole days ${wholeDays} | left out ${first.value.left.length} | the file's own interval ${first.value.refreshMs !== null} | asked again: ${again.ok ? `unchanged ${again.value.unchanged}` : again.reason} | named ${listed.ok && listed.value[0]!.name !== null}`);
      expect(events.length).toBeGreaterThan(50);
      expect(wholeDays).toBe(events.length);
      expect(first.value.left).toEqual([]);
      expect(again.ok).toBe(true);
    }, 90_000);
  }
});
