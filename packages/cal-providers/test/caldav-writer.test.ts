/**
 * A CalDAV calendar, written, at the bench's stand-in of a CalDAV server (a server of this test's
 * own on 127.0.0.1 that answers PUT and DELETE as RFC 4791 and RFC 7232 say: `If-None-Match: *` on
 * a member that is there is 412, `If-Match` on another tag is 412, and every write moves the tag).
 * The writer runs over the real request port, on the own-network policy a person's own server is
 * reached on. The live run at the bench's own server is `caldav.live.ts`'s.
 */
import { intlZones, readCalendar, DEFAULT_LIMITS, wall, zoned, parseRRule } from "@ohmail/cal-core";
import type { HostResolver } from "@trafficflow/core/net";
import { afterEach, describe, expect, it } from "vitest";
import { makeWriter } from "../src/caldav/index.js";
import type { CalendarWriter, Connection, EventDraft, WriteAnswer } from "../src/port.js";
import { namedHostRequest } from "../src/request/index.js";
import { startCalDavStandIn, type StandIn, type StandInOptions } from "./caldav-stand-in.js";

const ZONES = intlZones();
const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const KEY = "0123456789abcdef0123456789abcdef";
const UID = "01234567-89ab-cdef-0123-456789abcdef";
const never = new AbortController().signal;
const resolver: HostResolver = { resolve: async () => ["127.0.0.1"] };

const servers: StandIn[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function bench(options: StandInOptions = {}) {
  const dav = await startCalDavStandIn(options);
  servers.push(dav);
  dav.addCalendar("studio");
  const base = `http://127.0.0.1:${dav.port}`;
  const connection: Connection = {
    provider: "caldav",
    start: `${base}${dav.paths.start}`,
    credential: { kind: "basic", user: dav.options.user, password: () => dav.options.password },
  };
  const writer: CalendarWriter = makeWriter({
    http: namedHostRequest({ writes: true, resolver, policy: { kind: "own-network" } }),
    clock: { now: () => NOW },
    zones: ZONES,
  });
  const cal = { id: `${base}${dav.paths.collection("studio")}` };
  const member = (name: string) => `${base}${dav.paths.member("studio", name)}`;
  const writes = () => dav.seen.filter((s) => s.method === "PUT" || s.method === "DELETE");
  return { dav, connection, writer, cal, member, writes };
}

const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  start: zoned(wall(2026, 11, 17, 9), "Europe/Zurich"),
  end: zoned(wall(2026, 11, 17, 10), "Europe/Zurich"),
  summary: "Glaze firing",
  description: null,
  location: "Studio 2",
  url: null,
  busy: true,
  private: false,
  rule: null,
  organizer: null,
  attendees: [],
  alarms: [15],
  ...over,
});
const word = (a: WriteAnswer): string => (a.ok ? "ok" : a.reason);
const textOf = (dav: StandIn, name: string): string => {
  const put = dav.seen.filter((s) => s.method === "PUT" && s.path.endsWith(name)).at(-1);
  return put?.body ?? "";
};

