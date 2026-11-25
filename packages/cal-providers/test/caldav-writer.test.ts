/**
 * A CalDAV calendar, written, at the bench's stand-in of a CalDAV server (a server of this test's
 * own on 127.0.0.1 that answers PUT and DELETE as RFC 4791 and RFC 7232 say: `If-None-Match: *` on
 * a member that is there is 412, `If-Match` on another tag is 412, and every write moves the tag).
 * The writer runs over the real request port, on the own-network policy a person's own server is
 * reached on. The live run at the bench's own server is `caldav.live.ts`'s.
 */
import {
  formatRRule,
  intlZones,
  plainDate,
  expandSeries,
  seriesOf,
  readCalendar,
  DEFAULT_LIMITS,
  instant,
  momentOrUtc,
  wall,
  zoned,
  parseRRule,
} from "@ohmail/cal-core";
import { pinnedHttpRequest, type HostResolver } from "@trafficflow/core/net";
import { afterEach, describe, expect, it } from "vitest";
import { makeReader, makeWriter } from "../src/caldav/index.js";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, FETCH_BODY_MAX_BYTES, MAX_REDIRECTS } from "../src/limits.js";
import type { CalendarWriter, Connection, EventDraft, WriteAnswer } from "../src/port.js";
import { guardedRequest } from "../src/request/guarded.js";
import { namedHostRequest } from "../src/request/index.js";
import { startCalDavStandIn, type StandIn, type StandInOptions } from "./caldav-stand-in.js";

import { DRAFT_PROOF_CASES } from "./support/repeat-proof.js";

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

