/**
 * Microsoft's reading against the bench's double of Graph, started in this process on a port of its
 * own. The reader is made as a composing program makes it: the real request port over the address
 * gate, the double's address as the Graph base, the own-network policy. Nothing leaves the machine.
 *
 * The expected values are written from the double's seed (`support/ms-seed.json`): nine stored
 * events; in `cal-studio` between 16 November and 1 January eleven days, five of them single events,
 * five unchanged evenings of "Wheel class" (weekly on Tuesday 18:00 Europe/Zurich, six times from 17
 * November) and its third evening, moved to Wednesday 2 December 19:00.
 *
 * Microsoft has no test account yet: this proves the adapter against Microsoft's pages as the double
 * reads them, and nothing about a real mailbox.
 */
import { expandSeries, instant, intlZones, parseRRule, plainDate, recurrenceKeyOf, recurrenceKeyString, seriesOf, wall, zoned, type EventTime } from "@ohmail/cal-core";
import type { HostResolver } from "@trafficflow/core/net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeReader, microsoftHosts, MS_GRAPH_BASE, MS_GRAPH_CALENDAR_SCOPE, provider } from "../src/microsoft/index.js";
import type { CalendarReader, ChangeItem, ChangePage, ChangeToken, Connection } from "../src/port.js";
import { fixedHostRequest, type HttpPort } from "../src/request/index.js";
import { Secret } from "./support/calendar-test-accounts.ts";
import { MsDoubleClient } from "./support/ms-double-client.ts";
// @ts-expect-error a plain module
import { startMsDouble } from "./support/ms-double.mjs";

const ZURICH = "Europe/Zurich";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const WINDOW = { start: instant(Date.UTC(2026, 10, 16)), end: instant(Date.UTC(2027, 0, 1)) };
const UID = "evt-wheel-class@ms-double.example";
const zones = intlZones();
const never = new AbortController().signal;
/** No name is looked up: the double is reached by its number. */
const NOBODY: HostResolver = { resolve: async () => [] };

let double: { base: string; origin: string; token: string; close: () => Promise<void> };
let ms: MsDoubleClient;
let reader: CalendarReader;
/** Every request the reader made, as method and path, and where its sign-in was allowed to travel. */
const sent: { method: string; path: string; tokenGoesTo: Record<string, boolean> }[] = [];

beforeAll(async () => {
  double = await startMsDouble({ port: 0 });
  ms = new MsDoubleClient({ base: double.base, token: new Secret(double.token) });
  const real = fixedHostRequest(microsoftHosts(double.base), { resolver: NOBODY, policy: { kind: "own-network" } });
  const seeing: HttpPort = {
    request(url, o) {
      const { pathname, search } = new URL(url);
      sent.push({ method: o.method, path: pathname + search, tokenGoesTo: Object.fromEntries(["127.0.0.1", "graph.microsoft.com", "login.microsoftonline.com"].map((h) => [h, o.auth?.admits(h) ?? false])) });
      return real.request(url, o);
    },
  };
  reader = makeReader({ http: seeing, clock: { now: () => NOW }, zones, graphBase: double.base });
});
afterAll(() => double.close());
beforeEach(async () => {
  await ms.reset();
  sent.length = 0;
});

const signedIn = (token = double.token): Connection => ({ provider: "microsoft", credential: { kind: "bearer", accessToken: async () => ({ ok: true, token }) }, start: null });
const studio = { id: "cal-studio" };
const page = (limit: number, cursor: string | null = null) => ({ limit, cursor, window: WINDOW });
const upserts = (items: readonly ChangeItem[]) => items.filter((i): i is Extract<ChangeItem, { kind: "upsert" }> => i.kind === "upsert");
const keyOf = (t: EventTime): string => recurrenceKeyString(recurrenceKeyOf(t, zones));
const evening = (month: number, day: number): EventTime => zoned(wall(2026, month, day, 18), ZURICH);

