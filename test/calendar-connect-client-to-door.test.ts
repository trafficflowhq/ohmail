import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { RELAY_ALLOWLIST, relayVerdict } from "@trafficflow/api/relay-allowlist";
import { calCalendars, calCredentials, calSettings } from "@trafficflow/db/mail";
import { calendarFeed } from "@trafficflow/services/calendar";
import { CALENDAR_WAYS, HttpAdapter, MutationRejectedError, calendarWaysOf, type CalendarConnectTransport, type FetchLike } from "@ohmail/client-engine";
import { FIXED_NOW, makeDeps, seedSession } from "../packages/api/test/helpers.js";

/**
 * THE CONNECT DOOR FROM A DEVICE'S SIDE: the client's six calls through the real routes, and what
 * a door that does not carry them answers. A root test, because it holds the wire client and the
 * route table together and neither may depend on the other.
 *
 * The relay's answer is part of the door: none of the six routes is relayable, so a desktop paired
 * to an account and a phone, which both ask through a relay, are offered no way to connect.
 */

const app = createApp([...apiRoutes, ...calendarRoutes]);
const made = (tag: string): string => `${tag}${randomUUID().replaceAll("-", "")}`;

async function world() {
  const { db, deps } = await makeDeps();
  deps.services = {
    ...deps.services, calendar: calendarFeed,
    calendarConnect: { policy: "cloud", ceremonies: { google: { on: false, configured: false }, microsoft: { on: false, configured: false } } },
  } as never;
  const s = await seedSession(db, { now: FIXED_NOW });
  await db.insert(calSettings).values({ accountId: s.accountId, enabledAt: FIXED_NOW });
  /** Every request the client made, as it left: where it went and what it carried. */
  const sent: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({ method: String(init?.method), url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: (init?.body as string | undefined) ?? null });
    return app.handle(
      new Request(String(url), { method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string | undefined }),
      { ...deps, session: null, idempotency: null } as ApiDeps,
    );
  };
  const adapter = new HttpAdapter({
    baseUrl: "http://localhost", fetch: fetchImpl, headers: () => ({ authorization: `Bearer ${s.token}`, "x-requested-with": "ohmail" }),
  });
  return { db, deps, s, sent, adapter: adapter as CalendarConnectTransport };
}

