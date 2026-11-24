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
  formatRRule,
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
import type { Connection, EventDraft, MasterEditReceipt, WriteAnswer } from "../src/port.js";
import { guardedRequest } from "../src/request/guarded.js";

import { DRAFT_PROOF_CASES } from "./support/repeat-proof.js";

const ZONES = intlZones();
const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const KEY = "0123456789abcdef0123456789abcdef";
const BASE = "https://www.googleapis.com/calendar/v3/calendars/cal-1/events";
const calendar = { id: "cal-1" };
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
    losePatch?: (id: string) => boolean;
    inheritSeriesPatches?: boolean;
  } = {},
) {
  const records = new Map<string, Record<string, unknown>>();
  const generated = new Map<string, Record<string, unknown>>();
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
    const held = records.get(id) ?? [...generated.values()].find((event) => event.id === id);
    if (s.method === "GET" && path === "" && u.searchParams.get("singleEvents") === "false")
      return reply(200, { accessRole: "owner", items: [...records.values()].map(tagged) });
    if (s.method === "POST" && path === "") {
      const want = String(s.body!.id);
      const organizer = records.get("series")?.organizer;
      if (records.has(want))
        return reply(409, { error: { code: 409, message: "The requested identifier already exists." } });
      const made = {
        kind: "calendar#event",
        ...stored(s.body!),
        ...(organizer === undefined ? {} : { organizer }),
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
    if (s.method === "GET" && path.endsWith("/instances")) {
      const original = u.searchParams.get("originalStart");
      const atOriginal = (event: Record<string, unknown>) => {
        if (event.recurringEventId !== id) return false;
        const when = event.originalStartTime as { date?: string; dateTime?: string };
        return (
          original === when.date ||
          (when.dateTime !== undefined && Date.parse(original ?? "") === Date.parse(when.dateTime))
        );
      };
      const exceptions = [...records.values()].filter(atOriginal);
      return reply(200, {
        items: (exceptions.length > 0 ? exceptions : [...generated.values()].filter(atOriginal)).map(tagged),
      });
    }
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
      if (o.inheritSeriesPatches && Array.isArray(held.recurrence)) {
        for (const [childId, child] of records) {
          if (child.recurringEventId !== id || child.status === "cancelled") continue;
          const inherited = Object.fromEntries(
            Object.entries(stored(s.body!)).filter(
              ([field]) => JSON.stringify(child[field]) === JSON.stringify(held[field]),
            ),
          );
          records.set(childId, { ...child, ...inherited, etag: `"${n++}"`, sequence: next.sequence });
        }
      }
      if (o.losePatch?.(id)) throw Object.assign(new Error("lost reply"), { code: "ECONNRESET" });
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
  return { writer, records, generated, sent, plant };
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

describe("editing a Google series", () => {
  const organizer = "studio" + "@example.invalid";
  const guest = "visitor" + "@example.invalid";
  const people = { organizer: { email: organizer }, attendees: [{ email: guest }] };
  const audience = { organizer, guests: [guest] };
  const properties = { private: { existingPrivate: "kept" }, shared: { existingShared: "kept" } };
  const repeat = ["RRULE:FREQ=WEEKLY;COUNT=5"];
  const carry = (allDay: boolean) => {
    const occurrence = allDay ? plainDate(2026, 11, 25) : zoned(wall(2026, 11, 25, 10), "Europe/Zurich");
    const end = allDay ? plainDate(2026, 11, 26) : zoned(wall(2026, 11, 25, 11), "Europe/Zurich");
    const rule = parseRRule("FREQ=WEEKLY;COUNT=4")!;
    const change = { summary: "Firing from next week" };
    const event = draft({
      ...change,
      start: occurrence,
      end,
      rule,
      organizer,
      attendees: [{ email: guest, optional: false, name: null }],
    });
    return { occurrence, next: { key: { hex: KEY }, start: occurrence, end, rule, change, event } };
  };
  const plantSeries = (g: ReturnType<typeof google>, allDay = false) => {
    const master = g.plant("series", {
      ...people,
      recurrence: repeat,
      ...(allDay && { start: { date: "2026-11-18" }, end: { date: "2026-11-19" } }),
    });
    g.generated.set(master.id, {
      ...g.records.get(master.id),
      id: "generated-instance",
      recurringEventId: master.id,
      originalStartTime: allDay ? { date: "2026-11-25" } : { dateTime: "2026-11-25T10:00:00+01:00" },
      start: allDay
        ? { date: "2026-11-25" }
        : { dateTime: "2026-11-25T10:00:00+01:00", timeZone: "Europe/Zurich" },
      end: allDay
        ? { date: "2026-11-26" }
        : { dateTime: "2026-11-25T11:00:00+01:00", timeZone: "Europe/Zurich" },
    });
    return target(master);
  };
  const mutations = (g: ReturnType<typeof google>) => g.sent.filter((s) => s.method !== "GET");

  it.each([false, true])(
    "edits the exact original instance and the whole series separately (whole day %s)",
    async (allDay) => {
      const g = google();
      const master = plantSeries(g, allDay);
      const { occurrence } = carry(allDay);
      const member = { id: "opaque-instance-id", version: String(g.generated.get(master.id)?.etag) };
      g.generated.set(master.id, {
        ...g.generated.get(master.id),
        id: member.id,
        extendedProperties: properties,
      });
      const writeKey = { hex: KEY };
      const day = {
        ...master,
        occurrence: allDay ? instant(Date.UTC(2026, 10, 25)) : occurrence,
        audience,
        recurringSeries: true as const,
        writeKey,
      };
      const thisChange = { summary: "Only this event", alarms: [15] };
      expect(word(await g.writer.change(connection, calendar, day, thisChange, never))).toBe("ok");
      expect(word(await g.writer.change(connection, calendar, day, thisChange, never))).toBe("ok");
      expect(g.records.get(master.id)?.summary).toBe("Kiln check");
      expect(g.records.get(member.id)?.summary).toBe(thisChange.summary);
      expect(g.records.get(member.id)?.extendedProperties).toMatchObject(properties);
      expect(mutations(g).map((s) => [s.method, s.url, s.ifMatch])).toEqual([
        ["PATCH", `${BASE}/${member.id}?sendUpdates=all`, member.version],
      ]);
      const whole = { ...day, occurrence: null };
      expect(word(await g.writer.change(connection, calendar, whole, { summary: "All events" }, never))).toBe(
        "ok",
      );
      expect(mutations(g).at(-1)).toMatchObject({
        method: "PATCH",
        url: `${BASE}/${master.id}?sendUpdates=all`,
        ifMatch: master.version,
      });
      expect(g.records.get(master.id)?.recurrence).toEqual(repeat);
    },
  );

  it("refuses an instance edit if the master version or either complete audience moved", async () => {
    const g = google();
    const master = plantSeries(g);
    const { occurrence } = carry(false);
    const select = {
      ...master,
      occurrence,
      audience,
      recurringSeries: true as const,
      writeKey: { hex: KEY },
    };
    const instance = g.plant("opaque-instance-id", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
      attendeesOmitted: true,
    });
    const change = { summary: "Only this event" };
    expect(word(await g.writer.change(connection, calendar, select, change, never))).toBe("version_stale");
    g.records.set(instance.id, { ...g.records.get(instance.id), attendeesOmitted: false });
    expect(
      word(await g.writer.change(connection, calendar, { ...select, version: '"moved"' }, change, never)),
    ).toBe("version_stale");
    expect(
      word(
        await g.writer.change(
          connection,
          calendar,
          { ...select, audience: { organizer, guests: [] } },
          change,
          never,
        ),
      ),
    ).toBe("version_stale");
    expect(mutations(g)).toEqual([]);
  });

  it.each([false, true])(
    "creates before trimming, and recovers the same continuation for the second queue row (whole day %s)",
    async (allDay) => {
      const g = google();
      const master = plantSeries(g, allDay);
      const { occurrence, next } = carry(allDay);
      const from = {
        ...master,
        occurrence: allDay ? instant(Date.UTC(2026, 10, 25)) : occurrence,
        audience,
        recurringSeries: true as const,
      };
      const first = await g.writer.endSeries(
        connection,
        calendar,
        from,
        { then: next, mayBeDone: false },
        never,
      );
      expect(first.ok && first.items.map((item) => item.id)).toEqual([master.id]);
      expect(mutations(g).map((s) => [s.method, s.url, s.ifMatch])).toEqual([
        ["POST", `${BASE}?sendUpdates=all`, null],
        ["PATCH", `${BASE}/${master.id}?sendUpdates=all`, master.version],
      ]);
      expect(g.records.get(master.id)?.recurrence).toEqual([
        allDay ? "RRULE:FREQ=WEEKLY;UNTIL=20261124" : "RRULE:FREQ=WEEKLY;UNTIL=20261125T085959Z",
      ]);
      expect(g.records.get(KEY)?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=4"]);
      const second = await g.writer.continueSeries(
        connection,
        calendar,
        { ...next, from, requireExisting: true },
        never,
      );
      expect(second.ok && second.items.map((item) => item.id)).toEqual([KEY]);
      expect(mutations(g)).toHaveLength(2);
    },
  );

  it("rolls back only the returned version of the continuation when Google refuses the end", async () => {
    const g = google({ refuse: (s) => (s.method === "PATCH" ? { status: 412 } : null) });
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    const answer = await g.writer.endSeries(
      connection,
      calendar,
      from,
      { then: next, mayBeDone: false },
      never,
    );
    expect(word(answer)).toBe("version_stale");
    expect(g.records.get(from.id)?.recurrence).toEqual(repeat);
    expect(g.records.get(KEY)?.status).toBe("cancelled");
    expect(mutations(g).map((s) => [s.method, s.url, s.ifMatch])).toEqual([
      ["POST", `${BASE}?sendUpdates=all`, null],
      ["PATCH", `${BASE}/${from.id}?sendUpdates=all`, from.version],
      ["DELETE", `${BASE}/${KEY}?sendUpdates=all`, '"2"'],
    ]);
  });

  it.each([
    [503, "unavailable"],
    [429, "throttled"],
  ])("retries when Google returns %s while undoing a refused split", async (status, reason) => {
    const g = google({
      refuse: (s) => {
        if (s.method === "PATCH") return { status: 412 };
        return s.method === "DELETE" ? { status, headers: { "retry-after": "30" } } : null;
      },
    });
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    const answer = await g.writer.endSeries(
      connection,
      calendar,
      from,
      { then: next, mayBeDone: false },
      never,
    );
    expect(answer).toEqual({ ok: false, reason, retryAfterMs: 30_000 });
    expect(g.records.get(from.id)?.etag).toBe(from.version);
    expect(g.records.get(KEY)?.status).toBe("confirmed");
    expect(mutations(g).at(-1)).toMatchObject({ method: "DELETE", ifMatch: '"2"' });
  });

  it("keeps the continuation when an end may have succeeded despite an error and finds it on retry", async () => {
    let records = new Map<string, Record<string, unknown>>();
    const g = google({
      refuse: (s) => {
        if (s.method !== "PATCH") return null;
        records.set("series", { ...records.get("series"), ...s.body, etag: '"ended"' });
        return { status: 503 };
      },
    });
    records = g.records;
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    const first = await g.writer.endSeries(
      connection,
      calendar,
      from,
      { then: next, mayBeDone: false },
      never,
    );
    expect(word(first)).toBe("unavailable");
    const retry = await g.writer.endSeries(
      connection,
      calendar,
      from,
      { then: next, mayBeDone: true },
      never,
    );
    expect(retry.ok && retry.items.map((item) => item.id)).toEqual([from.id]);
    expect(g.records.get(KEY)?.status).toBe("confirmed");
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH"]);
  });

  it("does not trim the series after the continuation was changed between attempts", async () => {
    let refuseEnd = true;
    const g = google({ refuse: (s) => (s.method === "PATCH" && refuseEnd ? { status: 503 } : null) });
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("unavailable");
    g.records.set(KEY, { ...g.records.get(KEY), recurrence: [], etag: '"changed"' });
    refuseEnd = false;
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: true }, never)),
    ).toBe("version_stale");
    expect(g.records.get(from.id)?.recurrence).toEqual(repeat);
    expect(g.records.get(KEY)?.status).toBe("confirmed");
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH", "POST"]);
  });

  it("recovers the created personal continuation and preserves its reminders and guest privacy", async () => {
    const g = google();
    const reminders = { useDefault: false, overrides: [{ method: "email", minutes: 20 }] };
    const master = plantSeries(g, true);
    g.records.set(master.id, {
      ...g.records.get(master.id),
      attendees: [],
      reminders,
      guestsCanSeeOtherGuests: false,
    });
    g.generated.set(master.id, { ...g.generated.get(master.id), attendees: [] });
    const { occurrence, next } = carry(true);
    const from = {
      ...master,
      occurrence,
      audience: { organizer, guests: [] },
      recurringSeries: true as const,
    };
    const personal = { ...next, event: { ...next.event, organizer: null, attendees: [] } };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: personal, mayBeDone: false }, never)),
    ).toBe("ok");
    const second = await g.writer.continueSeries(
      connection,
      calendar,
      { ...personal, from, requireExisting: true },
      never,
    );
    expect(second.ok && second.items.map((item) => item.id)).toEqual([KEY]);
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH"]);
    expect(g.records.get(KEY)).toMatchObject({ reminders, guestsCanSeeOtherGuests: false, attendees: [] });
  });

  it("keeps both series if the new copy moves before a refused end can be rolled back", async () => {
    let records = new Map<string, Record<string, unknown>>();
    const g = google({
      refuse: (s) => {
        if (s.method !== "PATCH") return null;
        records.set(KEY, { ...records.get(KEY), summary: "Changed elsewhere", etag: '"moved"' });
        return { status: 412 };
      },
    });
    records = g.records;
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("version_stale");
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH"]);
    expect(g.records.get(from.id)?.recurrence).toEqual(repeat);
    expect(g.records.get(KEY)).toMatchObject({ status: "confirmed", summary: "Changed elsewhere" });
  });

  it("keeps the continuation when another edit drops later dates but keeps the selected date", async () => {
    const shortened = ["RRULE:FREQ=WEEKLY;UNTIL=20261202T090000Z"];
    let records = new Map<string, Record<string, unknown>>();
    const g = google({
      refuse: (s) => {
        if (s.method !== "PATCH") return null;
        records.set("series", { ...records.get("series"), recurrence: shortened, etag: '"shortened"' });
        return { status: 412 };
      },
    });
    records = g.records;
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    const answer = await g.writer.endSeries(
      connection,
      calendar,
      from,
      { then: next, mayBeDone: false },
      never,
    );
    expect(word(answer)).toBe("version_stale");
    expect(g.records.get(from.id)?.recurrence).toEqual(shortened);
    expect(g.records.get(KEY)?.status).toBe("confirmed");
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH"]);
  });

  it("refuses a whole-series update when a live exception has a different audience", async () => {
    const g = google();
    const master = plantSeries(g);
    g.plant("private-exception", {
      organizer: { email: organizer },
      attendees: [],
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-12-02T09:00:00Z" },
    });
    const whole = { ...master, audience, recurringSeries: true as const, writeKey: { hex: KEY } };
    expect(word(await g.writer.change(connection, calendar, whole, { summary: "All events" }, never))).toBe(
      "version_stale",
    );
    expect(mutations(g)).toEqual([]);
  });

  it("refuses to start a split that would discard a live cancelled exception without an iCalUID", async () => {
    const g = google();
    const master = plantSeries(g);
    g.records.set("cancelled-exception", {
      id: "cancelled-exception",
      status: "cancelled",
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-12-02T09:00:00Z" },
    });
    const { occurrence, next } = carry(false);
    const from = { ...master, occurrence, audience, recurringSeries: true as const };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("repeat_unsupported");
    expect(mutations(g)).toEqual([]);
  });

  it("refuses to create a continuation when Google cannot verify the exact selected originalStart", async () => {
    const g = google();
    const master = plantSeries(g);
    g.generated.clear();
    const { occurrence, next } = carry(false);
    const from = { ...master, occurrence, audience, recurringSeries: true as const };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("version_stale");
    expect(mutations(g)).toEqual([]);
  });

  it.each([false, true])(
    "edits an already changed occurrence under its reviewed version (whole day %s)",
    async (allDay) => {
      const g = google();
      const master = plantSeries(g, allDay);
      const { occurrence } = carry(allDay);
      const exception = g.plant("reviewed-exception", {
        ...g.generated.get(master.id),
        id: "reviewed-exception",
        etag: '"exception-before"',
        summary: "Previously changed title",
        location: "Room kept from the exception",
        extendedProperties: properties,
      });
      const select = {
        ...master,
        occurrence,
        exception: { ...exception, occurrence },
        audience,
        recurringSeries: true as const,
        writeKey: { hex: KEY },
      };
      const change = { summary: "The reviewed occurrence" };
      expect(word(await g.writer.change(connection, calendar, select, change, never))).toBe("ok");
      expect(word(await g.writer.change(connection, calendar, select, change, never))).toBe("ok");
      expect(mutations(g).map((call) => [call.method, call.url, call.ifMatch])).toEqual([
        ["PATCH", `${BASE}/${exception.id}?sendUpdates=all`, exception.version],
      ]);
      expect(g.records.get(exception.id)).toMatchObject({
        summary: change.summary,
        location: "Room kept from the exception",
        extendedProperties: properties,
      });
      expect(g.records.get(master.id)?.summary).toBe("Kiln check");
    },
  );

  it("refuses an edit whose reviewed exception no longer has the same version or recurrence key", async () => {
    const g = google();
    const master = plantSeries(g);
    const { occurrence } = carry(false);
    const exception = g.plant("reviewed-exception", {
      ...g.generated.get(master.id),
      id: "reviewed-exception",
      etag: '"exception-live"',
    });
    const select = {
      ...master,
      occurrence,
      audience,
      recurringSeries: true as const,
      writeKey: { hex: KEY },
    };
    const change = { summary: "Only this event" };
    expect(
      word(
        await g.writer.change(
          connection,
          calendar,
          {
            ...select,
            exception: { ...exception, version: '"exception-stale"', occurrence },
          },
          change,
          never,
        ),
      ),
    ).toBe("version_stale");
    g.records.set(exception.id, {
      ...g.records.get(exception.id),
      originalStartTime: { dateTime: "2026-12-02T09:00:00Z" },
    });
    expect(
      word(
        await g.writer.change(
          connection,
          calendar,
          {
            ...select,
            exception: { ...exception, occurrence },
          },
          change,
          never,
        ),
      ),
    ).toBe("version_stale");
    expect(mutations(g)).toEqual([]);
  });

  it("changes the master and the named field of the reviewed exception while preserving its other changes", async () => {
    const g = google();
    const master = plantSeries(g);
    const { occurrence } = carry(false);
    const start = { dateTime: "2026-11-25T13:00:00+01:00", timeZone: "Europe/Zurich" };
    const end = { dateTime: "2026-11-25T14:00:00+01:00", timeZone: "Europe/Zurich" };
    const exception = g.plant("reviewed-exception", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
      summary: "Different title",
      location: "Different room",
      start,
      end,
    });
    const whole = {
      ...master,
      exception: { ...exception, occurrence },
      audience,
      recurringSeries: true as const,
      writeKey: { hex: KEY },
    };
    const change = { summary: "All events" };
    expect(word(await g.writer.change(connection, calendar, whole, change, never))).toBe("ok");
    expect(word(await g.writer.change(connection, calendar, whole, change, never))).toBe("ok");
    expect(g.records.get(master.id)).toMatchObject({ summary: change.summary, recurrence: repeat });
    expect(g.records.get(exception.id)).toMatchObject({
      summary: change.summary,
      location: "Different room",
      start,
      end,
    });
    expect(mutations(g).map((call) => [call.method, call.url, call.ifMatch])).toEqual([
      ["PATCH", `${BASE}/${master.id}?sendUpdates=all`, master.version],
      ["PATCH", `${BASE}/${exception.id}?sendUpdates=all`, exception.version],
    ]);
  });

  it.each(["own write", "inherited marker", "unapplied field"] as const)(
    "reconciles a previous occurrence edit without resending (%s)",
    async (situation) => {
      const g = google();
      const master = plantSeries(g);
      const { occurrence } = carry(false);
      const previousMarker = { private: { ohmailRecurringEdit: KEY } };
      const exception = g.plant("reviewed-exception", {
        ...people,
        recurringEventId: master.id,
        originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
        extendedProperties: previousMarker,
        summary: situation === "unapplied field" ? "Existing exception title" : "Only this event",
      });
      if (situation === "inherited marker")
        g.records.set(master.id, { ...g.records.get(master.id), extendedProperties: previousMarker });
      const selected = {
        ...master,
        occurrence,
        exception: { ...exception, occurrence, version: '"version-before-own-write"' },
        audience,
        recurringSeries: true as const,
        writeKey: { hex: KEY },
      };
      const answer = await g.writer.change(
        connection,
        calendar,
        selected,
        { summary: "Only this event" },
        never,
      );
      expect(word(answer)).toBe(situation === "own write" ? "ok" : "version_stale");
      expect(mutations(g)).toEqual([]);
    },
  );

  it("updates a title override once even when the occurrence inherits the series edit marker", async () => {
    const g = google({ inheritSeriesPatches: true });
    const master = plantSeries(g);
    const { occurrence } = carry(false);
    const exception = g.plant("reviewed-exception", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
      summary: "Previous exception title",
      location: "Room kept from the exception",
    });
    const whole = {
      ...master,
      exception: { ...exception, occurrence },
      audience,
      recurringSeries: true as const,
      writeKey: { hex: KEY },
    };
    const change = { summary: "Edited for all events" };
    expect(word(await g.writer.change(connection, calendar, whole, change, never))).toBe("ok");
    expect(word(await g.writer.change(connection, calendar, whole, change, never))).toBe("ok");
    expect(g.records.get(exception.id)).toMatchObject({
      summary: change.summary,
      location: "Room kept from the exception",
    });
    const occurrenceEdits = mutations(g).filter((call) => call.url.includes("/reviewed-exception?"));
    expect(occurrenceEdits).toHaveLength(1);
    expect(occurrenceEdits[0]?.ifMatch).not.toBe(exception.version);
  });

  it.each(["acknowledgement", "matching conflict", "final reread", "recovered master changes"] as const)(
    "holds the exception when the series no longer has the approved title in its %s",
    async (response) => {
      let sentMaster = false;
      let recoveredReads = 0;
      let savedReceipt = 0;
      const g = google({
        inheritSeriesPatches: true,
        refuse: (request) => {
          if (request.method === "PATCH" && request.url.includes("/series?")) {
            sentMaster = true;
            if (response === "final reread") return null;
            const marked = {
              ...g.records.get("series"),
              etag: '"accepted-series"',
              extendedProperties: request.body?.extendedProperties,
              ...(response === "recovered master changes" && { summary: request.body?.summary }),
            };
            g.records.set("series", marked);
            return response === "acknowledgement" ? { status: 200, body: marked } : { status: 412 };
          }
          if (
            response === "final reread" &&
            sentMaster &&
            request.method === "GET" &&
            request.url.endsWith("/series")
          )
            return { status: 200, body: { ...g.records.get("series"), summary: "Kiln check" } };
          if (
            response === "recovered master changes" &&
            sentMaster &&
            request.method === "GET" &&
            request.url.endsWith("/series") &&
            ++recoveredReads === 2
          )
            return { status: 200, body: { ...g.records.get("series"), etag: '"edited-again"' } };
          return null;
        },
      });
      const master = plantSeries(g);
      const { occurrence } = carry(false);
      const exception = g.plant("reviewed-exception", {
        ...people,
        recurringEventId: master.id,
        originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
        summary: "Previous exception title",
      });
      const whole = {
        ...master,
        exception: { ...exception, occurrence },
        audience,
        recurringSeries: true as const,
        writeKey: { hex: KEY },
        rememberMasterReceipt: async () => {
          savedReceipt++;
        },
      };
      const answer = await g.writer.change(connection, calendar, whole, { summary: "All events" }, never);
      expect(word(answer)).toBe("version_stale");
      expect(savedReceipt).toBe(response === "final reread" ? 1 : 0);
      expect(g.records.get(exception.id)?.summary).toBe("Previous exception title");
      expect(mutations(g).map((call) => [call.method, call.url])).toEqual([
        ["PATCH", `${BASE}/${master.id}?sendUpdates=all`],
      ]);
    },
  );

  it.each(["saved receipt", "missing receipt", "independent edit"] as const)(
    "checks the reviewed exception when resuming after provider inheritance (%s)",
    async (situation) => {
      let interrupted = false;
      let receipt: MasterEditReceipt | undefined;
      const g = google({
        inheritSeriesPatches: true,
        refuse: (request) => {
          if (request.method !== "PATCH" || !request.url.includes("/reviewed-exception?") || interrupted)
            return null;
          interrupted = true;
          return { status: 503 };
        },
      });
      const master = plantSeries(g);
      const { occurrence } = carry(false);
      const exception = g.plant("reviewed-exception", {
        ...people,
        recurringEventId: master.id,
        originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
        summary: "Earlier title",
        location: "Earlier room",
      });
      const whole = {
        ...master,
        exception: { ...exception, occurrence },
        audience,
        recurringSeries: true as const,
        writeKey: { hex: KEY },
      };
      const change = { summary: "All events" };
      const result = await g.writer.change(
        connection,
        calendar,
        {
          ...whole,
          rememberMasterReceipt: async (saved) => {
            receipt = saved;
          },
        },
        change,
        never,
      );
      expect(word(result)).toBe("unavailable");
      expect(receipt).toMatchObject({
        version: g.records.get(master.id)?.etag,
        exceptionSnapshot: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      if (situation === "independent edit")
        g.records.set(exception.id, {
          ...g.records.get(exception.id),
          location: "New room",
          etag: '"new-child"',
        });

      const retry = await g.writer.change(
        connection,
        calendar,
        {
          ...whole,
          masterReceipt: situation === "missing receipt" ? undefined : receipt,
        },
        change,
        never,
      );
      const safe = situation === "saved receipt";
      expect(word(retry)).toBe(safe ? "ok" : "version_stale");
      expect(mutations(g).filter((call) => call.url.includes("/series?"))).toHaveLength(1);
      expect(mutations(g).filter((call) => call.url.includes("/reviewed-exception?"))).toHaveLength(
        safe ? 2 : 1,
      );
      expect(g.records.get(exception.id)).toMatchObject({
        summary: safe ? change.summary : "Earlier title",
        location: situation === "independent edit" ? "New room" : "Earlier room",
      });
    },
  );

  it.each(["same versions", "changed master", "changed exception"] as const)(
    "resumes a series edit after losing the exception response (%s)",
    async (situation) => {
      let interrupted = false;
      const g = google({
        refuse: (request) => {
          if (request.method !== "PATCH" || !request.url.includes("/reviewed-exception?") || interrupted)
            return null;
          interrupted = true;
          return { status: 503 };
        },
      });
      const master = plantSeries(g);
      const { occurrence } = carry(false);
      const exception = g.plant("reviewed-exception", {
        ...people,
        recurringEventId: master.id,
        originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
        summary: "Earlier title",
        location: "Earlier room",
      });
      const whole = {
        ...master,
        exception: { ...exception, occurrence },
        audience,
        recurringSeries: true as const,
        writeKey: { hex: KEY },
      };
      const change = { summary: "All events" };
      expect(word(await g.writer.change(connection, calendar, whole, change, never))).toBe("unavailable");
      if (situation === "changed master")
        g.records.set(master.id, {
          ...g.records.get(master.id),
          summary: "New master title",
          etag: '"new-master"',
        });
      if (situation === "changed exception")
        g.records.set(exception.id, {
          ...g.records.get(exception.id),
          location: "New room",
          etag: '"new-child"',
        });

      const result = await g.writer.change(connection, calendar, whole, change, never);
      const clean = situation === "same versions";
      expect(word(result)).toBe(clean ? "ok" : "version_stale");
      expect(mutations(g).filter((call) => call.url.includes("/series?"))).toHaveLength(1);
      expect(mutations(g).filter((call) => call.url.includes("/reviewed-exception?"))).toHaveLength(
        clean ? 2 : 1,
      );
      expect(g.records.get(exception.id)).toMatchObject({
        summary: clean ? change.summary : "Earlier title",
        location: situation === "changed exception" ? "New room" : "Earlier room",
      });
    },
  );

  it("continues from a reviewed exception after creating the replacement and keeps an earlier exception", async () => {
    const g = google();
    const master = plantSeries(g);
    const { occurrence, next } = carry(false);
    const earlier = g.plant("earlier-exception", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
      location: "Earlier room",
    });
    const exception = g.plant("reviewed-exception", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
      summary: "Replaced title",
      location: "Replaced room",
    });
    const from = {
      ...master,
      occurrence,
      exception: { ...exception, occurrence },
      audience,
      recurringSeries: true as const,
    };
    const answer = await g.writer.endSeries(
      connection,
      calendar,
      from,
      { then: next, mayBeDone: false },
      never,
    );
    expect(answer).toMatchObject({
      ok: true,
      items: [
        { kind: "upsert", id: master.id },
        { kind: "gone", id: exception.id },
      ],
    });
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: true }, never)),
    ).toBe("ok");
    expect(g.records.get(earlier.id)).toMatchObject({ location: "Earlier room", etag: earlier.version });
    expect(g.records.get(KEY)).toMatchObject({
      summary: next.change.summary,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
    });
    expect(g.records.get(master.id)?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261125T085959Z"]);
    expect(g.records.get(exception.id)?.status).toBe("cancelled");
    expect(mutations(g).map((call) => [call.method, call.url, call.ifMatch])).toEqual([
      ["POST", `${BASE}?sendUpdates=all`, null],
      ["PATCH", `${BASE}/${master.id}?sendUpdates=all`, master.version],
      ["DELETE", `${BASE}/${exception.id}?sendUpdates=all`, exception.version],
    ]);
  });

  it("keeps the reviewed override if the continuation changes after the trim", async () => {
    const g = google({
      refuse: (request) => {
        if (
          request.method === "GET" &&
          request.url.endsWith("/reviewed-exception") &&
          JSON.stringify(g.records.get("series")?.recurrence).includes("UNTIL")
        )
          g.records.set(KEY, { ...g.records.get(KEY), etag: '"changed-continuation"' });
        return null;
      },
    });
    const master = plantSeries(g);
    const { occurrence, next } = carry(false);
    const exception = g.plant("reviewed-exception", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
    });
    const from = {
      ...master,
      occurrence,
      exception: { ...exception, occurrence },
      audience,
      recurringSeries: true as const,
    };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("version_stale");
    expect(g.records.get(exception.id)).toMatchObject({ status: "confirmed", etag: exception.version });
    expect(mutations(g).map((call) => call.method)).toEqual(["POST", "PATCH"]);
  });

  it("refuses an occurrence edit made on the master after Google independently changed the instance", async () => {
    const g = google();
    const master = plantSeries(g);
    const { occurrence } = carry(false);
    g.plant("existing-exception", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-25T09:00:00Z" },
      summary: "Already changed elsewhere",
    });
    const select = {
      ...master,
      occurrence,
      audience,
      recurringSeries: true as const,
      writeKey: { hex: KEY },
    };
    expect(
      word(await g.writer.change(connection, calendar, select, { summary: "Only this event" }, never)),
    ).toBe("version_stale");
    expect(mutations(g)).toEqual([]);
  });

  it("does not create a continuation from the second row of a split", async () => {
    const g = google();
    const master = g.plant("series", { ...people, recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20261125T085959Z"] });
    const { occurrence, next } = carry(false);
    const from = { ...target(master), occurrence, audience, recurringSeries: true as const };
    expect(word(await g.writer.continueSeries(connection, calendar, { ...next, from }, never))).toBe(
      "version_stale",
    );
    expect(mutations(g)).toEqual([]);
  });

  it("recovers an already-ended modern split only from an existing continuation", async () => {
    const g = google();
    const master = g.plant("series", { ...people, recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20261125T085959Z"] });
    const { occurrence, next } = carry(false);
    const from = { ...target(master), occurrence, audience, recurringSeries: true as const };
    const req = { ...next, from, requireExisting: true as const };
    expect(word(await g.writer.continueSeries(connection, calendar, req, never))).toBe("event_gone");
    expect(mutations(g)).toEqual([]);
  });

  it.each([
    ["a missing provider version", { etag: undefined }],
    ["a different provider version", { etag: '"changed"' }],
    ["an incomplete audience", { attendeesOmitted: true }],
    ["a different organizer", { organizer: { email: "new-host" + "@example.invalid" } }],
    ["a different recurrence", { recurrence: ["RRULE:FREQ=MONTHLY;COUNT=4"] }],
  ])("rejects an already-created continuation with %s during either recovery", async (_reason, changed) => {
    const g = google();
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("ok");
    g.records.set(KEY, { ...g.records.get(KEY), ...changed });
    expect(
      word(
        await g.writer.endSeries(
          connection,
          calendar,
          from,
          { then: next, mayBeDone: true, late: true },
          never,
        ),
      ),
    ).toBe("version_stale");
    expect(
      word(
        await g.writer.continueSeries(connection, calendar, { ...next, from, requireExisting: true }, never),
      ),
    ).toBe("version_stale");
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH"]);
  });

  it("undoes the exact fresh continuation if an original exception appears during insertion", async () => {
    let records = new Map<string, Record<string, unknown>>();
    const g = google({
      refuse: (s) => {
        if (s.method === "POST")
          records.set("late-exception", {
            id: "late-exception",
            recurringEventId: "series",
            status: "cancelled",
            originalStartTime: { dateTime: "2026-12-02T09:00:00Z" },
          });
        return null;
      },
    });
    records = g.records;
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("repeat_unsupported");
    expect(g.records.get(from.id)?.recurrence).toEqual(repeat);
    expect(g.records.get(KEY)?.status).toBe("cancelled");
    expect(mutations(g).map((s) => [s.method, s.ifMatch])).toEqual([
      ["POST", null],
      ["DELETE", '"2"'],
    ]);
  });

  it.each(["POST", "PATCH"])(
    "preserves a continuation that gains its own exception during %s",
    async (stage) => {
      let records = new Map<string, Record<string, unknown>>();
      const g = google({
        refuse: (s) => {
          if (s.method !== stage) return null;
          records.set("continuation-exception", {
            id: "continuation-exception",
            recurringEventId: KEY,
            status: "cancelled",
            originalStartTime: { dateTime: "2026-12-02T09:00:00Z" },
          });
          return stage === "PATCH" ? { status: 400 } : null;
        },
      });
      records = g.records;
      const { occurrence, next } = carry(false);
      const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
      expect(
        word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
      ).toBe("version_stale");
      expect(g.records.get(from.id)?.recurrence).toEqual(repeat);
      expect(g.records.get(KEY)?.status).toBe("confirmed");
      expect(mutations(g).map((s) => s.method)).toEqual(stage === "PATCH" ? ["POST", "PATCH"] : ["POST"]);
    },
  );

  it.each([false, true])(
    "reuses the saved creation version after a temporary rollback failure (exception %s)",
    async (addedException) => {
      let failedDelete = false;
      let records = new Map<string, Record<string, unknown>>();
      const g = google({
        refuse: (s) => {
          if (s.method === "POST" && addedException)
            records.set("original-exception", {
              id: "original-exception",
              recurringEventId: "series",
              status: "cancelled",
              originalStartTime: { dateTime: "2026-12-02T09:00:00Z" },
            });
          if (s.method === "PATCH") return { status: 412 };
          if (s.method !== "DELETE" || failedDelete) return null;
          failedDelete = true;
          return { status: 503 };
        },
      });
      records = g.records;
      const { occurrence, next } = carry(false);
      const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
      const remembered: (string | null)[] = [];
      const rememberCreatedVersion = async (version: string | null) => {
        remembered.push(version);
      };
      const first = await g.writer.endSeries(
        connection,
        calendar,
        from,
        { then: { ...next, rememberCreatedVersion }, mayBeDone: false },
        never,
      );
      expect(word(first)).toBe("unavailable");
      expect(remembered).toEqual(['"2"']);
      const then = { ...next, createdVersion: '"2"', rememberCreatedVersion };
      const second = await g.writer.endSeries(connection, calendar, from, { then, mayBeDone: true }, never);
      expect(word(second)).toBe(addedException ? "repeat_unsupported" : "version_stale");
      expect(remembered).toEqual(['"2"', null]);
      expect(g.records.get(from.id)?.recurrence).toEqual(repeat);
      expect(g.records.get(KEY)?.status).toBe("cancelled");
      expect(mutations(g).filter((s) => s.method === "POST")).toHaveLength(1);
      expect(
        mutations(g)
          .filter((s) => s.method === "DELETE")
          .map((s) => s.ifMatch),
      ).toEqual(['"2"', '"2"']);
    },
  );

  it("keeps a recovered continuation with provider changes even when the original still has its old version", async () => {
    let status = 503;
    const g = google({ refuse: (s) => (s.method === "PATCH" ? { status } : null) });
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: false }, never)),
    ).toBe("unavailable");
    g.records.set(KEY, { ...g.records.get(KEY), colorId: "4", etag: '"changed"' });
    status = 412;
    expect(
      word(await g.writer.endSeries(connection, calendar, from, { then: next, mayBeDone: true }, never)),
    ).toBe("version_stale");
    expect(g.records.get(from.id)?.etag).toBe(from.version);
    expect(g.records.get(KEY)).toMatchObject({ status: "confirmed", colorId: "4" });
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH", "POST", "PATCH"]);
  });

  it("keeps the saved creation version and both series when the continuation moved before retry", async () => {
    const g = google({ refuse: (s) => (s.method === "PATCH" ? { status: 503 } : null) });
    const { occurrence, next } = carry(false);
    const from = { ...plantSeries(g), occurrence, audience, recurringSeries: true as const };
    const remembered: (string | null)[] = [];
    const rememberCreatedVersion = async (version: string | null) => {
      remembered.push(version);
    };
    const first = await g.writer.endSeries(
      connection,
      calendar,
      from,
      { then: { ...next, rememberCreatedVersion }, mayBeDone: false },
      never,
    );
    expect(word(first)).toBe("unavailable");
    g.records.set(KEY, { ...g.records.get(KEY), colorId: "4", etag: '"changed"' });
    const then = { ...next, createdVersion: '"2"', rememberCreatedVersion };
    const second = await g.writer.endSeries(connection, calendar, from, { then, mayBeDone: true }, never);
    expect(word(second)).toBe("version_stale");
    expect(remembered).toEqual(['"2"']);
    expect(g.records.get(from.id)?.recurrence).toEqual(repeat);
    expect(g.records.get(KEY)).toMatchObject({ status: "confirmed", colorId: "4" });
    expect(mutations(g).map((s) => s.method)).toEqual(["POST", "PATCH"]);
  });
});

