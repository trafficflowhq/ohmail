import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BENCH_EVENTS, benchUid, toICalendar } from "../bench-events.ts";
import { CALDAV_TEST_SERVERS, CalDavTestClient, readPlacesByUid, uidsOf } from "../caldav-test-client.ts";
import { Secret } from "../calendar-test-accounts.ts";

// Never dials: every client here is handed a `fetch` of the test's own.
const user = new Secret("bench");
const password = new Secret("abcd efgh ijkl mnop");
const expectedCredential = `Basic ${Buffer.from("bench:abcdefghijklmnop").toString("base64")}`;
type Sent = { url: string; method: string; headers: Headers; body: unknown };
function clientAt(baseUrl: string, answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const client = new CalDavTestClient({ baseUrl, user, password, fetch: async (url, init) => (sent.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body }), answer(sent.at(-1)!)) });
  return { client, sent };
}
const multistatus = (inner: string) => new Response(`<?xml version="1.0"?><multistatus xmlns="DAV:">${inner}</multistatus>`, { status: 207 });

describe("the CalDAV test client", () => {
  it("has two rows, the bench and iCloud, and takes no other server", () => {
    assert.deepEqual(CALDAV_TEST_SERVERS.map((r) => r.name), ["bench", "icloud"]);
    for (const ok of ["http://127.0.0.1:8821/", "http://localhost:8821/", "https://caldav.icloud.com/"]) assert.doesNotThrow(() => new CalDavTestClient({ baseUrl: ok, user, password }));
    for (const no of ["https://caldav.example.org/", "http://caldav.icloud.com/", "https://caldav.icloud.com:8443/", "https://caldav.icloud.com.attacker.example/", "http://192.168.1.10:5232/", "https://p12-caldav.icloud.com.example/"]) {
      assert.throws(() => new CalDavTestClient({ baseUrl: no, user, password }), /is not a test server/);
    }
    assert.throws(() => new CalDavTestClient({ baseUrl: "http://127.0.0.1:8821/", user, password: new Secret("") }), /no credentials/);
  });

  it("sends the app password joined, and only to an address of its row", async () => {
    const { client, sent } = clientAt("https://caldav.icloud.com/", () => multistatus(""));
    await client.request("PROPFIND", "https://p42-caldav.icloud.com:443/1/calendars/", { depth: "1", body: "<x/>" });
    assert.equal(sent[0]!.headers.get("authorization"), expectedCredential);
    assert.equal(sent[0]!.headers.get("depth"), "1");
    await assert.rejects(() => client.request("GET", "https://caldav.example.org/x"), /outside the icloud row/);
    await assert.rejects(() => client.request("GET", "http://127.0.0.1:8821/x"), /outside the icloud row/);
    assert.equal(sent.length, 1);
  });

  it("follows a redirect inside its row and stops at one that leaves it, before the credentials go", async () => {
    const inside = clientAt("https://caldav.icloud.com/", (s) => (s.url.includes("p07") ? multistatus("") : new Response(null, { status: 301, headers: { location: "https://p07-caldav.icloud.com/1/principal/" } })));
    assert.equal((await inside.client.request("PROPFIND", "/1/principal/")).status, 207);
    assert.deepEqual(inside.sent.map((s) => new URL(s.url).hostname), ["caldav.icloud.com", "p07-caldav.icloud.com"]);
    const outside = clientAt("https://caldav.icloud.com/", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } }));
    await assert.rejects(() => outside.client.request("PROPFIND", "/"), /outside the icloud row/);
    assert.equal(outside.sent.length, 1);
  });

  it("finds the principal and the home, and lists the home's calendars without the home itself", async () => {
    const { client } = clientAt("http://127.0.0.1:8821/", (s) => {
      const body = String(s.body);
      if (body.includes("current-user-principal")) return multistatus("<response><href>/</href><propstat><prop><current-user-principal><href>/bench/</href></current-user-principal></prop></propstat></response>");
      if (body.includes("calendar-home-set")) return multistatus('<response><href>/bench/</href><propstat><prop><C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"><href>/bench/</href></C:calendar-home-set></prop></propstat></response>');
      return multistatus(
        '<response><href>/bench/</href><propstat><prop><resourcetype><principal /><collection /></resourcetype></prop></propstat></response>' +
          '<response><href>/bench/studio/</href><propstat><prop><resourcetype><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav" /><collection /></resourcetype><displayname>Studio &amp; market</displayname><C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name=\'VEVENT\' /></C:supported-calendar-component-set><sync-token>tok-1</sync-token></prop></propstat></response>' +
          '<response><href>/bench/tasks/</href><propstat><prop><resourcetype><calendar xmlns="urn:ietf:params:xml:ns:caldav"/><collection/></resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VTODO"/></supported-calendar-component-set></prop></propstat></response>' +
          "<response><href>/bench/inbox/</href><propstat><prop><resourcetype><collection/><schedule-inbox xmlns=\"urn:ietf:params:xml:ns:caldav\"/><calendar-proxy-read/></resourcetype></prop></propstat></response>",
      );
    });
    const d = await client.discover();
    assert.deepEqual([d.status, d.principal, d.home], [207, "http://127.0.0.1:8821/bench/", "http://127.0.0.1:8821/bench/"]);
    const list = await client.collections(d.home);
    assert.deepEqual(list.collections.map((c) => [new URL(c.href).pathname, c.displayName, c.isCalendar, c.components.join(), c.syncToken]), [["/bench/studio/", "Studio & market", true, "VEVENT", "tok-1"], ["/bench/tasks/", "", true, "VTODO", undefined], ["/bench/inbox/", "", false, "", undefined]]);
  });

  it("reads a report's members, and leaves out the collection when a server names it among them", async () => {
    const data = toICalendar(BENCH_EVENTS[2]!);
    const { client, sent } = clientAt("http://127.0.0.1:8821/", () =>
      multistatus(
        '<response><href>/bench/studio/</href><propstat><prop><getetag>"c"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>' +
          `<response><href>/bench/studio/wheel-class.ics</href><propstat><prop><getetag>&quot;e1&quot;</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${data}]]></calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
          "<response><href>/bench/studio/gone.ics</href><status>HTTP/1.1 404 Not Found</status></response><sync-token>tok-2</sync-token>",
      ),
    );
    const q = await client.query("http://127.0.0.1:8821/bench/studio/", { uid: benchUid("wheel-class"), data: true });
    assert.deepEqual(q.objects.map((o) => [new URL(o.href).pathname, o.etag, o.status]), [["/bench/studio/wheel-class.ics", '"e1"', 200], ["/bench/studio/gone.ics", undefined, 404]]);
    assert.equal(q.objects[0]!.data, data);
    assert.ok(String(sent[0]!.body).includes(`<c:text-match collation="i;octet">${benchUid("wheel-class")}</c:text-match>`));
    const s = await client.sync("http://127.0.0.1:8821/bench/studio/", "");
    assert.deepEqual([s.objects.length, s.token], [2, "tok-2"]);
  });

  // iCloud's way: 412 to a query that filters on UID (with any collation or none), 207 to the plain one,
  // which names the collection itself first.
  const refusesTheUidFilter = (s: Sent) => {
    if (String(s.body).includes("prop-filter")) return new Response(null, { status: 412 });
    if (s.url.endsWith("/locked/")) return new Response(null, { status: 403 });
    const member = (key: string) => `<response><href>${new URL(s.url).pathname}${key}.ics</href><propstat><prop><getetag>"e"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${toICalendar(BENCH_EVENTS.find((e) => e.key === key)!).replace(/\r/g, "&#13;")}</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
    return multistatus(`<response><href>${new URL(s.url).pathname}</href><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>` + (s.url.endsWith("/studio/") ? member("glaze-firing") + member("wheel-class") : member("market-day")));
  };

  it("finds an event by its UID at a server that refuses the UID filter, by reading the texts", async () => {
    const { client, sent } = clientAt("https://caldav.icloud.com/", refusesTheUidFilter);
    assert.equal((await client.query("/1/studio/", { uid: benchUid("wheel-class"), data: true })).status, 412);
    const found = await client.byUid("/1/studio/", benchUid("wheel-class"));
    assert.deepEqual([found.status, found.objects.map((o) => new URL(o.href).pathname)], [207, ["/1/studio/wheel-class.ics"]]);
    assert.deepEqual(uidsOf(found.objects[0]!.data!), [benchUid("wheel-class"), benchUid("wheel-class")]);
    assert.deepEqual((await client.byUid("/1/studio/", benchUid("market-day"))).objects, []);
    assert.ok(!String(sent.at(-1)!.body).includes("prop-filter"));
    assert.deepEqual(uidsOf("BEGIN:VEVENT\r\nUID:a-long-identifier-that-a-server-fol\r\n ded@host.example\r\nEND:VEVENT"), ["a-long-identifier-that-a-server-folded@host.example"]);
  });

  it("reads every place for a UID, and a place that does not answer 207 is a fault, never 'not there'", async () => {
    const { client } = clientAt("https://caldav.icloud.com/", refusesTheUidFilter);
    const places = [{ where: "a calendar", href: "https://caldav.icloud.com/1/studio/" }, { where: "a calendar", href: "https://caldav.icloud.com/1/market/" }, { where: "the scheduling inbox", href: "https://caldav.icloud.com/1/locked/" }];
    const there = await readPlacesByUid(client, places, benchUid("market-day"));
    assert.deepEqual([there.readings.map((r) => r.status), there.found && new URL(there.found.href).pathname, there.faults.map((f) => f.where)], [[207, 207, 403], "/1/market/", ["the scheduling inbox"]]);
    const absent = await readPlacesByUid(client, places.slice(0, 2), "nobody-planted-this@ohmail-bench.example");
    assert.deepEqual([absent.found, absent.faults], [undefined, []]);
    // The server of the finding: every place answers 412. Nothing found, and every place a fault.
    const all412 = await readPlacesByUid({ byUid: async () => ({ status: 412, objects: [] }) }, places, benchUid("market-day"));
    assert.deepEqual([all412.found, all412.faults.length], [undefined, 3]);
  });

  it("writes only-if-new and only-if-unchanged by the standard's headers", async () => {
    const { client, sent } = clientAt("http://127.0.0.1:8821/", () => new Response(null, { status: 201, headers: { etag: '"new"' } }));
    assert.deepEqual(await client.put("/bench/studio/a.ics", "BEGIN:VCALENDAR", { onlyIfNew: true }), { status: 201, etag: '"new"', text: "" });
    await client.put("/bench/studio/a.ics", "BEGIN:VCALENDAR", { ifMatch: '"new"' });
    await client.delete("/bench/studio/a.ics", { ifMatch: '"new"' });
    assert.deepEqual(sent.map((s) => [s.method, s.headers.get("if-none-match"), s.headers.get("if-match"), s.headers.get("content-type")]), [["PUT", "*", null, "text/calendar; charset=utf-8"], ["PUT", null, '"new"', "text/calendar; charset=utf-8"], ["DELETE", null, '"new"', null]]);
  });
});

describe("the bench's events as iCalendar", () => {
  it("writes a series with its one changed day in one object, a zone definition, and the bench's mark", () => {
    const series = toICalendar(BENCH_EVENTS.find((e) => e.key === "wheel-class")!);
    assert.equal(series.match(/BEGIN:VEVENT/g)!.length, 2);
    assert.ok(series.includes("RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=TU\r\n") && series.includes("RECURRENCE-ID;TZID=Europe/Zurich:20261201T180000\r\nDTSTART;TZID=Europe/Zurich:20261202T190000\r\n"));
    assert.ok(series.includes("BEGIN:VTIMEZONE\r\nTZID:Europe/Zurich\r\n") && series.includes("X-OHMAIL-BENCH:r2-cal-accounts-20261113\r\n"));
    const allDay = toICalendar(BENCH_EVENTS.find((e) => e.key === "market-day")!);
    assert.ok(allDay.includes("DTSTART;VALUE=DATE:20261121\r\nDTEND;VALUE=DATE:20261122\r\n") && !allDay.includes("VTIMEZONE"));
    assert.ok(toICalendar(BENCH_EVENTS.find((e) => e.key === "stall-planning-call")!).includes("URL:https://call.ohmail-bench.example/stall-planning\r\n"));
    assert.ok(BENCH_EVENTS.every((e) => !/ATTENDEE|ORGANIZER|LOCATION/.test(toICalendar(e))));
  });
});