describe("the client's calls reach the connect door", () => {
  it("lists the ways, connects, signs in again, checks, sets a calendar and removes, each through its route", async () => {
    const w = await world();
    expect(await w.adapter.calendarWays()).toEqual(["icloud", "caldav", "ics"]);
    const connectionId = randomUUID();
    const key = randomUUID();
    const password = made("pw");
    const made1 = await w.adapter.connectCalendar({ way: "icloud", connectionId, user: "mila@studio.example.test", password }, key);
    expect([made1.connection.id, made1.connection.provider, made1.connection.serverHost, made1.seq !== null])
      .toEqual([connectionId, "caldav", "caldav.icloud.com", true]);
    // The press's key rides as the header, and what was typed is in the one request's body and nowhere else of it.
    const post = w.sent.find((r) => r.method === "POST")!;
    expect([post.url, post.headers["idempotency-key"]]).toEqual(["http://localhost/calendar/connections", key]);
    expect([post.url.includes(password), JSON.stringify(post.headers).includes(password), post.body!.includes(password)]).toEqual([false, false, true]);
    expect(w.sent.filter((r) => r.url.includes(password) || JSON.stringify(r.headers).includes(password))).toEqual([]);

    // The check before the sign-in typed again: the two share the connection's minute, and the sign-in is taken inside it.
    expect((await w.adapter.checkCalendarConnection(connectionId)).connection.id).toBe(connectionId);
    await expect(w.adapter.checkCalendarConnection(connectionId)).rejects.toMatchObject({ status: 429, code: "rate_limited", retryAfterMs: 60_000 });
    const again = await w.adapter.signInCalendarAgain(connectionId, { user: "mila@studio.example.test", password: made("pw") });
    expect([again.connection.status, again.seq !== null]).toEqual(["active", true]);

    const sub = await w.adapter.connectCalendar({ way: "ics", connectionId: randomUUID(), address: `https://feeds.example.test/${made("k")}/a.ics` }, randomUUID());
    const calendarId = randomUUID();
    await w.db.insert(calCalendars).values({ id: calendarId, accountId: w.s.accountId, connectionId: sub.connection.id, providerId: "subscription", name: "", access: "reader" });
    const named = await w.adapter.setCalendar(calendarId, { name: "Holidays", shown: false });
    expect([named.calendar.name, named.calendar.shown, named.seq !== null]).toEqual(["Holidays", false, true]);
    expect((await w.adapter.setCalendar(calendarId, { shown: false })).seq).toBeNull();

    expect(await w.adapter.removeCalendarConnection(connectionId)).toMatchObject({ removed: true });
    // This store is the test's own: every sealed sign-in in it is this account's.
    expect((await w.db.select({ id: calCredentials.connectionId }).from(calCredentials)).map((c) => c.id)).toEqual([sub.connection.id]);
    expect(w.sent.map((r) => r.method).sort()).toEqual(["DELETE", "GET", "PATCH", "PATCH", "POST", "POST", "POST", "POST", "POST"]);
  });

  it("hands a refusal on with our server's word and the closed word beside it", async () => {
    const w = await world();
    const refused = await w.adapter.connectCalendar({ way: "ics", connectionId: randomUUID(), address: "https://10.0.0.5/a.ics" }, randomUUID())
      .then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(MutationRejectedError);
    expect(refused).toMatchObject({ status: 400, code: "validation_failed", retryable: false, details: { fault: "address_not_allowed" } });
    await expect(w.adapter.removeCalendarConnection(randomUUID())).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("the ways an answer names", () => {
  it("drops a word this build does not know, and reads anything that is no list as no way", () => {
    expect(calendarWaysOf(["ics", "icloud", "carrier-pigeon", 3, null, "ics"])).toEqual(["ics", "icloud"]);
    for (const none of [undefined, null, "icloud", { ways: ["icloud"] }, 3]) expect(calendarWaysOf(none)).toEqual([]);
    expect(calendarWaysOf([...CALENDAR_WAYS])).toEqual([...CALENDAR_WAYS]);
  });

  it("are none on any failure: a door that has no such route, an answer that is no JSON, no network", async () => {
    const answering = (res: () => Response | Promise<Response>): CalendarConnectTransport =>
      new HttpAdapter({ baseUrl: "http://localhost", fetch: (async () => res()) as FetchLike }) as CalendarConnectTransport;
    expect(await answering(() => new Response(JSON.stringify({ error: { code: "not_found", message: "no such route" } }), { status: 404 })).calendarWays()).toEqual([]);
    expect(await answering(() => new Response("<html>", { status: 200 })).calendarWays()).toEqual([]);
    expect(await answering(() => { throw new TypeError("no network"); }).calendarWays()).toEqual([]);
    expect(await answering(() => new Response(JSON.stringify({ ways: ["google", "icloud"] }), { status: 200 })).calendarWays()).toEqual(["google", "icloud"]);
  });
});

describe("the relay does not carry the connect door", () => {
  const DOOR: [string, string][] = [
    ["GET", "/calendar/connect"], ["POST", "/calendar/connections"], ["DELETE", `/calendar/connections/${randomUUID()}`],
    ["POST", `/calendar/connections/${randomUUID()}/check`], ["POST", `/calendar/connections/${randomUUID()}/sign-in`],
    ["PATCH", `/calendar/calendars/${randomUUID()}`],
  ];

  it("refuses each of the six routes, in every spelling of its path, while the calendar's other routes are carried", () => {
    for (const [method, path] of DOOR) {
      expect(relayVerdict(method, path), `${method} ${path}`).toBe("refuse");
      expect(relayVerdict(method, `${path}/`), `${method} ${path}/`).toBe("refuse");
      expect(relayVerdict(method, path.replace("/calendar/", "/calendar//")), "a doubled slash").toBe("refuse");
    }
    expect(RELAY_ALLOWLIST.filter((r) => r.pattern.startsWith("/calendar/conn") || r.pattern.startsWith("/calendar/calendars"))).toEqual([]);
    // The control: the verdict is not refusing the whole calendar.
    expect(relayVerdict("GET", "/calendar/settings")).toBe("forward");
    expect(relayVerdict("POST", "/calendar/writes")).toBe("forward");
  });

  it("every one of them says so on its own row of the route table", () => {
    const door = calendarRoutes.filter((r) => /^\/calendar\/(connect|connections|calendars)/.test(r.pattern));
    expect(door.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual([
      "DELETE /calendar/connections/:id", "GET /calendar/connect", "PATCH /calendar/calendars/:id", "POST /calendar/connections",
      "POST /calendar/connections/:id/check", "POST /calendar/connections/:id/sign-in",
    ]);
    expect(door.filter((r) => r.relay !== false)).toEqual([]);
  });
});
