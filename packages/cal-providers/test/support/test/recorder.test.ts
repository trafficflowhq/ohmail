import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { parseCalendarTestAccounts } from "../calendar-test-accounts.ts";
import { assertClean, NotClean, NotRecorded, Recorder, Scrubber } from "../recorder.ts";

// Real-shaped values are put together at run time, so that this file itself carries none.
const REAL_DOMAIN = ["pottery-studio", "ch"].join(".");
const APPLE = `bench.potter@${["icloud", "com"].join(".")}`;
const GOOGLE = `bench.kiln@${["gmail", "com"].join(".")}`;
const accounts = parseCalendarTestAccounts([`ICLOUD_APPLE_ID=${APPLE}`, "ICLOUD_APP_PASSWORD=abcd-efgh-ijkl-mnop", `GOOGLE_TEST_ACCOUNT=${GOOGLE}`, "GOOGLE_OAUTH_CLIENT_ID=invented-client-id", "GOOGLE_OAUTH_CLIENT_SECRET=invented-client-secret", "GOOGLE_TEST_REFRESH_TOKEN=invented-refresh-token"].join("\n"));
const rule = (text: string) => {
  try {
    assertClean(text);
  } catch (e) {
    return (e as NotClean).rule;
  }
  return "clean";
};

describe("assertClean", () => {
  it("refuses an address on a real domain and lets the reserved ones through", () => {
    assert.equal(rule(`ORGANIZER:mailto:someone@${REAL_DOMAIN}`), "an address on a domain that is not reserved");
    assert.equal(rule("mila@lichtgrat.example, info@example.org, a@b.test, x@sub.example.com"), "clean");
  });
  it("refuses a credential's shape, a Meet room and an account number in a path", () => {
    assert.equal(rule(`Authorization: ${"Bear"}er abc`), "a bearer credential");
    assert.equal(rule(`Authorization: ${"Bas"}ic abc`), "a basic credential");
    assert.equal(rule(`"access_token": "${"ya"}29.abc"`), "a Google access token");
    assert.equal(rule(`refresh ${"1"}//0abc`), "a Google refresh token");
    assert.equal(rule(`${"GOC"}SPX-abc`), "a Google client secret");
    assert.equal(rule(`123-abc.apps.${"googleusercontent"}.com`), "a Google client id");
    assert.equal(rule(`https://meet.${"google"}.com/abc-defg-hij`), "a Meet room");
    assert.equal(rule(`/${"1234567890"}/calendars/`), "an account number in a path");
  });
  it("never quotes what it found", () => {
    try {
      assertClean(`someone@${REAL_DOMAIN}`);
      assert.fail("not refused");
    } catch (e) {
      assert.ok(!(e as Error).message.includes(REAL_DOMAIN));
    }
  });
});