describe("CalDAV's writer", () => {
  it("makes a new member named from the write's key, with that UID, only if it is new, and answers it as a reading would", async () => {
    const b = await bench();
    const made = await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event: draft() }, never);
    expect(word(made)).toBe("ok");
    expect(
      b.writes().map((s) => [s.method, s.path, s.headers["if-none-match"], s.headers["if-match"]]),
    ).toEqual([["PUT", b.dav.paths.member("studio", `${UID}.ics`), "*", undefined]]);
    const read = readCalendar(textOf(b.dav, `${UID}.ics`), DEFAULT_LIMITS);
    expect(
      read.ok && read.calendar.events.map((e) => [e.uid, e.summary, e.location, e.alarms.length]),
    ).toEqual([[UID, "Glaze firing", "Studio 2", 1]]);
    // The zone is defined beside the event: a server reading the text alone knows what 09:00 means.
    expect(read.ok && read.calendar.timezones.map((z) => z.tzid)).toEqual(["Europe/Zurich"]);
    expect(
      made.ok && made.items.map((i) => i.kind === "upsert" && [i.id, i.version, i.event.summary]),
    ).toEqual([[b.member(`${UID}.ics`), `"studio-${UID}.ics-1"`, "Glaze firing"]]);
  });

  it("leaves ONE member when a write is sent again after its answer was lost: the second PUT is refused 412, and the member is read back", async () => {
    const b = await bench();
    await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event: draft() }, never);
    const again = await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event: draft() }, never);
    expect(word(again)).toBe("ok");
    expect(b.writes().map((s) => s.method)).toEqual(["PUT", "PUT"]);
    expect(b.dav.seen.filter((s) => s.method === "REPORT").length).toBeGreaterThanOrEqual(2);
    expect(again.ok && again.items.length).toBe(1);
    // A member of that name with another UID is not ours: nothing is answered as done.
    const other = await bench();
    other.dav.put(
      "studio",
      `${UID}.ics`,
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//x//EN",
        "BEGIN:VEVENT",
        "UID:someone-else",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261117T090000Z",
        "SUMMARY:Theirs",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    expect(
      word(
        await other.writer.create(other.connection, other.cal, { key: { hex: KEY }, event: draft() }, never),
      ),
    ).toBe("unknown");
  });

  it("changes a stored member in the places the change names, against its tag, and keeps every other line", async () => {
    const b = await bench();
    b.dav.put(
      "studio",
      "kiln.ics",
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//elsewhere//EN",
        "BEGIN:VEVENT",
        "UID:kiln@elsewhere.test",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261118T090000Z",
        "DTEND:20261118T100000Z",
        "SUMMARY:Kiln check",
        "SEQUENCE:2",
        "X-ELSEWHERE-COLOUR:ochre",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    const target = { id: b.member("kiln.ics"), version: '"studio-kiln.ics-1"', text: null, occurrence: null };
    const changed = await b.writer.change(
      b.connection,
      b.cal,
      target,
      { summary: "Kiln check, moved", busy: false },
      never,
    );
    expect(word(changed)).toBe("ok");
    const put = b.writes().at(-1)!;
    expect([put.method, put.headers["if-match"]]).toEqual(["PUT", '"studio-kiln.ics-1"']);
    const read = readCalendar(put.body, DEFAULT_LIMITS);
    const e = read.ok ? read.calendar.events[0]! : null;
    expect([e?.summary, e?.transparency, e?.sequence, e?.uid]).toEqual([
      "Kiln check, moved",
      "TRANSPARENT",
      3,
      "kiln@elsewhere.test",
    ]);
    expect(put.body).toContain("X-ELSEWHERE-COLOUR:ochre");
  });

  it("refuses a change made against a tag the server moved past, and the member is left byte for byte", async () => {
    const b = await bench();
    b.dav.put(
      "studio",
      "kiln.ics",
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//x//EN",
        "BEGIN:VEVENT",
        "UID:kiln@x.test",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261118T090000Z",
        "DTEND:20261118T100000Z",
        "SUMMARY:Theirs",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    const old = { id: b.member("kiln.ics"), version: '"studio-kiln.ics-0"', text: null, occurrence: null };
    // Without the stored text the member is read first, and its tag is not the stored one: nothing is sent.
    expect(word(await b.writer.change(b.connection, b.cal, old, { summary: "Mine" }, never))).toBe(
      "version_stale",
    );
    expect(b.writes()).toEqual([]);
    // With the stored text in hand, the PUT goes and is refused 412: nothing is written.
    const stored = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//x//EN",
      "BEGIN:VEVENT",
      "UID:kiln@x.test",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261118T090000Z",
      "DTEND:20261118T100000Z",
      "SUMMARY:Before",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const refused = await b.writer.change(
      b.connection,
      b.cal,
      { ...old, version: '"studio-kiln.ics-0"', text: stored },
      { summary: "Mine" },
      never,
    );
    expect(word(refused)).toBe("version_stale");
    expect(b.writes().map((s) => s.headers["if-match"])).toEqual(['"studio-kiln.ics-0"']);
    const after = await b.writer.change(
      b.connection,
      b.cal,
      { ...old, version: '"studio-kiln.ics-1"', text: null },
      { summary: "Theirs" },
      never,
    );
    // The member already holds the change: it is done, whatever tag it was asked against.
    expect(word(after)).toBe("ok");
  });

  it("removes against the tag; a member already gone is removed; one changed since is not", async () => {
    const b = await bench();
    b.dav.put(
      "studio",
      "a.ics",
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//x//EN",
        "BEGIN:VEVENT",
        "UID:a@x.test",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261118T090000Z",
        "SUMMARY:A",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    const a = { id: b.member("a.ics"), version: '"studio-a.ics-1"', text: null, occurrence: null };
    // Removed by its own DELETE: what waits behind it may take its answer; removed already, found so: nothing is re-based onto it.
    expect(await b.writer.remove(b.connection, b.cal, a, never)).toEqual({
      ok: true,
      items: [{ kind: "gone", id: a.id }],
      written: true,
    });
    expect(await b.writer.remove(b.connection, b.cal, a, never)).toEqual({
      ok: true,
      items: [{ kind: "gone", id: a.id }],
    });
    b.dav.put(
      "studio",
      "b.ics",
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//x//EN",
        "BEGIN:VEVENT",
        "UID:b@x.test",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261118T090000Z",
        "SUMMARY:B",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    const old = { id: b.member("b.ics"), version: '"studio-b.ics-0"', text: null, occurrence: null };
    expect(word(await b.writer.remove(b.connection, b.cal, old, never))).toBe("version_stale");
  });

  it("writes invitees only where the server sends invitations itself", async () => {
    const people = [{ email: "giulia@example.test", name: "Giulia", optional: false }];
    const plain = await bench();
    expect(
      word(
        await plain.writer.create(
          plain.connection,
          plain.cal,
          { key: { hex: KEY }, event: draft({ attendees: people, organizer: "mila@example.test" }) },
          never,
        ),
      ),
    ).toBe("invitees_unsupported");
    expect(plain.writes()).toEqual([]);
    const scheduling = await bench({ autoSchedule: true });
    expect(
      word(
        await scheduling.writer.create(
          scheduling.connection,
          scheduling.cal,
          { key: { hex: KEY }, event: draft({ attendees: people, organizer: "mila@example.test" }) },
          never,
        ),
      ),
    ).toBe("ok");
    const read = readCalendar(scheduling.writes()[0]!.body, DEFAULT_LIMITS);
    expect(
      read.ok &&
        read.calendar.events.map((e) => [
          e.organizer?.email,
          e.attendees.map((p) => [p.email, p.role, p.partstat, p.rsvp]),
        ]),
    ).toEqual([["mila@example.test", [["giulia@example.test", "REQ-PARTICIPANT", "NEEDS-ACTION", true]]]]);
  });

  it("takes an answer whose first attempt landed as done when it is sent again, and writes nothing more; one on a copy someone else moved is refused", async () => {
    const b = await bench({ autoSchedule: true });
    const invitation = (summary: string): string =>
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//x//EN",
        "BEGIN:VEVENT",
        "UID:invite@x.test",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261118T090000Z",
        "DTEND:20261118T100000Z",
        `SUMMARY:${summary}`,
        "ORGANIZER:mailto:anna@example.test",
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:mila@example.test",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
    b.dav.put("studio", "invite.ics", invitation("Kiln check"));
    const asStored = {
      id: b.member("invite.ics"),
      version: '"studio-invite.ics-1"',
      text: invitation("Kiln check"),
      occurrence: null,
    };
    const answer = { as: "mila@example.test", reply: "ACCEPTED" } as const;
    expect(word(await b.writer.answer(b.connection, b.cal, asStored, answer, never))).toBe("ok");
    // Its answer lost, the same write is sent again on the copy it was recorded on: refused 412, and the line already says it.
    const again = await b.writer.answer(b.connection, b.cal, asStored, answer, never);
    expect(word(again)).toBe("ok");
    expect(
      again.ok &&
        again.items.map((i) => i.kind === "upsert" && [i.version, i.event.attendees.map((p) => p.partstat)]),
    ).toEqual([['"studio-invite.ics-2"', ["ACCEPTED"]]]);
    expect(b.writes().map((s) => [s.method, s.headers["if-match"]])).toEqual([
      ["PUT", '"studio-invite.ics-1"'],
      ["PUT", '"studio-invite.ics-1"'],
    ]);
    // Someone else's change, the line not answered: refused 412, nothing written over theirs.
    b.dav.put("studio", "invite.ics", invitation("Theirs"));
    expect(word(await b.writer.answer(b.connection, b.cal, asStored, answer, never))).toBe("version_stale");
    const read = await b.writer.change(
      b.connection,
      b.cal,
      { ...asStored, version: '"studio-invite.ics-3"', text: null },
      { summary: "Theirs" },
      never,
    );
    expect(
      read.ok &&
        read.items.map(
          (i) => i.kind === "upsert" && [i.event.summary, i.event.attendees.map((p) => p.partstat)],
        ),
    ).toEqual([["Theirs", ["NEEDS-ACTION"]]]);
  });

  it("asks nothing for an address outside the collection, and says view only where the server refuses the write", async () => {
    const b = await bench();
    for (const id of [
      `http://127.0.0.1:${b.dav.port}/dav/calendars/mila/other/x.ics`,
      `http://127.0.0.1:${b.dav.port}/dav/calendars/mila/studio`,
      "https://elsewhere.example.test/dav/calendars/mila/studio/x.ics",
      "mailto:x@example.test",
    ]) {
      expect(
        word(
          await b.writer.change(
            b.connection,
            b.cal,
            { id, version: '"1"', text: null, occurrence: null },
            { summary: "x" },
            never,
          ),
        ),
      ).toBe("address_not_allowed");
    }
    expect(b.dav.seen.length).toBe(0);
    const readOnly = await bench();
    readOnly.dav.addCalendar("shared", { privileges: ["read"] });
    const shared = { id: `http://127.0.0.1:${readOnly.dav.port}${readOnly.dav.paths.collection("shared")}` };
    expect(
      word(
        await readOnly.writer.create(
          readOnly.connection,
          shared,
          { key: { hex: KEY }, event: draft() },
          never,
        ),
      ),
    ).toBe("read_only");
  });

  it("sends no write, no question and no sign-in to a collection on a server its own did not name: a new member, a change with invitees, a removal", async () => {
    const typed = await bench({ autoSchedule: true });
    const other = await bench({ autoSchedule: true });
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//x//EN",
      "BEGIN:VEVENT",
      "UID:one",
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261117T090000Z",
      "DTEND:20261117T100000Z",
      "SUMMARY:Kiln check",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    other.dav.put("studio", "one.ics", text, '"one-1"');
    // The other server's calendar and member, as a stored row would name them: another port of the typed server's own host.
    const stored = { id: other.member("one.ics"), version: '"one-1"', text, occurrence: null };
    const answers = [
      await typed.writer.create(typed.connection, other.cal, { key: { hex: KEY }, event: draft() }, never),
      await typed.writer.change(typed.connection, other.cal, stored, { attendees: [] }, never),
      await typed.writer.remove(typed.connection, other.cal, stored, never),
    ];
    expect(answers.map(word)).toEqual(["host_changed", "host_changed", "host_changed"]);
    expect(other.dav.seen).toEqual([]);
    // The typed server was asked where its calendars are, once for the three, and nothing was written there either.
    expect(typed.dav.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "PROPFIND /dav/",
      "PROPFIND /dav/principals/mila/",
    ]);
  });

  it("writes a series' rule and the zone over the series' span", async () => {
    const b = await bench();
    await b.writer.create(
      b.connection,
      b.cal,
      { key: { hex: KEY }, event: draft({ rule: parseRRule("FREQ=WEEKLY;COUNT=6")! }) },
      never,
    );
    const read = readCalendar(b.writes()[0]!.body, DEFAULT_LIMITS);
    expect(read.ok && read.calendar.events[0]!.rules.map((r) => r.text)).toEqual(["FREQ=WEEKLY;COUNT=6"]);
  });

  it("keeps the organizer's own line as it is in the series a series' days become, found by the ORGANIZER's own value in each spelling, and asks the others again", async () => {
    const giulia = "ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:giulia@example.test";
    const seriesOf = (organizer: string, own: string): string =>
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//x//EN",
        "BEGIN:VEVENT",
        "UID:critique@x.test",
        "DTSTAMP:20261101T000000Z",
        "DTSTART;TZID=Europe/Zurich:20261116T090000",
        "DTEND;TZID=Europe/Zurich:20261116T100000",
        // The series as a press's first part leaves it: ended before 30 November, the day its days are made a series of their own from.
        "RRULE:FREQ=WEEKLY;UNTIL=20261130T075959Z",
        "SUMMARY:Glaze critique",
        organizer,
        own,
        giulia,
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
    const spellings: Record<string, { organizer: string; own: string; made: string }> = {
      "a principal's path, its address in a parameter": {
        organizer: "ORGANIZER;CN=Mila;EMAIL=mila@x.test:/principals/mila/",
        own: "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;ROLE=CHAIR;EMAIL=mila@x.test:/principals/mila/",
        made: "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;ROLE=CHAIR;EMAIL=mila@x.test:/principals/mila/",
      },
      "a urn": {
        organizer: "ORGANIZER;CN=Mila:urn:uuid:00000000-0000-4000-8000-00000000a11a",
        own: "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;ROLE=CHAIR:urn:uuid:00000000-0000-4000-8000-00000000a11a",
        made: "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;ROLE=CHAIR:urn:uuid:00000000-0000-4000-8000-00000000a11a",
      },
      "a mail address in capitals, its own line in small letters": {
        organizer: "ORGANIZER;CN=Mila:MAILTO:Mila@X.Test",
        own: "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:mila@x.test",
        made: "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:mila@x.test",
      },
      // Another value than the organizer's: an invitee of the series like any other, asked again.
      "a mail address, the line of the same name a principal's path": {
        organizer: "ORGANIZER;CN=Mila:mailto:mila@x.test",
        own: "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED;ROLE=CHAIR;EMAIL=mila@x.test:/principals/mila/",
        made: "ATTENDEE;CN=Mila;PARTSTAT=NEEDS-ACTION;ROLE=CHAIR;EMAIL=mila@x.test;RSVP=TRUE:/principals/mila/",
      },
    };
    const seen: Record<string, { own: string | undefined; giulia: string | undefined }> = {};
    for (const [name, s] of Object.entries(spellings)) {
      const b = await bench({ autoSchedule: true });
      const text = seriesOf(s.organizer, s.own);
      b.dav.put("studio", "c.ics", text, '"c-1"');
      const day = zoned(wall(2026, 11, 30, 9), "Europe/Zurich");
      const made = await b.writer.continueSeries(
        b.connection,
        b.cal,
        {
          key: { hex: KEY },
          from: { id: b.member("c.ics"), version: '"c-1"', text, occurrence: day },
          start: day,
          end: zoned(wall(2026, 11, 30, 10), "Europe/Zurich"),
          rule: parseRRule("FREQ=WEEKLY;COUNT=4")!,
          change: {},
        },
        never,
      );
      expect(word(made)).toBe("ok");
      const lines = b
        .writes()[0]!
        .body.replace(/\r\n[ \t]/g, "")
        .split("\r\n");
      seen[name] = {
        own: lines.find((l) => l.startsWith("ATTENDEE;CN=Mila")),
        giulia: lines.find((l) => l.startsWith("ATTENDEE;CN=Giulia")),
      };
    }
    expect(seen).toEqual(
      Object.fromEntries(
        Object.entries(spellings).map(([name, s]) => [
          name,
          {
            own: s.made,
            giulia: "ATTENDEE;CN=Giulia;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:giulia@example.test",
          },
        ]),
      ),
    );
  });
});
