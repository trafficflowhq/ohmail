/**
 * Google's calendar, written, against a stand-in of Google's events API answering as Google's own
 * reference says it does (an id given on insert is the event's id; a second insert of it is 409; a
 * write with `If-Match` against another tag is 412; a deleted event answers 410). The stand-in sits
 * under the real request port, so what is checked is what would leave the process: method, address,
 * the port's own lines, the body. No request leaves the process.
 *
 * Google's write exchanges are not recorded yet (no write was made at the test account by this
 * build); the shapes here are Google's reference's, and the recorded GET of the bench's set is the
 * read they meet.
 */
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  intlZones,
  parseRRule,
  instant,
  plainDate,
  wall,
  zoned,
  floating,
  type EventTime,
} from "@ohmail/cal-core";
import type { HostResolver, PinnedRequestOptions, PinnedResponse } from "@trafficflow/core/net";
import { describe, expect, it } from "vitest";
import { makeWriter } from "../src/google/index.js";
import { GOOGLE_HOSTS } from "../src/google/hosts.js";
import type { Connection, EventDraft, WriteAnswer } from "../src/port.js";
import { guardedRequest } from "../src/request/guarded.js";

const ZONES = intlZones();
const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const KEY = "0123456789abcdef0123456789abcdef";
const BASE = "https://www.googleapis.com/calendar/v3/calendars/cal-1/events";
const never = new AbortController().signal;
const connection: Connection = {
  provider: "google",
  start: null,
  credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: "short-lived" }) },
};

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly ifMatch: string | null;
  readonly ifNoneMatch: string | null;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | null;
  readonly headers: readonly string[];
}

