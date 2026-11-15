/**
 * LIVE: the CalDAV reader against servers that are really there. Never part of the default run:
 * this file is named `*.live.ts`, and only the package's own configuration for such files reads it.
 *
 *   OHCAL_CAL_BENCH_ENV_FILE=<the bench's env file> OHCAL_TEST_ACCOUNTS_FILE=<the accounts file> \
 *     npx vitest run --config packages/cal-providers/vitest.live.config.ts packages/cal-providers/test/caldav.live.ts
 *
 * One list of servers, as in the recorded proof: the bench's own server on this machine, and the
 * test account at a hosted provider. A server whose place is not named is not asked, and says so.
 * Each holds the bench's invented set in a calendar of the bench's name: five stored objects, six
 * events (one of the five is a series with a changed day).
 *
 * It only reads: three PROPFINDs and two kinds of REPORT. It prints counts, words of the closed
 * list and yes or no, and it compares nothing else, so that a failure shows none of a server's own
 * text: no address, no name, no identifier.
 */
import { intlZones } from "@ohmail/cal-core";
import { nodeHostResolver } from "@trafficflow/core/net";
import { describe, expect, it } from "vitest";
import { makeReader } from "../src/caldav/index.js";
import type { ChangeToken, Connection } from "../src/port.js";
import { namedHostRequest, type AddressPolicy } from "../src/request/index.js";
import { BENCH_CALENDAR } from "./support/bench-events.ts";
import { readCalBenchEnv, readCalendarTestAccounts } from "./support/calendar-test-accounts.ts";

interface LiveRow {
  readonly name: string;
  /** Which servers this deployment may ask: the bench's is on this machine, the hosted one is asked as a hosted server would. */
  readonly policy: AddressPolicy;
  /** The sign-in, or `null` when its place was not named to this run. */
  readonly connection: () => Connection | null;
  /** Whether a wrong password is tried. Never at a provider that counts failures against a real account. */
  readonly triesWrongPassword: boolean;
}

const env = (name: string): string | undefined => process.env[name];
const basic = (start: string, user: string, password: string): Connection => ({ provider: "caldav", credential: { kind: "basic", user, password: () => password }, start });

const CALDAV_LIVE_ROWS: readonly LiveRow[] = [
  {
    name: "bench",
    policy: { kind: "own-network" },
    triesWrongPassword: true,
    connection() {
      if (!env("OHCAL_CAL_BENCH_ENV_FILE") && !env("OHCAL_CALDAV_BENCH_URL")) return null;
      const bench = readCalBenchEnv(process.env);
      if (!bench.OHCAL_CALDAV_BENCH_URL || !bench.OHCAL_CALDAV_BENCH_USER || !bench.OHCAL_CALDAV_BENCH_PASSWORD) throw new Error("the CalDAV bench is not named");
      return basic(bench.OHCAL_CALDAV_BENCH_URL, bench.OHCAL_CALDAV_BENCH_USER, bench.OHCAL_CALDAV_BENCH_PASSWORD);
    },
  },
  {
    name: "icloud",
    policy: { kind: "cloud" },
    triesWrongPassword: false,
    connection() {
      if (!env("OHCAL_TEST_ACCOUNTS_FILE")) return null;
      const accounts = readCalendarTestAccounts(process.env);
      // An app password is shown in groups; the server takes it joined.
      return basic("caldav.icloud.com", accounts.ICLOUD_APPLE_ID.reveal(), accounts.ICLOUD_APP_PASSWORD.reveal().replaceAll(" ", ""));
    },
  },
];

const ZONES = intlZones();
const CLOCK = { now: () => Date.now() };
const say = (line: string): void => void process.stdout.write(`${line}\n`);

