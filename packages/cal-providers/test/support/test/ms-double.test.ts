import assert from "node:assert/strict";
import { request } from "node:http";
import { afterAll, beforeAll, describe, it } from "vitest";
import { Secret } from "../calendar-test-accounts.ts";
import { MsDoubleClient } from "../ms-double-client.ts";
// @ts-expect-error a plain module
import { startMsDouble } from "../ms-double.mjs";

// The double runs inside this process on a port of its own; nothing here leaves the machine.
const WINDOW = { startDateTime: "2026-11-16T00:00:00Z", endDateTime: "2027-01-01T00:00:00Z" };
let double: { base: string; origin: string; token: string; close: () => Promise<void> };
let ms: MsDoubleClient;
type Ev = Record<string, any>;
const values = (a: { json: Record<string, unknown> }) => a.json.value as Ev[];

beforeAll(async () => {
  double = await startMsDouble({ port: 0 });
  ms = new MsDoubleClient({ base: double.base, token: new Secret(double.token) });
});
afterAll(() => double.close());

/** A whole delta round: follows nextLinks to the deltaLink. */
async function round(first: string, query?: Record<string, string>, pageSize = 4) {
  const items: Ev[] = [];
  let pages = 0;
  let a = await ms.graph("GET", first, { query, headers: { Prefer: `odata.maxpagesize=${pageSize}` } });
  for (;;) {
    assert.equal(a.status, 200);
    pages++;
    items.push(...values(a));
    assert.ok(values(a).length <= pageSize);
    if (a.json["@odata.deltaLink"]) return { items, pages, deltaLink: a.json["@odata.deltaLink"] as string };
    a = await ms.graph("GET", a.json["@odata.nextLink"] as string, { headers: { Prefer: `odata.maxpagesize=${pageSize}` } });
  }
}

describe("the Microsoft double: who may ask", () => {
  it("answers 401 InvalidAuthenticationToken without a token and with a wrong one", async () => {
    const none = await fetch(`${double.base}/me/calendars`);
    assert.equal(none.status, 401);
    assert.equal(((await none.json()) as Ev).error.code, "InvalidAuthenticationToken");
    assert.ok(none.headers.get("www-authenticate")?.startsWith("Bearer "));
    const wrong = await ms.graph("GET", "/me/calendars", { token: "not-the-token" });
    assert.deepEqual([wrong.status, (wrong.json.error as Ev).code], [401, "InvalidAuthenticationToken"]);
    assert.ok((wrong.json.error as Ev).innerError["request-id"]);
  });
  it("refuses a Host that is not its own loopback address", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(`${double.base}/me/calendars`, { headers: { Host: "graph.attacker.example", Authorization: `Bearer ${double.token}` } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      r.on("error", reject);
      r.end();
    });
    assert.equal(status, 421);
  });
  it("is reached by its client on this machine only", () => {
    assert.throws(() => new MsDoubleClient({ base: "https://graph.microsoft.com/v1.0", token: new Secret("x") }), /is not this machine/);
    assert.throws(() => new MsDoubleClient({ base: "http://10.0.0.5:8822/v1.0", token: new Secret("x") }), /is not this machine/);
    assert.throws(() => MsDoubleClient.fromEnv({}), /is not named/);
    return assert.rejects(() => ms.graph("GET", "https://graph.microsoft.com/v1.0/me/calendars"), /is not the double/);
  });
});