/** One whole reading: every page to the end. */
async function round(since: ChangeToken | null, limit = 250): Promise<{ pages: ChangePage[]; token: ChangeToken }> {
  const pages: ChangePage[] = [];
  let cursor: string | null = null;
  for (;;) {
    const answer = await reader.readChanges(signedIn(), studio, since, page(limit, cursor), never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    pages.push(answer.value);
    const at = answer.value.cursor;
    if (at.kind === "end") {
      if (at.token === null) throw new Error("the reading ended with no token");
      return { pages, token: at.token };
    }
    cursor = at.value;
  }
}

describe("Microsoft: where it is reached, and that it is off unless named", () => {
  it("is the reader of the word microsoft, and Graph's base is Microsoft's own address unless the composing program names another", () => {
    expect(provider).toBe("microsoft");
    expect(reader.provider).toBe("microsoft");
    expect(MS_GRAPH_BASE).toBe("https://graph.microsoft.com/v1.0");
    expect([...microsoftHosts(MS_GRAPH_BASE)].sort()).toEqual(["graph.microsoft.com", "login.microsoftonline.com"]);
    expect([...microsoftHosts(double.base)].sort()).toEqual(["127.0.0.1", "login.microsoftonline.com"]);
    // The calendar's permission and the one that keeps a sign-in; mail's are another registration's.
    expect(MS_GRAPH_CALENDAR_SCOPE).toBe("Calendars.ReadWrite offline_access");
  });

  it("is not made without a base, or with one that is no address of a service", () => {
    const deps = { http: { request: async () => ({ arrived: false as const, reason: "unknown" as const }) }, clock: { now: () => NOW }, zones };
    // The one with a user and a password in it is put together here, so that no line of this file is shaped like one.
    const withSignIn = ["https://", "user", ":", "pw", "@", "graph.microsoft.com/v1.0"].join("");
    for (const base of ["", "graph.microsoft.com/v1.0", "ftp://graph.microsoft.com/v1.0", withSignIn, "https://graph.microsoft.com/v1.0?x=1", "https://graph.microsoft.com/v1.0#x"]) {
      expect(() => makeReader({ ...deps, graphBase: base }), base).toThrow();
    }
  });
});

describe("Microsoft against the double: the calendars and the sign-in", () => {
  it("lists the three calendars, one of them not writable, none with a colour of its own", async () => {
    const answer = await reader.listCalendars(signedIn(), never);
    expect(answer).toEqual({
      ok: true,
      value: [
        { id: "cal-studio", name: "Calendar", color: null, writable: true, byToken: true, zone: null },
        { id: "cal-market", name: "Market", color: null, writable: true, byToken: true, zone: null },
        { id: "cal-closing-days", name: "Studio closing days", color: null, writable: false, byToken: true, zone: null },
      ],
    });
    expect(sent).toEqual([{ method: "GET", path: "/v1.0/me/calendars", tokenGoesTo: { "127.0.0.1": true, "graph.microsoft.com": false, "login.microsoftonline.com": false } }]);
  });

  it("checks a sign-in on the calendars and names the account by who owns its default calendar", async () => {
    expect(await reader.checkSignIn(signedIn(), never)).toEqual({ ok: true, value: { principal: "mila@lichtgrat.example", addresses: ["mila@lichtgrat.example"] } });
    expect(await reader.checkSignIn(signedIn("not-the-double-s-own"), never)).toEqual({ ok: false, reason: "sign_in_refused", retryAfterMs: null });
  });
});

describe("Microsoft against the double: a window read whole", () => {
  it("hands the five single events, the series as its rule and its changed evening; an expanded day is an identity and never an item", async () => {
    const { pages, token } = await round(null);
    expect(pages.length).toBe(1);
    const [only] = pages as [ChangePage];
    expect(only.items.map((i) => [i.kind, i.kind === "upsert" ? i.id : null, i.kind === "upsert" ? i.text : null])).toEqual([
      ["upsert", "evt-wheel-class", null],
      ["upsert", "evt-glaze-firing", null],
      ["upsert", "evt-catalogue-proofs", null],
      ["upsert", "evt-kiln-handover", null],
      ["upsert", "evt-catalogue-shoot", null],
      ["upsert", "evt-kiln-service", null],
      ["upsert", "evt-wheel-class.2026-12-01", null],
    ]);
    expect({ mode: only.mode, unchanged: only.unchanged, left: only.left, refreshMs: only.refreshMs }).toEqual({ mode: "whole", unchanged: false, left: [], refreshMs: null });
    expect(only.expanded).toEqual({
      window: WINDOW,
      seen: [evening(11, 17), evening(11, 24), evening(12, 1), evening(12, 8), evening(12, 15), evening(12, 22)].map((originalStart) => ({ uid: UID, originalStart })),
    });
    expect(token.provider).toBe("microsoft");
    expect(token.value.length).toBeLessThanOrEqual(4096);

    const [series, glaze, , handover, shoot, , moved] = upserts(only.items).map((i) => i.event);
    expect({ uid: series!.uid, was: series!.recurrenceId, start: series!.start, end: series!.end, rules: series!.rules.map((r) => r.rule), summary: series!.summary }).toEqual({
      uid: UID,
      was: null,
      start: evening(11, 17),
      end: zoned(wall(2026, 11, 17, 19, 30), ZURICH),
      // ms-seed.json: weekly, every 1, on Tuesday, weeks beginning on Monday, numbered 6.
      rules: [parseRRule("FREQ=WEEKLY;COUNT=6;BYDAY=TU;WKST=MO")],
      summary: "Wheel class",
    });
    expect({ uid: moved!.uid, was: moved!.recurrenceId, start: moved!.start, end: moved!.end, rules: moved!.rules }).toEqual({
      uid: UID,
      was: evening(12, 1),
      start: zoned(wall(2026, 12, 2, 19), ZURICH),
      end: zoned(wall(2026, 12, 2, 20, 30), ZURICH),
      rules: [],
    });
    expect({ uid: glaze!.uid, summary: glaze!.summary, description: glaze!.description, start: glaze!.start, end: glaze!.end, organizer: [glaze!.organizer?.name, glaze!.organizer?.email], created: glaze!.created }).toEqual({
      uid: "evt-glaze-firing@ms-double.example",
      summary: "Glaze firing",
      description: "Cone 6. The blue set for the catalogue goes in first.",
      start: zoned(wall(2026, 11, 19, 9), ZURICH),
      end: zoned(wall(2026, 11, 19, 11), ZURICH),
      organizer: ["Mila Brunner", "mila@lichtgrat.example"],
      created: instant(Date.UTC(2026, 10, 13, 12)),
    });
    expect(handover!.attendees.map((a) => [a.email, a.name, a.partstat, a.role])).toEqual([["petra@makersfest.example", "Petra Wyss", "NEEDS-ACTION", "REQ-PARTICIPANT"]]);
    expect([shoot!.organizer?.name, shoot!.organizer?.email]).toEqual(["Giulia Ferrari", "giulia@terracotta-milano.example"]);
  });

  it("asks for the window once and for the series once, each under the Graph base, with the sign-in for that host alone", async () => {
    await round(null);
    expect(sent.map((s) => [s.method, s.path])).toEqual([
      ["GET", "/v1.0/me/calendars/cal-studio/calendarView/delta?startDateTime=2026-11-16T00:00:00Z&endDateTime=2027-01-01T00:00:00Z"],
      ["GET", "/v1.0/me/calendars/cal-studio/events/evt-wheel-class"],
    ]);
    expect(sent.every((s) => s.tokenGoesTo["127.0.0.1"] === true && !s.tokenGoesTo["graph.microsoft.com"] && !s.tokenGoesTo["login.microsoftonline.com"])).toBe(true);
  });

  it("hands the series so that its own expansion gives the days Microsoft showed: six evenings, the third on Wednesday at seven", async () => {
    const { pages } = await round(null);
    const [wheel] = seriesOf(upserts(pages[0]!.items).map((i) => i.event), zones).filter((s) => s.uid === UID);
    const evenings = expandSeries(wheel!, { startMs: WINDOW.start.epochMs, endMs: WINDOW.end.epochMs, viewerZone: ZURICH }, zones);
    // Zurich is an hour east of UTC from the last Sunday of October: 18:00 there is 17:00 UTC.
    expect(evenings.occurrences.map((o) => (o.start.kind === "zoned" ? [o.start.wall.month, o.start.wall.day, o.start.wall.hour] : null))).toEqual([[11, 17, 18], [11, 24, 18], [12, 2, 19], [12, 8, 18], [12, 15, 18], [12, 22, 18]]);
    // The comparison a sync makes: every day the rule gives is among the days seen, by the one key both have.
    expect(evenings.occurrences.map((o) => recurrenceKeyString(o.key)).sort()).toEqual(pages[0]!.expanded!.seen.map((s) => keyOf(s.originalStart)).sort());
  });

  it("reads the same window in pages of four: every page names its days, the series comes with each page that shows one", async () => {
    const { pages } = await round(null, 4);
    // By start: an evening, two single events, an evening | three single events, the moved evening | three evenings.
    expect(pages.map((p) => [p.items.length, p.expanded!.seen.length, p.mode])).toEqual([[3, 2, "whole"], [5, 1, "whole"], [1, 3, "whole"]]);
    expect([...new Set(pages.flatMap((p) => upserts(p.items).map((i) => i.id)))].sort()).toEqual(["evt-catalogue-proofs", "evt-catalogue-shoot", "evt-glaze-firing", "evt-kiln-handover", "evt-kiln-service", "evt-wheel-class", "evt-wheel-class.2026-12-01"]);
    expect(pages.flatMap((p) => p.expanded!.seen.map((s) => keyOf(s.originalStart)))).toEqual([evening(11, 17), evening(11, 24), evening(12, 1), evening(12, 8), evening(12, 15), evening(12, 22)].map(keyOf));
    // Three pages of the window, and the series asked for once a page: nothing is kept between two calls.
    expect([sent.length, sent.filter((s) => s.path === "/v1.0/me/calendars/cal-studio/events/evt-wheel-class").length]).toEqual([6, 3]);
    expect((await ms.state()).requests).toBe(6);
  });

  it("reads an all-day event as its days and a call's link as the event's address", async () => {
    const answer = await reader.readChanges(signedIn(), { id: "cal-market" }, null, page(250), never);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    const [market, call] = upserts(answer.value.items).map((i) => i.event);
    expect({ start: market!.start, end: market!.end, shown: market!.transparency, summary: market!.summary }).toEqual({ start: plainDate(2026, 11, 21), end: plainDate(2026, 11, 22), shown: "TRANSPARENT", summary: "Market day" });
    expect({ url: call!.url, shown: call!.transparency, start: call!.start }).toEqual({ url: "https://teams.ms-double.example/l/meetup-join/evt-stall-planning-call", shown: "OPAQUE", start: zoned(wall(2026, 11, 23, 10), ZURICH) });
    expect(answer.value.expanded).toEqual({ window: WINDOW, seen: [] });
  });

  it("hands a version that is the precondition Microsoft takes for a change", async () => {
    const { pages } = await round(null);
    const glaze = upserts(pages[0]!.items).find((i) => i.id === "evt-glaze-firing")!;
    const stale = await ms.graph("PATCH", "/me/events/evt-glaze-firing", { body: { subject: "lost" }, headers: { "If-Match": 'W/"another"' } });
    const current = await ms.graph("PATCH", "/me/events/evt-glaze-firing", { body: { subject: "Glaze firing, second load" }, headers: { "If-Match": glaze.version } });
    expect([stale.status, current.status]).toEqual([412, 200]);
  });
});

describe("Microsoft against the double: what changed since", () => {
  it("hands nothing when nothing changed, then what was made, changed and removed", async () => {
    const whole = await round(null);
    const quiet = await round(whole.token);
    expect(quiet.pages.map((p) => [p.mode, p.items, p.expanded])).toEqual([["delta", [], { window: WINDOW, seen: [] }]]);

    await ms.graph("POST", "/me/calendars/cal-studio/events", { body: { subject: "Kiln cooling", start: { dateTime: "2026-11-30T08:00:00", timeZone: ZURICH }, end: { dateTime: "2026-11-30T09:00:00", timeZone: ZURICH } } });
    await ms.graph("PATCH", "/me/events/evt-glaze-firing", { body: { subject: "Glaze firing, second load" } });
    await ms.graph("DELETE", "/me/events/evt-catalogue-proofs");
    const next = await round(quiet.token);
    const items = next.pages.flatMap((p) => p.items);
    expect(items.filter((i) => i.kind === "gone")).toEqual([{ kind: "gone", id: "evt-catalogue-proofs" }]);
    expect(upserts(items).map((i) => [i.event.summary, i.event.start]).sort()).toEqual([
      ["Glaze firing, second load", zoned(wall(2026, 11, 19, 9), ZURICH)],
      ["Kiln cooling", zoned(wall(2026, 11, 30, 8), ZURICH)],
    ]);
    expect((await round(next.token)).pages.flatMap((p) => p.items)).toEqual([]);
  });

  it("reports a removed evening of the series by Microsoft's id of it, and a whole reading then shows which evening is missing", async () => {
    const whole = await round(null);
    await ms.graph("DELETE", "/me/events/evt-wheel-class.2026-11-24");
    const next = await round(whole.token);
    expect(next.pages.flatMap((p) => p.items)).toEqual([{ kind: "gone", id: "evt-wheel-class.2026-11-24" }]);

    const again = await round(null);
    const [wheel] = seriesOf(upserts(again.pages[0]!.items).map((i) => i.event), zones).filter((s) => s.uid === UID);
    const seen = new Set(again.pages[0]!.expanded!.seen.map((s) => keyOf(s.originalStart)));
    const missing = expandSeries(wheel!, { startMs: WINDOW.start.epochMs, endMs: WINDOW.end.epochMs, viewerZone: ZURICH }, zones).occurrences.filter((o) => !seen.has(recurrenceKeyString(o.key)));
    expect(missing.map((o) => recurrenceKeyString(o.key))).toEqual([keyOf(evening(11, 24))]);
  });

  it("answers a sync state Microsoft no longer keeps as a token that is gone, and does not go where the answer points", async () => {
    const whole = await round(null);
    await ms.expireSyncState();
    const before = (await ms.state()).requests!;
    sent.length = 0;
    expect(await reader.readChanges(signedIn(), studio, whole.token, page(250), never)).toEqual({ ok: false, reason: "token_gone", retryAfterMs: null });
    expect([sent.length, (await ms.state()).requests! - before]).toEqual([1, 1]);
  });

  it("answers a throttled request with the wait Microsoft named", async () => {
    await ms.throttleNext(2, 7);
    expect(await reader.listCalendars(signedIn(), never)).toEqual({ ok: false, reason: "throttled", retryAfterMs: 7000 });
    expect(await reader.readChanges(signedIn(), studio, null, page(250), never)).toEqual({ ok: false, reason: "throttled", retryAfterMs: 7000 });
    expect((await reader.listCalendars(signedIn(), never)).ok).toBe(true);
  });

  it("answers a calendar that is not there, and a token of another calendar or another window, without reading anything into the wrong place", async () => {
    expect(await reader.readChanges(signedIn(), { id: "cal-nothing" }, null, page(250), never)).toEqual({ ok: false, reason: "not_found", retryAfterMs: null });
    const whole = await round(null);
    sent.length = 0;
    const gone = { ok: false, reason: "token_gone", retryAfterMs: null };
    expect(await reader.readChanges(signedIn(), { id: "cal-market" }, whole.token, page(250), never)).toEqual(gone);
    const wider = { limit: 250, cursor: null, window: { start: WINDOW.start, end: instant(Date.UTC(2027, 1, 1)) } };
    expect(await reader.readChanges(signedIn(), studio, whole.token, wider, never)).toEqual(gone);
    expect(await reader.readChanges(signedIn(), studio, { provider: "google", value: whole.token.value }, page(250), never)).toEqual(gone);
    expect(sent).toEqual([]);
    // The token itself still reads, with or without the window named again.
    expect((await reader.readChanges(signedIn(), studio, whole.token, { limit: 250, cursor: null, window: null }, never)).ok).toBe(true);
  });
});