describe("Scrubber", () => {
  const googleEvent = (id: string) => ({
    kind: "calendar#event",
    etag: '"333"',
    id,
    htmlLink: "https://calendar.example/event?eid=abc",
    created: "2026-11-13T17:30:01.000Z",
    updated: "2026-11-13T17:30:02.123Z",
    summary: "Kiln handover",
    creator: { email: GOOGLE, self: true },
    organizer: { email: GOOGLE, self: true, displayName: "A Display Name" },
    attendees: [{ email: APPLE, displayName: "Another Name", responseStatus: "needsAction" }, { email: `third@${REAL_DOMAIN}`, responseStatus: "accepted", comment: "see you" }],
    iCalUID: `${id.replace(/_.*/, "")}@${["google", "com"].join(".")}`,
    hangoutLink: `https://meet.${"google"}.com/abc-defg-hij`,
    conferenceData: { createRequest: { requestId: "r", conferenceSolutionKey: { type: "hangoutsMeet" }, status: { statusCode: "success" } }, entryPoints: [{ entryPointType: "video", uri: `https://meet.${"google"}.com/abc-defg-hij`, label: "x" }, { entryPointType: "phone", uri: "tel:+41-00-000-00-00", pin: "1234" }], conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet", iconUri: "https://icons.example/x.png" }, conferenceId: "abc-defg-hij" },
  });

  it("maps a Google answer: ids by counter, people to the bench's domain, the Meet room to an invented one", () => {
    const s = new Scrubber({ accounts });
    const out = s.google({ kind: "calendar#events", etag: '"1"', nextSyncToken: "CPj-raw-token", items: [googleEvent("abc123"), { ...googleEvent("abc123_20261201T170000Z"), recurringEventId: "abc123" }] }) as any;
    const [first, day] = out.items;
    assert.equal(out.etag, undefined);
    assert.equal(out.nextSyncToken, "sync-1");
    assert.deepEqual([first.id, first.iCalUID, day.id, day.recurringEventId, day.iCalUID], ["evt-1", "evt-1@bench.example", "evt-1_20261201T170000Z", "evt-1", "evt-1@bench.example"]);
    assert.deepEqual(first.organizer, { email: "google-account@bench.example", self: true });
    assert.deepEqual(first.attendees, [{ email: "icloud-account@bench.example", responseStatus: "needsAction" }, { email: "person-1@bench.example", responseStatus: "accepted" }]);
    assert.deepEqual([first.created, first.updated, first.htmlLink, first.etag], ["2026-11-13T12:00:00.000Z", "2026-11-13T12:00:00.000Z", undefined, undefined]);
    assert.equal(first.hangoutLink, "https://meet.bench.example/room-1");
    assert.deepEqual(first.conferenceData.entryPoints, [{ entryPointType: "video", uri: "https://meet.bench.example/room-1" }]);
    assert.equal(first.conferenceData.conferenceId, "room-1");
    assertClean(JSON.stringify(out));
  });

  it("maps iCalendar: the same event gets the same name as at Google, Apple's own lines go", () => {
    const s = new Scrubber({ accounts });
    s.google(googleEvent("abc123"));
    const ics = ["BEGIN:VEVENT", `UID:abc123@${["google", "com"].join(".")}`, "DTSTAMP:20261113T173001Z", "CREATED:20261113T173000Z", "LAST-MODIFIED:20261113T173002Z", `ORGANIZER;CN="Name: with a colon";EMAIL=${GOOGLE}:mailto:${GOOGLE}`, `ATTENDEE;CN=Folded Name;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;SCHEDULE-STATUS="1.1";X-`, ` CALENDARSERVER-DTSTAMP=20261113T173001Z:mailto:${APPLE.toUpperCase()}`, "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC", "SUMMARY:Kiln handover", "END:VEVENT"].join("\r\n");
    assert.deepEqual(s.ics(ics).split("\r\n"), ["BEGIN:VEVENT", "UID:evt-1@bench.example", "DTSTAMP:20261113T120000Z", "CREATED:20261113T120000Z", "LAST-MODIFIED:20261113T120000Z", "ORGANIZER:mailto:google-account@bench.example", "ATTENDEE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:icloud-account@bench.example", "SUMMARY:Kiln handover", "END:VEVENT"]);
  });

  it("maps a multistatus: the account number, the host, the tokens, the addresses, the text inside", () => {
    const s = new Scrubber({ accounts });
    const dsid = "1234567890";
    const body = `<multistatus xmlns="DAV:"><response><href>/${dsid}/calendars/bench/a.ics</href><propstat><prop><getetag>"mk8f2z"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[BEGIN:VCALENDAR\r\nUID:one@host.example\r\nATTENDEE;CN=X:mailto:${APPLE}\r\nEND:VCALENDAR\r\n]]></calendar-data><owner><href>https://p42-caldav.icloud.com:443/${dsid}/principal/</href></owner><calendar-user-address-set xmlns="urn:ietf:params:xml:ns:caldav"><href>mailto:${APPLE}</href><href>urn:uuid:0a1b2c3d-0000-1111-2222-333344445555</href></calendar-user-address-set></prop></propstat></response><sync-token>https://p42-caldav.icloud.com/${dsid}/sync/tok-99</sync-token></multistatus>`;
    const out = s.dav(body);
    assertClean(out);
    assert.ok(out.includes("<href>/principal-1/calendars/bench/a.ics</href>") && out.includes("https://p00-caldav.icloud.com/principal-1/principal/"));
    assert.ok(out.includes("<getetag>&quot;etag-1&quot;</getetag>") && out.includes("<sync-token>sync-1</sync-token>"));
    assert.ok(out.includes("UID:evt-1@bench.example&#13;\nATTENDEE:mailto:icloud-account@bench.example") && out.includes("<href>mailto:icloud-account@bench.example</href>") && out.includes("urn:uuid:uuid-1"));
    assert.ok(!out.includes(dsid) && !out.includes("p42") && !out.includes("mk8f2z"));
  });
});

describe("Scrubber: what a provider wrote for another account", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "");
  /** Is `needle` in `text` as base64, at any of the three places its first byte can fall? */
  const inBase64 = (text: string, needle: string) =>
    [0, 1, 2].some((off) => {
      const enc = Buffer.from("A".repeat(off) + needle, "utf8").toString("base64");
      return text.includes(enc.slice([0, 2, 3][off]!, enc.length - ((off + needle.length) % 3 ? 4 : 0)));
    });
  const CALENDAR_HOST = ["calendar", "google", "com"].join(".");

  // Google writes a "view your event" link into an invitation's text. Its eid is base64 of the event's id
  // and the invitee's address, its tok base64 of the organizer's address and a hash.
  for (const pad of ["", "s", "ss"]) {
    const apple = `bench.potter.wheel${pad}@${["icloud", "com"].join(".")}`;
    const google = `bench.kiln.wheel.mug${pad}@${["gmail", "com"].join(".")}`;
    it(`takes the invitation's link, its eid and its tok out, addresses in base64 with them (addresses of ${apple.length} and ${google.length} letters)`, () => {
      const local = parseCalendarTestAccounts([`ICLOUD_APPLE_ID=${apple}`, "ICLOUD_APP_PASSWORD=abcd-efgh-ijkl-mnop", `GOOGLE_TEST_ACCOUNT=${google}`, "GOOGLE_OAUTH_CLIENT_ID=invented-client-id", "GOOGLE_OAUTH_CLIENT_SECRET=invented-client-secret", "GOOGLE_TEST_REFRESH_TOKEN=invented-refresh-token"].join("\n"));
      const eid = b64(`0a1b2c3d4e5f6g7h8i9j0k1l2m ${apple}`);
      const tok = b64(`${google.length}#${google}${"ab12".repeat(10)}`);
      const link = `https://${CALENDAR_HOST}/calendar/event?action=VIEW&eid=${eid}&tok=${tok}&ctz=Europe%2FZurich&hl=en&es=1`;
      const ics = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:0a1b2c3d4e5f6g7h8i9j0k1l2m@google.example", `ORGANIZER;CN=Bench Kiln:mailto:${google}`, `ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=${apple}:mailto:${apple}`, "SUMMARY:Kiln handover", `DESCRIPTION:The kiln's keys change hands.\\n\\nView your event at ${link}.`.replace(/(.{70})/g, "$1\r\n "), `X-KEPT-ELSEWHERE:${b64(`seen by ${google} at the kiln`)}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
      const dir = mkdtempSync(join(tmpdir(), "ohcal-recorder-"));
      const body = `<multistatus xmlns="DAV:"><response><href>/calendars/inbox/x.ics</href><propstat><prop><getetag>"abc"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${ics}]]></calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
      const text = readFileSync(new Recorder({ dir, scrubber: new Scrubber({ accounts: local }) }).save("caldav", "invitation-from-google", { method: "REPORT", url: "https://p12-caldav.icloud.com/calendars/inbox/", depth: "1", status: 207, contentType: "application/xml", body }), "utf8");
      assert.deepEqual([text.includes(eid), text.includes(tok), /[?&;](?:eid|tok)=/.test(text), text.includes(CALENDAR_HOST)], [false, false, false, false]);
      assert.deepEqual([inBase64(text, apple), inBase64(text, google)], [false, false]);
      assert.ok(text.includes("View your event at https://calendar.bench.example/event") && text.includes("SUMMARY:Kiln handover"));
    });
  }

  it("is backed by assertClean: a Google Calendar link or an event link's token is refused", () => {
    assert.equal(rule(`see https://${CALENDAR_HOST}/calendar/event?action=VIEW`), "a Google Calendar link");
    assert.equal(rule(`see https://www.${["google", "com"].join(".")}/calendar/event?action=VIEW`), "a Google Calendar link");
    assert.equal(rule("https://links.example/open?eid=abc"), "an event link's token");
    assert.equal(rule("https://links.example/open?a=1&tok=abc"), "an event link's token");
    assert.equal(rule("https://call.ohmail-bench.example/stall-planning?token=1&video=1"), "clean");
  });

  // iCloud names the collection itself in a report, with an EMPTY calendar-data in a 404 propstat.
  it("keeps every member of a report whose first response carries an empty calendar-data", () => {
    const member = (name: string, etag: string) => `<response><href>/calendars/bench/${name}.ics</href><propstat><prop><getetag xmlns="DAV:">"${etag}"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR&#13;\nUID:${name}@host.example&#13;\nEND:VCALENDAR&#13;\n</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
    const body = `<multistatus xmlns="DAV:"><response><href>/calendars/bench/</href><propstat><prop><getetag xmlns="DAV:">"raw-collection-tag"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"/><getctag xmlns="http://calendarserver.org/ns/"/>\n</prop><status>HTTP/1.1 404 Not Found</status></propstat></response>${member("first", "raw-first-tag")}${member("second", "raw-second-tag")}</multistatus>`;
    const out = new Scrubber({ accounts }).dav(body);
    const responses = out.match(/<response>[\s\S]*?<\/response>/g) ?? [];
    assert.equal(responses.length, 3);
    assert.deepEqual(responses.slice(1).map((r) => /<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/.exec(r)?.[1]?.slice(0, 15)), ["BEGIN:VCALENDAR", "BEGIN:VCALENDAR"]);
    assert.deepEqual([out.includes("&lt;response"), /raw-[a-z]+-tag/.test(out), (out.match(/&quot;etag-\d&quot;/g) ?? []).length], [false, false, 3]);
    assert.ok(out.includes('<calendar-data xmlns="urn:ietf:params:xml:ns:caldav"/><getctag xmlns="http://calendarserver.org/ns/"/>\n</prop>'));
  });
});