describe.each(CALDAV_LIVE_ROWS)("the CalDAV reader at $name", (row) => {
  it("finds the calendars, reads the bench's calendar whole and then nothing from its token", { timeout: 180_000 }, async () => {
    const c = row.connection();
    if (c === null) {
      say(`caldav-live ${row.name}: NOT ASKED (its place is not named to this run)`);
      return;
    }
    const reader = makeReader({ http: namedHostRequest({ resolver: nodeHostResolver, policy: row.policy }), clock: CLOCK, zones: ZONES });
    const signal = AbortSignal.timeout(150_000);
    /** What was read against what the bench planted: numbers, words and yes or no only. */
    const read: Record<string, number | string | boolean> = {};
    const wanted: Record<string, number | string | boolean> = {};
    const check = (what: string, got: number | string | boolean, want: number | string | boolean): void => {
      read[what] = got;
      wanted[what] = want;
    };
    try {
      const who = await reader.checkSignIn(c, signal);
      check("sign-in", who.ok ? "ok" : who.reason, "ok");
      if (who.ok) say(`caldav-live ${row.name}: principal named=${who.value.principal !== null} own addresses=${who.value.addresses.length}`);

      const calendars = await reader.listCalendars(c, signal);
      check("calendars", calendars.ok ? "ok" : calendars.reason, "ok");
      const bench = calendars.ok ? calendars.value.filter((k) => k.name === BENCH_CALENDAR) : [];
      check("the bench's calendar", bench.length, 1);
      if (calendars.ok) say(`caldav-live ${row.name}: calendars for events=${calendars.value.length} by token=${calendars.value.filter((k) => k.byToken).length} writable=${calendars.value.filter((k) => k.writable).length}`);

      if (bench.length === 1) {
        const cal = { id: bench[0]!.id };
        // In pages of two, so that the listing is asked three times and cut twice.
        const ids = new Set<string>();
        let events = 0;
        let left = 0;
        let pages = 0;
        let token: ChangeToken | null = null;
        let mode = "";
        for (let cursor: string | null = null; pages < 20; ) {
          const answer = await reader.readChanges(c, cal, null, { limit: 2, cursor, window: null }, signal);
          if (!answer.ok) {
            check(`page ${pages + 1}`, answer.reason, "ok");
            break;
          }
          pages++;
          mode = answer.value.mode;
          left += answer.value.left.length;
          for (const item of answer.value.items) {
            if (item.kind !== "upsert") continue;
            ids.add(item.id);
            events++;
          }
          if (answer.value.cursor.kind === "end") {
            token = answer.value.cursor.token;
            break;
          }
          cursor = answer.value.cursor.value;
        }
        check("mode", mode, "whole");
        check("stored objects", ids.size, 5);
        check("events", events, 6);
        check("left out", left, 0);
        check("pages", pages, 3);
        check("a token to go on from", token !== null, bench[0]!.byToken);

        if (token !== null) {
          const again = await reader.readChanges(c, cal, token, { limit: 250, cursor: null, window: null }, signal);
          check("the round from the token", again.ok ? `${again.value.mode} ${again.value.unchanged ? "unchanged" : again.value.items.length}` : again.reason, bench[0]!.byToken ? "delta 0" : "whole unchanged");
          if (bench[0]!.byToken) {
            // A token the server never gave out stands for one it has thrown away.
            const dead = await reader.readChanges(c, cal, { provider: "caldav", value: "sync:http://sync.invalid/ns/sync/0000" }, { limit: 250, cursor: null, window: null }, signal);
            check("a token the server does not know", dead.ok ? "read" : dead.reason, "token_gone");
          }
        }
      }

      if (row.triesWrongPassword && c.credential.kind === "basic") {
        const refused = await reader.checkSignIn({ ...c, credential: { kind: "basic", user: c.credential.user, password: () => ["not", "the", "password"].join("-") } }, signal);
        check("a wrong password", refused.ok ? "ok" : refused.reason, "sign_in_refused");
      }
    } catch (fault) {
      // A fault's own text may hold what a server wrote: only its kind is told.
      check("fault", fault instanceof Error ? fault.name : "thrown", "none");
    }
    say(`caldav-live ${row.name}: ${Object.entries(read).map(([what, got]) => `${what}=${String(got)}`).join(" | ")}`);
    expect(read).toEqual(wanted);
  });
});