describe("the Microsoft double: reading", () => {
  beforeAll(() => ms.reset());
  it("lists the calendars, one of them the default, one read-only", async () => {
    const a = await ms.graph("GET", "/me/calendars");
    assert.equal(a.status, 200);
    assert.deepEqual(values(a).map((c) => [c.id, c.isDefaultCalendar, c.canEdit]), [["cal-studio", true, true], ["cal-market", false, true], ["cal-closing-days", false, false]]);
  });
  it("needs a time window for a calendar view: 400 without one", async () => {
    const a = await ms.graph("GET", "/me/calendars/cal-studio/calendarView");
    assert.deepEqual([a.status, (a.json.error as Ev).code], [400, "ErrorInvalidParameter"]);
    assert.equal((await ms.graph("GET", "/me/calendars/cal-studio/calendarView", { query: { startDateTime: WINDOW.startDateTime } })).status, 400);
  });
  it("hands over a window's days expanded: occurrences, the exception, single instances; UTC unless asked", async () => {
    const a = await ms.graph("GET", "/me/calendars/cal-studio/calendarView", { query: { ...WINDOW, $top: "50" } });
    const days = values(a);
    assert.deepEqual(days.map((e) => e.type).sort().join(), "exception,occurrence,occurrence,occurrence,occurrence,occurrence,singleInstance,singleInstance,singleInstance,singleInstance,singleInstance");
    const series = days.filter((e) => e.seriesMasterId === "evt-wheel-class");
    assert.deepEqual(series.map((e) => [e.type, e.start.dateTime, e.start.timeZone, e.recurrence]), [
      ["occurrence", "2026-11-17T17:00:00.0000000", "UTC", null],
      ["occurrence", "2026-11-24T17:00:00.0000000", "UTC", null],
      ["exception", "2026-12-02T18:00:00.0000000", "UTC", null],
      ["occurrence", "2026-12-08T17:00:00.0000000", "UTC", null],
      ["occurrence", "2026-12-15T17:00:00.0000000", "UTC", null],
      ["occurrence", "2026-12-22T17:00:00.0000000", "UTC", null],
    ]);
    assert.equal(series[2]!.originalStart, "2026-12-01T17:00:00Z");
    assert.ok(days.every((e) => e.changeKey && e["@odata.etag"] === `W/"${e.changeKey}"` && e.calendarId === undefined));
    const local = await ms.graph("GET", "/me/calendars/cal-studio/calendarView", { query: { ...WINDOW, $top: "1" }, headers: { Prefer: 'outlook.timezone="Europe/Zurich"' } });
    assert.deepEqual(values(local)[0]!.start, { dateTime: "2026-11-17T18:00:00.0000000", timeZone: "Europe/Zurich" });
  });
  it("pages a calendar view by $top with a next link, and keeps the rule on the series master", async () => {
    const first = await ms.graph("GET", "/me/calendars/cal-studio/calendarView", { query: { ...WINDOW, $top: "4" } });
    assert.equal(values(first).length, 4);
    const second = await ms.graph("GET", first.json["@odata.nextLink"] as string);
    const third = await ms.graph("GET", second.json["@odata.nextLink"] as string);
    assert.deepEqual([values(second).length, values(third).length, third.json["@odata.nextLink"]], [4, 3, undefined]);
    assert.equal((await ms.graph("GET", "/me/calendars/cal-studio/calendarView", { query: { ...WINDOW, $top: "1001" } })).status, 400);
    const master = await ms.graph("GET", "/me/events/evt-wheel-class");
    assert.deepEqual([master.json.type, (master.json.recurrence as Ev).pattern.type, (master.json.recurrence as Ev).range.numberOfOccurrences], ["seriesMaster", "weekly", 6]);
    assert.deepEqual([(await ms.graph("GET", "/me/events/evt-nothing")).status, ((await ms.graph("GET", "/me/events/evt-nothing")).json.error as Ev).code], [404, "ErrorItemNotFound"]);
  });
  it("shows an all-day event and a call as Microsoft writes them", async () => {
    const a = await ms.graph("GET", "/me/calendars/cal-market/calendarView", { query: WINDOW });
    const [market, call] = values(a);
    assert.deepEqual([market!.isAllDay, market!.start.dateTime, market!.end.dateTime], [true, "2026-11-21T00:00:00.0000000", "2026-11-22T00:00:00.0000000"]);
    assert.deepEqual([call!.isOnlineMeeting, call!.onlineMeetingProvider, new URL(call!.onlineMeeting.joinUrl).hostname], [true, "teamsForBusiness", "teams.ms-double.example"]);
  });
  it("says so when asked for what it does not implement, instead of guessing", async () => {
    assert.deepEqual([(await ms.graph("GET", "/me/calendars/cal-studio/calendarView", { query: { ...WINDOW, $filter: "isAllDay eq true" } })).status, (await ms.graph("GET", "/me/mailFolders")).status], [501, 501]);
  });
});

