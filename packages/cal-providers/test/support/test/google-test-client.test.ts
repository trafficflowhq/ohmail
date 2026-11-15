import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BENCH_ID, BENCH_INVITATION, BENCH_INVITE_MARKER, BENCH_MARKER, toGoogleEvent } from "../bench-events.ts";
import { parseCalendarTestAccounts, Secret } from "../calendar-test-accounts.ts";
import { GOOGLE_CALENDAR_BASE, GOOGLE_TOKEN_URL, GoogleConsentEnded, GoogleTestClient } from "../google-test-client.ts";

// Never dials: every client here is handed a `fetch` of the test's own. Apple's domain is put together at
// run time so that this file carries no address on a real domain.
const APPLE_DOMAIN = ["icloud", "com"].join(".");
const accountsWith = (appleId: string) => parseCalendarTestAccounts([`ICLOUD_APPLE_ID=${appleId}`, "ICLOUD_APP_PASSWORD=abcd-efgh-ijkl-mnop", "GOOGLE_TEST_ACCOUNT=bench.kiln@gmail.example", "GOOGLE_OAUTH_CLIENT_ID=invented-client-id", "GOOGLE_OAUTH_CLIENT_SECRET=invented-client-secret", "GOOGLE_TEST_REFRESH_TOKEN=invented-refresh-token"].join("\n"));
const accounts = accountsWith(`bench.potter@${APPLE_DOMAIN}`);

interface Call {
  method: string;
  url: URL;
  body: any;
  authorization: string | null;
}
function fake(answers: (call: Call) => { status?: number; json?: unknown } | undefined = () => undefined) {
  const calls: Call[] = [];
  const fetchFake = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: init?.method ?? "GET", url: new URL(input), body: headers.get("content-type") === "application/json" ? JSON.parse(raw) : raw, authorization: headers.get("authorization") };
    calls.push(call);
    if (input === GOOGLE_TOKEN_URL) return new Response(JSON.stringify(answers(call)?.json ?? { access_token: "fake-token", expires_in: 3600 }), { status: answers(call)?.status ?? 200 });
    const a = answers(call) ?? { json: call.method === "GET" ? { items: [] } : { id: "made-1", ...call.body } };
    return new Response(a.status === 204 ? null : JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  };
  return { calls, client: new GoogleTestClient({ accounts, benchId: BENCH_ID, fetch: fetchFake }), fetchFake };
}
const api = (calls: Call[]) => calls.filter((c) => c.url.href !== GOOGLE_TOKEN_URL);