async function bench(options: StandInOptions = {}, now = () => NOW) {
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
    clock: { now },
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
  const personalText = (extra: string[] = []) =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example//EN",
      "BEGIN:VEVENT",
      "UID:pottery",
      "DTSTAMP:20261101T000000Z",
      "DTSTART;VALUE=DATE:20261116",
      "DTEND;VALUE=DATE:20261117",
      "RRULE:FREQ=DAILY;COUNT=5",
      "SUMMARY:Kiln check",
      ...extra,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
  const cut = plainDate(2026, 11, 18);

  it.each(
    (["create", "change", "move", "remove"] as const).flatMap((operation) =>
      (["p01", "p02"] as const).map((storedOn) => [operation, storedOn] as const),
    ),
  )(
    "can %s on a numbered host after following a home alias in a fresh turn (stored on %s, the alias names p01)",
    async (operation, storedOn) => {
      const home = "/dav/calendars/mila/";
      const alias = "/calendar-home/";
      const redirects: Record<string, string> = {};
      const b = await bench({ homeHref: () => alias, sendsOn: redirects, nativeMove: true });
      const base = `caldav.example.test:${b.dav.port}`;
      const numbered = `p01-${base}`;
      redirects[alias] = `http://${numbered}${home}`;
      b.dav.addCalendar("personal");
      // A row stored on another numbered host, as before the provider moved the account, names the same place at today's host.
      const stored = (path: string) => `http://${storedOn}-${base}${path}`;
      const cal = { id: stored(b.dav.paths.collection("studio")) };
      const to = { id: stored(b.dav.paths.collection("personal")) };
      const source = b.dav.paths.member("studio", "kiln.ics");
      const original = personalText();
      b.dav.put("studio", "kiln.ics", original, '"original"');
      const target = { id: stored(source), version: '"original"', text: original, occurrence: null };
      const connection = { ...b.connection, start: `http://${base}${b.dav.paths.start}` };
      const writer = makeWriter({
        http: guardedRequest({
          writes: true,
          resolver,
          policy: { kind: "own-network" },
          hosts: null,
          limits: {
            connectMs: CONNECT_TIMEOUT_MS,
            totalMs: ANSWER_TIMEOUT_MS,
            maxRedirects: MAX_REDIRECTS,
            maxBodyBytes: FETCH_BODY_MAX_BYTES,
          },
          request: (url, opts) => {
            const here = new URL(url);
            const host = here.host;
            here.hostname = "127.0.0.1";
            return pinnedHttpRequest(here.href, { ...opts, headers: { ...opts.headers, host } });
          },
        }),
        clock: { now: () => NOW },
        zones: ZONES,
      });

      const operations = {
        create: () => writer.create(connection, cal, { key: { hex: KEY }, event: draft() }, never),
        change: () => writer.change(connection, cal, target, { summary: "Kiln check, moved" }, never),
        move: () =>
          writer.moveEvent!(
            connection,
            cal,
            to,
            {
              ...target,
              audience: { organizer: null, guests: [] },
              recurringSeries: true,
            },
            never,
          ),
        remove: () => writer.remove(connection, cal, target, never),
      };
      expect(await operations[operation]()).toMatchObject({ ok: true, written: true });
      expect(b.dav.seen.slice(0, 4).map(({ host, method, path }) => [host, method, path])).toEqual([
        [base, "PROPFIND", b.dav.paths.start],
        [base, "PROPFIND", b.dav.paths.principal],
        [base, "PROPFIND", alias],
        [numbered, "PROPFIND", home],
      ]);
      const method = { create: "PUT", change: "PUT", move: "MOVE", remove: "DELETE" }[operation];
      const path = operation === "create" ? b.dav.paths.member("studio", `${UID}.ics`) : source;
      const sent = b.dav.seen
        .slice(4)
        .filter((request) => ["PUT", "MOVE", "DELETE"].includes(request.method));
      expect(sent.map((request) => [request.host, request.method, request.path, request.signedIn])).toEqual([
        [numbered, method, path, true],
      ]);
      if (operation === "move") {
        expect(sent.map((request) => request.headers.destination)).toEqual([
          `http://${numbered}${b.dav.paths.member("personal", "kiln.ics")}`,
        ]);
      }
      expect(b.dav.seen.filter((request) => request.host.startsWith("p02-"))).toEqual([]);
    },
  );
  it("finds the original UID at the destination when the response to MOVE was lost", async () => {
    const b = await bench({ nativeMove: true, loseMoveReply: true });
    b.dav.addCalendar("personal");
    const original = personalText();
    b.dav.put("studio", "kiln.ics", original, '"original"');
    const to = { id: b.cal.id.replace(/studio\/$/, "personal/") };
    const target = {
      id: b.member("kiln.ics"),
      version: '"original"',
      text: original,
      occurrence: null,
      audience: { organizer: null, guests: [] },
      recurringSeries: true,
    };
    expect(word(await b.writer.moveEvent!(b.connection, b.cal, to, target, never))).toBe("connection_failed");
    expect(
      word(await b.writer.moveEvent!(b.connection, b.cal, to, { ...target, retryMove: true }, never)),
    ).toBe("ok");
    expect(b.dav.seen.filter(({ method }) => method === "MOVE")).toHaveLength(1);
  });

  it("moves an event with guests on a server that permits MOVE, under its original tag", async () => {
    const b = await bench({ nativeMove: true, autoSchedule: true });
    b.dav.addCalendar("personal");
    const host = "host" + "@example.test",
      guest = "guest" + "@example.test";
    const original = personalText([`ORGANIZER:mailto:${host}`, `ATTENDEE:mailto:${guest}`]);
    b.dav.put("studio", "kiln.ics", original, '"original"');
    const to = { id: b.cal.id.replace(/studio\/$/, "personal/") };
    expect(
      word(
        await b.writer.moveEvent!(
          b.connection,
          b.cal,
          to,
          {
            id: b.member("kiln.ics"),
            version: '"original"',
            text: original,
            occurrence: null,
            audience: { organizer: host, guests: [guest] },
            recurringSeries: true,
          },
          never,
        ),
      ),
    ).toBe("ok");
    const moved = b.dav.seen.find(({ method }) => method === "MOVE");
    expect(moved?.headers["if-match"]).toBe('"original"');
    expect(moved?.headers.overwrite).toBe("F");
  });

  it("checks an unanswered occurrence cancellation without writing to the newer copy", async () => {
    const b = await bench();
    const target = {
      id: b.member("kiln.ics"),
      version: '"before"',
      text: null,
      occurrence: cut,
      caldavReadOnly: true as const,
    };
    b.dav.put("studio", "kiln.ics", personalText(["EXDATE;VALUE=DATE:20261118"]), '"cancelled"');
    expect(await b.writer.remove(b.connection, b.cal, target, never)).toMatchObject({ ok: true });
    b.dav.put("studio", "kiln.ics", personalText().replace("FREQ=DAILY", "FREQ=WEEKLY"), '"different"');
    expect(word(await b.writer.remove(b.connection, b.cal, target, never))).toBe("version_stale");
    expect(b.writes()).toEqual([]);
  });

  const continuation = {
    key: { hex: KEY },
    start: cut,
    end: plainDate(2026, 11, 19),
    rule: parseRRule("FREQ=DAILY;COUNT=3")!,
    change: { summary: "New firing" },
  };

  const organizer = ["kiln-owner", "example.test"].join("@");
  const guest = ["potter", "example.test"].join("@");
  const hiddenGuest = ["extra", "example.test"].join("@");
  const forkName = `${UID}.ics`;
  async function ownedSeries(timed = false, now = () => NOW) {
    const b = await bench({ autoSchedule: true }, now);
    const withGuests = personalText([
      "SEQUENCE:4",
      `ORGANIZER:mailto:${organizer}`,
      `ATTENDEE:mailto:${guest}`,
    ]);
    const text = timed
      ? withGuests
          .replace("DTSTART;VALUE=DATE:20261116", "DTSTART:20261116T090000Z")
          .replace("DTEND;VALUE=DATE:20261117", "DTEND:20261116T100000Z")
      : withGuests;
    const occurrence = timed ? instant(Date.UTC(2026, 10, 18, 9)) : cut;
    const end = timed ? instant(Date.UTC(2026, 10, 18, 10)) : continuation.end;
    const target = {
      id: b.member("kiln.ics"),
      version: '"original"',
      text,
      occurrence,
      recurringSeries: true as const,
      audience: { organizer, guests: [guest] },
    };
    const then = { ...continuation, start: occurrence, end };
    b.dav.put("studio", "kiln.ics", text, target.version);
    return { ...b, target, then };
  }

  it.each([{ timed: true }, { timed: false }])(
    "writes each scope of an owned series with confirmed guests (timed=$timed)",
    async ({ timed }) => {
      const b = await ownedSeries(timed);
      const { target, then } = b;
      const earlier = timed ? instant(Date.UTC(2026, 10, 17, 9)) : plainDate(2026, 11, 17);
      const one = await b.writer.change(
        b.connection,
        b.cal,
        { ...target, occurrence: earlier },
        then.change,
        never,
      );
      const occurrence =
        one.ok && one.items.find((i) => i.kind === "upsert" && i.event.recurrenceId !== null);
      if (!occurrence || occurrence.kind !== "upsert") throw new Error("missing override");
      expect(occurrence.event.sequence).toBe(5);
      expect(occurrence.event.summary).toBe(then.change.summary);
      expect(b.writes()[0]?.headers["if-match"]).toBe(target.version);
      const all = await b.writer.change(
        b.connection,
        b.cal,
        {
          ...target,
          occurrence: null,
          text: occurrence.text,
          version: occurrence.version,
        },
        { summary: "All firings" },
        never,
      );
      const master = all.ok && all.items.find((i) => i.kind === "upsert" && i.event.recurrenceId === null);
      if (!master || master.kind !== "upsert") throw new Error("missing changed master");
      expect(master.event.sequence).toBe(5);
      expect(master.event.summary).toBe("All firings");
      expect(b.writes()[1]?.headers["if-match"]).toBe(occurrence.version);

      const ended = await b.writer.endSeries(
        b.connection,
        b.cal,
        {
          ...target,
          text: master.text,
          version: master.version,
        },
        { then, mayBeDone: false },
        never,
      );
      expect(word(ended)).toBe("ok");
      const item = ended.ok && ended.items.find((i) => i.kind === "upsert" && i.event.recurrenceId === null);
      if (!item || item.kind !== "upsert") throw new Error("missing ended master");
      expect(ended.ok && ended.items.every((i) => i.kind === "upsert" && i.id === target.id)).toBe(true);
      expect(ended.ok && ended.items.some((i) => i.kind === "upsert" && i.event.recurrenceId !== null)).toBe(
        true,
      );
      expect(item.event.sequence).toBe(6);
      expect(item.text).toContain(timed ? "UNTIL=20261118T085959Z" : "UNTIL=20261117");
      expect(
        b
          .writes()
          .slice(2)
          .map((w) => [w.method, w.path.split("/").at(-1)]),
      ).toEqual([
        ["PUT", forkName],
        ["PUT", "kiln.ics"],
      ]);
      expect(b.writes()[2]?.headers["if-none-match"]).toBe("*");
      expect(b.writes()[3]?.headers["if-match"]).toBe(master.version);
      const continued = await b.writer.continueSeries(
        b.connection,
        b.cal,
        {
          ...then,
          from: { ...target, text: item.text, version: item.version },
        },
        never,
      );
      const fork = continued.ok && continued.items[0];
      if (!fork || fork.kind !== "upsert") throw new Error("missing continuation");
      expect(fork.id).toBe(b.member(forkName));
      expect(fork.event.summary).toBe(then.change.summary);
      expect(fork.event.attendees.length).toBe(1);
      expect(b.writes()).toHaveLength(4);
    },
  );

  async function changedOccurrence(timed = false) {
    const b = await ownedSeries(timed);
    const altered = timed
      ? { start: instant(Date.UTC(2026, 10, 18, 11)), end: instant(Date.UTC(2026, 10, 18, 12)) }
      : {};
    const changed = await b.writer.change(
      b.connection,
      b.cal,
      b.target,
      { summary: "Private firing", location: "Annex", ...altered },
      never,
    );
    const item =
      changed.ok && changed.items.find((i) => i.kind === "upsert" && i.event.recurrenceId !== null);
    if (!item || item.kind !== "upsert") throw new Error("missing stored occurrence");
    return {
      ...b,
      target: {
        ...b.target,
        text: item.text,
        version: item.version,
        exception: { id: item.id, version: item.version, occurrence: b.target.occurrence },
      },
    };
  }

  it("edits a previously changed occurrence under its reviewed resource version", async () => {
    const b = await changedOccurrence();
    const stale = { ...b.target, exception: { ...b.target.exception, version: '"older"' } };
    const update = { summary: "Revised firing" };
    expect(word(await b.writer.change(b.connection, b.cal, stale, update, never))).toBe("version_stale");
    expect(b.writes()).toHaveLength(1);
    const result = await b.writer.change(b.connection, b.cal, b.target, update, never);
    expect(
      result.ok &&
        result.items.map(
          (i) =>
            i.kind === "upsert" && [
              i.event.summary,
              i.event.location,
              i.event.sequence,
              i.event.recurrenceId !== null,
            ],
        ),
    ).toEqual([
      ["Kiln check", null, 4, false],
      ["Revised firing", "Annex", 6, true],
    ]);
    expect(b.writes()[1]?.headers["if-match"]).toBe(b.target.exception.version);
    const repeated = await b.writer.change(b.connection, b.cal, b.target, update, never);
    expect(word(repeated)).toBe("ok");
    expect(b.writes()).toHaveLength(2);
  });

  it("applies an all-series edit from a changed occurrence to the named field and preserves its other changes", async () => {
    const b = await changedOccurrence();
    const result = await b.writer.change(
      b.connection,
      b.cal,
      { ...b.target, occurrence: null },
      { summary: "All firings" },
      never,
    );
    expect(
      result.ok &&
        result.items.map(
          (i) =>
            i.kind === "upsert" && [
              i.event.summary,
              i.event.location,
              i.event.sequence,
              i.event.recurrenceId !== null,
            ],
        ),
    ).toEqual([
      ["All firings", null, 5, false],
      ["All firings", "Annex", 6, true],
    ]);
    expect(b.writes()[1]?.headers["if-match"]).toBe(b.target.exception.version);
  });

  it("moves the original key of a reviewed timed override with its series and preserves its timing difference", async () => {
    const b = await changedOccurrence(true);
    const result = await b.writer.change(
      b.connection,
      b.cal,
      { ...b.target, occurrence: null },
      {
        start: instant(Date.UTC(2026, 10, 16, 9, 30)),
        end: instant(Date.UTC(2026, 10, 16, 10, 45)),
      },
      never,
    );
    const edited =
      result.ok && result.items.find((item) => item.kind === "upsert" && item.event.recurrenceId !== null);
    if (!edited || edited.kind !== "upsert") throw new Error(`timed edit did not land: ${word(result)}`);
    expect(edited.event.recurrenceId).toEqual(instant(Date.UTC(2026, 10, 18, 9, 30)));
    expect(edited.event.start).toEqual(instant(Date.UTC(2026, 10, 18, 11, 30)));
    expect(edited.event.end).toEqual(instant(Date.UTC(2026, 10, 18, 12, 45)));
    expect(edited.event.location).toBe("Annex");
    expect(edited.event.summary).toBe("Private firing");
  });

  it("replaces the selected override with the first occurrence of the continuation before trimming the original", async () => {
    const b = await changedOccurrence();
    const then = { ...b.then, requireExisting: true as const, createdAtMs: NOW };
    const result = await b.writer.endSeries(b.connection, b.cal, b.target, { then, mayBeDone: false }, never);
    const ended = result.ok && result.items[0];
    if (!ended || ended.kind !== "upsert") throw new Error(`split did not land: ${word(result)}`);
    expect(result.ok && result.items).toHaveLength(1);
    expect(
      b
        .writes()
        .slice(1)
        .map((write) => [write.method, write.path.split("/").at(-1)]),
    ).toEqual([
      ["PUT", forkName],
      ["PUT", "kiln.ics"],
    ]);
    expect(b.writes()[1]?.headers["if-none-match"]).toBe("*");
    expect(b.writes()[2]?.headers["if-match"]).toBe(b.target.exception.version);
    const recovered = await b.writer.continueSeries(
      b.connection,
      b.cal,
      { ...then, from: { ...b.target, version: ended.version, text: ended.text } },
      never,
    );
    expect(
      recovered.ok &&
        recovered.items.map(
          (i) => i.kind === "upsert" && [i.event.summary, i.event.location, i.event.recurrenceId],
        ),
    ).toEqual([["New firing", null, null]]);
    expect(b.writes()).toHaveLength(3);
  });

  it("refuses a moved source version and an unconfirmed override audience before writing", async () => {
    const b = await ownedSeries();
    const { target, then } = b;
    b.dav.put("studio", "kiln.ics", target.text, '"moved"');
    expect(
      word(await b.writer.endSeries(b.connection, b.cal, target, { then, mayBeDone: false }, never)),
    ).toBe("version_stale");
    const override = [
      "BEGIN:VEVENT",
      "UID:pottery",
      "DTSTAMP:20261101T000000Z",
      "RECURRENCE-ID;VALUE=DATE:20261118",
      "DTSTART;VALUE=DATE:20261118",
      "DTEND;VALUE=DATE:20261119",
      `ORGANIZER:mailto:${organizer}`,
      `ATTENDEE:mailto:${hiddenGuest}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const live = target.text.replace("END:VCALENDAR", override);
    b.dav.put("studio", "kiln.ics", live, target.version);
    expect(word(await b.writer.change(b.connection, b.cal, target, then.change, never))).toBe(
      "version_stale",
    );
    expect(
      word(await b.writer.endSeries(b.connection, b.cal, target, { then, mayBeDone: false }, never)),
    ).toBe("version_stale");
    expect(b.writes()).toHaveLength(0);
  });

  it.each(["one", "following", "all"])(
    "refuses changes to attendees of a confirmed recurring %s edit",
    async (scope) => {
      const b = await ownedSeries();
      const change = { attendees: [] };
      const result =
        scope === "following"
          ? await b.writer.endSeries(
              b.connection,
              b.cal,
              b.target,
              { then: { ...b.then, change }, mayBeDone: false },
              never,
            )
          : await b.writer.change(
              b.connection,
              b.cal,
              { ...b.target, occurrence: scope === "all" ? null : cut },
              change,
              never,
            );
      expect(word(result)).toBe("field_unwritable");
      expect(b.writes()).toHaveLength(0);
    },
  );

  it.each([403, 412])(
    "rolls back the version it just created when the original refuses %s",
    async (status) => {
      const b = await ownedSeries();
      b.dav.refuseNextWriteOf("kiln.ics", status);
      expect(
        word(
          await b.writer.endSeries(
            b.connection,
            b.cal,
            b.target,
            {
              then: b.then,
              mayBeDone: false,
            },
            never,
          ),
        ),
      ).toBe(status === 403 ? "read_only" : "version_stale");
      expect(b.writes().map((w) => [w.method, w.path.split("/").at(-1)])).toEqual([
        ["PUT", forkName],
        ["PUT", "kiln.ics"],
        ["DELETE", forkName],
      ]);
      expect(b.writes()[2]?.headers["if-match"]).toBe(`"studio-${forkName}-2"`);
    },
  );

  it.each([{ refolded: false }, { refolded: true }])(
    "rolls back the continuation under its verified read-back tag when create omits the tag (refolded=$refolded)",
    async ({ refolded }) => {
      const b = await ownedSeries();
      b.dav.omitNextCreateTag();
      if (refolded) {
        b.dav.afterNextWrite(() => {
          const same = textOf(b.dav, forkName).replace("SUMMARY:New firing", "SUMMARY:New \r\n firing");
          b.dav.put("studio", forkName, same, '"refolded"');
        });
      }
      b.dav.refuseNextWriteOf("kiln.ics", 403);
      expect(
        word(
          await b.writer.endSeries(b.connection, b.cal, b.target, { then: b.then, mayBeDone: false }, never),
        ),
      ).toBe("read_only");
      expect(b.writes().map((write) => [write.method, write.path.split("/").at(-1)])).toEqual([
        ["PUT", forkName],
        ["PUT", "kiln.ics"],
        ["DELETE", forkName],
      ]);
      expect(b.writes()[2]?.headers["if-match"]).toBe(refolded ? '"refolded"' : `"studio-${forkName}-2"`);
    },
  );

  it("does not adopt a headerless creation's read-back tag after an independent edit", async () => {
    const b = await ownedSeries();
    b.dav.omitNextCreateTag();
    b.dav.afterNextWrite(() => {
      const changed = textOf(b.dav, forkName).replace("END:VEVENT", "LOCATION:Annex\r\nEND:VEVENT");
      b.dav.put("studio", forkName, changed, '"edited"');
    });
    b.dav.refuseNextWriteOf("kiln.ics", 403);
    expect(
      word(
        await b.writer.endSeries(b.connection, b.cal, b.target, { then: b.then, mayBeDone: false }, never),
      ),
    ).toBe("read_only");
    expect(b.writes().map((write) => [write.method, write.path.split("/").at(-1)])).toEqual([
      ["PUT", forkName],
      ["PUT", "kiln.ics"],
    ]);
  });

  it("refuses a split before writing if it would discard an individually edited future occurrence", async () => {
    const b = await ownedSeries();
    const future = { ...b.target, occurrence: plainDate(2026, 11, 19) };
    const edited = await b.writer.change(b.connection, b.cal, future, { location: "Annex" }, never);
    const item = edited.ok && edited.items[0];
    if (!item || item.kind !== "upsert") throw new Error("missing edited occurrence");
    expect(
      word(
        await b.writer.endSeries(
          b.connection,
          b.cal,
          {
            ...b.target,
            text: item.text,
            version: item.version,
          },
          { then: b.then, mayBeDone: false },
          never,
        ),
      ),
    ).toBe("field_unwritable");
    expect(b.writes()).toHaveLength(1);
  });

  it("cannot delete a continuation someone changed before rollback", async () => {
    const b = await ownedSeries();
    b.dav.refuseNextWriteOf("kiln.ics", () => {
      b.dav.put("studio", forkName, textOf(b.dav, forkName).replace("New firing", "Another copy"), '"newer"');
      return 403;
    });
    expect(
      word(
        await b.writer.endSeries(
          b.connection,
          b.cal,
          b.target,
          {
            then: b.then,
            mayBeDone: false,
          },
          never,
        ),
      ),
    ).toBe("read_only");
    expect(b.writes()[2]?.method).toBe("DELETE");
    expect(b.writes()[2]?.headers["if-match"]).toBe(`"studio-${forkName}-2"`);
  });

  it.each(["unchanged", "edited", "restamped"] as const)(
    "checks the full %s continuation before cleanup after its creation response was lost",
    async (state) => {
      let now = NOW;
      const b = await ownedSeries(false, () => now);
      const then = { ...b.then, requireExisting: true as const, createdAtMs: NOW };
      b.dav.doneThen(500);
      expect(
        word(
          await b.writer.endSeries(
            b.connection,
            b.cal,
            b.target,
            {
              then,
              mayBeDone: false,
            },
            never,
          ),
        ),
      ).toBe("unavailable");
      expect(b.writes()).toHaveLength(1);

      now += 60_000;
      const created = textOf(b.dav, forkName);
      if (state !== "unchanged") {
        const edited =
          state === "edited"
            ? created.replace("END:VEVENT", "LOCATION:Annex\r\nEND:VEVENT")
            : created.replace(/DTSTAMP:[^\r\n]+/, "DTSTAMP:20261115T090100Z");
        b.dav.put("studio", forkName, edited, '"newer"');
      }
      b.dav.refuseNextWriteOf("kiln.ics", 403);
      expect(
        word(
          await b.writer.endSeries(
            b.connection,
            b.cal,
            b.target,
            {
              then,
              mayBeDone: true,
            },
            never,
          ),
        ),
      ).toBe("read_only");
      expect(b.writes().map((w) => w.method)).toEqual(
        state === "unchanged" ? ["PUT", "PUT", "DELETE"] : ["PUT", "PUT"],
      );
      if (state === "unchanged") expect(b.writes()[2]?.headers["if-match"]).toBe(`"studio-${forkName}-2"`);
    },
  );

  it("keeps the continuation after an uncertain end and recovers the split without repeating its writes", async () => {
    const b = await ownedSeries();
    const { target } = b;
    const then = { ...b.then, requireExisting: true as const };
    b.dav.afterNextWrite(() => b.dav.afterNextWrite(() => b.dav.doneThen(500)));
    expect(
      word(await b.writer.endSeries(b.connection, b.cal, target, { then, mayBeDone: false }, never)),
    ).toBe("unavailable");
    const ended = await b.writer.endSeries(b.connection, b.cal, target, { then, mayBeDone: true }, never);
    const item = ended.ok && ended.items[0];
    if (!item || item.kind !== "upsert") throw new Error("missing ended master");
    const continued = await b.writer.continueSeries(
      b.connection,
      b.cal,
      {
        ...then,
        from: { ...target, text: item.text, version: item.version },
      },
      never,
    );
    expect(word(continued)).toBe("ok");
    expect(b.writes().map((w) => [w.method, w.path.split("/").at(-1)])).toEqual([
      ["PUT", forkName],
      ["PUT", "kiln.ics"],
    ]);
  });

  it.each(["end", "continue"])(
    "refuses replay of the %s step when another client made the same cut and no continuation exists",
    async (step) => {
      const b = await ownedSeries();
      const { target } = b;
      const then = { ...b.then, requireExisting: true as const };
      const text = target.text.replace("COUNT=5", "UNTIL=20261117");
      b.dav.put("studio", "kiln.ics", text, '"another-end"');
      const result =
        step === "end"
          ? await b.writer.endSeries(b.connection, b.cal, target, { then, mayBeDone: true }, never)
          : await b.writer.continueSeries(
              b.connection,
              b.cal,
              {
                ...then,
                from: { ...target, text, version: '"another-end"' },
              },
              never,
            );
      expect(word(result)).toBe("version_stale");
      expect(b.writes()).toHaveLength(0);
    },
  );

  it("creates the missing continuation for an earlier already-ended queue row", async () => {
    const b = await ownedSeries();
    const { target, then } = b;
    const text = target.text.replace("COUNT=5", "UNTIL=20261117");
    b.dav.put("studio", "kiln.ics", text, '"ended"');
    const req = { ...then, from: { ...target, text, version: '"ended"' } };
    expect(word(await b.writer.continueSeries(b.connection, b.cal, req, never))).toBe("ok");
    expect(word(await b.writer.continueSeries(b.connection, b.cal, req, never))).toBe("ok");
    expect(b.writes().map((w) => [w.method, w.path.split("/").at(-1)])).toEqual([["PUT", forkName]]);
  });

  it("ends a recorded legacy request before its second row constructs the continuation", async () => {
    const b = await ownedSeries();
    const target = {
      id: b.target.id,
      version: b.target.version,
      text: b.target.text,
      occurrence: cut,
    };
    const ended = await b.writer.endSeries(
      b.connection,
      b.cal,
      target,
      { then: b.then, mayBeDone: false },
      never,
    );
    const item = ended.ok && ended.items[0];
    if (!item || item.kind !== "upsert") throw new Error("missing ended legacy series");
    expect(b.writes().map((w) => w.path.split("/").at(-1))).toEqual(["kiln.ics"]);
    expect(
      word(
        await b.writer.continueSeries(
          b.connection,
          b.cal,
          {
            ...b.then,
            from: { ...target, text: item.text, version: item.version },
            event: draft({ organizer, attendees: [{ email: guest, name: null, optional: false }] }),
          },
          never,
        ),
      ),
    ).toBe("ok");
    expect(b.writes().map((w) => w.path.split("/").at(-1))).toEqual(["kiln.ics", forkName]);
  });

  it.each([true, false])(
    "compares a legacy continuation's live audience with its queued invitees (mirrored=%s)",
    async (mirrored) => {
      const b = await ownedSeries();
      const ended = b.target.text.replace("COUNT=5", "UNTIL=20261117");
      const live = ended.replace("END:VEVENT", `ATTENDEE:mailto:${hiddenGuest}\r\nEND:VEVENT`);
      b.dav.put("studio", "kiln.ics", live, '"additional-guest"');
      const from = {
        id: b.target.id,
        occurrence: cut,
        text: mirrored ? live : ended,
        version: mirrored ? '"additional-guest"' : '"before-guest"',
      };
      const event = draft({ organizer, attendees: [{ email: guest, name: null, optional: false }] });
      expect(
        word(await b.writer.continueSeries(b.connection, b.cal, { ...b.then, from, event }, never)),
      ).toBe("version_stale");
      expect(b.writes()).toHaveLength(0);
    },
  );

  it.each([
    { copy: "stable", refolded: false, edited: false },
    { copy: "refolded", refolded: true, edited: false },
    { copy: "independently edited", refolded: true, edited: true },
  ])(
    "retries cleanup after a temporary CalDAV refusal for a $copy continuation",
    async ({ refolded, edited }) => {
      const b = await ownedSeries();
      const then = { ...b.then, requireExisting: true as const, createdAtMs: NOW };
      if (refolded) {
        b.dav.omitNextCreateTag();
        b.dav.afterNextWrite(() => {
          const same = textOf(b.dav, forkName).replace("SUMMARY:New firing", "SUMMARY:New \r\n firing");
          b.dav.put("studio", forkName, same, '"refolded"');
        });
      }
      b.dav.refuseNextWriteOf("kiln.ics", () => {
        b.dav.refuseNextWriteOf(forkName, 503);
        return 403;
      });
      expect(
        word(await b.writer.endSeries(b.connection, b.cal, b.target, { then, mayBeDone: false }, never)),
      ).toBe("unavailable");
      if (edited) {
        const changed = textOf(b.dav, forkName).replace("END:VEVENT", "LOCATION:Annex\r\nEND:VEVENT");
        b.dav.put("studio", forkName, changed, '"edited"');
      }
      b.dav.refuseNextWriteOf("kiln.ics", 403);
      expect(
        word(await b.writer.endSeries(b.connection, b.cal, b.target, { then, mayBeDone: true }, never)),
      ).toBe("read_only");
      expect(b.writes().map((w) => [w.method, w.path.split("/").at(-1)])).toEqual([
        ["PUT", forkName],
        ["PUT", "kiln.ics"],
        ["DELETE", forkName],
        ["PUT", "kiln.ics"],
        ...(edited ? [] : [["DELETE", forkName]]),
      ]);
      const tag = refolded ? '"refolded"' : `"studio-${forkName}-2"`;
      expect(
        b
          .writes()
          .filter((w) => w.method === "DELETE")
          .map((w) => w.headers["if-match"]),
      ).toEqual(edited ? [tag] : [tag, tag]);
    },
  );

  it("keeps both halves of a personal series edit untouched if the provider copy names an unlisted guest", async () => {
    const b = await bench({ autoSchedule: true });
    const text = personalText(["ATTENDEE:urn:uuid:aa"]);
    b.dav.put("studio", "kiln.ics", text, '"one"');
    const target = {
      id: b.member("kiln.ics"),
      version: '"one"',
      text,
      occurrence: cut,
      personalSeries: true as const,
    };
    expect(word(await b.writer.change(b.connection, b.cal, target, { summary: "New firing" }, never))).toBe(
      "version_stale",
    );
    expect(
      word(
        await b.writer.endSeries(
          b.connection,
          b.cal,
          target,
          { then: continuation, mayBeDone: false },
          never,
        ),
      ),
    ).toBe("version_stale");
    const ended = text.replace("COUNT=5", "UNTIL=20261117");
    b.dav.put("studio", "kiln.ics", ended, target.version);
    expect(
      word(
        await b.writer.continueSeries(
          b.connection,
          b.cal,
          { ...continuation, from: { ...target, text: ended } },
          never,
        ),
      ),
    ).toBe("version_stale");
    expect(b.writes()).toHaveLength(0);
  });

  it("keeps a continued series unmade if its provider has since restored the original days", async () => {
    const b = await bench();
    const original = personalText();
    const ended = original.replace("COUNT=5", "UNTIL=20261117");
    b.dav.put("studio", "kiln.ics", original, '"restored"');
    const from = {
      id: b.member("kiln.ics"),
      version: '"ended"',
      text: ended,
      occurrence: cut,
      personalSeries: true as const,
    };
    expect(word(await b.writer.continueSeries(b.connection, b.cal, { ...continuation, from }, never))).toBe(
      "version_stale",
    );
    expect(b.writes()).toHaveLength(0);
  });

  it.each(["all", "one"])(
    "checks the series membership on a retried %s edit even when the title matches",
    async (scope) => {
      const b = await bench();
      const text = personalText();
      b.dav.put("studio", "kiln.ics", text, '"one"');
      const target = {
        id: b.member("kiln.ics"),
        version: '"one"',
        text,
        occurrence: scope === "all" ? null : cut,
        personalSeries: true as const,
      };
      const change = { summary: "New firing" };
      expect(word(await b.writer.change(b.connection, b.cal, target, change, never))).toBe("ok");
      const applied = textOf(b.dav, "kiln.ics");
      expect(word(await b.writer.change(b.connection, b.cal, target, change, never))).toBe("ok");
      b.dav.put(
        "studio",
        "kiln.ics",
        applied.replace("END:VEVENT", "ATTENDEE:urn:uuid:aa\r\nEND:VEVENT"),
        '"new"',
      );
      expect(word(await b.writer.change(b.connection, b.cal, target, change, never))).toBe("version_stale");
    },
  );

  it.each(["one", "following", "all"])(
    "changes the selected dates of a personal series for %s",
    async (scope) => {
      const b = await bench();
      const text = personalText();
      b.dav.put("studio", "kiln.ics", text, '"one"');
      const target = {
        id: b.member("kiln.ics"),
        version: '"one"',
        text,
        occurrence: cut,
        personalSeries: true as const,
      };
      if (scope === "following") {
        const ended = await b.writer.endSeries(
          b.connection,
          b.cal,
          target,
          { then: continuation, mayBeDone: false },
          never,
        );
        expect(word(ended)).toBe("ok");
        const item = ended.ok && ended.items[0];
        if (!item || item.kind !== "upsert") throw new Error("missing ended series");
        expect(
          word(
            await b.writer.continueSeries(
              b.connection,
              b.cal,
              {
                ...continuation,
                from: { ...target, text: item.text, version: item.version },
              },
              never,
            ),
          ),
        ).toBe("ok");
      } else {
        expect(
          word(
            await b.writer.change(
              b.connection,
              b.cal,
              { ...target, occurrence: scope === "one" ? cut : null },
              continuation.change,
              never,
            ),
          ),
        ).toBe("ok");
      }
      const titles = b
        .writes()
        .flatMap((w) => {
          const read = readCalendar(w.body, DEFAULT_LIMITS);
          if (!read.ok) throw new Error("invalid written series");
          return seriesOf(read.calendar.events, ZONES).flatMap((series) =>
            expandSeries(
              series,
              { startMs: Date.UTC(2026, 10, 16), endMs: Date.UTC(2026, 10, 21), viewerZone: "UTC" },
              ZONES,
            ).occurrences.map((occurrence) => ({
              at: momentOrUtc(occurrence.start, ZONES),
              summary: occurrence.event.summary,
            })),
          );
        })
        .sort((a, b) => a.at - b.at)
        .map((occurrence) => occurrence.summary);
      expect(titles).toEqual(
        [16, 17, 18, 19, 20].map((d) =>
          scope === "all" || (scope === "following" ? d >= 18 : d === 18) ? "New firing" : "Kiln check",
        ),
      );
    },
  );

  it("does not send an update when the member carries a guest missing from the confirmation", async () => {
    const b = await bench();
    const made = await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event: draft() }, never);
    const item = made.ok ? made.items[0] : null;
    if (item?.kind !== "upsert") throw new Error("missing test event");
    const target = {
      id: item.id,
      version: item.version,
      text: item.text,
      occurrence: null,
      audience: { organizer: "studio@example.invalid", guests: ["clay@example.invalid"] },
    };
    expect(word(await b.writer.change(b.connection, b.cal, target, { summary: "Moved firing" }, never))).toBe(
      "version_stale",
    );
    expect(b.writes()).toHaveLength(1);
  });

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

  it.each([false, true])(
    "moves only the versioned organizerless copy with guests (scheduling advertised: %s)",
    async (autoSchedule) => {
      const b = await bench({ autoSchedule });
      const guestLines = [
        "ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED:mailto:guest@example.test",
        "ATTENDEE;ROLE=OPT-PARTICIPANT:mailto:other@example.test",
      ];
      const original = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:pottery",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261118T090000Z",
        "DTEND:20261118T100000Z",
        "SUMMARY:Kiln check",
        ...guestLines,
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
      b.dav.addCalendar("other");
      b.dav.put("other", "same.ics", original, '"another-copy"');
      b.dav.put("studio", "same.ics", original, '"reviewed"');
      const target = {
        id: b.member("same.ics"),
        version: '"reviewed"',
        occurrence: null,
        text: original,
        sharedCopy: true as const,
      };
      const times = { start: instant(Date.UTC(2026, 10, 18, 10)), end: instant(Date.UTC(2026, 10, 18, 11)) };
      const reply = await b.writer.change(b.connection, b.cal, target, times, never);
      expect(word(reply)).toBe("ok");
      const [put, ...others] = b.writes();
      expect(others).toEqual([]);
      expect(put).toMatchObject({ path: b.dav.paths.member("studio", "same.ics") });
      expect(put?.headers["if-match"]).toBe('"reviewed"');
      expect(put?.body.split("\r\n").filter((line) => /^(ORGANIZER|ATTENDEE)/.test(line))).toEqual(
        guestLines,
      );
      expect(put?.body).toContain("DTSTART:20261118T100000Z");
      const read = b.dav.seen.findIndex(
        ({ method, body }) =>
          method === "REPORT" && body.includes(put!.path) && body.includes("calendar-multiget"),
      );
      expect(read).toBeGreaterThanOrEqual(0);
      expect(read).toBeLessThan(b.dav.seen.indexOf(put!));
      const stale = await b.writer.change(b.connection, b.cal, target, times, never);
      expect(word(stale)).toBe("version_stale");
      expect(b.writes()).toHaveLength(1);
      expect(
        b.dav.seen.some(({ method, body }) => method === "POST" || body.includes("<D:resourcetype/>")),
      ).toBe(false);
    },
  );

  it("discovers automatic scheduling advertised on OPTIONS and stores an invitation with its guest", async () => {
    const b = await bench({ autoSchedule: true, scheduleOnOptionsOnly: true });
    const reader = makeReader({
      http: namedHostRequest({ writes: false, resolver, policy: { kind: "own-network" } }),
      clock: { now: () => NOW },
      zones: ZONES,
    });
    const organizer = ["organizer", "example.test"].join("@");
    const guest = ["guest", "example.test"].join("@");
    const event = draft({ organizer, attendees: [{ email: guest, name: "Guest", optional: false }] });
    const listed = await reader.listCalendars(b.connection, never);
    const result = await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event }, never);
    expect.soft(listed).toMatchObject({ ok: true, value: [{ id: b.cal.id, autoSchedule: true }] });
    expect(result).toMatchObject({
      ok: true,
      items: [{ event: { organizer: { email: organizer }, attendees: [{ email: guest, rsvp: true }] } }],
    });
    expect(b.writes()).toHaveLength(1);
    expect(b.dav.seen.some(({ method }) => method === "POST")).toBe(false);
  });

  it.each([{ optionsStatus: 403 }, { optionsStatus: 405 }, { optionsStatus: 501 }, { optionsDav: "" }])(
    "creates and edits invitations using the collection properties when OPTIONS lacks CalDAV (%j)",
    async (options) => {
      const b = await bench({ ...options, autoSchedule: true });
      const organizer = ["organizer", "example.test"].join("@");
      const guest = ["guest", "example.test"].join("@");
      const attendees = [{ email: guest, name: "Guest", optional: false }];
      const made = await b.writer.create(
        b.connection,
        b.cal,
        { key: { hex: KEY }, event: draft({ organizer, attendees }) },
        never,
      );
      const item = made.ok && made.items[0];
      expect(item).toMatchObject({ kind: "upsert", event: { attendees: [{ email: guest }] } });
      if (!item || item.kind !== "upsert") throw new Error("Expected the invitation to be stored");
      const changed = await b.writer.change(
        b.connection,
        b.cal,
        { id: item.id, version: item.version, text: item.text, occurrence: null },
        { organizer, attendees: [{ ...attendees[0]!, optional: true }] },
        never,
      );
      expect(changed).toMatchObject({
        ok: true,
        items: [{ event: { attendees: [{ email: guest, role: "OPT-PARTICIPANT" }] } }],
      });
      expect(
        b.dav.seen.filter(({ depth, body }) => depth === "0" && body.includes("<D:resourcetype/>")),
      ).toHaveLength(2);
      expect(b.writes()).toHaveLength(2);
    },
  );

  it.each([false, true])(
    "checks an organizer object's scheduling before editing it after OPTIONS is refused (%s)",
    async (autoSchedule) => {
      const b = await bench({ autoSchedule, optionsStatus: 403 });
      const organizer = ["organizer", "example.test"].join("@");
      const text = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:shared-event",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261118T090000Z",
        "DTEND:20261118T100000Z",
        `ORGANIZER:mailto:${organizer}`,
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
      b.dav.put("studio", "shared.ics", text, '"reviewed"');
      const result = await b.writer.change(
        b.connection,
        b.cal,
        { id: b.member("shared.ics"), version: '"reviewed"', text, occurrence: null, sharedCopy: true },
        { summary: "New title" },
        never,
      );
      expect(word(result)).toBe(autoSchedule ? "read_only" : "ok");
      expect(b.writes()).toHaveLength(autoSchedule ? 0 : 1);
    },
  );

  it("reports the failed invitation write and can store the event without its guest", async () => {
    const b = await bench({ autoSchedule: true });
    const organizer = ["organizer", "example.test"].join("@");
    const guest = ["guest", "example.test"].join("@");
    const event = draft({ organizer, attendees: [{ email: guest, name: null, optional: false }] });
    b.dav.refuseNextWriteOf(`${UID}.ics`, 403);
    const result = await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event }, never);
    expect(result).toMatchObject({ ok: false, reason: "read_only" });
    expect(
      await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event: draft() }, never),
    ).toMatchObject({ ok: true, items: [{ event: { attendees: [] } }] });
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

  it.each([{}, { optionsStatus: 403 }, { scheduleOnOptionsOnly: true }])(
    "takes an answer whose first attempt landed as done when it is sent again, and writes nothing more; one on a copy someone else moved is refused (%j)",
    async (options) => {
      const b = await bench({ autoSchedule: true, ...options });
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
          again.items.map(
            (i) => i.kind === "upsert" && [i.version, i.event.attendees.map((p) => p.partstat)],
          ),
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
    },
  );

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
      "PROPFIND /dav/calendars/mila/",
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

it("refuses deleting the anchor of a range override and round-trips a later cancellation", async () => {
  const b = await bench();
  const original = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example//EN",
    "BEGIN:VEVENT",
    "UID:kiln",
    "DTSTAMP:20261101T000000Z",
    "DTSTART;VALUE=DATE:20261116",
    "DTEND;VALUE=DATE:20261117",
    "RRULE:FREQ=DAILY;COUNT=5",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:kiln",
    "DTSTAMP:20261101T000000Z",
    "RECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261117",
    "DTSTART;VALUE=DATE:20261118",
    "DTEND;VALUE=DATE:20261119",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  b.dav.put("studio", "kiln.ics", original, '"one"');
  const target = { id: b.member("kiln.ics"), version: '"one"', text: original };
  const remove = (day: number) =>
    b.writer.remove(
      b.connection,
      b.cal,
      {
        ...target,
        occurrence: plainDate(2026, 11, day),
      },
      never,
    );
  expect(word(await remove(17))).toBe("field_unwritable");
  expect(b.writes()).toHaveLength(0);
  expect(word(await remove(18))).toBe("ok");
  const parsed = readCalendar(textOf(b.dav, "kiln.ics"), DEFAULT_LIMITS);
  if (!parsed.ok) throw new Error("The written object did not read back");
  const rounds = expandSeries(
    seriesOf(parsed.calendar.events, ZONES)[0]!,
    {
      startMs: Date.UTC(2026, 10, 15),
      endMs: Date.UTC(2026, 10, 23),
      viewerZone: "UTC",
    },
    ZONES,
  ).occurrences;
  expect(rounds.map(({ start }) => start.kind === "date" && start.day)).toEqual([16, 18, 20, 21]);
});

it("hands the scheduling server the invitee and the complete repeat rule in the same event", async () => {
  const b = await bench({ autoSchedule: true });
  const guest = ["fern", "example.com"].join("@");
  const rule = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6")!;
  const made = await b.writer.create(
    b.connection,
    b.cal,
    {
      key: { hex: KEY },
      event: draft({
        rule,
        organizer: ["organiser", "example.com"].join("@"),
        attendees: [{ email: guest, name: "Fern Pike", optional: false }],
      }),
    },
    never,
  );
  expect(word(made)).toBe("ok");
  const read = readCalendar(b.writes()[0]!.body, DEFAULT_LIMITS);
  expect(read.ok && read.calendar.events[0]?.rules[0]?.rule).toEqual(rule);
  expect(read.ok && read.calendar.events[0]?.attendees[0]?.email).toBe(guest);
});

it.each(DRAFT_PROOF_CASES)("round-trips CalDAV RRULE: $name", async ({ draft: event }) => {
  const b = await bench();
  const made = await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event }, never);
  expect(word(made)).toBe("ok");
  expect(b.writes()[0]?.body.replace(/\r\n[ \t]/g, "")).toContain(
    "RRULE:" + formatRRule(event.rule!) + "\r\n",
  );
  const item = made.ok && made.items[0];
  expect(item && item.kind === "upsert" && item.event.rules[0]?.rule).toEqual(event.rule);
});

it("sends a multi-day selection with an exclusive DATE end in CalDAV", async () => {
  const b = await bench();
  const event = draft({ start: plainDate(2026, 10, 24), end: plainDate(2026, 10, 27) });
  const made = await b.writer.create(b.connection, b.cal, { key: { hex: KEY }, event }, never);
  expect(word(made)).toBe("ok");
  const text = b.writes().find(({ method }) => method === "PUT")?.body;
  expect(text).toContain("DTSTART;VALUE=DATE:20261024");
  expect(text).toContain("DTEND;VALUE=DATE:20261027");
});
