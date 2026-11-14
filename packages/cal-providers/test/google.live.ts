/**
 * LIVE: Google's reading on the bench's test account, through the request port a hosted server uses
 * and the package's own trade of the lasting sign-in. The account reaches this file through the
 * bench's reader alone, from the place whoever starts the run names (`OHCAL_TEST_ACCOUNTS_FILE`).
 * It prints statuses, counts and booleans and compares nothing but those: a failed line shows no
 * address, no sign-in and no event.
 *
 *   OHCAL_TEST_ACCOUNTS_FILE=<the place> npx vitest run --config packages/cal-providers/vitest.live.config.ts packages/cal-providers/test/google.live.ts
 *
 * Read against the bench as it was planted: two calendars, one of them writable; on that one the
 * invented set of five events, one a weekly series of six with one changed day (six records). A
 * consent that has ended is a state of the test account (it lasts a week): it is said, and is no
 * failure of the reader.
 */
import { intlZones, type CalEvent } from "@ohmail/cal-core";
import { nodeHostResolver } from "@trafficflow/core/net";
import { describe, expect, it } from "vitest";
import { googleBearer, type GoogleSignIn } from "../src/google/index.js";
import { makeCalendarProviders } from "../src/index.js";
import type { ChangeToken, Connection, ProviderWord } from "../src/port.js";
import { Secret } from "../src/secret.js";
import { readCalendarTestAccounts } from "./support/calendar-test-accounts.ts";

/** The planted set's names, as the bench's builder wrote them down. */
const PLANTED = ["Glaze firing", "Catalogue proofs", "Wheel class", "Market day", "Stall planning call"];
const SERIES = "Wheel class";
const MAX_PAGES = 40;

describe("Google's calendar, live on the bench's test account", () => {
  it("opens the sign-in, lists the calendars, reads the planted set whole and keeps the token for the next reading", async () => {
    const accounts = readCalendarTestAccounts(process.env);
    const clock = { now: () => Date.now() };
    const providers = makeCalendarProviders({ clock, zones: intlZones(), resolver: nodeHostResolver, policy: { kind: "cloud" }, enabled: new Set<ProviderWord>(["google"]), microsoft: null });
    const { reader, http } = providers.get("google")!;
    // The one place this file reveals the account's values: where the package's own holder takes them over.
    const signIn: GoogleSignIn = { client: { id: accounts.GOOGLE_OAUTH_CLIENT_ID.reveal(), secret: new Secret(accounts.GOOGLE_OAUTH_CLIENT_SECRET.reveal()) }, refreshToken: new Secret(accounts.GOOGLE_TEST_REFRESH_TOKEN.reveal()) };
    const connection: Connection = { provider: "google", credential: googleBearer({ http, clock }, signIn), start: null };
    const signal = AbortSignal.timeout(150_000);

    const who = await reader.checkSignIn(connection, signal);
    if (!who.ok && who.reason === "consent_needed") {
      console.log("google: the test consent has ended (consent_needed). One press renews it; nothing else was asked.");
      return;
    }
    const named = who.ok && who.value.principal !== null;
    console.log(`google: sign-in ${who.ok ? "ok" : who.reason} | named ${named} | by the test account's own address ${who.ok && who.value.principal !== null && accounts.GOOGLE_TEST_ACCOUNT.is(who.value.principal)}`);
    expect(who.ok).toBe(true);

    const listed = await reader.listCalendars(connection, signal);
    if (!listed.ok) console.log(`google: the calendars were refused: ${listed.reason}`);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const writable = listed.value.filter((calendar) => calendar.writable);
    console.log(`google: calendars ${listed.value.length} | writable ${writable.length} | by token ${listed.value.every((calendar) => calendar.byToken)}`);
    expect([listed.value.length, writable.length]).toEqual([2, 1]);
    const calendar = { id: writable[0]!.id };

    const events: CalEvent[] = [];
    let [pages, left, gone, cancelledDays] = [0, 0, 0, 0];
    let cursor: string | null = null;
    let token: ChangeToken | null = null;
    let whole = true;
    for (;;) {
      const answer = await reader.readChanges(connection, calendar, null, { limit: 250, cursor, window: null }, signal);
      if (!answer.ok) console.log(`google: page ${pages + 1} was refused: ${answer.reason}`);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      pages++;
      whole &&= answer.value.mode === "whole";
      left += answer.value.left.length;
      for (const item of answer.value.items) {
        if (item.kind === "upsert") events.push(item.event);
        else if (item.kind === "gone") gone++;
        else cancelledDays++;
      }
      if (answer.value.cursor.kind === "end") {
        token = answer.value.cursor.token;
        break;
      }
      cursor = answer.value.cursor.value;
      expect(pages).toBeLessThan(MAX_PAGES);
    }

    const own = events.filter((event) => event.recurrenceId === null);
    const planted = PLANTED.map((name) => own.filter((event) => event.summary === name).length);
    const series = own.filter((event) => event.summary === SERIES);
    const changedDays = events.filter((event) => event.recurrenceId !== null && event.uid !== null && series.some((s) => s.uid === event.uid)).length;
    const counts = { planted: planted.filter((n) => n === 1).length, changedDays, seriesWithOneRule: series.filter((s) => s.rules.length === 1 && s.rules[0]!.rule !== null).length, left, whole, tokenKept: token !== null };
    console.log(`google: pages ${pages} | events ${own.length} | changed days ${events.length - own.length} | removed ${gone} | cancelled days ${cancelledDays} | of the planted five ${counts.planted} | changed days of the series ${changedDays} | left out ${left} | token kept ${counts.tokenKept}`);
    expect(counts).toEqual({ planted: 5, changedDays: 1, seriesWithOneRule: 1, left: 0, whole: true, tokenKept: true });

    const again = await reader.readChanges(connection, calendar, token, { limit: 250, cursor: null, window: null }, signal);
    console.log(`google: asked again with the token: ${again.ok ? `${again.value.mode}, ${again.value.items.length} changed, ${again.value.cursor.kind === "end" && again.value.cursor.token !== null ? "a token again" : "more pages"}` : again.reason}`);
    expect(again.ok && again.value.mode).toBe("delta");
  }, 180_000);
});