/** Google's events API for one calendar, as its reference answers: a store of records by id, each with its tag. */
function google(
  o: {
    refuse?: (s: Sent) => { status: number; body?: unknown; headers?: Record<string, string> } | null;
    noTags?: boolean;
  } = {},
) {
  const records = new Map<string, Record<string, unknown>>();
  const sent: Sent[] = [];
  let n = 1;
  const tagged = (r: Record<string, unknown>): Record<string, unknown> =>
    o.noTags === true ? { ...r, etag: undefined } : r;
  /** Google writes every clock time back with its offset: in November, Zurich is an hour east of UTC. */
  const withOffset = (t: unknown): unknown => {
    const v = t as { dateTime?: string; timeZone?: string } | undefined;
    return v?.dateTime !== undefined &&
      /T\d{2}:\d{2}:\d{2}$/.test(v.dateTime) &&
      v.timeZone === "Europe/Zurich"
      ? { ...v, dateTime: `${v.dateTime}+01:00` }
      : t;
  };
  const stored = (b: Record<string, unknown>): Record<string, unknown> => ({
    ...b,
    ...(b.start === undefined ? {} : { start: withOffset(b.start) }),
    ...(b.end === undefined ? {} : { end: withOffset(b.end) }),
  });
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): PinnedResponse => ({
    status,
    headers: { "content-type": "application/json", ...headers },
    stream: Readable.from([
      Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    ]) as unknown as IncomingMessage,
  });
  const request = async (url: string, opts: PinnedRequestOptions): Promise<PinnedResponse> => {
    const h = (opts.headers ?? {}) as Record<string, string>;
    const s: Sent = {
      method: opts.method ?? "GET",
      url,
      ifMatch: h["if-match"] ?? null,
      ifNoneMatch: h["if-none-match"] ?? null,
      authorization: h.authorization ?? null,
      body:
        opts.body === undefined ? null : JSON.parse(Buffer.from(opts.body as Uint8Array).toString("utf8")),
      headers: Object.keys(h).sort(),
    };
    sent.push(s);
    const refused = o.refuse?.(s);
    if (refused) return reply(refused.status, refused.body, refused.headers);
    const u = new URL(url);
    const path = u.pathname.replace("/calendar/v3/calendars/cal-1/events", "");
    const id = decodeURIComponent(path.split("/")[1] ?? "");
    const held = records.get(id);
    if (s.method === "POST" && path === "") {
      const want = String(s.body!.id);
      if (records.has(want))
        return reply(409, { error: { code: 409, message: "The requested identifier already exists." } });
      const made = {
        kind: "calendar#event",
        ...stored(s.body!),
        id: want,
        etag: `"${n++}"`,
        status: "confirmed",
        iCalUID: `${want}@google.com`,
        updated: "2026-11-15T09:00:00.000Z",
        created: "2026-11-15T09:00:00.000Z",
        sequence: 0,
      };
      records.set(want, made);
      return reply(200, tagged(made));
    }
    if (s.method === "POST" && path.endsWith("/move"))
      return held === undefined ? reply(404) : reply(200, tagged(held));
    if (held === undefined)
      return reply(s.method === "DELETE" ? 410 : 404, { error: { code: 404, message: "Not Found" } });
    if (held.status === "cancelled")
      return reply(410, { error: { code: 410, message: "Resource has been deleted" } });
    if (s.method === "GET") return reply(200, tagged(held));
    if (s.ifMatch !== null && s.ifMatch !== held.etag)
      return reply(412, { error: { code: 412, message: "Precondition Failed" } });
    if (s.method === "PATCH") {
      const next = {
        ...held,
        ...stored(s.body!),
        etag: `"${n++}"`,
        sequence: Number(held.sequence ?? 0) + 1,
      };
      records.set(id, next);
      return reply(200, tagged(next));
    }
    if (s.method === "DELETE") {
      records.set(id, { ...held, status: "cancelled", etag: `"${n++}"` });
      return reply(204);
    }
    return reply(400);
  };
  const resolver: HostResolver = { resolve: async () => ["203.0.114.7"] };
  const http = guardedRequest({
    resolver,
    request,
    policy: { kind: "cloud" },
    hosts: GOOGLE_HOSTS,
    writes: true,
    limits: { connectMs: 2_000, totalMs: 4_000, maxRedirects: 0, maxBodyBytes: 1024 * 1024 },
  });
  const writer = makeWriter({ http, clock: { now: () => NOW }, zones: ZONES });
  /** An event Google holds, as if a reading had stored it. */
  const plant = (id: string, over: Record<string, unknown> = {}): { id: string; version: string } => {
    const r = {
      kind: "calendar#event",
      id,
      etag: `"${n++}"`,
      status: "confirmed",
      summary: "Kiln check",
      iCalUID: `${id}@google.com`,
      start: { dateTime: "2026-11-18T10:00:00+01:00", timeZone: "Europe/Zurich" },
      end: { dateTime: "2026-11-18T11:00:00+01:00", timeZone: "Europe/Zurich" },
      updated: "2026-11-14T09:00:00.000Z",
      sequence: 0,
      ...over,
    };
    records.set(id, r);
    return { id, version: String(r.etag) };
  };
  return { writer, records, sent, plant };
}

const at = (h: number, m = 0): EventTime => zoned(wall(2026, 11, 17, h, m), "Europe/Zurich");
const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  start: at(9),
  end: at(10),
  summary: "Glaze firing",
  description: null,
  location: "Studio 2",
  url: null,
  busy: true,
  private: false,
  rule: null,
  organizer: null,
  attendees: [],
  alarms: [10],
  ...over,
});
const target = (p: { id: string; version: string }) => ({
  id: p.id,
  version: p.version,
  text: null,
  occurrence: null,
});
const word = (a: WriteAnswer): string => (a.ok ? "ok" : a.reason);