describe("the Google test client", () => {
  it("talks to Google's two addresses and nowhere else, and keeps the token in the header", async () => {
    assert.equal(GOOGLE_CALENDAR_BASE, "https://www.googleapis.com/calendar/v3");
    assert.equal(GOOGLE_TOKEN_URL, "https://oauth2.googleapis.com/token");
    const { calls, client } = fake();
    await client.calendarList();
    await client.listMarked("primary-calendar");
    assert.ok(calls.every((c) => c.url.href === GOOGLE_TOKEN_URL || c.url.href.startsWith(`${GOOGLE_CALENDAR_BASE}/`)));
    assert.equal(calls.filter((c) => c.url.href === GOOGLE_TOKEN_URL).length, 1);
    assert.ok(api(calls).every((c) => c.authorization === "Bearer fake-token" && !c.url.search.includes("fake-token")));
    assert.equal(api(calls)[1]!.url.searchParams.get("privateExtendedProperty"), `${BENCH_MARKER}=${BENCH_ID}`);
  });

  it("says so when Google's test consent has ended", async () => {
    const { client } = fake((c) => (c.url.href === GOOGLE_TOKEN_URL ? { status: 400, json: { error: "invalid_grant" } } : undefined));
    await assert.rejects(() => client.calendarList(), GoogleConsentEnded);
  });

  it("refuses a write that does not say whether mail goes out", async () => {
    const { calls, client } = fake();
    await assert.rejects(() => client.insertEvent("c", toGoogleEvent(BENCH_INVITATION), {} as any), /names sendUpdates/);
    await assert.rejects(() => client.patchEvent("c", "e", {}, undefined as any), /names sendUpdates/);
    await assert.rejects(() => client.deleteEvent("c", "e", { sendUpdates: "sometimes" as any }), /names sendUpdates/);
    assert.equal(api(calls).length, 0);
  });

  it("marks every event it plants, and sends no mail unless told", async () => {
    const { calls, client } = fake();
    await client.insertEvent("c", { summary: "Glaze firing" }, { sendUpdates: "none" });
    const [insert] = api(calls);
    assert.equal(insert!.url.searchParams.get("sendUpdates"), "none");
    assert.deepEqual(insert!.body.extendedProperties.private, { [BENCH_MARKER]: BENCH_ID });
    assert.equal(insert!.body.attendees, undefined);
  });

  it("refuses an invitee that is not a test account's own address, before anything is sent", async () => {
    const { calls, client } = fake();
    await assert.rejects(() => client.insertEvent("c", { summary: "x", attendees: [{ email: new Secret("mila@lichtgrat.example") }] }, { sendUpdates: "all" }), /not a test account's own address/);
    await assert.rejects(() => client.insertEvent("c", { summary: "x", attendees: [{ email: "bench.kiln@gmail.example" as any }] }, { sendUpdates: "all" }), /not a test account's own address/);
    await assert.rejects(() => client.patchEvent("c", "e", { attendees: [] }, { sendUpdates: "none" }), /does not carry invitees/);
    assert.equal(calls.length, 0);
  });

  it("plants no invitation when the iCloud account's address is not on an Apple domain, or is the Google one", async () => {
    for (const [appleId, why] of [["bench.potter@pottery.example", "not on an Apple domain"], ["bench.kiln@gmail.example", "share one address"]] as const) {
      const calls: string[] = [];
      const client = new GoogleTestClient({ accounts: accountsWith(appleId), benchId: BENCH_ID, fetch: async (input) => (calls.push(input), new Response("{}")) });
      const r = await client.inviteOnce("c", toGoogleEvent(BENCH_INVITATION));
      assert.ok(!r.planted && r.why.includes(why));
      assert.deepEqual(calls, []);
    }
  });

  it("plants no second invitation while one stands", async () => {
    const { calls, client } = fake((c) => (c.method === "GET" && c.url.searchParams.get("privateExtendedProperty")?.startsWith(BENCH_INVITE_MARKER) ? { json: { items: [{ id: "standing" }] } } : undefined));
    const r = await client.inviteOnce("c", toGoogleEvent(BENCH_INVITATION));
    assert.deepEqual([r.planted, r.why], [false, "an invitation already stands"]);
    assert.ok(api(calls).every((c) => c.method === "GET"));
  });

  it("plants the one invitation to the one address, and a second write with invitees is refused in this process", async () => {
    const { calls, client } = fake();
    const r = await client.inviteOnce("c", toGoogleEvent(BENCH_INVITATION));
    assert.equal(r.planted, true);
    const insert = api(calls).find((c) => c.method === "POST")!;
    assert.equal(insert.url.searchParams.get("sendUpdates"), "all");
    assert.deepEqual(insert.body.attendees, [{ email: `bench.potter@${APPLE_DOMAIN}` }]);
    assert.deepEqual([insert.body.guestsCanInviteOthers, insert.body.guestsCanSeeOtherGuests], [false, false]);
    assert.equal(insert.body.extendedProperties.private[BENCH_INVITE_MARKER], BENCH_ID);
    assert.equal(insert.body.extendedProperties.private[BENCH_MARKER], BENCH_ID);

    const again = fake();
    await assert.rejects(() => again.client.inviteOnce("c", toGoogleEvent(BENCH_INVITATION)), /a second write with invitees in one process/);
    assert.ok(api(again.calls).every((c) => c.method === "GET"));
  });

  it("removes without mail, keeps the invitation unless asked, and cancels it with one notice when asked", async () => {
    const marked = { items: [{ id: "single", extendedProperties: { private: {} } }, { id: "series_20261201T170000Z", recurringEventId: "series" }, { id: "invitation", extendedProperties: { private: { [BENCH_INVITE_MARKER]: BENCH_ID } } }] };
    const answers = (c: Call) => (c.method === "GET" ? { json: marked } : c.method === "DELETE" ? { status: 204 } : undefined);
    const kept = fake(answers);
    assert.deepEqual(await kept.client.removeMarked("c", { withInvitation: false }), { removed: 1, kept: 1, statuses: [204] });
    assert.deepEqual(api(kept.calls).filter((c) => c.method === "DELETE").map((c) => [c.url.pathname.split("/").pop(), c.url.searchParams.get("sendUpdates")]), [["single", "none"]]);
    const all = fake(answers);
    assert.deepEqual(await all.client.removeMarked("c", { withInvitation: true }), { removed: 2, kept: 0, statuses: [204, 204] });
    assert.deepEqual(api(all.calls).filter((c) => c.method === "DELETE").map((c) => [c.url.pathname.split("/").pop(), c.url.searchParams.get("sendUpdates")]), [["single", "none"], ["invitation", "all"]]);
  });
});
