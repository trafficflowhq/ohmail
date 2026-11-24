import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { intlZones } from "@ohmail/cal-core";
import { makeReader } from "@ohmail/cal-providers/caldav";
import { parseCredential } from "@ohmail/cal-providers/connect";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, FETCH_BODY_MAX_BYTES, MAX_REDIRECTS } from "@ohmail/cal-providers/limits";
import { CALENDAR_WAYS, HttpAdapter, MutationRejectedError, calendarWaysOf, type CalendarConnectTransport, type FetchLike } from "@ohmail/client-engine";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { RELAY_ALLOWLIST, relayVerdict } from "@trafficflow/api/relay-allowlist";
import { pinnedHttpRequest } from "@trafficflow/core/net";
import { calCalendars, calCredentials, calSettings } from "@trafficflow/db/mail";
import { calendarFeed } from "@trafficflow/services/calendar";
import { FIXED_NOW, makeDeps, seedSession } from "../packages/api/test/helpers.js";
import { guardedRequest } from "../packages/cal-providers/src/request/guarded.js";
import { startCalDavStandIn } from "../packages/cal-providers/test/caldav-stand-in.js";

/**
 * THE CONNECT DOOR FROM A DEVICE'S SIDE: the client's six calls through the real routes, and what
 * a door that does not carry them answers. A root test, because it holds the wire client and the
 * route table together and neither may depend on the other.
 *
 * The relay's answer is part of the door: all six routes are relayable, so a desktop paired to an
 * account and a phone, which both ask through a relay, connect a calendar as they add a mailbox.
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

    // What the account holds, by the read: the records the two connects answered, as they stand now.
    expect((await w.adapter.calendarConnections()).map((c) => [c.id, c.provider, c.serverHost]))
      .toEqual([[connectionId, "caldav", "caldav.icloud.com"], [sub.connection.id, "ics", "feeds.example.test"]]);
    expect(await w.adapter.removeCalendarConnection(connectionId)).toMatchObject({ removed: true });
    expect((await w.adapter.calendarConnections()).map((c) => c.id)).toEqual([sub.connection.id]);
    // This store is the test's own: every sealed sign-in in it is this account's.
    expect((await w.db.select({ id: calCredentials.connectionId }).from(calCredentials)).map((c) => c.id)).toEqual([sub.connection.id]);
    expect(w.sent.map((r) => r.method).sort()).toEqual(["DELETE", "GET", "GET", "GET", "PATCH", "PATCH", "POST", "POST", "POST", "POST", "POST"]);
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

describe("typed calendar passwords", () => {
  const groups = ["blue", "hand", "clay", "kiln"];
  const appPassword = groups.join("-");
  const ordinaryPassword = [groups[0], "2", ...groups.slice(1)].join(" - ");
  const apple = "caldav.icloud.com";
  const numbered = "p42-caldav.icloud.com";
  const nonAsciiPassword = `é${groups.join("").slice(1)}`;
  const cases = [
    ["iCloud without dashes", null, groups.join(""), appPassword],
    ["iCloud with spaces", null, groups.join(" "), appPassword],
    ["iCloud in uppercase", null, appPassword.toUpperCase(), appPassword],
    ["CalDAV at iCloud", apple, groups.join(""), appPassword],
    ["CalDAV at a numbered iCloud host", numbered, groups.join(" ").toUpperCase(), appPassword],
    ["iCloud with a password containing a digit", null, ordinaryPassword, ordinaryPassword],
    ["iCloud with a password containing a non-ASCII letter", null, nonAsciiPassword, nonAsciiPassword],
    ["CalDAV at a lookalike host", `${apple}.example.test`, groups.join(" "), groups.join(" ")],
  ] as const;
  const user = ["mila", "studio.example.test"].join("@");

  async function expectAccepted(w: Awaited<ReturnType<typeof world>>, connectionId: string, expected: string) {
    const [row] = await w.db.select().from(calCredentials);
    const text = await w.deps.keyProvider.decrypt(row.secretEnc, row.keyVersion);
    const stored = parseCredential(text, { accountId: w.s.accountId, connectionId });
    if (stored?.kind !== "basic") throw new Error("expected a sealed CalDAV sign-in");
    const redirectsToNumbered = new URL(stored.server).hostname === apple;
    const redirects: Record<string, string> = {};
    const dav = await startCalDavStandIn({ user, password: expected, sendsOn: redirects });
    try {
      if (redirectsToNumbered) {
        redirects["/.well-known/caldav"] = `https://${numbered}${dav.paths.start}`;
      }
      dav.addCalendar("work");
      const reader = makeReader({
        zones: intlZones(),
        clock: { now: () => FIXED_NOW.getTime() },
        http: guardedRequest({
          writes: false, policy: { kind: "own-network" }, hosts: null,
          resolver: { resolve: async () => ["127.0.0.1"] },
          limits: { connectMs: CONNECT_TIMEOUT_MS, totalMs: ANSWER_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS, maxBodyBytes: FETCH_BODY_MAX_BYTES },
          request: (url, opts) => {
            const named = new URL(url);
            return pinnedHttpRequest(`http://127.0.0.1:${dav.port}${named.pathname}`, {
              ...opts, headers: { ...opts.headers, host: named.host },
            });
          },
        }),
      });
      const listed = await reader.listCalendars({
        provider: "caldav", start: stored.server,
        credential: { kind: "basic", user: stored.user, password: () => stored.password.reveal() },
      }, new AbortController().signal);
      expect(listed.ok && listed.value.length === 1).toBe(true);
      expect(dav.seen.length > 0 && dav.seen.every(({ signedIn }) => signedIn)).toBe(true);
      if (redirectsToNumbered) expect(dav.seen.some(({ host }) => host === numbered)).toBe(true);
    } finally {
      await dav.close();
    }
  }

  it.each(cases)("sends the expected password on create for %s", async (_name, host, typed, expected) => {
    const w = await world();
    const connectionId = randomUUID();
    const body = { connectionId, user, password: typed };
    await w.adapter.connectCalendar(host === null ? { ...body, way: "icloud" } : { ...body, way: "caldav", server: host }, randomUUID());
    await expectAccepted(w, connectionId, expected);
  });

  it.each(cases)("sends the expected password on sign-in again for %s", async (_name, host, typed, expected) => {
    const w = await world();
    const connectionId = randomUUID();
    const body = { connectionId, user, password: made("pw") };
    await w.adapter.connectCalendar(host === null ? { ...body, way: "icloud" } : { ...body, way: "caldav", server: host }, randomUUID());
    await w.adapter.signInCalendarAgain(connectionId, { user, password: typed });
    await expectAccepted(w, connectionId, expected);
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

  it("what the account holds is not guessed: a read that failed throws, and so does an answer that names no list", async () => {
    const answering = (res: () => Response | Promise<Response>): CalendarConnectTransport =>
      new HttpAdapter({ baseUrl: "http://localhost", fetch: (async () => res()) as FetchLike }) as CalendarConnectTransport;
    // "Nothing is connected" is a sentence a pane may only say when our server said it.
    await expect(answering(() => new Response(JSON.stringify({ error: { code: "not_found", message: "no such route" } }), { status: 404 })).calendarConnections())
      .rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(answering(() => { throw new TypeError("no network"); }).calendarConnections()).rejects.toBeInstanceOf(MutationRejectedError);
    // A server whose door is older than this read answers its ways alone. That is no word about what the account holds:
    // a pane that read it as "nothing" would show an empty list while connections and their sealed sign-ins stand.
    for (const none of [{ ways: [] }, { ways: [], connections: null }, { ways: [], connections: "x" }]) {
      await expect(answering(() => new Response(JSON.stringify(none), { status: 200 })).calendarConnections(), JSON.stringify(none))
        .rejects.toBeInstanceOf(MutationRejectedError);
    }
    // The control: a list our server did send is what the account holds, an empty one too.
    expect(await answering(() => new Response(JSON.stringify({ ways: [], connections: [] }), { status: 200 })).calendarConnections()).toEqual([]);
  });
});

describe("the relay carries the connect door", () => {
  const DOOR: [string, string][] = [
    ["GET", "/calendar/connect"], ["POST", "/calendar/connections"], ["DELETE", `/calendar/connections/${randomUUID()}`],
    ["POST", `/calendar/connections/${randomUUID()}/check`], ["POST", `/calendar/connections/${randomUUID()}/sign-in`],
    ["PATCH", `/calendar/calendars/${randomUUID()}`],
  ];

  it("forwards each of the six routes, in every spelling of its path that reaches it, and nothing beside them under their paths", () => {
    for (const [method, path] of DOOR) {
      expect(relayVerdict(method, path), `${method} ${path}`).toBe("forward");
      expect(relayVerdict(method, `${path}/`), `${method} ${path}/`).toBe("forward");
      expect(relayVerdict(method, path.replace("/calendar/", "/calendar//")), "a doubled slash").toBe("forward");
      expect(relayVerdict(method, `/api${path}`), "under the web's prefix").toBe("forward");
    }
    expect(RELAY_ALLOWLIST.filter((r) => r.pattern.startsWith("/calendar/conn") || r.pattern.startsWith("/calendar/calendars")).map((r) => `${r.method} ${r.pattern}`).sort())
      .toEqual([
        "DELETE /calendar/connections/:id", "GET /calendar/connect", "PATCH /calendar/calendars/:id", "POST /calendar/connections",
        "POST /calendar/connections/:id/check", "POST /calendar/connections/:id/sign-in",
      ]);
    // The controls: a method a route does not take, and a path one step past a route, are no route of the door.
    for (const [method, path] of [
      ["PUT", "/calendar/connections"], ["GET", "/calendar/connections"], ["GET", `/calendar/connections/${randomUUID()}`],
      ["DELETE", "/calendar/connections"], ["POST", `/calendar/connections/${randomUUID()}/sign-in/again`], ["POST", "/calendar/connect"],
      ["GET", `/calendar/calendars/${randomUUID()}`], ["POST", `/Calendar/connections`],
    ] as const) {
      expect(relayVerdict(method, path), `${method} ${path}`).toBe("refuse");
    }
  });

  it("every one of them says so on its own row of the route table, and is a route of a signed-in session of its own account", () => {
    const door = calendarRoutes.filter((r) => /^\/calendar\/(connect|connections|calendars)/.test(r.pattern));
    expect(door.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual([
      "DELETE /calendar/connections/:id", "GET /calendar/connect", "PATCH /calendar/calendars/:id", "POST /calendar/connections",
      "POST /calendar/connections/:id/check", "POST /calendar/connections/:id/sign-in",
    ]);
    expect(door.filter((r) => r.relay !== true)).toEqual([]);
    // What a relayed route may never be: open to nobody's session, to an enrolling one, or an answer for a sign-in of ours in its body.
    expect(door.filter((r) => r.options?.public === true || r.options?.anonymous === true || r.options?.enrollmentOk === true || r.options?.credentialSubject === true)).toEqual([]);
  });
});