describe("Google's writer", () => {
  it("compares the confirmed guests to the whole current event before notifying them", async () => {
    const g = google();
    const organizer = "studio@example.invalid";
    const guest = "kiln@example.invalid";
    const stored = g.plant("evt-firing", { organizer: { email: organizer }, attendees: [{ email: guest }] });
    const expected = (guests: string[]) => ({ ...target(stored), audience: { organizer, guests } });
    const change = { summary: "Moved firing" };
    const update = (guests: string[]) => g.writer.change(connection, { id: "cal-1" }, expected(guests), change, never);
    expect(word(await update([]))).toBe("version_stale");
    expect(g.sent.map((r) => r.method)).toEqual(["GET"]);
    expect(word(await update([guest]))).toBe("ok");
    expect(g.sent.at(-1)?.ifMatch).toBe(stored.version);
  });

  it("refuses duplicate confirmed addresses, omitted attendees, and a change from a single event to a series", async () => {
    const organizer = "studio@example.invalid";
    const first = "kiln@example.invalid";
    const second = "studio-two@example.invalid";
    for (const [other, guests] of [
      [{}, [first, first]],
      [{ attendeesOmitted: true }, [first, second]],
      [{ recurrence: ["RRULE:FREQ=WEEKLY"] }, [first, second]],
    ] as const) {
      const g = google();
      const stored = g.plant("evt-firing", { organizer: { email: organizer }, attendees: [{ email: first }, { email: second }], ...other });
      const requested = { ...target(stored), audience: { organizer, guests } };
      const result = await g.writer.change(connection, { id: "cal-1" }, requested, { summary: "Moved firing" }, never);
      expect(word(result)).toBe("version_stale");
      expect(g.sent.map((r) => r.method)).toEqual(["GET"]);
    }
  });

  it("makes a new event under the id the write's key names, tells every invitee, and answers it as a reading would", async () => {
    const g = google();
    const made = await g.writer.create(
      connection,
      { id: "cal-1" },
      {
        key: { hex: KEY },
        event: draft({ attendees: [{ email: "giulia@example.test", name: "Giulia", optional: true }] }),
      },
      never,
    );
    expect(word(made)).toBe("ok");
    expect(g.sent.map((s) => [s.method, s.url, s.ifMatch, s.ifNoneMatch])).toEqual([
      ["POST", `${BASE}?sendUpdates=all`, null, null],
    ]);
    expect(g.sent[0]!.body).toEqual({
      id: KEY,
      summary: "Glaze firing",
      description: "",
      location: "Studio 2",
      transparency: "opaque",
      visibility: "default",
      start: { dateTime: "2026-11-17T09:00:00", timeZone: "Europe/Zurich" },
      end: { dateTime: "2026-11-17T10:00:00", timeZone: "Europe/Zurich" },
      recurrence: [],
      attendees: [{ email: "giulia@example.test", displayName: "Giulia", optional: true }],
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
    expect(
      made.ok && made.items.map((i) => i.kind === "upsert" && [i.id, i.version, i.event.summary]),
    ).toEqual([[KEY, '"1"', "Glaze firing"]]);
    expect(g.sent[0]!.authorization).toBe("Bearer short-lived");
  });

  it("makes ONE event of a write sent again after its answer was lost: the second insert is refused 409, and the event is read where it was made", async () => {
    const g = google();
    const first = await g.writer.create(
      connection,
      { id: "cal-1" },
      { key: { hex: KEY }, event: draft() },
      never,
    );
    const again = await g.writer.create(
      connection,
      { id: "cal-1" },
      { key: { hex: KEY }, event: draft() },
      never,
    );
    expect(g.records.size).toBe(1);
    expect(g.sent.map((s) => [s.method, s.url])).toEqual([
      ["POST", `${BASE}?sendUpdates=all`],
      ["POST", `${BASE}?sendUpdates=all`],
      ["GET", `${BASE}/${KEY}`],
    ]);
    // The same event, made by the first insert alone: the second found it so, and nothing waiting is re-based onto what it read.
    expect(again).toEqual({ ...first, written: undefined });
    expect([first.ok && first.written, again.ok && again.written]).toEqual([true, undefined]);
  });

  it("refuses a change made against a version Google moved past, and leaves Google's event as it was", async () => {
    const g = google();
    const stored = g.plant("evt-1");
    await g.writer.change(connection, { id: "cal-1" }, target(stored), { summary: "Theirs" }, never);
    const before = JSON.stringify(g.records.get("evt-1"));
    const stale = await g.writer.change(
      connection,
      { id: "cal-1" },
      target(stored),
      { summary: "Mine" },
      never,
    );
    expect(word(stale)).toBe("version_stale");
    expect(JSON.stringify(g.records.get("evt-1"))).toBe(before);
    expect(g.sent.filter((s) => s.method === "PATCH").map((s) => s.ifMatch)).toEqual([
      stored.version,
      stored.version,
    ]);
  });

  it("takes a 412 whose event already holds every field of the change as done: an earlier attempt landed", async () => {
    const g = google();
    const stored = g.plant("evt-1");
    await g.writer.change(
      connection,
      { id: "cal-1" },
      target(stored),
      { summary: "Mine", busy: false },
      never,
    );
    const again = await g.writer.change(
      connection,
      { id: "cal-1" },
      target(stored),
      { summary: "Mine", busy: false },
      never,
    );
    expect(word(again)).toBe("ok");
    expect(g.sent.map((s) => s.method)).toEqual(["PATCH", "PATCH", "GET"]);
    expect(again.ok && again.items[0]!.kind === "upsert" && again.items[0]!.event.summary).toBe("Mine");
  });

  it("removes against the stored version; an event already gone is removed; one changed since is not", async () => {
    const g = google();
    const one = g.plant("evt-1");
    expect(await g.writer.remove(connection, { id: "cal-1" }, target(one), never)).toEqual({
      ok: true,
      items: [{ kind: "gone", id: "evt-1" }],
      written: true,
    });
    expect(await g.writer.remove(connection, { id: "cal-1" }, target(one), never)).toEqual({
      ok: true,
      items: [{ kind: "gone", id: "evt-1" }],
    });
    const two = g.plant("evt-2");
    await g.writer.change(connection, { id: "cal-1" }, target(two), { summary: "Moved on" }, never);
    expect(word(await g.writer.remove(connection, { id: "cal-1" }, target(two), never))).toBe(
      "version_stale",
    );
    expect(g.records.get("evt-2")!.status).toBe("confirmed");
  });

  it("answers an invitation on the account's own line, written back under the tag of the read it was made on", async () => {
    const g = google();
    const invited = g.plant("evt-9", {
      organizer: { email: "anna@example.test" },
      attendees: [
        { email: "anna@example.test", organizer: true, responseStatus: "accepted" },
        { email: "mila@example.test", self: true, responseStatus: "needsAction" },
      ],
    });
    const a = await g.writer.answer(
      connection,
      { id: "cal-1" },
      target(invited),
      { as: "mila@example.test", reply: "TENTATIVE" },
      never,
    );
    expect(word(a)).toBe("ok");
    const patch = g.sent.find((s) => s.method === "PATCH")!;
    expect([patch.url, patch.ifMatch]).toEqual([`${BASE}/evt-9?sendUpdates=all`, invited.version]);
    expect(patch.body).toEqual({
      attendees: [
        { email: "anna@example.test", organizer: true, responseStatus: "accepted" },
        { email: "mila@example.test", self: true, responseStatus: "tentative" },
      ],
    });
  });

  it("takes an answer whose first attempt landed as done when it is sent again, and writes nothing; an answer on a copy someone else moved is refused", async () => {
    const people = [
      { email: "anna@example.test", organizer: true, responseStatus: "accepted" },
      { email: "mila@example.test", self: true, responseStatus: "needsAction" },
    ];
    let records = new Map<string, Record<string, unknown>>();
    const g = google({
      // Once: the event moves on between the answer's read and its write. Where its title is still the planted one,
      // the account's own line already says the answer (another of its devices answered alike); else someone else changed it.
      refuse: (s) => {
        const held = records.get("evt-12");
        if (s.method !== "PATCH" || !s.url.includes("/evt-12?") || held === undefined || held.raced === true)
          return null;
        const own = { ...people[1]!, responseStatus: "tentative" };
        records.set("evt-12", {
          ...held,
          raced: true,
          etag: '"raced"',
          attendees: held.summary === "Kiln check" ? [people[0], own] : people,
        });
        return { status: 412, body: { error: { code: 412, message: "Precondition Failed" } } };
      },
    });
    records = g.records;
    const answer = { as: "mila@example.test", reply: "TENTATIVE" } as const;
    const invited = g.plant("evt-9", { organizer: { email: "anna@example.test" }, attendees: people });
    expect(word(await g.writer.answer(connection, { id: "cal-1" }, target(invited), answer, never))).toBe(
      "ok",
    );
    // Its answer lost, the same write is sent again under the version it was recorded on.
    const again = await g.writer.answer(connection, { id: "cal-1" }, target(invited), answer, never);
    expect(word(again)).toBe("ok");
    expect(again.ok && again.items[0]!.kind === "upsert" && again.items[0]!.version).toBe(
      g.records.get("evt-9")!.etag,
    );
    expect(g.sent.map((s) => s.method)).toEqual(["GET", "PATCH", "GET"]);

    // Someone else moved the event on, and the account's line does not say the answer: refused, nothing written.
    const moved = g.plant("evt-10", { organizer: { email: "anna@example.test" }, attendees: people });
    await g.writer.change(connection, { id: "cal-1" }, target(moved), { summary: "Theirs" }, never);
    const before = JSON.stringify(g.records.get("evt-10"));
    g.sent.length = 0;
    expect(word(await g.writer.answer(connection, { id: "cal-1" }, target(moved), answer, never))).toBe(
      "version_stale",
    );
    expect([g.sent.map((s) => s.method), JSON.stringify(g.records.get("evt-10"))]).toEqual([["GET"], before]);

    // A write refused 412 is read once more: done where the line says the answer, else made on another copy.
    for (const [summary, said] of [
      ["Kiln check", "ok"],
      ["Theirs", "version_stale"],
    ] as const) {
      const raced = g.plant("evt-12", {
        summary,
        organizer: { email: "anna@example.test" },
        attendees: people,
      });
      g.sent.length = 0;
      expect([
        summary,
        word(await g.writer.answer(connection, { id: "cal-1" }, target(raced), answer, never)),
      ]).toEqual([summary, said]);
      expect(g.sent.map((s) => s.method)).toEqual(["GET", "PATCH", "GET"]);
    }
  });

  it("sends nothing unconditional: a stored version that is no tag is read again and compared, and with no tag there either nothing is sent", async () => {
    const g = google({ noTags: true });
    const stored = g.plant("evt-1");
    const asReadingStoredIt = { ...target(stored), version: "2026-11-14T09:00:00.000Z" };
    for (const version of [asReadingStoredIt.version, "\u0007bell", "x".repeat(5_000)]) {
      const a = await g.writer.change(
        connection,
        { id: "cal-1" },
        { ...asReadingStoredIt, version },
        { summary: "Mine" },
        never,
      );
      expect([version.slice(0, 10), word(a)]).toEqual([
        version.slice(0, 10),
        version === asReadingStoredIt.version ? "version_unknown" : "version_stale",
      ]);
    }
    expect(g.sent.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("names every event by one escaped segment of Google's path, and sends nothing for an id that names no event", async () => {
    const g = google();
    for (const id of ["../../users/me", "a?sendUpdates=none", "a#b", "a\r\nx-injected: 1", "a%2fb", "a/b"]) {
      await g.writer.change(
        connection,
        { id: "cal-1" },
        { id, version: '"1"', text: null, occurrence: null },
        { summary: "x" },
        never,
      );
    }
    for (const s of g.sent) {
      const u = new URL(s.url);
      expect([
        s.url.slice(0, 80),
        u.pathname.split("/").length,
        u.pathname.startsWith("/calendar/v3/calendars/cal-1/events/"),
      ]).toEqual([s.url.slice(0, 80), 7, true]);
      expect([...u.searchParams.keys()].filter((k) => k !== "sendUpdates")).toEqual([]);
      expect(
        s.headers.filter(
          (h) =>
            ![
              "accept",
              "accept-encoding",
              "authorization",
              "content-length",
              "content-type",
              "if-match",
              "user-agent",
            ].includes(h),
        ),
      ).toEqual([]);
    }
    const before = g.sent.length;
    for (const id of ["", ".", "..", "x".repeat(1_025)]) {
      expect(
        word(
          await g.writer.remove(
            connection,
            { id: "cal-1" },
            { id, version: '"1"', text: null, occurrence: null },
            never,
          ),
        ),
      ).toBe("not_found");
    }
    expect(g.sent.length).toBe(before);
  });

  it("writes no field Google would not keep as written, and asks nothing for it", async () => {
    const g = google();
    const floatingTimes = draft({
      start: floating(wall(2026, 11, 17, 9)),
      end: floating(wall(2026, 11, 17, 10)),
    });
    expect(
      word(
        await g.writer.create(
          connection,
          { id: "cal-1" },
          { key: { hex: KEY }, event: floatingTimes },
          never,
        ),
      ),
    ).toBe("field_unwritable");
    expect(
      word(
        await g.writer.create(
          connection,
          { id: "cal-1" },
          { key: { hex: KEY }, event: draft({ url: "https://call.example.test/room" }) },
          never,
        ),
      ),
    ).toBe("field_unwritable");
    expect(g.sent).toEqual([]);
    // A series and a whole day, as Google writes them.
    await g.writer.create(
      connection,
      { id: "cal-1" },
      {
        key: { hex: KEY },
        event: draft({
          start: instant(NOW),
          end: instant(NOW + 3_600_000),
          rule: parseRRule("FREQ=WEEKLY;COUNT=3")!,
        }),
      },
      never,
    );
    await g.writer.create(
      connection,
      { id: "cal-1" },
      {
        key: { hex: "f".repeat(32) },
        event: draft({ start: plainDate(2026, 11, 20), end: plainDate(2026, 11, 21) }),
      },
      never,
    );
    expect(g.sent.map((s) => [s.body!.start, s.body!.recurrence])).toEqual([
      [{ dateTime: "2026-11-15T09:00:00.000Z", timeZone: "UTC" }, ["RRULE:FREQ=WEEKLY;COUNT=3"]],
      [{ date: "2026-11-20" }, []],
    ]);
  });

  it("answers Google's refusals in the write's words, and a redirect is never followed", async () => {
    const cases: [number, unknown, Record<string, string>, string][] = [
      [401, {}, {}, "sign_in_refused"],
      [403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }, { "retry-after": "30" }, "throttled"],
      [403, { error: { errors: [{ reason: "forbidden" }] } }, {}, "read_only"],
      [400, { error: { code: 400 } }, {}, "field_unwritable"],
      [429, {}, {}, "throttled"],
      [503, {}, {}, "unavailable"],
      [
        307,
        {},
        { location: "https://www.googleapis.com/calendar/v3/calendars/other/events" },
        "redirect_invalid",
      ],
    ];
    for (const [status, body, headers, expected] of cases) {
      const g = google({ refuse: () => ({ status, body, headers }) });
      const a = await g.writer.create(
        connection,
        { id: "cal-1" },
        { key: { hex: KEY }, event: draft() },
        never,
      );
      expect([status, word(a)]).toEqual([status, expected]);
      expect(g.sent.length).toBe(1);
    }
  });

  it("writes no day of a series yet, and never a day's write onto its series: nothing is asked", async () => {
    const g = google();
    const series = g.plant("series-1", { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"] });
    const day = { ...target(series), occurrence: at(9) };
    const answers = [
      await g.writer.change(connection, { id: "cal-1" }, day, { summary: "Only that day" }, never),
      await g.writer.remove(connection, { id: "cal-1" }, day, never),
      await g.writer.answer(
        connection,
        { id: "cal-1" },
        day,
        { as: "mila@example.test", reply: "ACCEPTED" },
        never,
      ),
      // Nor a series' end, nor its days from one on as a series of their own.
      await g.writer.endSeries(connection, { id: "cal-1" }, day, { then: null, mayBeDone: false }, never),
      await g.writer.continueSeries(
        connection,
        { id: "cal-1" },
        {
          key: { hex: KEY },
          from: day,
          start: at(9),
          end: at(10),
          rule: parseRRule("FREQ=WEEKLY;BYDAY=TU")!,
          change: {},
        },
        never,
      ),
    ];
    expect(answers.map(word)).toEqual(Array(5).fill("repeat_unsupported"));
    expect(g.sent).toEqual([]);
  });
});