describe("Google's writer", () => {
  it("compares the confirmed guests to the whole current event before notifying them", async () => {
    const g = google();
    const organizer = "studio@example.invalid";
    const guest = "kiln@example.invalid";
    const stored = g.plant("evt-firing", { organizer: { email: organizer }, attendees: [{ email: guest }] });
    const expected = (guests: string[]) => ({ ...target(stored), audience: { organizer, guests } });
    const change = { summary: "Moved firing" };
    const update = (guests: string[]) =>
      g.writer.change(connection, { id: "cal-1" }, expected(guests), change, never);
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
      const stored = g.plant("evt-firing", {
        organizer: { email: organizer },
        attendees: [{ email: first }, { email: second }],
        ...other,
      });
      const requested = { ...target(stored), audience: { organizer, guests } };
      const result = await g.writer.change(
        connection,
        { id: "cal-1" },
        requested,
        { summary: "Moved firing" },
        never,
      );
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

  it("sends a cancellation only after it verifies the event's complete audience", async () => {
    const g = google();
    const organizer = "host" + "@example.test";
    const guest = "visitor" + "@example.test";
    const audience = { organizer, guests: [guest] };
    const people = { organizer: { email: organizer }, attendees: [{ email: guest }] };
    const incomplete = g.plant("incomplete", { ...people, attendeesOmitted: true });
    const complete = g.plant("complete", people);
    const remove = (event: typeof complete, guests: string[]) =>
      g.writer.remove(
        connection,
        { id: "cal-1" },
        { ...target(event), audience: { ...audience, guests } },
        never,
      );
    expect(word(await remove(incomplete, [guest]))).toBe("version_stale");
    expect(word(await remove(complete, []))).toBe("version_stale");
    expect(g.sent.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(word(await remove(complete, [guest]))).toBe("ok");
    expect(g.sent.slice(2).map((r) => [r.method, r.ifMatch])).toEqual([
      ["GET", null],
      ["DELETE", complete.version],
    ]);
  });

  it("cancels a single master after checking the changed day's version and the combined audience", async () => {
    const g = google();
    const organizer = "host" + "@example.test";
    const guest = "guest" + "@example.test";
    const another = "another" + "@example.test";
    const first = g.plant("series", {
      organizer: { email: organizer },
      attendees: [{ email: guest }],
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-11-17T09:00:00Z" },
      end: { dateTime: "2026-11-17T10:00:00Z" },
    });
    const changed = g.plant("changed", {
      organizer: { email: organizer },
      attendees: [{ email: another }],
      recurringEventId: first.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
      start: { dateTime: "2026-11-18T12:00:00Z" },
      end: { dateTime: "2026-11-18T13:00:00Z" },
    });
    const remove = (version: string) =>
      g.writer.remove(
        connection,
        { id: "cal-1" },
        {
          ...target(first),
          recurringSeries: true,
          audience: { organizer, guests: [another, guest] },
          seriesCancellation: {
            overrides: [{ id: changed.id, version }],
            message: "The event has been cancelled",
          },
        },
        never,
      );
    expect(word(await remove('"stale"'))).toBe("version_stale");
    expect(g.sent.filter((r) => r.method === "DELETE")).toHaveLength(0);
    expect(word(await remove(changed.version))).toBe("ok");
    expect(g.sent.filter((r) => r.method === "DELETE").map(({ url, ifMatch }) => [url, ifMatch])).toEqual([
      [`${BASE}/series?sendUpdates=all`, first.version],
    ]);
  });

  it("cancels an unchanged series under its confirmed guest list", async () => {
    const g = google();
    const host = "host" + "@example.test";
    const guest = "guest" + "@example.test";
    const people = { organizer: { email: host }, attendees: [{ email: guest }] };
    const master = g.plant("booked-series", {
      ...people,
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-11-17T09:00:00Z" },
      end: { dateTime: "2026-11-17T10:00:00Z" },
    });
    g.plant("changed-day", {
      ...people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
    });
    const remove = () =>
      g.writer.remove(
        connection,
        { id: "cal-1" },
        { ...target(master), recurringSeries: true, audience: { organizer: host, guests: [guest] } },
        never,
      );
    expect(word(await remove())).toBe("repeat_unsupported");
    expect(g.sent.filter((r) => r.method === "DELETE")).toHaveLength(0);
    g.records.delete("changed-day");
    expect(word(await remove())).toBe("ok");
    expect(g.sent.filter((r) => r.method === "DELETE").map(({ ifMatch }) => ifMatch)).toEqual([
      master.version,
    ]);
  });

  it("cancels only the reviewed occurrence and returns its original time", async () => {
    const g = google();
    const organizer = "host" + "@example.test",
      guest = "guest" + "@example.test";
    const people = { organizer: { email: organizer }, attendees: [{ email: guest }] };
    const master = g.plant("cancel-occurrence", {
      ...people,
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-11-17T09:00:00Z" },
      end: { dateTime: "2026-11-17T10:00:00Z" },
    });
    const day = {
      ...g.records.get(master.id)!,
      id: "cancel-this-day",
      etag: '"that-day"',
      recurrence: undefined,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
      start: { dateTime: "2026-11-18T09:00:00Z" },
      end: { dateTime: "2026-11-18T10:00:00Z" },
    };
    g.generated.set(master.id, day);
    const occurrence = instant(Date.UTC(2026, 10, 18, 9));
    const answer = await g.writer.remove(
      connection,
      { id: "cal-1" },
      {
        ...target(master),
        recurringSeries: true,
        occurrence,
        audience: { organizer, guests: [guest] },
      },
      never,
    );
    expect(answer).toMatchObject({
      ok: true,
      items: [{ kind: "cancelled_occurrence", originalStart: occurrence }],
    });
    expect(g.sent.filter((r) => r.method === "DELETE").map(({ url, ifMatch }) => [url, ifMatch])).toEqual([
      [`${BASE}/cancel-this-day?sendUpdates=all`, day.etag],
    ]);
  });

  it("moves an event only under its reviewed version and guest list", async () => {
    const g = google();
    const organizer = "host" + "@example.test",
      guest = "guest" + "@example.test";
    const source = g.plant("moving", { organizer: { email: organizer }, attendees: [{ email: guest }] });
    const move = (version: string, guests: string[]) =>
      g.writer.moveEvent(
        connection,
        { id: "cal-1" },
        { id: "cal-2" },
        { ...target(source), version, audience: { organizer, guests } },
        never,
      );
    expect(word(await move('"stale"', [guest]))).toBe("version_stale");
    expect(word(await move(source.version, []))).toBe("version_stale");
    expect(g.sent.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(word(await move(source.version, [guest]))).toBe("ok");
    expect(g.sent.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "POST"]);
  });

  it("moves a whole series only when its guest list and unchanged days are verified", async () => {
    const g = google();
    const organizer = "host" + "@example.test";
    const source = g.plant("series-to-move", {
      organizer: { email: organizer },
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-11-17T09:00:00Z" },
      end: { dateTime: "2026-11-17T10:00:00Z" },
    });
    const move = () =>
      g.writer.moveEvent(
        connection,
        { id: "cal-1" },
        { id: "cal-2" },
        {
          ...target(source),
          recurringSeries: true,
          audience: { organizer, guests: [] },
        },
        never,
      );
    g.plant("changed-day", {
      recurringEventId: source.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
    });
    expect(word(await move())).toBe("repeat_unsupported");
    expect(g.sent.filter(({ method }) => method === "POST")).toHaveLength(0);
    g.records.delete("changed-day");
    expect(word(await move())).toBe("ok");
    expect(g.sent.filter(({ method }) => method === "POST")).toHaveLength(1);
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

  it("answers the named occurrence against its own tag and never patches the master", async () => {
    const g = google();
    const host = "host" + "@example.test";
    const self = "guest" + "@example.test";
    const people = [
      { email: host, organizer: true },
      { email: self, self: true, responseStatus: "accepted" },
    ];
    const master = g.plant("meeting", {
      organizer: { email: host },
      attendees: people,
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-11-17T09:00:00Z" },
      end: { dateTime: "2026-11-17T10:00:00Z" },
    });
    const instance = {
      ...g.records.get(master.id)!,
      id: "meeting-tomorrow",
      etag: '"one-day"',
      recurrence: undefined,
      organizer: { email: host },
      attendees: people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
      start: { dateTime: "2026-11-18T09:00:00Z" },
      end: { dateTime: "2026-11-18T10:00:00Z" },
    };
    g.generated.set(master.id, instance);
    const changed = await g.writer.answer(
      connection,
      { id: "cal-1" },
      { ...target(master), recurringSeries: true, occurrence: instant(Date.UTC(2026, 10, 18, 9)) },
      { as: self, reply: "TENTATIVE" },
      never,
    );
    expect(word(changed)).toBe("ok");
    const patches = g.sent.filter((r) => r.method === "PATCH");
    expect(patches.map(({ url, ifMatch }) => [url, ifMatch])).toEqual([
      [`${BASE}/meeting-tomorrow?sendUpdates=all`, instance.etag],
    ]);
  });
  it("refuses to use a Google event with attachments for a portable move", async () => {
    const g = google();
    const reminders = { useDefault: false };
    const simple = g.plant("portable", { reminders });
    const stored = g.plant("with-attachment", { reminders, attachments: [{ title: "Plans" }] });
    await expect(g.writer.readForMove!(connection, { id: "cal-1" }, simple.id, never)).resolves.toMatchObject(
      {
        ok: true,
        items: [{ kind: "upsert", portableCopy: true }],
      },
    );
    const read = await g.writer.readForMove!(connection, { id: "cal-1" }, stored.id, never);
    expect(read).toMatchObject({ ok: true, items: [{ kind: "upsert" }] });
    expect(read.ok && read.items[0]).not.toHaveProperty("portableCopy");
    expect(g.sent.every(({ method }) => method === "GET")).toBe(true);
  });

  it("recovers an occurrence answer after Google applied it but the reply was lost", async () => {
    const g = google({ losePatch: () => true });
    const host = "host" + "@example.test";
    const self = "guest" + "@example.test";
    const people = [
      { email: host, organizer: true },
      { email: self, self: true, responseStatus: "accepted" },
    ];
    const master = g.plant("meeting", {
      organizer: { email: host },
      attendees: people,
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-11-17T09:00:00Z" },
      end: { dateTime: "2026-11-17T10:00:00Z" },
    });
    const instance = {
      ...g.records.get(master.id)!,
      id: "meeting-tomorrow",
      etag: '"one-day"',
      recurrence: undefined,
      organizer: { email: host },
      attendees: people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
      start: { dateTime: "2026-11-18T09:00:00Z" },
      end: { dateTime: "2026-11-18T10:00:00Z" },
    };
    g.generated.set(master.id, instance);
    const write = (retry?: true) =>
      g.writer.answer(
        connection,
        { id: "cal-1" },
        { ...target(master), recurringSeries: true, occurrence: instant(Date.UTC(2026, 10, 18, 9)) },
        { as: self, reply: "TENTATIVE", retry },
        never,
      );
    expect(word(await write())).toBe("connection_failed");
    expect(word(await write(true))).toBe("ok");
    const patches = g.sent.filter((r) => r.method === "PATCH");
    expect(patches.map(({ url, ifMatch }) => [url, ifMatch])).toEqual([
      [`${BASE}/meeting-tomorrow?sendUpdates=all`, instance.etag],
    ]);
  });

  it("answers a previously changed instance only while both reviewed copies match", async () => {
    const g = google();
    const host = "host" + "@example.test";
    const self = "guest" + "@example.test";
    const people = [
      { email: host, organizer: true },
      { email: self, self: true, responseStatus: "accepted" },
    ];
    const master = g.plant("repeated-meeting", {
      organizer: { email: host },
      attendees: people,
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-11-17T09:00:00Z" },
      end: { dateTime: "2026-11-17T10:00:00Z" },
    });
    const instance = g.plant("changed-meeting", {
      organizer: { email: host },
      attendees: people,
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-11-18T09:00:00Z" },
      start: { dateTime: "2026-11-18T12:00:00Z" },
      end: { dateTime: "2026-11-18T13:00:00Z" },
    });
    const occurrence = instant(Date.UTC(2026, 10, 18, 9));
    const write = (version: string) =>
      g.writer.answer(
        connection,
        { id: "cal-1" },
        {
          ...target(master),
          recurringSeries: true,
          occurrence,
          exception: { id: instance.id, version, occurrence },
        },
        { as: self, reply: "TENTATIVE" },
        never,
      );
    expect(word(await write('"stale"'))).toBe("version_stale");
    expect(g.sent.filter((r) => r.method === "PATCH")).toHaveLength(0);
    expect(word(await write(instance.version))).toBe("ok");
    expect(g.sent.filter((r) => r.method === "PATCH").map(({ ifMatch }) => ifMatch)).toEqual([
      instance.version,
    ]);
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

  it("refuses a series-day command without recurring edit authority", async () => {
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

it("notifies guests with the recurring meeting and reads its rule back", async () => {
  const g = google();
  const rule = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6")!;
  const guest = ["fern", "example.com"].join("@");
  const made = await g.writer.create(
    connection,
    calendar,
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
  const item = made.ok && made.items[0];
  expect(item && item.kind === "upsert" && item.event.rules[0]?.rule).toEqual(rule);
  const posted = g.sent.find((request) => request.method === "POST")!;
  expect(new URL(posted.url).searchParams.get("sendUpdates")).toBe("all");
  expect(posted.body).toMatchObject({
    attendees: [{ email: guest }],
    recurrence: [expect.stringMatching(/^RRULE:/)],
  });
});

it.each(DRAFT_PROOF_CASES)("round-trips Google RRULE: $name", async ({ draft: event }) => {
  const g = google();
  const made = await g.writer.create(connection, calendar, { key: { hex: KEY }, event }, never);
  expect(word(made)).toBe("ok");
  expect(g.sent[0]?.body?.recurrence).toEqual(["RRULE:" + formatRRule(event.rule!)]);
  const item = made.ok && made.items[0];
  expect(item && item.kind === "upsert" && item.event.rules[0]?.rule).toEqual(event.rule);
});
