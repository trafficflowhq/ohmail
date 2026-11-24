/**
 * THE CALDAV WRITER AT THE BENCH'S OWN SERVER, live: a new event written twice under one key is one
 * member, a change against a tag the server moved past is refused and writes nothing, and the
 * event is removed again, so the bench's planted set stands as it stood. Only the bench's server
 * (on this machine) is asked: a provider's real account meets the writer in the preview batch.
 *
 *   OHCAL_CAL_BENCH_ENV_FILE=<the bench's file> npx vitest run --config packages/cal-providers/vitest.live.config.ts packages/cal-providers/test/caldav-writer.live.ts
 *
 * Prints statuses, counts and words; never an address, a password, a title of the planted set.
 */
import { randomBytes } from "node:crypto";
import { intlZones, wall, zoned } from "@ohmail/cal-core";
import { nodeHostResolver } from "@trafficflow/core/net";
import { describe, expect, it } from "vitest";
import { makeReader, makeWriter } from "../src/caldav/index.js";
import type { Connection, WriteAnswer } from "../src/port.js";
import { namedHostRequest } from "../src/request/index.js";
import { BENCH_CALENDAR } from "./support/bench-events.ts";
import { readCalBenchEnv } from "./support/calendar-test-accounts.ts";

const ZONES = intlZones();
const CLOCK = { now: () => Date.now() };
const say = (line: string): void => void process.stdout.write(`${line}\n`);
const word = (a: WriteAnswer): string => (a.ok ? "ok" : a.reason);

describe("the CalDAV writer at the bench's server", () => {
  it(
    "one key is one member, a stale tag writes nothing, and the bench's set stands as it stood",
    { timeout: 120_000 },
    async () => {
      if (!process.env.OHCAL_CAL_BENCH_ENV_FILE && !process.env.OHCAL_CALDAV_BENCH_URL) {
        say("caldav-writer-live bench: NOT ASKED (its place is not named to this run)");
        return;
      }
      const bench = readCalBenchEnv(process.env);
      if (
        !bench.OHCAL_CALDAV_BENCH_URL ||
        !bench.OHCAL_CALDAV_BENCH_USER ||
        !bench.OHCAL_CALDAV_BENCH_PASSWORD
      )
        throw new Error("the CalDAV bench is not named");
      const password = bench.OHCAL_CALDAV_BENCH_PASSWORD;
      const c: Connection = {
        provider: "caldav",
        start: bench.OHCAL_CALDAV_BENCH_URL,
        credential: { kind: "basic", user: bench.OHCAL_CALDAV_BENCH_USER, password: () => password },
      };
      const http = namedHostRequest({
        writes: true,
        resolver: nodeHostResolver,
        policy: { kind: "own-network" },
      });
      const reader = makeReader({ http, clock: CLOCK, zones: ZONES });
      const writer = makeWriter({ http, clock: CLOCK, zones: ZONES });
      const signal = new AbortController().signal;

      const listed = await reader.listCalendars(c, signal);
      const cal = listed.ok ? (listed.value.find((k) => k.name === BENCH_CALENDAR) ?? null) : null;
      say(
        `caldav-writer-live bench: calendars ${listed.ok ? "ok" : listed.reason}, bench calendar ${cal === null ? "missing" : "found"}`,
      );
      expect(cal).not.toBeNull();
      const count = async (): Promise<number> => {
        const page = await reader.readChanges(
          c,
          { id: cal!.id },
          null,
          { limit: 250, cursor: null, window: null },
          signal,
        );
        return page.ok
          ? new Set(page.value.items.filter((i) => i.kind === "upsert").map((i) => i.id)).size
          : -1;
      };
      const before = await count();
      const key = { hex: randomBytes(16).toString("hex") };
      const draft = {
        start: zoned(wall(2026, 11, 26, 9), "Europe/Zurich"),
        end: zoned(wall(2026, 11, 26, 10), "Europe/Zurich"),
        summary: "cal-write live trial",
        description: null,
        location: null,
        url: null,
        busy: true,
        private: false,
        rule: null,
        organizer: null,
        attendees: [],
        alarms: [],
      };
      const first = await writer.create(c, { id: cal!.id }, { key, event: draft }, signal);
      const again = await writer.create(c, { id: cal!.id }, { key, event: draft }, signal);
      const made = first.ok ? first.items.find((i) => i.kind === "upsert") : undefined;
      const afterCreate = await count();
      say(
        `caldav-writer-live bench: create ${word(first)}, again ${word(again)}, members ${before} -> ${afterCreate}, same answer ${JSON.stringify(first) === JSON.stringify(again)}`,
      );
      expect([word(first), word(again), afterCreate - before]).toEqual(["ok", "ok", 1]);
      expect(made?.kind).toBe("upsert");
      const target =
        made!.kind === "upsert"
          ? { id: made!.id, version: made!.version, text: made!.text, occurrence: null }
          : null;

      const changed = await writer.change(
        c,
        { id: cal!.id },
        target!,
        { summary: "cal-write live trial, changed" },
        signal,
      );
      const stale = await writer.change(
        c,
        { id: cal!.id },
        target!,
        { summary: "cal-write live trial, stale" },
        signal,
      );
      say(`caldav-writer-live bench: change ${word(changed)}, the same change on the old tag ${word(stale)}`);
      expect([word(changed), word(stale)]).toEqual(["ok", "version_stale"]);
      const now = changed.ok ? changed.items.find((i) => i.kind === "upsert") : undefined;
      const removed = await writer.remove(
        c,
        { id: cal!.id },
        { ...target!, version: now?.kind === "upsert" ? now.version : target!.version },
        signal,
      );
      const after = await count();
      say(
        `caldav-writer-live bench: remove ${word(removed)}, members ${afterCreate} -> ${after} (as before: ${after === before})`,
      );
      expect([word(removed), after]).toEqual(["ok", before]);
    },
  );
});