describe("Recorder", () => {
  const exchange = (body: string) => ({ method: "GET", url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE)}/events?syncToken=raw-token`, status: 200, contentType: "application/json; charset=UTF-8", body });

  it("writes a scrubbed fixture, with the calendar and the token in the address mapped too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohcal-recorder-"));
    const path = new Recorder({ dir, scrubber: new Scrubber({ accounts }) }).save("google", "events-list", exchange(JSON.stringify({ kind: "calendar#events", summary: GOOGLE, items: [{ kind: "calendar#event", id: "a1", summary: "kept" }, { kind: "calendar#event", id: "b2", summary: "dropped" }] })), { item: (i) => i.summary === "kept" });
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(fixture.request.url, "https://www.googleapis.com/calendar/v3/calendars/cal-1/events?syncToken=sync-1");
    assert.deepEqual(fixture.response, { status: 200, contentType: "application/json", body: { kind: "calendar#events", summary: "google-account@bench.example", items: [{ kind: "calendar#event", id: "evt-1", summary: "kept" }] } });
  });

  it("has no raw mode: what is not clean is refused and nothing is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohcal-recorder-"));
    const recorder = new Recorder({ dir, scrubber: new Scrubber({ accounts }) });
    assert.throws(() => recorder.save("google", "leaky", exchange(JSON.stringify({ kind: "calendar#event", id: "a1", description: `write to someone@${REAL_DOMAIN}` }))), NotClean);
    assert.throws(() => recorder.save("caldav", "leaky-dav", { ...exchange(`<x>${"Bear"}er abcdef</x>`), contentType: "application/xml" }), NotClean);
    // A value where no scrub rule looks (a request's header, kept as it was sent) is still refused.
    assert.throws(() => recorder.save("caldav", "leaky-header", { ...exchange("<x/>"), url: "http://127.0.0.1:1/bench/", contentType: "application/xml", depth: "invented-refresh-token" }), (e: Error) => e instanceof NotClean && e.rule.startsWith("a value of the accounts file"));
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
    assert.equal("raw" in recorder || "saveRaw" in recorder, false);
  });

  it("records the one exchange it was armed for, and never the sign-in's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohcal-recorder-"));
    const tap = new Recorder({ dir, scrubber: new Scrubber({ accounts }) }).tap(async (input) => new Response(JSON.stringify(input.includes("oauth2") ? { access_token: "would-be-a-token" } : { kind: "calendar#events", items: [] }), { headers: { "content-type": "application/json" } }));
    tap.next("google", "armed");
    await tap.fetch("https://oauth2.googleapis.com/token", { method: "POST" });
    assert.deepEqual(readdirSync(dir), []);
    await tap.fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    await tap.fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(tap.commit().length, 1);
    assert.deepEqual(readdirSync(dir), ["armed.json"]);
  });

  it("keeps a run whole or not at all: a refusal that was not armed as one fails it, and nothing is written", async () => {
    const answers = (statuses: number[]) => async () => new Response(null, { status: statuses.shift()!, headers: { "content-type": "" } });
    const dir = mkdtempSync(join(tmpdir(), "ohcal-recorder-"));
    const tap = new Recorder({ dir, scrubber: new Scrubber({ accounts }) }).tap(answers([207, 412]));
    tap.next("caldav", "good");
    await tap.fetch("http://127.0.0.1:1/bench/", { method: "REPORT" });
    tap.next("caldav", "refused-unasked");
    await assert.rejects(() => tap.fetch("http://127.0.0.1:1/bench/", { method: "REPORT" }), (e: Error) => e instanceof NotRecorded && e.message === "not recorded, nothing kept: refused-unasked was answered 412, armed for 2xx");
    assert.throws(() => tap.commit(), NotRecorded);
    assert.deepEqual(readdirSync(dir), []);

    const asRefusal = new Recorder({ dir, scrubber: new Scrubber({ accounts }) }).tap(answers([412, 207]));
    asRefusal.next("caldav", "one-uid-refused", { status: 412 });
    await asRefusal.fetch("http://127.0.0.1:1/bench/", { method: "REPORT" });
    assert.deepEqual(asRefusal.commit().length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, "one-uid-refused.json"), "utf8")).response.status, 412);
    asRefusal.next("caldav", "was-to-be-refused", { status: 412 });
    await assert.rejects(() => asRefusal.fetch("http://127.0.0.1:1/bench/", { method: "REPORT" }), NotRecorded);

    const neverAsked = new Recorder({ dir, scrubber: new Scrubber({ accounts }) }).tap(answers([]));
    neverAsked.next("caldav", "armed-and-left");
    assert.throws(() => neverAsked.commit(), /armed and never asked/);
  });
});