describe("the Microsoft double: a delta round", () => {
  beforeAll(() => ms.reset());
  it("refuses a round without a window, and the options Microsoft does not support on it", async () => {
    assert.equal((await ms.graph("GET", "/me/calendars/cal-studio/calendarView/delta")).status, 400);
    assert.equal((await ms.graph("GET", "/me/calendars/cal-studio/calendarView/delta", { query: { ...WINDOW, $select: "subject" } })).status, 400);
  });
  it("hands over everything in pages, then only what changed, with removed events marked", async () => {
    const full = await round("/me/calendars/cal-studio/calendarView/delta", WINDOW);
    assert.deepEqual([full.items.length, full.pages], [11, 3]);
    assert.ok(full.items.every((e) => e["@odata.type"] === "#microsoft.graph.event" && e["@removed"] === undefined));

    const quiet = await round(full.deltaLink);
    assert.deepEqual(quiet.items, []);

    const made = await ms.graph("POST", "/me/calendars/cal-studio/events", { body: { subject: "Kiln cooling", start: { dateTime: "2026-11-30T08:00:00", timeZone: "Europe/Zurich" }, end: { dateTime: "2026-11-30T09:00:00", timeZone: "Europe/Zurich" } } });
    assert.equal(made.status, 201);
    assert.equal((await ms.graph("PATCH", "/me/events/evt-glaze-firing", { body: { subject: "Glaze firing, second load" } })).status, 200);
    assert.equal((await ms.graph("DELETE", "/me/events/evt-catalogue-proofs")).status, 204);
    assert.equal((await ms.graph("PATCH", "/me/events/evt-kiln-service", { body: { start: { dateTime: "2027-02-01T08:30:00", timeZone: "Europe/Zurich" }, end: { dateTime: "2027-02-01T09:30:00", timeZone: "Europe/Zurich" } } })).status, 200);

    const next = await round(quiet.deltaLink);
    assert.deepEqual(next.items.filter((e) => e["@removed"]).map((e) => [e.id, e["@removed"].reason]).sort(), [["evt-catalogue-proofs", "deleted"], ["evt-kiln-service", "deleted"]]);
    assert.deepEqual(next.items.filter((e) => !e["@removed"]).map((e) => e.subject).sort(), ["Glaze firing, second load", "Kiln cooling"]);
    assert.deepEqual((await round(next.deltaLink)).items, []);
  });
  it("reports a deleted series as its days, and a deleted day alone", async () => {
    await ms.reset();
    const full = await round("/me/calendars/cal-studio/calendarView/delta", WINDOW);
    assert.equal((await ms.graph("DELETE", "/me/events/evt-wheel-class.2026-11-24")).status, 204);
    const one = await round(full.deltaLink);
    assert.deepEqual(one.items.map((e) => [e.id, Boolean(e["@removed"])]), [["evt-wheel-class.2026-11-24", true]]);
    assert.deepEqual(((await ms.graph("GET", "/me/events/evt-wheel-class")).json.cancelledOccurrences as string[]), ["evt-wheel-class.2026-11-24"]);
    assert.equal((await ms.graph("DELETE", "/me/events/evt-wheel-class")).status, 204);
    const all = await round(one.deltaLink);
    assert.equal(all.items.filter((e) => e["@removed"] && e.id.startsWith("evt-wheel-class.")).length, 5);
  });
  it("answers 410 with a Location when the sync state is gone, and the Location starts a full round", async () => {
    await ms.reset();
    const full = await round("/me/calendarView/delta", WINDOW);
    assert.equal(await ms.expireSyncState(), 204);
    const gone = await ms.graph("GET", full.deltaLink);
    assert.deepEqual([gone.status, (gone.json.error as Ev).code], [410, "SyncStateNotFound"]);
    const location = gone.headers.get("location")!;
    assert.ok(location.startsWith(`${double.base}/me/calendarView/delta?startDateTime=`) && !location.includes("token"));
    assert.equal((await round(location)).items.length, full.items.length);
    assert.equal((await ms.graph("GET", "/me/calendarView/delta", { query: { $deltatoken: "not-a-token" } })).status, 410);
  });
});

describe("the Microsoft double: writing and answering", () => {
  beforeAll(() => ms.reset());
  it("creates, changes under a change key, and deletes", async () => {
    const made = await ms.graph("POST", "/me/events", { body: { subject: "Shelf building", transactionId: "t-1", isOnlineMeeting: true, start: { dateTime: "2026-12-03T10:00:00", timeZone: "Europe/Zurich" }, end: { dateTime: "2026-12-03T11:00:00", timeZone: "Europe/Zurich" } } });
    assert.deepEqual([made.status, made.json.type, made.json.isOrganizer, made.json.seriesMasterId], [201, "singleInstance", true, null]);
    assert.ok((made.json.onlineMeeting as Ev).joinUrl);
    assert.equal((await ms.graph("POST", "/me/events", { body: { subject: "Shelf building", transactionId: "t-1", start: { dateTime: "2026-12-03T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-12-03T11:00:00", timeZone: "UTC" } } })).json.id, made.json.id);
    const path = `/me/events/${made.json.id}`;
    const changed = await ms.graph("PATCH", path, { body: { subject: "Shelf building, part two" }, headers: { "If-Match": made.json["@odata.etag"] as string } });
    assert.deepEqual([changed.status, changed.json.subject, changed.json.changeKey !== made.json.changeKey], [200, "Shelf building, part two", true]);
    const stale = await ms.graph("PATCH", path, { body: { subject: "lost" }, headers: { "If-Match": made.json["@odata.etag"] as string } });
    assert.deepEqual([stale.status, (stale.json.error as Ev).code], [412, "ErrorIrresolvableConflict"]);
    assert.equal((await ms.graph("DELETE", path)).status, 204);
    assert.equal((await ms.graph("GET", path)).status, 404);
    assert.equal((await ms.graph("POST", "/me/calendars/cal-closing-days/events", { body: { subject: "x", start: { dateTime: "2026-12-03T10:00:00" }, end: { dateTime: "2026-12-03T11:00:00" } } })).status, 403);
    assert.equal((await ms.graph("POST", "/me/events", { body: { subject: "no times" } })).status, 400);
  });
  it("turns a changed occurrence into an exception of its series", async () => {
    const changed = await ms.graph("PATCH", "/me/events/evt-wheel-class.2026-12-08", { body: { start: { dateTime: "2026-12-09T19:00:00", timeZone: "Europe/Zurich" }, end: { dateTime: "2026-12-09T20:30:00", timeZone: "Europe/Zurich" } } });
    assert.deepEqual([changed.status, changed.json.type, changed.json.seriesMasterId, (changed.json.start as Ev).dateTime, changed.json.originalStart], [200, "exception", "evt-wheel-class", "2026-12-09T18:00:00.0000000", "2026-12-08T17:00:00Z"]);
    const days = values(await ms.graph("GET", "/me/events/evt-wheel-class/instances", { query: WINDOW }));
    assert.deepEqual(days.map((e) => e.type), ["occurrence", "occurrence", "exception", "exception", "occurrence", "occurrence"]);
  });
  it("counts what the server would have sent: an invitation on create, a cancellation on delete", async () => {
    const before = await ms.state();
    const made = await ms.graph("POST", "/me/events", { body: { subject: "Stall rota", start: { dateTime: "2026-12-04T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-12-04T11:00:00", timeZone: "UTC" }, attendees: [{ type: "required", emailAddress: { name: "Petra Wyss", address: "petra@makersfest.example" } }] } });
    await ms.graph("DELETE", `/me/events/${made.json.id}`);
    const after = await ms.state();
    assert.deepEqual([after.invitationsSent! - before.invitationsSent!, after.cancellationsSent! - before.cancellationsSent!], [1, 1]);
  });
  it("takes an invitee's answer with 202 and no body, and holds Microsoft's rules for a proposed time", async () => {
    const accept = await ms.graph("POST", "/me/events/evt-catalogue-shoot/accept", { body: { comment: "See you there.", sendResponse: true } });
    assert.deepEqual([accept.status, accept.json], [202, {}]);
    assert.equal(((await ms.graph("GET", "/me/events/evt-catalogue-shoot")).json.responseStatus as Ev).response, "accepted");
    const time = { start: { dateTime: "2026-11-27T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-27T11:00:00", timeZone: "UTC" } };
    assert.equal((await ms.graph("POST", "/me/events/evt-catalogue-shoot/tentativelyAccept", { body: { sendResponse: true, proposedNewTime: time } })).status, 202);
    assert.equal((await ms.graph("POST", "/me/events/evt-catalogue-shoot/decline", { body: { sendResponse: false, proposedNewTime: time } })).status, 400);
    assert.equal((await ms.graph("POST", "/me/events/evt-kiln-service/decline", { body: { sendResponse: true, proposedNewTime: time } })).status, 400);
    const quiet = await ms.state();
    assert.equal((await ms.graph("POST", "/me/events/evt-kiln-service/decline", { body: { sendResponse: false } })).status, 202);
    assert.equal((await ms.state()).answersSent, quiet.answersSent);
    assert.equal((await ms.graph("POST", "/me/events/evt-kiln-handover/accept", { body: {} })).status, 400);
    assert.equal((await ms.graph("POST", "/me/events/evt-nothing/accept", { body: {} })).status, 404);
  });
  it("answers 429 with Retry-After when told to throttle, then answers again", async () => {
    assert.equal(await ms.throttleNext(2, 7), 204);
    const first = await ms.graph("GET", "/me/calendars");
    assert.deepEqual([first.status, first.headers.get("retry-after"), (first.json.error as Ev).code], [429, "7", "TooManyRequests"]);
    assert.equal((await ms.graph("GET", "/me/calendars")).status, 429);
    assert.equal((await ms.graph("GET", "/me/calendars")).status, 200);
  });
  it("hands the adapter its token through the port the adapter takes", async () => {
    assert.equal(await ms.accessToken(), double.token);
    assert.equal(String(new Secret(double.token)), "[secret]");
  });
});
