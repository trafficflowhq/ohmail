/**
 * A PRESS ON A SERIES, FROM THE DOOR TO THE SERVER, on a real Postgres: the services' door records
 * the press, the worker's drain carries it out in a whole turn, and the real CalDAV writer writes it
 * at the CalDAV stand-in on this machine. What the server received is read whole: each request's
 * method and precondition, and the object's text outside what the press names, byte for byte; and
 * the days the server is left with, as the calendar core expands them. A root test, because it holds
 * the door and the worker's passes together, and neither imports the other. Nothing leaves this
 * machine; every address is on a reserved domain.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS, expandSeries, fold, intlZones, momentOrUtc, readCalendar, seriesOf, vtimezoneFrom, writeComponent, zonesOf,
} from "@ohmail/cal-core";
import {
  BENCH_CALDAV_PLACE, PROVEN_REPEATS, makeCalendarProviders, proofPlaceOf, type CalendarProvider, type CalendarWriter, type ProvenRepeats,
  type RepeatShape,
} from "@ohmail/cal-providers";
import type { HostResolver } from "@trafficflow/core/net";
import { calCalendars, calConnections, calEvents, calWrites, changeLog, mailboxes } from "@trafficflow/db";
import { CALENDAR_WRITE_FAULTS, type CalendarWritePayload } from "@trafficflow/db/calendar";
import { ServiceError, dbFor, type Db as ServicesDb, type ServiceContext } from "@trafficflow/services";
import { CALENDAR_BUILDERS, dismissCalendarWrite, recordCalendarWrite, retryCalendarWrite } from "@trafficflow/services/calendar";
import { calendarSyncPass } from "../packages/organizer/src/calendar/sync-pass.js";
import { CalendarTurnOverdue, WORD_PLAN } from "../packages/organizer/src/calendar/words.js";
import { calendarWriteDrain } from "../packages/organizer/src/calendar/write-drain.js";
import {
  AVAILABLE, Secret, and, asc, capturedLog, depsFor, eq, openWorld, providersOf, recordWrite, seedConnection, sql, type World,
} from "../packages/organizer/test/_calendar-world.js";
import { startCalDavStandIn, type StandIn } from "../packages/cal-providers/test/caldav-stand-in.js";

const ZONES = intlZones();
const NOBODY: HostResolver = { resolve: async () => [] };
const never = new AbortController().signal;
const ZH = "Europe/Zurich";
const NY = "America/New_York";

/** A zone's definition as another program writes it, over the stand-in's months. */
function zoneLines(tz: string, startMs = Date.UTC(2026, 9, 1), endMs = Date.UTC(2028, 0, 1)): string[] {
  const made = vtimezoneFrom(tz, ZONES, { startMs, endMs });
  const text = made === null ? null : writeComponent(made);
  if (text === null || !text.ok) throw new Error(`the zone ${tz} did not write`);
  return text.text.trimEnd().split("\r\n");
}

interface Member {
  readonly uid: string;
  /** A zone's name, or `null` for whole days. */
  readonly tz: string | null;
  readonly start: string;
  readonly end: string;
  readonly rule: string;
  readonly summary: string;
  readonly excluded?: readonly string[];
  /** More lines of the series' own component. */
  readonly more?: readonly string[];
  /** Its changed days, each a component of its own (`status`: its STATUS line, where it has one: a day cancelled by its own component). */
  readonly days?: readonly { readonly was: string; readonly start: string; readonly end: string; readonly summary: string; readonly status?: string; readonly more?: readonly string[] }[];
}

/** A member's text as another program wrote it. */
function memberText(m: Member): string {
  const t = (name: string, v: string): string => (m.tz === null ? `${name};VALUE=DATE:${v}` : `${name};TZID=${m.tz}:${v}`);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//calendar//EN", ...(m.tz === null ? [] : zoneLines(m.tz)),
    "BEGIN:VEVENT", `UID:${m.uid}`, "DTSTAMP:20261113T120000Z", t("DTSTART", m.start), t("DTEND", m.end), `RRULE:${m.rule}`,
    ...(m.excluded ?? []).map((d) => t("EXDATE", d)), `SUMMARY:${m.summary}`, "SEQUENCE:0", "X-ELSEWHERE-COLOUR:ochre", ...(m.more ?? []),
    "END:VEVENT",
    ...(m.days ?? []).flatMap((d) => [
      "BEGIN:VEVENT", `UID:${m.uid}`, "DTSTAMP:20261113T120000Z", t("RECURRENCE-ID", d.was), t("DTSTART", d.start), t("DTEND", d.end),
      `SUMMARY:${d.summary}`, ...(d.status === undefined ? [] : [`STATUS:${d.status}`]), "SEQUENCE:0", ...(d.more ?? []), "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].map((line) => `${fold(line)}\r\n`).join("");
}

/** A text's own lines and its components, byte for byte, in order. */
function partsOf(text: string): { readonly own: string[]; readonly components: { readonly name: string; readonly lines: string[] }[] } {
  const own: string[] = [];
  const components: { name: string; lines: string[] }[] = [];
  let open: { name: string; lines: string[] } | null = null;
  let depth = 0;
  for (const line of text.split("\r\n")) {
    if (line === "" || line === "BEGIN:VCALENDAR" || (line === "END:VCALENDAR" && depth === 0)) continue;
    if (line.startsWith("BEGIN:")) {
      depth += 1;
      if (depth === 1) open = { name: line.slice(6), lines: [] };
    }
    if (open !== null) open.lines.push(line);
    else own.push(line);
    if (line.startsWith("END:")) {
      depth -= 1;
      if (depth === 0 && open !== null) {
        components.push(open);
        open = null;
      }
    }
  }
  return { own, components };
}

/** The series' own component's lines (the VEVENT without a RECURRENCE-ID), unfolded. */
const masterOf = (text: string): string[] =>
  partsOf(text.replace(/\r\n[ \t]/g, "")).components.find((c) => c.name === "VEVENT" && !c.lines.some((l) => /^RECURRENCE-ID[;:]/.test(l)))!.lines;

/** The days a text holds, as the calendar core expands them: each start, as a moment in UTC or a whole day. */
function daysOf(text: string): string[] {
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok) throw new Error("the core does not read the text");
  const zones = zonesOf(read.calendar, ZONES);
  return seriesOf(read.calendar.events, zones).flatMap((s) => {
    const found = expandSeries(s, { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2031, 0, 1), viewerZone: "Etc/UTC" }, zones);
    if (found.capped) throw new Error("the series did not expand whole");
    return found.occurrences.map((o) => (o.start.kind === "date"
      ? `${o.start.year}-${String(o.start.month).padStart(2, "0")}-${String(o.start.day).padStart(2, "0")}`
      : new Date(momentOrUtc(o.start, zones)).toISOString()));
  }).sort();
}

const zoned = (value: string, zone: string) => ({ kind: "zoned", value, zone });
const on = (row: { id: string; updatedAt: Date }) => ({ eventId: row.id, base: row.updatedAt.toISOString() });

/** A request's body with what moves from run to run told by name: its stamps, and a new member's own name. */
const steady = (body: string | null): string | null => body === null ? null : body
  .replace(/^(DTSTAMP|LAST-MODIFIED):\d{8}T\d{6}Z$/gm, "$1:<now>")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<the write's own>");
/** The series' end as the writer writes it, from the text the press was made on: its rule ended there, its counter of versions on one, its stamps now. */
const endedFrom = (text: string, rule: string): string => {
  const lines = text.split("\r\n");
  const out: string[] = [];
  let modified = false;
  for (const l of lines) {
    if (l.startsWith("RRULE:")) out.push(rule);
    else if (l.startsWith("SEQUENCE:")) out.push(`SEQUENCE:${Number(l.slice(9)) + 1}`);
    else if (l.startsWith("DTSTAMP:")) out.push("DTSTAMP:<now>");
    else if (l.startsWith("LAST-MODIFIED:")) {
      out.push("LAST-MODIFIED:<now>");
      modified = true;
    } else if (l === "END:VEVENT" && !modified) out.push("LAST-MODIFIED:<now>", l);
    else out.push(l);
  }
  return out.join("\r\n");
};
/**
 * The new series the days from 14 December on become, as the writer makes it from the series' own component in the text the
 * press was made on (one event, short lines): its lines in their order, its name, stamps, times, repeat, excluded days and title
 * anew, its counter of versions and its old excluded days left out; the zone the text defines.
 */
const madeOf = (text: string, o: { readonly rule: string; readonly exdates?: readonly string[] }): string => {
  const lines = text.split("\r\n");
  const zone = lines.slice(lines.indexOf("BEGIN:VTIMEZONE"), lines.indexOf("END:VTIMEZONE") + 1);
  const own = lines.slice(lines.indexOf("BEGIN:VEVENT") + 1, lines.indexOf("END:VEVENT"));
  const event: string[] = [];
  for (const l of own) {
    if (l.startsWith("UID:")) event.push("UID:<the write's own>");
    else if (l.startsWith("DTSTAMP:")) event.push("DTSTAMP:<now>");
    else if (l.startsWith("DTSTART;")) event.push(`DTSTART;TZID=${ZH}:20261214T090000`);
    else if (l.startsWith("DTEND;")) event.push(`DTEND;TZID=${ZH}:20261214T100000`);
    else if (l.startsWith("RRULE:")) event.push(`RRULE:${o.rule}`, ...(o.exdates ?? []));
    else if (l.startsWith("SUMMARY:")) event.push("SUMMARY:The new term");
    else if (l.startsWith("LAST-MODIFIED:")) event.push("LAST-MODIFIED:<now>");
    else if (!/^(SEQUENCE|CREATED|EXDATE)[;:]/.test(l)) event.push(l);
  }
  if (!event.includes("LAST-MODIFIED:<now>")) event.push("LAST-MODIFIED:<now>");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//calendar//EN", ...zone, "BEGIN:VEVENT", ...event, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
};

function isLegacySplit(body: unknown): boolean {
  const act = body as { kind?: string; scope?: { kind?: string }; audience?: unknown } | null;
  return act?.kind === "calendar_event_update" && act.scope?.kind === "following" && act.audience === undefined;
}

describe.skipIf(!AVAILABLE)("a press on a series, from the door to the server", () => {
  let w: World;
  const servers: StandIn[] = [];
  beforeAll(async () => { w = await openWorld(6); }, 120_000);
  afterAll(async () => {
    for (const s of servers) await s.close();
    await w?.close();
  });

  /**
   * A CalDAV account at its own stand-in, read once, whose turns run the drain as the worker composes
   * it with the real writer. By default the stand-in is taken as the server the bench's proof was run
   * at (its row is the bench's).
   */
  async function bench(members: Record<string, string>, o: {
    readonly autoSchedule?: boolean; readonly nativeMove?: boolean; readonly mailboxes?: readonly string[]; readonly proven?: ProvenRepeats;
    readonly configure?: (server: StandIn) => void;
    /** The shapes proven at this stand-in's place, in place of the bench's row. */
    readonly shapes?: readonly RepeatShape[];
    readonly currentQueue?: boolean;
    readonly wrap?: (real: CalendarWriter) => CalendarWriter;
    /** Whom the connection signs in as, as its sign-in check stored it. */
    readonly principal?: string | null;
  } = {}) {
    const identity = o.principal?.replace(/^mailto:/i, "");
    const dav = await startCalDavStandIn({
      autoSchedule: o.autoSchedule ?? false,
      nativeMove: o.nativeMove ?? false,
      ...(identity === undefined ? {} : { schedulingAddresses: identity.includes("@") ? [identity] : [] }),
    });
    servers.push(dav);
    // The account's own calendar, as its server says by naming the sign-in its owner: where a server names no owner, a calendar
    // is taken for one shared with the account, whose events by others its write access lets it change.
    const held = dav.addCalendar("studio", { name: "Studio", owner: dav.paths.principal });
    for (const [name, text] of Object.entries(members)) dav.put("studio", name, text, `"${name}-1"`);
    o.configure?.(dav);
    const serverUrl = `http://127.0.0.1:${dav.port}${dav.paths.start}`;
    const boxes = o.mailboxes ?? [];
    const t = await seedConnection(w, {
      provider: "caldav", credential: { kind: "basic", user: dav.options.user, password: new Secret(dav.options.password) }, serverUrl,
      ...(boxes.length === 0 ? {} : { mailboxAddress: boxes[0]! }),
    });
    for (const address of boxes.slice(1)) await w.db.insert(mailboxes).values({ accountId: t.accountId, provider: "imap", address, status: "connected" });
    const real = makeCalendarProviders({
      clock: { now: () => Date.now() }, zones: ZONES, resolver: NOBODY, policy: { kind: "own-network" }, enabled: new Set(["caldav"]), microsoft: null, writes: true,
    }).get("caldav")!;
    const provider: CalendarProvider = { ...real, writer: (o.wrap ?? ((x) => x))(real.writer!) };
    const proven = o.proven ?? { [proofPlaceOf("caldav", serverUrl)!]: o.shapes ?? PROVEN_REPEATS[BENCH_CALDAV_PLACE]! };
    const drain = calendarWriteDrain({ clock: { now: () => Date.now() }, zones: ZONES, log: capturedLog().log, proven });
    const withDrain = depsFor(w, providersOf({ caldav: provider }), { drainWrites: drain });
    // One memory for both, as the worker keeps it: the listing is asked again on its own hour, not by the first turn that drains.
    const readingOnly = depsFor(w, providersOf({ caldav: provider }), { memory: withDrain.memory });
    const due = async () => {
      await w.db.update(calCalendars).set({ nextPollAt: null }).where(eq(calCalendars.accountId, t.accountId));
      await w.db.update(calConnections).set({ nextPollAt: null }).where(eq(calConnections.accountId, t.accountId));
      await w.db.update(calWrites).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(and(eq(calWrites.accountId, t.accountId), eq(calWrites.state, "pending")));
    };
    expect((await calendarSyncPass(readingOnly, t.due, never)).kind).toBe("synced");
    const memberUrl = (name: string, slug = "studio") => `http://127.0.0.1:${dav.port}${dav.paths.member(slug, name)}`;
    const ctx = (): ServiceContext => ({ db: dbFor(w.db as unknown as ServicesDb, t.accountId), accountId: t.accountId, userId: null, now: () => new Date(), requestId: `sd-${randomUUID().slice(0, 8)}` });
    return {
      dav, t,
      access: async (owned: boolean) => {
        held.owner = owned ? dav.paths.principal : null;
        readingOnly.memory.listedAt.clear();
        await due();
        return (await calendarSyncPass(readingOnly, t.due, never)).kind;
      },
      /** One whole turn: the drain, then the reading. */
      turn: async () => { await due(); return (await calendarSyncPass(withDrain, t.due, never)).kind; },
      /** One whole turn on a signal of the caller's: the worker's stop, or the turn's own time run out. */
      turnOn: async (signal: AbortSignal) => { await due(); return (await calendarSyncPass(withDrain, t.due, signal)).kind; },
      /** A turn without the drain: a reading alone. */
      read: async () => { await due(); return (await calendarSyncPass(readingOnly, t.due, never)).kind; },
      /** The stored rows of a member: the series' own first. */
      rows: (name: string, slug?: string) => w.db.select({ id: calEvents.id, updatedAt: calEvents.updatedAt, recurrenceId: calEvents.recurrenceId })
        .from(calEvents).where(and(eq(calEvents.accountId, t.accountId), eq(calEvents.providerId, memberUrl(name, slug)))).orderBy(asc(calEvents.recurrenceId)),
      /** The press as the door takes it: its receipt's state and word, or the door's refusal. */
      door: async (key: string, act: unknown): Promise<string> => {
        try {
          const r = await recordCalendarWrite(ctx(), key, act, { proven });
          // Preserve the queue format the legacy recovery journeys exercise.
          if (!o.currentQueue && r.seq !== null && isLegacySplit(act)) {
            await w.db.update(calWrites).set({ payload: sql`${calWrites.payload} #- '{part,from,confirmed}'` })
              .where(and(eq(calWrites.accountId, t.accountId), eq(calWrites.idempotencyKey, `${key}:2`)));
          }
          return `${r.answer.write?.state}${r.answer.write?.reason == null ? "" : ` ${r.answer.write.reason}`}`;
        } catch (err) {
          if (err instanceof ServiceError) return `${err.httpStatus} ${err.code}`;
          throw err;
        }
      },
      /** The retry route on the write of this key: its receipt's state, or the route's refusal. */
      retry: async (key: string): Promise<string> => {
        const [row] = await w.db.select({ id: calWrites.id }).from(calWrites).where(and(eq(calWrites.accountId, t.accountId), eq(calWrites.idempotencyKey, key)));
        if (row === undefined) return "(no such write)";
        try {
          return (await retryCalendarWrite(ctx(), row.id)).answer.write?.state ?? "(none)";
        } catch (err) {
          if (err instanceof ServiceError) return `${err.httpStatus} ${err.code}`;
          throw err;
        }
      },
      /** The letting go of the write of this key: done, or the route's refusal. */
      dismiss: async (key: string): Promise<string> => {
        const [row] = await w.db.select({ id: calWrites.id }).from(calWrites).where(and(eq(calWrites.accountId, t.accountId), eq(calWrites.idempotencyKey, key)));
        if (row === undefined) return "(no such write)";
        try {
          await dismissCalendarWrite(ctx(), row.id);
          return "let go";
        } catch (err) {
          if (err instanceof ServiceError) return `${err.httpStatus} ${err.code}`;
          throw err;
        }
      },
      /** The change log's rows for one event's record, in order: what tells a device its record (and its marks) changed. */
      changes: async (eventId: string) => (await w.db.select({ op: changeLog.op }).from(changeLog)
        .where(and(eq(changeLog.accountId, t.accountId), eq(changeLog.entityId, eventId))).orderBy(asc(changeLog.seq))).map((r) => r.op),
      /** Every write of the account recorded this many hours earlier than it was (their order kept). */
      age: (hours: number) => w.db.update(calWrites).set({ createdAt: sql`${calWrites.createdAt} - make_interval(hours => ${hours})` }).where(eq(calWrites.accountId, t.accountId)),
      /** A row recorded past the door, as the store's own parser takes it. */
      plant: (key: string, act: unknown, more: { readonly after?: string; readonly part?: CalendarWritePayload["part"] } = {}) =>
        recordWrite(w, { accountId: t.accountId, key, act, ...more }),
      writes: async () => (await w.db.select({ key: calWrites.idempotencyKey, state: calWrites.state, refusal: calWrites.refusal })
        .from(calWrites).where(eq(calWrites.accountId, t.accountId))
        .orderBy(asc(calWrites.createdAt), asc(sql`coalesce((${calWrites.payload}->'part'->>'n')::int, 1)`), asc(calWrites.idempotencyKey)))
        .map((r) => `${r.key} ${r.state}${r.refusal === null ? "" : ` ${r.refusal}`}`),
      /** Every write of the account with the attempts counted for it. */
      counted: async () => (await w.db.select({ key: calWrites.idempotencyKey, state: calWrites.state, refusal: calWrites.refusal, attempts: calWrites.attempts })
        .from(calWrites).where(eq(calWrites.accountId, t.accountId))
        .orderBy(asc(calWrites.createdAt), asc(sql`coalesce((${calWrites.payload}->'part'->>'n')::int, 1)`), asc(calWrites.idempotencyKey)))
        .map((r) => `${r.key} ${r.state}${r.refusal === null ? "" : ` ${r.refusal}`} attempts=${r.attempts}`),
      /** The writing requests the server received from `from` on: method, member (the press's own, or a new one), preconditions, and the body whole. */
      sent: (from: number, member: string) => dav.seen.slice(from).filter((s) => !["PROPFIND", "REPORT", "GET", "OPTIONS"].includes(s.method)).map((s) => ({
        method: s.method, member: decodeURIComponent(s.path.split("/").pop() ?? "") === member ? member : "a new member",
        ifMatch: s.headers["if-match"] ?? null, ifNoneMatch: s.headers["if-none-match"] ?? null, body: s.body,
      })),
      /** The members the server holds now, by name. */
      held: () => new Map([...held.members].map(([name, m]) => [name, m.ics] as const)),
      feed: (ids: readonly string[]) => CALENDAR_BUILDERS.calendar_event(ctx().db, t.accountId, ids),
      calendarId: async (slug = "studio") => (await w.db.select({ id: calCalendars.id }).from(calCalendars).where(and(
        eq(calCalendars.accountId, t.accountId), eq(calCalendars.providerId, `http://127.0.0.1:${dav.port}${dav.paths.collection(slug)}`),
      )))[0]!.id,
    };
  }

  it("edits a guestless annual all-day event on a calendar shared with write access", async () => {
    const b = await bench({ anniversary: memberText({
      uid: "annual-reminder", tz: null, start: "20261226", end: "20261227", rule: "FREQ=YEARLY", summary: "Annual reminder",
    }) });
    expect(await b.access(false)).toBe("synced");
    const [calendar] = await w.db.select({ access: calCalendars.access }).from(calCalendars)
      .where(eq(calCalendars.accountId, b.t.accountId));
    expect(calendar?.access).toBe("writer");
    const [row] = await b.rows("anniversary");
    expect(await b.door("change-annual-reminder", {
      kind: "calendar_event_update", ...on(row!), scope: { kind: "record" },
      audience: { organizer: null, guests: [] }, change: { title: "Updated annual reminder" },
    })).toBe("pending");
    expect(await b.turn()).toBe("synced");
    expect(b.dav.seen.filter(({ method }) => method === "PUT")).toEqual([
      expect.objectContaining({ body: expect.stringContaining("SUMMARY:Updated annual reminder") }),
    ]);
    expect(await b.read()).toBe("synced");
    const [record] = await w.db.select({ title: calEvents.title, repeat: calEvents.repeatRule }).from(calEvents)
      .where(eq(calEvents.id, row!.id));
    expect(record).toEqual({ title: "Updated annual reminder", repeat: "FREQ=YEARLY" });
  });

  it("moves a guestless annual event from a write-share using the provider's native move", async () => {
    const annual = memberText({
      uid: "annual-move", tz: null, start: "20261226", end: "20261227", rule: "FREQ=YEARLY", summary: "Annual reminder",
    });
    const b = await bench({}, { nativeMove: true, proven: {}, configure(dav) {
      dav.addCalendar("shared", { owner: "/dav/principals/another/", privileges: ["read", "write-content", "bind", "unbind"] });
      dav.put("shared", "anniversary", annual);
    } });
    const [row] = await b.rows("anniversary", "shared");
    expect(await b.door("move-annual-reminder", {
      kind: "calendar_event_move", ...on(row!), toCalendarId: await b.calendarId(),
      audience: { organizer: null, guests: [] },
    })).toBe("pending");
    expect(await b.turn()).toBe("synced");
    expect(b.dav.seen.filter(({ method }) => method === "MOVE")).toEqual([
      expect.objectContaining({ path: b.dav.paths.member("shared", "anniversary") }),
    ]);
    expect(await b.read()).toBe("synced");
    expect(await b.rows("anniversary", "shared")).toHaveLength(0);
    expect(await b.rows("anniversary")).toHaveLength(1);
    expect(b.held().get("anniversary")).toBe(annual);
  });

  it("creates, answers and deletes through the provider while read shares and subscriptions refuse writes", async () => {
    const identity = ["guest", "example.test"].join("@");
    const organizer = ["host", "example.test"].join("@");
    const invitation = memberText({
      uid: "provider-invitation", tz: null, start: "20261226", end: "20261227", rule: "FREQ=YEARLY", summary: "A meeting",
      more: [`ORGANIZER:mailto:${organizer}`, `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${identity}`],
    }).replace("RRULE:FREQ=YEARLY\r\n", "");
    const b = await bench({}, { autoSchedule: true, principal: identity, configure(dav) {
      dav.addCalendar("shared", { owner: "/dav/principals/another/" });
      dav.addCalendar("reader", { owner: "/dav/principals/another/", privileges: ["read"] });
      dav.addCalendar("subscription", { kind: "subscribed", owner: dav.paths.principal });
      dav.put("shared", "invitation", invitation);
    } });
    const calendars = await w.db.select({ id: calCalendars.id, access: calCalendars.access }).from(calCalendars)
      .where(eq(calCalendars.accountId, b.t.accountId));
    const feed = await CALENDAR_BUILDERS.calendar(dbFor(w.db as unknown as ServicesDb, b.t.accountId),
      b.t.accountId, calendars.map(({ id }) => id));
    expect([...feed.values()].map(({ access }) => access).sort()).toEqual(["owner", "reader", "reader", "writer"]);
    await w.db.update(calConnections).set({ status: "failing", errorCode: null }).where(eq(calConnections.accountId, b.t.accountId));
    const create = async (slug: string) => b.door(`create-${slug}`, {
      kind: "calendar_event_create", eventId: randomUUID(), calendarId: await b.calendarId(slug), event: {
        title: `A new event in ${slug}`, start: { kind: "date", value: "20261226" }, end: { kind: "date", value: "20261227" },
        busy: true, private: false, notes: null, place: null, callLink: null, repeat: null, invitees: [], alarms: [],
      },
    });
    expect(await create("reader")).toBe("409 calendar_read_only");
    expect(await create("subscription")).toBe("409 calendar_read_only");
    expect(await create("studio")).toBe("pending");
    expect(await create("shared")).toBe("pending");
    const [invited] = await b.rows("invitation", "shared");
    expect(await b.door("answer-invitation", {
      kind: "calendar_event_answer", ...on(invited!), scope: { kind: "record" }, answer: "accepted",
    })).toBe("pending");
    expect(await b.turn()).toBe("synced");
    const writes = b.dav.seen.filter(({ method }) => method === "PUT");
    expect(writes.map(({ body }) => body)).toEqual(expect.arrayContaining([
      expect.stringContaining("SUMMARY:A new event in studio"),
      expect.stringContaining("SUMMARY:A new event in shared"),
      expect.stringContaining("PARTSTAT=ACCEPTED"),
    ]));
    expect(writes).toHaveLength(3);
    expect(await b.read()).toBe("synced");
    expect((await b.feed([invited!.id])).get(invited!.id)?.myAnswer).toBe("accepted");
    const [created] = await w.db.select({ id: calEvents.id, updatedAt: calEvents.updatedAt }).from(calEvents)
      .where(and(eq(calEvents.accountId, b.t.accountId), eq(calEvents.title, "A new event in shared")));
    expect(await b.door("delete-from-share", {
      kind: "calendar_event_delete", ...on(created!), scope: { kind: "record" },
    })).toBe("pending");
    expect(await b.turn()).toBe("synced");
    expect(b.dav.seen.filter(({ method }) => method === "DELETE")).toEqual([
      expect.objectContaining({ path: expect.stringContaining(b.dav.paths.collection("shared")) }),
    ]);
    expect(await b.read()).toBe("synced");
    expect((await b.feed([created!.id])).has(created!.id)).toBe(false);
  });

  it("restores the CalDAV subscription explanation on relisting an existing reader", async () => {
    const b = await bench({});
    const subscription = b.dav.addCalendar("subscription", { privileges: ["read"] });
    b.dav.addCalendar("reader", { privileges: ["read"] });
    expect(await b.access(true)).toBe("synced");
    const id = await b.calendarId("subscription");
    const readerId = await b.calendarId("reader");
    const db = dbFor(w.db as unknown as ServicesDb, b.t.accountId);
    const feed = () => CALENDAR_BUILDERS.calendar(db, b.t.accountId, [id, readerId]);
    expect((await feed()).get(id)).toMatchObject({ access: "reader" });
    expect((await feed()).get(id)).not.toHaveProperty("subscribed");
    const priorChanges = await b.changes(id);

    subscription.kind = "subscribed";
    expect(await b.access(true)).toBe("synced");
    expect(await b.calendarId("subscription")).toBe(id);
    const refreshed = await feed();
    expect(refreshed.get(id)).toMatchObject({ access: "reader", subscribed: true });
    expect(refreshed.get(readerId)).not.toHaveProperty("subscribed");
    expect((await b.changes(id)).slice(priorChanges.length)).toEqual(["update"]);

    subscription.kind = "calendar";
    expect(await b.access(true)).toBe("synced");
    expect((await feed()).get(id)).not.toHaveProperty("subscribed");
  });

  /** Nine Tuesdays at 18:00 in New York, ended by UNTIL told as the last day's own start (as many programs write it). */
  const NINE_TUESDAYS = memberText({
    uid: "d@studio.example.test", tz: NY, start: "20261124T180000", end: "20261124T190000", rule: "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270119T230000Z", summary: "D new york",
  });
  /** Ten days at 09:00 in Zurich, ended by UNTIL told as the last day's own start. */
  const TEN_DAYS = memberText({
    uid: "d2b@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=DAILY;UNTIL=20261202T080000Z", summary: "Ten days, daily",
  });
  /** What a change of the series' times rewrites in its own component, and nothing else. */
  const unchanged = (l: string) => !/^(DTSTART|DTEND|DTSTAMP|SEQUENCE|LAST-MODIFIED|RRULE)[;:]/.test(l);

  it.each(["occurrence", "record", "following"] as const)("writes %s from the exact reviewed CalDAV exception", async (kind) => {
    const at = String(Date.UTC(2026, 11, 15, 23));
    const original = memberText({
      uid: "weekly-clay", tz: NY, start: "20261124T180000", end: "20261124T190000",
      rule: "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270119T230000Z", summary: "Weekly clay",
      days: [{ was: "20261215T180000", start: "20261215T200000", end: "20261215T210000", summary: "Moved lesson" }],
    }).replace("SUMMARY:Moved lesson", "SUMMARY:Moved lesson\r\nDESCRIPTION:Keep the exception note");
    const b = await bench({ "scope.ics": original }, { shapes: [], currentQueue: true });
    const [master, child] = await b.rows("scope.ics");
    expect(child?.recurrenceId).toBe(at);
    const from = b.dav.seen.length;
    const scope = kind === "record" ? { kind } : kind === "occurrence" ? { kind, at } : { kind, at, newEventId: randomUUID() };
    const act = { kind: "calendar_event_update", eventId: child!.id, scope,
      base: kind === "occurrence" ? child!.updatedAt.toISOString() : `${child!.updatedAt.toISOString()}/${master!.updatedAt.toISOString()}`,
      audience: { organizer: null, guests: [] }, change: { title: "Reviewed lesson" } };
    expect(await b.door("reviewed", act)).toBe("pending");
    expect(await b.turn()).toBe("synced");
    const sent = b.sent(from, "scope.ics");
    if (kind === "following") {
      expect(await b.writes()).toEqual(["reviewed applied", "reviewed:2 applied"]);
      expect(sent.map((request) => [request.method, request.member, request.ifMatch, request.ifNoneMatch])).toEqual([
        ["PUT", "a new member", null, "*"], ["PUT", "scope.ics", '"scope.ics-1"', null],
      ]);
      expect(daysOf(sent[0]!.body)).toEqual(daysOf(NINE_TUESDAYS).slice(3));
      expect(sent[1]!.body).not.toContain("RECURRENCE-ID");
      expect(await b.rows("scope.ics")).toHaveLength(1);
    } else {
      expect(await b.writes()).toEqual(["reviewed applied"]);
      expect(sent.map((request) => [request.method, request.member, request.ifMatch])).toEqual([
        ["PUT", "scope.ics", '"scope.ics-1"'],
      ]);
      const components = partsOf(sent[0]!.body).components.filter((component) => component.name === "VEVENT");
      expect(components).toHaveLength(2);
      expect(components[0]!.lines).toContain(kind === "record" ? "SUMMARY:Reviewed lesson" : "SUMMARY:Weekly clay");
      expect(components[1]!.lines).toEqual(expect.arrayContaining([
        "SUMMARY:Reviewed lesson", "DESCRIPTION:Keep the exception note", "DTSTART;TZID=America/New_York:20261215T200000",
      ]));
    }
    expect(await b.door("reviewed", act)).toBe("applied");
    expect(await b.turn()).toBe("synced");
    expect(b.sent(from, "scope.ics")).toEqual(sent);
  });

  describe("a new time for a series that ends on a day (UNTIL)", () => {
    it("moves the series' end with its start: nine Tuesdays at 18:00 become nine at 19:00, 19 January among them", async () => {
      const b = await bench({ "d.ics": NINE_TUESDAYS });
      const [series] = await b.rows("d.ics");
      const from = b.dav.seen.length;
      expect(await b.door("later", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { start: zoned("20261124T190000", NY), end: zoned("20261124T200000", NY) },
      })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["later applied"]);
      const sent = b.sent(from, "d.ics");
      expect(sent.map((s) => [s.method, s.member, s.ifMatch, s.ifNoneMatch])).toEqual([["PUT", "d.ics", '"d.ics-1"', null]]);
      // Outside the series' times: the calendar's own lines, the zone and the series' other lines as they were.
      expect(partsOf(sent[0]!.body).own).toEqual(partsOf(NINE_TUESDAYS).own);
      expect(partsOf(sent[0]!.body).components.filter((c) => c.name !== "VEVENT")).toEqual(partsOf(NINE_TUESDAYS).components.filter((c) => c.name !== "VEVENT"));
      expect(masterOf(sent[0]!.body).filter(unchanged)).toEqual(masterOf(NINE_TUESDAYS).filter(unchanged));
      // Its end moved with it: 19 January at 19:00 in New York is 00:00 UTC on the 20th.
      expect(masterOf(sent[0]!.body).find((l) => l.startsWith("RRULE"))).toBe("RRULE:FREQ=WEEKLY;UNTIL=20270120T000000Z;BYDAY=TU");
      expect(daysOf(sent[0]!.body)).toEqual(daysOf(NINE_TUESDAYS).map((d) => new Date(Date.parse(d) + 3_600_000).toISOString()));
      expect(daysOf(b.held().get("d.ics")!).length).toBe(9);
    });

    it("keeps ten days at 09:00 in Zurich ten at 10:00", async () => {
      const b = await bench({ "d2b.ics": TEN_DAYS });
      const [series] = await b.rows("d2b.ics");
      const from = b.dav.seen.length;
      expect(await b.door("later", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { start: zoned("20261123T100000", ZH), end: zoned("20261123T110000", ZH) },
      })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      const sent = b.sent(from, "d2b.ics");
      expect(sent.map((s) => [s.method, s.member, s.ifMatch])).toEqual([["PUT", "d2b.ics", '"d2b.ics-1"']]);
      expect(masterOf(sent[0]!.body).find((l) => l.startsWith("RRULE"))).toBe("RRULE:FREQ=DAILY;UNTIL=20261202T090000Z");
      expect(daysOf(sent[0]!.body)).toEqual(daysOf(TEN_DAYS).map((d) => new Date(Date.parse(d) + 3_600_000).toISOString()));
    });

    it("moves the new series' end with a new time when the days from one on go to a series of their own: nine become three and six", async () => {
      const b = await bench({ "d.ics": NINE_TUESDAYS });
      const [series] = await b.rows("d.ics");
      const from = b.dav.seen.length;
      expect(await b.door("term", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 15, 23)), newEventId: randomUUID() },
        change: { start: zoned("20261215T190000", NY), end: zoned("20261215T200000", NY) },
      })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term applied", "term:2 applied"]);
      const sent = b.sent(from, "d.ics");
      expect(sent.map((s) => [s.method, s.member, s.ifMatch, s.ifNoneMatch])).toEqual([["PUT", "d.ics", '"d.ics-1"', null], ["PUT", "a new member", null, "*"]]);
      expect(daysOf(sent[0]!.body).length).toBe(3);
      expect(masterOf(sent[1]!.body).find((l) => l.startsWith("RRULE"))).toBe("RRULE:FREQ=WEEKLY;UNTIL=20270120T000000Z;BYDAY=TU");
      expect(daysOf(sent[1]!.body)).toEqual(daysOf(NINE_TUESDAYS).slice(3).map((d) => new Date(Date.parse(d) + 3_600_000).toISOString()));
    });

    it.each([false, true])("creates the continuation before shortening the series and deduplicates Save (explicit audience: %s)", async (confirmAudience) => {
      const b = await bench({ "d.ics": NINE_TUESDAYS }, { ...(confirmAudience ? { shapes: [] } : {}), currentQueue: true });
      const [series] = await b.rows("d.ics");
      const from = b.dav.seen.length;
      const act = {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 15, 23)), newEventId: randomUUID() },
        change: { title: "Updated term" }, ...(confirmAudience ? { audience: { organizer: null, guests: [] } } : {}),
      };
      expect(await b.door("confirmed", act)).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["confirmed applied", "confirmed:2 applied"]);
      const sent = b.sent(from, "d.ics");
      expect(sent.map((s) => [s.method, s.member, s.ifMatch, s.ifNoneMatch])).toEqual([
        ["PUT", "a new member", null, "*"], ["PUT", "d.ics", '"d.ics-1"', null],
      ]);
      expect(daysOf(sent[0]!.body)).toEqual(daysOf(NINE_TUESDAYS).slice(3));
      expect(daysOf(sent[1]!.body)).toEqual(daysOf(NINE_TUESDAYS).slice(0, 3));
      expect(b.held().size).toBe(2);
      expect(await b.door("confirmed", act)).toBe("applied");
      expect(await b.turn()).toBe("synced");
      expect(b.sent(from, "d.ics")).toEqual(sent);
    });

    it("refuses a new start on another day with no repeat named, at the door and past it, and the server is asked nothing", async () => {
      const b = await bench({ "d2b.ics": TEN_DAYS });
      const [series] = await b.rows("d2b.ics");
      const whole = { kind: "calendar_event_update", ...on(series!), scope: { kind: "record" }, change: { start: zoned("20261124T090000", ZH), end: zoned("20261124T100000", ZH) } };
      const newEventId = randomUUID();
      const split = {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 10, 26, 8)), newEventId },
        change: { start: zoned("20261127T090000", ZH), end: zoned("20261127T100000", ZH) },
      };
      // Where the last day went would be a guess: the person names the repeat, with its end.
      expect([await b.door("whole", whole), await b.door("split", split)]).toEqual(["400 validation_failed", "400 validation_failed"]);
      expect(await b.writes()).toEqual([]);
      const from = b.dav.seen.length;
      await b.plant("whole", whole);
      const first = await b.plant("split", split, { part: { of: "split", n: 1 } });
      await b.plant("split:2", {
        kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(),
        event: {
          title: "Ten days, daily", start: zoned("20261127T090000", ZH), end: zoned("20261127T100000", ZH), notes: null, place: null, callLink: null, busy: true, private: false,
          repeat: "FREQ=DAILY;UNTIL=20261202T080000Z", invitees: [], alarms: [],
        },
      }, { after: first.id, part: { of: "split", n: 2, from: { eventId: series!.id, at: String(Date.UTC(2026, 10, 26, 8)), named: [] } } });
      expect(await b.turn()).toBe("synced");
      expect(b.sent(from, "d2b.ics").map((s) => [s.method, s.member])).toEqual([]);
      expect(await b.writes()).toEqual(["whole refused repeat_unsupported", "split refused content_refused", "split:2 refused earlier_refused"]);
    });

    it("refuses a second part recorded past the door that keeps the series' end where its new time would lose a day; neither part is sent", async () => {
      const b = await bench({ "d.ics": NINE_TUESDAYS });
      const [series] = await b.rows("d.ics");
      const newEventId = randomUUID();
      const first = await b.plant("term", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 15, 23)), newEventId },
        change: { start: zoned("20261215T190000", NY), end: zoned("20261215T200000", NY) },
      }, { part: { of: "term", n: 1 } });
      await b.plant("term:2", {
        kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(),
        event: {
          title: "D new york", start: zoned("20261215T190000", NY), end: zoned("20261215T200000", NY), notes: null, place: null, callLink: null, busy: true, private: false,
          repeat: "FREQ=WEEKLY;UNTIL=20270119T230000Z;BYDAY=TU", invitees: [], alarms: [],
        },
      }, { after: first.id, part: { of: "term", n: 2, from: { eventId: series!.id, at: String(Date.UTC(2026, 11, 15, 23)), named: [] } } });
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(b.sent(from, "d.ics").map((s) => [s.method, s.member])).toEqual([]);
      expect(await b.writes()).toEqual(["term refused content_refused", "term:2 refused earlier_refused"]);
    });
  });

  describe("the days from one on, as a series of their own, made from the series' own component", () => {
    /** Ten Mondays at 09:00 in Zurich, 28 December excluded, with lines no reader has a field for and an alarm by mail. */
    const TEN_MONDAYS = memberText({
      uid: "a@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "A weekly",
      excluded: ["20261228T090000"],
      more: [
        "DESCRIPTION:Bring the glaze notes", "LOCATION:Studio 2", "CATEGORIES:KILN,STUDIO", "ATTACH:https://files.example.test/kiln-plan.pdf", "PRIORITY:3",
        "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M", "END:VALARM",
        "BEGIN:VALARM", "ACTION:EMAIL", "SUMMARY:Kiln", "DESCRIPTION:Kiln", "ATTENDEE:mailto:mila@studio.example.test", "TRIGGER:-P1D", "END:VALARM",
      ],
      days: [
        { was: "20261130T090000", start: "20261130T140000", end: "20261130T150000", summary: "A moved" },
        { was: "20270111T090000", start: "20270111T090000", end: "20270111T100000", summary: "A retitled" },
      ],
    });
    /** What a new series of the days writes anew in the series' own component; every other line (an alarm's whole) is carried as it is. */
    const anew = (l: string) => /^(UID|DTSTAMP|DTSTART|DTEND|RRULE|EXDATE|SEQUENCE|CREATED|LAST-MODIFIED|SUMMARY)[;:]/.test(l);
    const carriedOf = (lines: readonly string[]): string[] => {
      let depth = 0;
      return lines.filter((l) => {
        if (l.startsWith("BEGIN:") && l !== "BEGIN:VEVENT") depth += 1;
        const kept = depth > 0 || !anew(l);
        if (l.startsWith("END:") && l !== "END:VEVENT") depth -= 1;
        return kept;
      });
    };

    it("carries every line of the series, its alarms and the days it excluded from that day on; writes anew its name, times, repeat and title", async () => {
      const b = await bench({ "a.ics": TEN_MONDAYS });
      const [series] = await b.rows("a.ics");
      const from = b.dav.seen.length;
      expect(await b.door("term", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId: randomUUID() },
        change: { title: "A weekly, new term" },
      })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term applied", "term:2 applied"]);
      const sent = b.sent(from, "a.ics");
      expect(sent.map((s) => [s.method, s.member, s.ifMatch, s.ifNoneMatch])).toEqual([["PUT", "a.ics", '"a.ics-1"', null], ["PUT", "a new member", null, "*"]]);
      const made = sent[1]!.body;
      // Every line of the series' own component, its alarms among them, is carried byte for byte and in order.
      expect(carriedOf(masterOf(made))).toEqual(carriedOf(masterOf(TEN_MONDAYS)));
      const ownLines = (lines: readonly string[]): string[] => {
        let depth = 0;
        return lines.filter((l) => {
          if (l.startsWith("BEGIN:") && l !== "BEGIN:VEVENT") depth += 1;
          const own = depth === 0;
          if (l.startsWith("END:") && l !== "END:VEVENT") depth -= 1;
          return own;
        });
      };
      expect(ownLines(masterOf(made)).filter((l) => /^(RRULE|EXDATE|SUMMARY|DTSTART|DTEND)[;:]/.test(l))).toEqual([
        `DTSTART;TZID=${ZH}:20261214T090000`, `DTEND;TZID=${ZH}:20261214T100000`, "RRULE:FREQ=WEEKLY;COUNT=7;BYDAY=MO", `EXDATE;TZID=${ZH}:20261228T090000`,
        "SUMMARY:A weekly\\, new term",
      ]);
      // Its own name, made from the write's key; a counter of versions of its own, from none.
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
      expect(masterOf(made).filter((l) => /^(UID|SEQUENCE)[;:]/.test(l)).map((l) => l.replace(uuid, "<the write's own>"))).toEqual(["UID:<the write's own>"]);
      // Its zone is the series' own definition; its changed days are not carried.
      expect(partsOf(made).components.filter((c) => c.name === "VTIMEZONE")).toEqual(partsOf(TEN_MONDAYS).components.filter((c) => c.name === "VTIMEZONE"));
      expect(partsOf(made).components.map((c) => c.name)).toEqual(["VTIMEZONE", "VEVENT"]);
      // No day comes back and none is lost: three before 14 December, six from it (28 December stays excluded).
      expect([daysOf(sent[0]!.body).length, daysOf(made).length]).toEqual([3, 6]);
      expect(daysOf(made).includes("2026-12-28T08:00:00.000Z")).toBe(false);
    });

    it("keeps the excluded days of whole days from that day on: eight days become four and four", async () => {
      const WHOLE = memberText({
        uid: "b@studio.example.test", tz: null, start: "20261123", end: "20261124", rule: "FREQ=DAILY;COUNT=10", summary: "B daily whole days",
        excluded: ["20261126", "20261130"], days: [{ was: "20261125", start: "20261125", end: "20261126", summary: "B changed" }],
      });
      const b = await bench({ "b.ics": WHOLE });
      const [series] = await b.rows("b.ics");
      const from = b.dav.seen.length;
      expect(await b.door("term", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 10, 28)), newEventId: randomUUID() },
        change: { title: "B from the 28th" },
      })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      const sent = b.sent(from, "b.ics");
      expect(sent.map((s) => [s.method, s.member])).toEqual([["PUT", "b.ics"], ["PUT", "a new member"]]);
      expect(masterOf(sent[1]!.body).filter((l) => /^(RRULE|EXDATE)[;:]/.test(l))).toEqual(["RRULE:FREQ=DAILY;COUNT=5", "EXDATE;VALUE=DATE:20261130"]);
      expect([daysOf(WHOLE).length, daysOf(sent[0]!.body).length, daysOf(sent[1]!.body).length]).toEqual([8, 4, 4]);
    });
  });

  describe("a press on a day and the days after it whose new series cannot be made: nothing of it is sent (the recheck's first finding)", () => {
    const MILA = "mila@studio.example.test";
    const GIULIA = "giulia@example.test";
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const DEC_14_DAY = String(Date.UTC(2026, 11, 14));
    const Z = (uid: string, rule: string, more: Partial<Member> = {}): Member =>
      ({ uid: `${uid}@studio.example.test`, tz: ZH, start: "20261123T090000", end: "20261123T100000", rule, summary: "Kiln", ...more });
    const W = (uid: string, rule: string, more: Partial<Member> = {}): Member =>
      ({ uid: `${uid}@studio.example.test`, tz: null, start: "20261123", end: "20261124", rule, summary: "Whole days", ...more });
    /** A series that excludes every fourth Monday by a rule of its own (EXRULE), as some programs still write it. */
    const EXRULE = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//calendar//EN", ...zoneLines(ZH), "BEGIN:VEVENT", "UID:h4@studio.example.test", "DTSTAMP:20261113T120000Z",
      `DTSTART;TZID=${ZH}:20261123T090000`, `DTEND;TZID=${ZH}:20261123T100000`, "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", "EXRULE:FREQ=WEEKLY;INTERVAL=4;BYDAY=MO", "SUMMARY:Kiln",
      "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const dt = (value: string) => ({ kind: "date", value });
    /** The new series' fields as the door records them for the press (the series' own, the change over them, its start, end and repeat as reckoned). */
    const made = (o: { readonly start: unknown; readonly end: unknown; readonly repeat: string; readonly title?: string; readonly invitees?: unknown[] }) => ({
      title: o.title ?? "Kiln", start: o.start, end: o.end, notes: null, place: null, callLink: null, busy: true, private: false, repeat: o.repeat,
      invitees: o.invitees ?? [], alarms: [],
    });
    interface Case {
      readonly name: string;
      readonly text: string;
      readonly at: string;
      readonly change: Record<string, unknown>;
      /** The second part as the door would record it, for the run past the door. */
      readonly second: Record<string, unknown>;
      readonly autoSchedule?: boolean;
      readonly audience?: { organizer: string; guests: string[] };
      /** The drain's word for the first part. */
      readonly word: string;
    }
    const toTuesday = { start: zoned("20261215T090000", ZH), end: zoned("20261215T100000", ZH) };
    const REFUSED: Case[] = [
      {
        name: "weekly with no weekday named, a day after the cut excluded; from 14 December on, moved to Tuesday the 15th",
        text: memberText(Z("h1", "FREQ=WEEKLY;COUNT=10", { excluded: ["20261228T090000"] })), at: DEC_14, change: toTuesday,
        second: made({ ...toTuesday, repeat: "FREQ=WEEKLY;COUNT=7" }), word: "field_unwritable",
      },
      {
        name: "daily, a day after the cut excluded; from 14 December on, a day later",
        text: memberText(Z("h1d", "FREQ=DAILY;COUNT=30", { excluded: ["20261220T090000"] })), at: DEC_14, change: toTuesday,
        second: made({ ...toTuesday, repeat: "FREQ=DAILY;COUNT=9" }), word: "field_unwritable",
      },
      {
        name: "weekly with no weekday named and an invitee, at a server that sends invitations itself; the same day excluded, the same move",
        text: memberText(Z("h1g", "FREQ=WEEKLY;COUNT=10", { excluded: ["20261228T090000"], more: [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`] })),
        at: DEC_14, change: toTuesday, autoSchedule: true, audience: { organizer: MILA, guests: [GIULIA] },
        second: made({ ...toTuesday, repeat: "FREQ=WEEKLY;COUNT=7", invitees: [{ address: GIULIA, name: "Giulia", role: "required" }] }), word: "field_unwritable",
      },
      {
        name: "Mondays, a day after the cut excluded; from 14 December on, Tuesdays (the repeat named)",
        text: memberText(Z("h2", "FREQ=WEEKLY;BYDAY=MO;COUNT=10", { excluded: ["20261228T090000"] })), at: DEC_14, change: { ...toTuesday, repeat: "FREQ=WEEKLY;BYDAY=TU" },
        second: made({ ...toTuesday, repeat: "FREQ=WEEKLY;BYDAY=TU" }), word: "field_unwritable",
      },
      {
        name: "whole days, a day after the cut excluded; from 14 December on at 09:00",
        text: memberText(W("h3", "FREQ=WEEKLY;COUNT=10", { excluded: ["20261228"] })), at: DEC_14_DAY,
        change: { start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH) },
        second: made({ start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), repeat: "FREQ=WEEKLY;COUNT=7", title: "Whole days" }), word: "field_unwritable",
      },
      {
        name: "whole days, a day after the cut excluded; from 14 December on, moved to the 15th",
        text: memberText(W("h3b", "FREQ=WEEKLY;COUNT=10", { excluded: ["20261228"] })), at: DEC_14_DAY, change: { start: dt("20261215"), end: dt("20261216") },
        second: made({ start: dt("20261215"), end: dt("20261216"), repeat: "FREQ=WEEKLY;COUNT=7", title: "Whole days" }), word: "field_unwritable",
      },
      {
        name: "a series that excludes days by a rule (EXRULE); from 14 December on, a new title",
        text: EXRULE, at: DEC_14, change: { title: "The new term" },
        second: made({ start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), repeat: "FREQ=WEEKLY;COUNT=7;BYDAY=MO", title: "The new term" }),
        word: "repeat_unsupported",
      },
      {
        name: "the press's own copy already ends before the day it names (a repeat named for the days after)",
        text: memberText(Z("e1", "FREQ=WEEKLY;UNTIL=20261214T075959Z;BYDAY=MO")), at: DEC_14, change: { title: "The new term", repeat: "FREQ=WEEKLY;BYDAY=MO" },
        second: made({ start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), repeat: "FREQ=WEEKLY;BYDAY=MO", title: "The new term" }),
        word: "event_gone",
      },
    ];

    /** A press recorded past the door, as the door records it: its first part, and its second naming where it comes from. */
    const plant = async (b: Awaited<ReturnType<typeof bench>>, c: Case, series: { id: string; updatedAt: Date }) => {
      const newEventId = randomUUID();
      const first = await b.plant("k", { kind: "calendar_event_update", ...on(series), scope: { kind: "following", at: c.at, newEventId }, change: c.change, ...(c.audience ? { audience: c.audience } : {}) }, { part: { of: "k", n: 1 } });
      const named = ["title", "notes", "place", "callLink", "busy", "private", "alarms"].filter((f) => c.change[f] !== undefined) as "title"[];
      await b.plant("k:2", { kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(), event: c.second }, {
        after: first.id, part: { of: "k", n: 2, from: { eventId: series.id, at: c.at, named, ...(c.audience ? { confirmed: true as const } : {}) } },
      });
    };

    it("refuses each at the door, and past it sends neither part: the series is not ended where the series its days become cannot be made", async () => {
      const seen: Record<string, unknown> = {};
      for (const c of REFUSED) {
        const atDoor = await bench({ "s.ics": c.text }, { autoSchedule: c.autoSchedule ?? false, mailboxes: [MILA] });
        const [series] = await atDoor.rows("s.ics");
        const door = await atDoor.door("term", { kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: c.at, newEventId: randomUUID() }, change: c.change, ...(c.audience ? { audience: c.audience } : {}) });
        const doorTurn = door === "pending" ? await atDoor.turn() : "(no turn)";
        const past = await bench({ "s.ics": c.text }, { autoSchedule: c.autoSchedule ?? false, mailboxes: [MILA] });
        const [planted] = await past.rows("s.ics");
        await plant(past, c, planted!);
        const from = past.dav.seen.length;
        const turn = await past.turn();
        seen[c.name] = {
          door, doorTurn, turn, writes: await past.writes(), written: past.sent(from, "s.ics").map((x) => `${x.method} ${x.member}`),
          asItWas: past.held().get("s.ics") === c.text && past.held().size === 1,
        };
      }
      expect(seen).toEqual(Object.fromEntries(REFUSED.map((c) => [c.name, {
        door: "400 validation_failed", doorTurn: "(no turn)", turn: "synced", writes: [`k refused ${c.word}`, "k:2 refused earlier_refused"], written: [], asItWas: true,
      }])));
    }, 240_000);

    it("still writes both parts where the new series can be made: no excluded day, one only before the day, or a new time or whole days on the day itself", async () => {
      const WRITTEN: { readonly name: string; readonly member: Member; readonly change: Record<string, unknown>; readonly exdates: string[]; readonly days: [number, number, number] }[] = [
        { name: "no excluded day; from 14 December on, moved to Tuesday the 15th (the control)", member: Z("w1", "FREQ=WEEKLY;COUNT=10"), change: toTuesday, exdates: [], days: [10, 3, 7] },
        {
          name: "a day excluded only before the cut; from 14 December on, moved to Tuesday the 15th", member: Z("w2", "FREQ=WEEKLY;COUNT=10", { excluded: ["20261130T090000"] }),
          change: toTuesday, exdates: [], days: [9, 2, 7],
        },
        {
          name: "a day after the cut excluded; from 14 December on, at 11:00 the same day (the excluded day moved with it)",
          member: Z("w3", "FREQ=WEEKLY;BYDAY=MO;COUNT=10", { excluded: ["20261228T090000"] }), change: { start: zoned("20261214T110000", ZH), end: zoned("20261214T120000", ZH) },
          exdates: [`EXDATE;TZID=${ZH}:20261228T110000`], days: [9, 3, 6],
        },
        {
          name: "a day after the cut excluded; from 14 December on, as whole days from that very day",
          member: Z("w4", "FREQ=WEEKLY;BYDAY=MO;COUNT=10", { excluded: ["20261228T090000"] }), change: { start: dt("20261214"), end: dt("20261215") },
          exdates: ["EXDATE;VALUE=DATE:20261228"], days: [9, 3, 6],
        },
      ];
      const seen: Record<string, unknown> = {};
      for (const c of WRITTEN) {
        const text = memberText(c.member);
        const b = await bench({ "s.ics": text }, { mailboxes: [MILA] });
        const [series] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("term", { kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: DEC_14, newEventId: randomUUID() }, change: c.change });
        const turn = door === "pending" ? await b.turn() : "(no turn)";
        const sent = b.sent(from, "s.ics");
        seen[c.name] = {
          door, turn, writes: await b.writes(), requests: sent.map((x) => [x.method, x.member, x.ifMatch === null ? null : "the press's own", x.ifNoneMatch]),
          exdates: sent[1] === undefined ? null : masterOf(sent[1].body).filter((l) => l.startsWith("EXDATE")),
          days: [daysOf(text).length, sent[0] === undefined ? null : daysOf(sent[0].body).length, sent[1] === undefined ? null : daysOf(sent[1].body).length],
        };
      }
      expect(seen).toEqual(Object.fromEntries(WRITTEN.map((c) => [c.name, {
        door: "pending", turn: "synced", writes: ["term applied", "term:2 applied"],
        requests: [["PUT", "s.ics", "the press's own", null], ["PUT", "a new member", null, "*"]], exdates: c.exdates, days: c.days,
      }])));
    }, 120_000);
  });

  describe("whose name the new series goes out under, and whom it asks", () => {
    const MILA = "mila@studio.example.test";
    const MILA_2 = "mila.private@home.example.test";
    const GIULIA = "giulia@example.test";
    /** The organizer and invitee lines of a text's series, unfolded. */
    const peopleOf = (text: string) => masterOf(text).filter((l) => /^(ORGANIZER|ATTENDEE)[;:]/.test(l));
    const split = async (b: Awaited<ReturnType<typeof bench>>, member: string, audience: { organizer: string; guests: string[] }) => {
      const [series] = await b.rows(member);
      return b.door("term", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId: randomUUID() },
        change: { title: "Glaze critique, the new term" }, audience,
      });
    };

    it("keeps the series' own organizer line and the organizer's own line as they are, and asks the other invitees again, whichever mailbox is the account's first", async () => {
      // The account has two mailboxes; the series is organized under the second, its organizer's own line among its invitees.
      const TWO = memberText({
        uid: "critique-2@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze critique",
        more: [`ORGANIZER;CN=Mila:mailto:${MILA_2}`, `ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:mailto:${MILA_2}`, `ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      });
      for (const boxes of [[MILA, MILA_2], [MILA_2, MILA]]) {
        const b = await bench({ "critique.ics": TWO }, { autoSchedule: true, mailboxes: boxes });
        const from = b.dav.seen.length;
        expect(await split(b, "critique.ics", { organizer: MILA_2, guests: [GIULIA] })).toBe("pending");
        expect(await b.turn()).toBe("synced");
        expect(await b.writes()).toEqual(["term applied", "term:2 applied"]);
        const sent = b.sent(from, "critique.ics");
        expect(sent.map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch])).toEqual([["PUT", "a new member", null, "*"], ["PUT", "critique.ics", '"critique.ics-1"', null]]);
        // The series' end leaves its people as they were; the new series goes out under the series' own organizer, its own line not asked.
        expect(peopleOf(sent[1]!.body)).toEqual(peopleOf(TWO));
        expect(peopleOf(sent[0]!.body)).toEqual([
          `ORGANIZER;CN=Mila:mailto:${MILA_2}`, `ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:mailto:${MILA_2}`,
          `ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${GIULIA}`,
        ]);
      }
    });

    it("splits a series with an invitee there for information, or one who chairs it: each line is carried as it is, its role among it, and asked again", async () => {
      const ROLES = memberText({
        uid: "roles@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze critique",
        more: [
          `ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;ROLE=NON-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${GIULIA}`,
          "ATTENDEE;CN=Ben;ROLE=CHAIR;PARTSTAT=TENTATIVE:mailto:ben@example.test",
        ],
      });
      const b = await bench({ "roles.ics": ROLES }, { autoSchedule: true, mailboxes: [MILA] });
      const from = b.dav.seen.length;
      expect(await split(b, "roles.ics", { organizer: MILA, guests: [GIULIA, ["ben", "example.test"].join("@")] })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term applied", "term:2 applied"]);
      const sent = b.sent(from, "roles.ics");
      expect(peopleOf(sent[0]!.body)).toEqual([
        `ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;ROLE=NON-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${GIULIA}`,
        "ATTENDEE;CN=Ben;ROLE=CHAIR;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ben@example.test",
      ]);
    });

    it("splits a series whose organizer's own line chairs it: that line is no invitee of the new series, and stays as it is", async () => {
      const CHAIR = memberText({
        uid: "chair@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze critique",
        more: [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Mila;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      });
      const b = await bench({ "chair.ics": CHAIR }, { autoSchedule: true, mailboxes: [MILA] });
      const from = b.dav.seen.length;
      expect(await split(b, "chair.ics", { organizer: MILA, guests: [GIULIA] })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      const sent = b.sent(from, "chair.ics");
      expect(sent.map((x) => [x.method, x.member])).toEqual([["PUT", "a new member"], ["PUT", "chair.ics"]]);
      expect(peopleOf(sent[0]!.body)).toEqual([
        `ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Mila;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:${MILA}`,
        `ATTENDEE;CN=Giulia;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${GIULIA}`,
      ]);
    });
  });

  describe("someone else's series, the account on it under an address that is no mailbox of its", () => {
    const ANNA = "anna@example.test";
    const GIULIA = "giulia@example.test";
    const MILA = "mila@studio.example.test";
    /** The calendar account's own address, which no mailbox of the account has. */
    const MILA_DAV = "mila@dav.example.test";
    const glaze = (mila: string) => memberText({
      uid: "glaze-group@elsewhere.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze group",
      more: [
        `ORGANIZER;CN=Anna:mailto:${ANNA}`, `ATTENDEE;CN=Anna;PARTSTAT=ACCEPTED:mailto:${ANNA}`, `ATTENDEE;CN=Mila;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${mila}`,
        `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`,
      ],
    });
    const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const acts = (s: { id: string; updatedAt: Date }, newEventId: string): Record<string, unknown> => ({
      retitle: { kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { title: "Glaze group, renamed by an invitee" } },
      "move-a-day": { kind: "calendar_event_update", ...on(s), scope: { kind: "occurrence", at: DEC_7 }, change: { start: zoned("20261207T140000", ZH), end: zoned("20261207T150000", ZH) } },
      "cancel-a-day": { kind: "calendar_event_delete", ...on(s), scope: { kind: "occurrence", at: DEC_7 } },
      remove: { kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } },
      "remove-from-a-day": { kind: "calendar_event_delete", ...on(s), scope: { kind: "following", at: DEC_14 } },
      split: { kind: "calendar_event_update", ...on(s), scope: { kind: "following", at: DEC_14, newEventId }, change: { title: "Glaze group, my way" } },
    });

    it("takes nothing at the door but an answer, and the account is not invited under a mailbox of its: nothing is recorded", async () => {
      const b = await bench({ "glaze.ics": glaze(MILA_DAV) }, { autoSchedule: true, mailboxes: [MILA] });
      const [series] = await b.rows("glaze.ics");
      const said: Record<string, string> = {};
      for (const [key, act] of Object.entries(acts(series!, randomUUID()))) said[key] = await b.door(key, act);
      said.answer = await b.door("answer", { kind: "calendar_event_answer", ...on(series!), scope: { kind: "record" }, answer: "accepted" });
      expect(said).toEqual({
        retitle: "409 calendar_read_only", "move-a-day": "409 calendar_read_only", "cancel-a-day": "409 calendar_read_only", remove: "409 calendar_read_only",
        "remove-from-a-day": "409 calendar_read_only", split: "409 calendar_read_only", answer: "409 calendar_read_only",
      });
      expect(await b.writes()).toEqual([]);
    });

    it("sends nothing of a write recorded past the door on someone else's series: each is refused read_only", async () => {
      const b = await bench({ "glaze.ics": glaze(MILA_DAV) }, { autoSchedule: true, mailboxes: [MILA] });
      const [series] = await b.rows("glaze.ics");
      const newEventId = randomUUID();
      const planted = acts(series!, newEventId);
      for (const key of ["retitle", "move-a-day", "cancel-a-day", "remove", "remove-from-a-day"]) await b.plant(key, planted[key]);
      const first = await b.plant("split", planted.split, { part: { of: "split", n: 1 } });
      await b.plant("split:2", {
        kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(),
        event: {
          title: "Glaze group, my way", start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), notes: null, place: null, callLink: null, busy: true,
          private: false, repeat: "FREQ=WEEKLY;BYDAY=MO", invitees: [{ address: ANNA, name: "Anna", role: "required" }, { address: GIULIA, name: "Giulia", role: "required" }], alarms: [],
        },
      }, { after: first.id, part: { of: "split", n: 2, from: { eventId: series!.id, at: DEC_14, named: ["title"] } } });
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(b.sent(from, "glaze.ics").map((x) => [x.method, x.member])).toEqual([]);
      expect(await b.writes()).toEqual([
        "retitle refused read_only", "move-a-day refused read_only", "cancel-a-day refused read_only", "remove refused read_only",
        "remove-from-a-day refused read_only", "split refused read_only", "split:2 refused earlier_refused",
      ]);
    });

    it("takes the account's answer, and nothing else, where its address on the series is a mailbox of its", async () => {
      const b = await bench({ "glaze.ics": glaze(MILA) }, { autoSchedule: true, mailboxes: [MILA] });
      const [series] = await b.rows("glaze.ics");
      const all = acts(series!, randomUUID());
      expect([await b.door("split", all.split), await b.door("cancel-a-day", all["cancel-a-day"])]).toEqual(["409 calendar_read_only", "409 calendar_read_only"]);
      expect(await b.door("answer", { kind: "calendar_event_answer", ...on(series!), scope: { kind: "record" }, answer: "accepted" })).toBe("pending");
      expect(await b.writes()).toEqual(["answer pending"]);
    });

    it.each([false, true])("declines one ordinary day without changing the other mailbox or neighboring day (reversed: %s)", async (reverse) => {
      const seats = [
        `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${MILA}`,
        `ATTENDEE;PARTSTAT=TENTATIVE:mailto:${MILA_DAV}`,
      ];
      const text = memberText({
        uid: "assembly", tz: ZH, start: "20261123T090000", end: "20261123T100000",
        rule: "FREQ=WEEKLY;COUNT=5", summary: "Assembly",
        more: [`ORGANIZER:mailto:${ANNA}`, ...(reverse ? seats.reverse() : seats)],
      });
      const b = await bench({ "assembly.ics": text }, { autoSchedule: true, mailboxes: [MILA, MILA_DAV], principal: MILA_DAV });
      const [series] = await b.rows("assembly.ics");
      const copy = { calendarId: await b.calendarId(), attendee: MILA_DAV };
      const press = { kind: "calendar_event_answer", ...on(series!), scope: { kind: "occurrence", at: DEC_7 }, answer: "declined", copy };
      const first = b.dav.seen.length;
      expect((await b.feed([series!.id])).get(series!.id)?.myAnswer).toBe("tentative");
      expect(await b.door("decline-one", press)).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.door("decline-one", press)).toBe("applied");
      expect(await b.turn()).toBe("synced");
      const sent = b.sent(first, "assembly.ics");
      expect(sent.map(({ method, member }) => [method, member])).toEqual([["PUT", "assembly.ics"]]);
      const written = partsOf(sent[0]!.body!).components.filter(({ name }) => name === "VEVENT");
      expect(written).toHaveLength(2);
      expect(written[0]!.lines).toEqual(masterOf(text));
      expect(written[1]!.lines.some((line) => line.includes(`PARTSTAT=DECLINED:mailto:${MILA_DAV}`))).toBe(true);
      expect(written[1]!.lines.some((line) => line.includes(`PARTSTAT=ACCEPTED:mailto:${MILA}`))).toBe(true);
      const rows = await b.rows("assembly.ics");
      const feed = await b.feed(rows.map(({ id }) => id));
      expect(rows.map(({ recurrenceId, id }) => [recurrenceId, feed.get(id)?.myAnswer]))
        .toEqual([["", "tentative"], [DEC_7, "declined"]]);
    });

    it("keeps a moved occurrence hidden after the provider restores its original time", async () => {
      const more = [`ORGANIZER:mailto:${ANNA}`, `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${MILA_DAV}`];
      const seriesOf = { uid: "assembly", tz: ZH, start: "20261123T090000", end: "20261123T100000",
        rule: "FREQ=WEEKLY;COUNT=5", summary: "Assembly", more };
      const moved = memberText({ ...seriesOf, days: [{
        was: "20261207T090000", start: "20261207T130000", end: "20261207T140000", summary: "Moved assembly", more,
      }] });
      const b = await bench({ "assembly.ics": moved }, { mailboxes: [MILA_DAV], principal: MILA_DAV });
      const [series, child] = await b.rows("assembly.ics");
      expect(child?.recurrenceId).toBe(DEC_7);
      const from = b.dav.seen.length;
      expect(await b.door("hide-one", { kind: "calendar_event_delete", eventId: child!.id, localOnly: true, hide: true,
        base: `${child!.updatedAt.toISOString()}/${series!.updatedAt.toISOString()}`, scope: { kind: "occurrence", at: DEC_7 },
        copy: { calendarId: await b.calendarId(), attendee: MILA_DAV },
      })).toBe("applied");
      b.dav.put("studio", "assembly.ics", memberText(seriesOf), '"restored"');
      expect(await b.read()).toBe("synced");
      const restored = await b.rows("assembly.ics");
      expect(restored.map(({ id, recurrenceId }) => [id, recurrenceId])).toEqual([[series!.id, ""]]);
      const record = (await b.feed([series!.id])).get(series!.id);
      expect(record).toMatchObject({ hiddenOccurrences: [DEC_7], myAnswer: "accepted", busy: true });
      expect(b.sent(from, "assembly.ics")).toEqual([]);
    });

    it("converges a continuously synced device and one first loaded while access was shared", async () => {
      const more = [`ORGANIZER:mailto:${ANNA}`, `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${MILA_DAV}`];
      const config = { uid: "assembly", tz: ZH, start: "20261123T090000", end: "20261123T100000",
        rule: "FREQ=WEEKLY;COUNT=5", summary: "Assembly", more };
      const masterAndDay = memberText({ ...config, days: [{
        was: "20261207T090000", start: "20261207T130000", end: "20261207T140000", summary: "Moved assembly", more,
      }] });
      const single = memberText({ ...config, uid: "single" }).replace(/^RRULE:.*\r\n/m, "");
      const dateList = memberText({ ...config, uid: "date-list" })
        .replace(/^RRULE:.*\r\n/m, "RDATE;TZID=Europe/Zurich:20261207T090000\r\n");
      const b = await bench({ "series.ics": masterAndDay, "single.ics": single, "dates.ics": dateList },
        { mailboxes: [MILA_DAV], principal: MILA_DAV });
      const [master, child] = await b.rows("series.ics");
      const [standalone] = await b.rows("single.ics");
      const [dates] = await b.rows("dates.ics");
      const ids = [master!.id, child!.id, standalone!.id, dates!.id];
      for (const event of [master!, standalone!, dates!]) {
        expect(await b.door(`hide-${event.id}`, { kind: "calendar_event_delete", ...on(event),
          localOnly: true, hide: true, scope: { kind: "record" },
          copy: { calendarId: await b.calendarId(), attendee: MILA_DAV },
        })).toBe("applied");
      }
      const continuous = await b.feed(ids);
      const owned = [...continuous.values()].filter((record) => record.hiddenOccurrences?.includes("")).map(({ id }) => id).sort();
      expect(owned).toEqual([master!.id, standalone!.id, dates!.id].sort());
      const transition = async (owner: boolean, devices: Awaited<ReturnType<typeof b.feed>>[]) => {
        const account = eq(changeLog.accountId, b.t.accountId);
        const [before] = await w.db.select({ seq: sql<bigint>`max(${changeLog.seq})` }).from(changeLog).where(account);
        expect(await b.access(owner)).toBe("synced");
        const delta = await w.db.select({ id: changeLog.entityId }).from(changeLog)
          .where(and(account, sql`${changeLog.seq} > ${before!.seq}`, eq(changeLog.entityType, "calendar_event")));
        const records = await b.feed([...new Set(delta.map(({ id }) => id))]);
        expect([...records.keys()].sort()).toEqual([...ids].sort());
        for (const device of devices) for (const [id, record] of records) device.set(id, record);
      };
      await transition(false, [continuous]);
      const fresh = await b.feed(ids);
      expect([...fresh.values()].every(({ hiddenOccurrences }) => hiddenOccurrences === undefined)).toBe(true);
      expect(continuous).toEqual(fresh);
      await transition(true, [continuous, fresh]);
      expect(continuous).toEqual(fresh);
      expect([...fresh.values()].filter((record) => record.hiddenOccurrences?.includes("")).map(({ id }) => id).sort()).toEqual(owned);
    });

    it("holds a series organized under a mailbox the account has removed for someone else's: the door takes none of its writes, the drain sends none", async () => {
      const MILA_OLD = "mila@old-studio.example.test";
      const KILN = memberText({
        uid: "kiln@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Kiln rota",
        more: [`ORGANIZER;CN=Mila:mailto:${MILA_OLD}`, `ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:mailto:${MILA_OLD}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      });
      const retitle = (s: { id: string; updatedAt: Date }) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { title: "Kiln rota, renamed" }, audience: { organizer: MILA_OLD, guests: [GIULIA] } });
      // While that mailbox is the account's, the series is its own.
      const kept = await bench({ "kiln.ics": KILN }, { autoSchedule: true, mailboxes: [MILA, MILA_OLD] });
      const [own] = await kept.rows("kiln.ics");
      expect(await kept.door("retitle", retitle(own!))).toBe("pending");
      // Removed (its copy kept), it is no mailbox of the account's any more: the series is someone else's.
      const b = await bench({ "kiln.ics": KILN }, { autoSchedule: true, mailboxes: [MILA, MILA_OLD] });
      await w.db.update(mailboxes).set({ status: "disabled", disabledReason: null })
        .where(and(eq(mailboxes.accountId, b.t.accountId), eq(mailboxes.address, MILA_OLD)));
      const [series] = await b.rows("kiln.ics");
      expect([await b.door("retitle", retitle(series!)), await b.door("split", acts(series!, randomUUID()).split)])
        .toEqual(["409 calendar_read_only", "409 calendar_read_only"]);
      await b.plant("late-retitle", retitle(series!));
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(b.sent(from, "kiln.ics")).toEqual([]);
      expect(await b.writes()).toEqual(["late-retitle refused read_only"]);
    });
  });

  describe("a day cancelled by a component of its own, from the cut on (the recheck's third finding)", () => {
    const MILA = "mila@studio.example.test";
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const DEC_28 = String(Date.UTC(2026, 11, 28, 8));
    const cancelled = (was: string) => ({ was, start: was, end: was.replace("T090000", "T100000"), summary: "Kiln", status: "CANCELLED" });
    const TEN = (more: Partial<Member> = {}): Member =>
      ({ uid: "astride@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln", ...more });
    /** Ten Mondays, 28 December cancelled as many programs keep it: a component of its own, STATUS:CANCELLED, and no EXDATE. */
    const CANCELLED_28 = memberText(TEN({ days: [cancelled("20261228T090000")] }));
    const split = (s: { id: string; updatedAt: Date }, change: Record<string, unknown>, at = DEC_14, newEventId: string = randomUUID()) =>
      ({ kind: "calendar_event_update", ...on(s), scope: { kind: "following", at, newEventId }, change });
    const exdates = (text: string) => masterOf(text).filter((l) => l.startsWith("EXDATE"));
    const components = (text: string) => partsOf(text).components.filter((c) => c.name === "VEVENT").length;
    /** What a series' end writes anew in the series' own component: its rule, its stamps, and the days it keeps excluded. */
    const outsideTheEnd = (l: string) => !/^(RRULE|DTSTAMP|SEQUENCE|LAST-MODIFIED|EXDATE)[;:]/.test(l);

    it("carries each day it cancels from that day on as an excluded day of the new series, in each spelling, and the series' end keeps it as one", async () => {
      const Z28 = `EXDATE;TZID=${ZH}:20261228T090000`;
      const WRITTEN: Record<string, {
        readonly text: string; readonly change: Record<string, unknown>; readonly made: string[]; readonly days: [number, number, number];
        /** The ended series' excluded days. */
        readonly ended: string[];
      }> = {
        "28 December cancelled by its own component; from 14 December on, a new title": {
          text: CANCELLED_28, change: { title: "The new term" }, made: [Z28], days: [9, 3, 6], ended: [Z28],
        },
        "the same; from 14 December on at 11:00": {
          text: CANCELLED_28, change: { start: zoned("20261214T110000", ZH), end: zoned("20261214T120000", ZH) }, made: [`EXDATE;TZID=${ZH}:20261228T110000`], days: [9, 3, 6],
          ended: [Z28],
        },
        "the same, the day's own component naming it in UTC": {
          text: CANCELLED_28.replace(`RECURRENCE-ID;TZID=${ZH}:20261228T090000`, "RECURRENCE-ID:20261228T080000Z"), change: { title: "The new term" },
          made: [Z28], days: [9, 3, 6], ended: [Z28],
        },
        "28 December cancelled by its own component and by a line of the series too": {
          text: memberText(TEN({ excluded: ["20261228T090000"], days: [cancelled("20261228T090000")] })), change: { title: "The new term" },
          made: [Z28], days: [9, 3, 6], ended: [Z28],
        },
        "a day before the cut (30 November) cancelled by its own component": {
          text: memberText(TEN({ days: [cancelled("20261130T090000")] })), change: { title: "The new term" }, made: [], days: [9, 2, 7], ended: [],
        },
      };
      const seen: Record<string, unknown> = {};
      for (const [name, c] of Object.entries(WRITTEN)) {
        const b = await bench({ "s.ics": c.text }, { mailboxes: [MILA] });
        const [series] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("term", split(series!, c.change));
        const turn = door === "pending" ? await b.turn() : "(no turn)";
        const sent = b.sent(from, "s.ics");
        seen[name] = {
          door, turn, writes: await b.writes(), requests: sent.map((x) => [x.method, x.member]),
          made: sent[1] === undefined ? null : exdates(sent[1].body),
          days: [daysOf(c.text).length, sent[0] === undefined ? null : daysOf(sent[0].body).length, sent[1] === undefined ? null : daysOf(sent[1].body).length],
          // The series' end: its own component and nothing else (a day's own component from the cut on goes), the days it cancelled from there on kept as excluded
          // days; outside its rule, its stamps and those lines, its own component and the zone byte for byte as they were.
          ended: sent[0] === undefined ? null : {
            components: components(sent[0].body), excluded: exdates(sent[0].body),
            outside: JSON.stringify(masterOf(sent[0].body).filter(outsideTheEnd)) === JSON.stringify(masterOf(c.text).filter(outsideTheEnd))
              && JSON.stringify(exdates(sent[0].body).slice(0, exdates(c.text).length)) === JSON.stringify(exdates(c.text))
              && JSON.stringify(partsOf(sent[0].body).components.filter((x) => x.name === "VTIMEZONE")) === JSON.stringify(partsOf(c.text).components.filter((x) => x.name === "VTIMEZONE")),
          },
        };
      }
      expect(seen).toEqual(Object.fromEntries(Object.entries(WRITTEN).map(([name, c]) => [name, {
        door: "pending", turn: "synced", writes: ["term applied", "term:2 applied"], requests: [["PUT", "s.ics"], ["PUT", "a new member"]], made: c.made, days: c.days,
        ended: { components: name.startsWith("a day before the cut") ? 2 : 1, excluded: c.ended, outside: true },
      }])));
    }, 120_000);

    it("keeps the day cancelled where the new series is made later, from the series as the store then holds it: after a refusal and its retry, and after a lost answer", async () => {
      const seen: Record<string, unknown> = {};
      // The second half refused once (the new series is made only by the person's retry), and the first half's answer lost.
      for (const how of ["refused, then retried", "the first half's answer lost"] as const) {
        let once = true;
        const b = await bench({ "s.ics": CANCELLED_28 }, {
          mailboxes: [MILA],
          wrap: (real) => ({
            ...real,
            async endSeries(...args: Parameters<CalendarWriter["endSeries"]>) {
              const done = await real.endSeries(...args);
              if (how === "the first half's answer lost" && once) { once = false; throw new Error("the connection dropped after the server answered"); }
              return done;
            },
            async continueSeries(...args: Parameters<CalendarWriter["continueSeries"]>) {
              if (how === "refused, then retried" && once) { once = false; return { ok: false, reason: "read_only", retryAfterMs: null }; }
              return real.continueSeries(...args);
            },
          }),
        });
        const [series] = await b.rows("s.ics");
        expect(await b.door("term", split(series!, { title: "The new term" }))).toBe("pending");
        expect(await b.turn()).toBe("synced");
        if (how === "refused, then retried") {
          // The press half carried out; the person's retry makes the new series from the store's copy, which is the ended series now.
          expect(await b.writes()).toEqual(["term applied", "term:2 refused read_only"]);
          expect(await b.retry("term:2")).toBe("pending");
        }
        const from = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        const made = [...b.held().entries()].find(([n]) => n !== "s.ics")?.[1] ?? "";
        seen[how] = { writes: await b.writes(), sent: b.sent(from, "s.ics").map((x) => x.member), made: made === "" ? null : exdates(made), days: made === "" ? null : daysOf(made).length };
      }
      expect(seen).toEqual({
        "refused, then retried": { writes: ["term applied", "term:2 applied"], sent: ["a new member"], made: [`EXDATE;TZID=${ZH}:20261228T090000`], days: 6 },
        "the first half's answer lost": { writes: ["term applied", "term:2 applied"], sent: ["a new member"], made: [`EXDATE;TZID=${ZH}:20261228T090000`], days: 6 },
      });
    }, 120_000);

    it("refuses at the door, as past it, what the cancelled day makes a guess or a day the series does not have", async () => {
      const REFUSED: Record<string, { readonly act: (s: { id: string; updatedAt: Date }, newEventId: string) => unknown; readonly second?: Record<string, unknown>; readonly at?: string; readonly past: string[] }> = {
        "the days from 14 December moved to Tuesdays, 28 December cancelled by its own component": {
          act: (s, id) => split(s, { start: zoned("20261215T090000", ZH), end: zoned("20261215T100000", ZH), repeat: "FREQ=WEEKLY;BYDAY=TU" }, DEC_14, id),
          second: { start: zoned("20261215T090000", ZH), end: zoned("20261215T100000", ZH), repeat: "FREQ=WEEKLY;BYDAY=TU", title: "Kiln" },
          past: ["k refused field_unwritable", "k:2 refused earlier_refused"],
        },
        "a press on 28 December, the day its own component cancels": {
          act: (s, id) => split(s, { title: "The new term" }, DEC_28, id), at: DEC_28,
          second: { start: zoned("20261228T090000", ZH), end: zoned("20261228T100000", ZH), repeat: "FREQ=WEEKLY;COUNT=5;BYDAY=MO", title: "The new term" },
          past: ["k refused event_gone", "k:2 refused earlier_refused"],
        },
        "one day's change of 28 December, the day its own component cancels": {
          act: (s) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "occurrence", at: DEC_28 }, change: { title: "That day" } }),
          past: ["k refused event_gone"],
        },
      };
      const seen: Record<string, unknown> = {};
      for (const [name, c] of Object.entries(REFUSED)) {
        const atDoor = await bench({ "s.ics": CANCELLED_28 }, { mailboxes: [MILA] });
        const [series] = await atDoor.rows("s.ics");
        const door = await atDoor.door("k", c.act(series!, randomUUID()));
        const past = await bench({ "s.ics": CANCELLED_28 }, { mailboxes: [MILA] });
        const [planted] = await past.rows("s.ics");
        const newEventId = randomUUID();
        const act = c.act(planted!, newEventId);
        if (c.second === undefined) await past.plant("k", act);
        else {
          const first = await past.plant("k", act, { part: { of: "k", n: 1 } });
          const named = c.second.title === "The new term" ? ["title" as const] : [];
          await past.plant("k:2", {
            kind: "calendar_event_create", eventId: newEventId, calendarId: await past.calendarId(),
            event: { notes: null, place: null, callLink: null, busy: true, private: false, invitees: [], alarms: [], ...c.second },
          }, { after: first.id, part: { of: "k", n: 2, from: { eventId: planted!.id, at: c.at ?? DEC_14, named } } });
        }
        const from = past.dav.seen.length;
        expect(await past.turn()).toBe("synced");
        seen[name] = { door, past: await past.writes(), written: past.sent(from, "s.ics").length };
      }
      expect(seen).toEqual(Object.fromEntries(Object.entries(REFUSED).map(([name, c]) => [name, { door: "400 validation_failed", past: c.past, written: 0 }])));
    }, 120_000);
  });

  describe("a changed day that speaks for the days after it (RANGE=THISANDFUTURE): the series is not split (the recheck's fourth finding)", () => {
    const MILA = "mila@studio.example.test";
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    /** Ten Mondays and one component of their own that speaks for the days from it on. */
    const withRange = (was: string, lines: readonly string[], range = "RANGE=THISANDFUTURE") => memberText({
      uid: "range@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln",
    }).replace("END:VCALENDAR\r\n", [
      "BEGIN:VEVENT", "UID:range@studio.example.test", "DTSTAMP:20261113T120000Z", `RECURRENCE-ID;${range};TZID=${ZH}:${was}`, ...lines, "SEQUENCE:1", "END:VEVENT",
      "END:VCALENDAR", "",
    ].join("\r\n"));
    const later = (was: string) => [`DTSTART;TZID=${ZH}:${was.replace("T090000", "T100000")}`, `DTEND;TZID=${ZH}:${was.replace("T090000", "T110000")}`, "SUMMARY:Kiln\\, an hour later from here on"];
    const MEMBERS: Record<string, string> = {
      "an hour later from 7 December on (before the cut)": withRange("20261207T090000", later("20261207T090000")),
      "an hour later from 21 December on (after the cut)": withRange("20261221T090000", later("20261221T090000")),
      "an hour later from 14 December on (the day of the cut)": withRange("20261214T090000", later("20261214T090000")),
      "every day from 7 December on cancelled (STATUS:CANCELLED)": withRange("20261207T090000", [...later("20261207T090000"), "STATUS:CANCELLED"]),
      "the range told in small letters": withRange("20261207T090000", later("20261207T090000"), "range=thisandfuture"),
    };
    const press = (s: { id: string; updatedAt: Date }, newEventId: string) =>
      ({ kind: "calendar_event_update", ...on(s), scope: { kind: "following", at: DEC_14, newEventId }, change: { title: "The new term" } });

    it("refuses the split of such a series at the door, and past it sends neither part", async () => {
      const seen: Record<string, unknown> = {};
      for (const [name, text] of Object.entries(MEMBERS)) {
        const atDoor = await bench({ "s.ics": text }, { mailboxes: [MILA] });
        const [series] = await atDoor.rows("s.ics");
        const door = await atDoor.door("k", press(series!, randomUUID()));
        const past = await bench({ "s.ics": text }, { mailboxes: [MILA] });
        const [planted] = await past.rows("s.ics");
        const newEventId = randomUUID();
        const first = await past.plant("k", press(planted!, newEventId), { part: { of: "k", n: 1 } });
        await past.plant("k:2", {
          kind: "calendar_event_create", eventId: newEventId, calendarId: await past.calendarId(),
          event: {
            title: "The new term", start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), notes: null, place: null, callLink: null, busy: true,
            private: false, repeat: "FREQ=WEEKLY;COUNT=7;BYDAY=MO", invitees: [], alarms: [],
          },
        }, { after: first.id, part: { of: "k", n: 2, from: { eventId: planted!.id, at: DEC_14, named: ["title"] } } });
        const from = past.dav.seen.length;
        expect(await past.turn()).toBe("synced");
        seen[name] = { door, past: await past.writes(), written: past.sent(from, "s.ics").length, asItWas: past.held().get("s.ics") === text };
      }
      expect(seen).toEqual(Object.fromEntries(Object.keys(MEMBERS).map((name) => [name, {
        door: "400 validation_failed", past: ["k refused repeat_unsupported", "k:2 refused earlier_refused"], written: 0, asItWas: true,
      }])));
    }, 120_000);

    it("still ends such a series alone where the days from one on are let go: its changed day before the cut stays as it was", async () => {
      const text = MEMBERS["an hour later from 7 December on (before the cut)"]!;
      const b = await bench({ "s.ics": text }, { mailboxes: [MILA] });
      const [series] = await b.rows("s.ics");
      const from = b.dav.seen.length;
      expect(await b.door("k", { kind: "calendar_event_delete", ...on(series!), scope: { kind: "following", at: DEC_14 } })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["k applied"]);
      const sent = b.sent(from, "s.ics");
      expect(sent.map((x) => [x.method, x.member, x.ifMatch])).toEqual([["PUT", "s.ics", '"s.ics-1"']]);
      // The component that speaks for the days from 7 December on is the object's as it was; the series now ends before 14 December.
      const range = (t: string) => partsOf(t).components.filter((c) => c.lines.some((l) => l.startsWith("RECURRENCE-ID")));
      expect(range(sent[0]!.body)).toEqual(range(text));
      expect(daysOf(sent[0]!.body)).toEqual(["2026-11-23T08:00:00.000Z", "2026-11-30T08:00:00.000Z", "2026-12-07T09:00:00.000Z"]);
    });
  });

  describe("whose an event is, read off the ORGANIZER line of its own component, a line with no mail address included (the recheck's second finding)", () => {
    const MILA = "mila@studio.example.test";
    const ANNA = "anna@example.test";
    const GIULIA = "giulia@example.test";
    const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const series = (uid: string, people: readonly string[]) => memberText({
      uid: `${uid}@elsewhere.example.test`, tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze group", more: people,
    });
    /** One event of the same lines, with no repeat. */
    const one = (uid: string, people: readonly string[]) => series(uid, people).replace("RRULE:FREQ=WEEKLY;BYDAY=MO\r\n", "");
    type Row = { id: string; updatedAt: Date };
    const ACTS: Record<string, (s: Row, newEventId: string, audience?: { organizer: string; guests: string[] }) => unknown> = {
      retitle: (s, _id, audience) => ({ kind: "calendar_event_update", ...on(s), ...(audience ? { audience } : {}), scope: { kind: "record" }, change: { title: "Renamed by the account" } }),
      "new time": (s, _id, audience) => ({ kind: "calendar_event_update", ...on(s), ...(audience ? { audience } : {}), scope: { kind: "record" }, change: { start: zoned("20261123T140000", ZH), end: zoned("20261123T150000", ZH) } }),
      "cancel-a-day": (s, _id, audience) => ({ kind: "calendar_event_delete", ...on(s), ...(audience ? { audience } : {}), scope: { kind: "occurrence", at: DEC_7 } }),
      split: (s, newEventId, audience) => ({ kind: "calendar_event_update", ...on(s), ...(audience ? { audience } : {}), scope: { kind: "following", at: DEC_14, newEventId }, change: { title: "My way from 14 December" } }),
      remove: (s, _id, audience) => ({ kind: "calendar_event_delete", ...on(s), ...(audience ? { audience } : {}), scope: { kind: "record" } }),
      answer: (s) => ({ kind: "calendar_event_answer", ...on(s), scope: { kind: "record" }, answer: "accepted" }),
    };
    const SERIES_ACTS = ["retitle", "cancel-a-day", "split", "remove", "answer"];
    const ONE_ACTS = ["retitle", "new time", "remove", "answer"];
    /** Whose an event is: someone else's (the account invited to it under a mailbox of its, or not), or the account's own. */
    type Whose = "theirs, invited" | "theirs, not invited" | "theirs, incomplete" | "own";
    const PRINCIPAL = "mailto:Mila@DAV.example.test";
    interface Case {
      readonly name: string;
      readonly text: string;
      readonly whose: Whose;
      /** One event with no repeat, at a CalDAV server no repeat was proven at (the providers' own table): no proof stands in front of it. */
      readonly single?: boolean;
      readonly mailboxes?: readonly string[];
      readonly principal?: string | null;
      readonly confirmedOrganizer?: string;
      readonly deletionUnconfirmed?: true;
    }
    const CASES: Case[] = [
      {
        name: "an organizer told by a principal's path, its address in a parameter; the account's own line the same way", whose: "theirs, not invited",
        text: series("w1", [
          `ORGANIZER;CN=Anna;EMAIL=${ANNA}:/principals/anna/`, `ATTENDEE;CN=Anna;EMAIL=${ANNA};PARTSTAT=ACCEPTED;ROLE=CHAIR:/principals/anna/`,
          `ATTENDEE;CN=Mila;EMAIL=${MILA};PARTSTAT=NEEDS-ACTION;RSVP=TRUE:/principals/mila/`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`,
        ]),
      },
      { name: "an organizer 'invalid:nomail', the account not among the invitees", whose: "theirs, not invited", text: series("w3", ["ORGANIZER;CN=Anna:invalid:nomail", `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]) },
      { name: "an ORGANIZER line with no value at all", whose: "theirs, not invited", text: series("w3b", ["ORGANIZER;CN=Anna:", `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]) },
      { name: "an organizer named by an address with no scheme", whose: "theirs, not invited", text: series("w3c", [`ORGANIZER;CN=Anna:${ANNA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]) },
      {
        name: "two ORGANIZER lines, the account's own first", whose: "theirs, not invited",
        text: series("w3d", [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ORGANIZER;CN=Anna:mailto:${ANNA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]),
      },
      {
        name: "the account's own series as a server may write its own users: the organizer and its own line a principal's path (its address in a parameter)",
        whose: "theirs, not invited",
        text: series("w9", [
          `ORGANIZER;CN=Mila;EMAIL=${MILA}:/principals/mila/`, `ATTENDEE;CN=Mila;EMAIL=${MILA};PARTSTAT=ACCEPTED;ROLE=CHAIR:/principals/mila/`,
          `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`,
        ]),
      },
      {
        name: "one event of someone else's, its organizer a principal's path, the account's own line the same way", whose: "theirs, not invited", single: true,
        text: one("o1", [
          `ORGANIZER;CN=Anna;EMAIL=${ANNA}:/principals/anna/`, `ATTENDEE;CN=Anna;EMAIL=${ANNA};PARTSTAT=ACCEPTED;ROLE=CHAIR:/principals/anna/`,
          `ATTENDEE;CN=Mila;EMAIL=${MILA};PARTSTAT=NEEDS-ACTION;RSVP=TRUE:/principals/mila/`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`,
        ]),
      },
      // Held before, and still: someone else's where the line names another address; the account's own where it names one of its own.
      {
        name: "an organizer told by a urn, the account's own line a mailbox's address", whose: "theirs, incomplete",
        text: series("w2", [
          "ORGANIZER;CN=Anna:urn:uuid:5f6a0c1e-0000-4000-8000-00000000a44a", "ATTENDEE;CN=Anna;PARTSTAT=ACCEPTED:urn:uuid:5f6a0c1e-0000-4000-8000-00000000a44a",
          `ATTENDEE;CN=Mila;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`,
        ]),
      },
      {
        name: "the account's own address with a plus tag", whose: "theirs, not invited",
        text: series("w5", ["ORGANIZER;CN=Mila:mailto:mila+calendar@studio.example.test", "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:mailto:mila+calendar@studio.example.test", `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]),
      },
      {
        name: "a server that names nobody, an account with no mailbox: Anna's series", whose: "theirs, not invited", mailboxes: [],
        text: series("w6", [`ORGANIZER;CN=Anna:mailto:${ANNA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]),
      },
      {
        name: "one event of someone else's, its organizer a mail address, the account's own line a mailbox's", whose: "theirs, invited", single: true,
        text: one("o2", [`ORGANIZER;CN=Anna:mailto:${ANNA}`, `ATTENDEE;CN=Mila;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]),
      },
      {
        name: "the account's own address in capitals (MAILTO:Mila@Studio...), its own line in small letters", whose: "own", confirmedOrganizer: MILA,
        text: series("w4", ["ORGANIZER;CN=Mila:MAILTO:Mila@Studio.Example.Test", `ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]),
      },
      {
        name: "the account's own address with parameters (a name, one who sends for it)", whose: "own", confirmedOrganizer: MILA,
        text: series("w8", [`ORGANIZER;CN="Mila, Studio";SENT-BY="mailto:desk@studio.example.test":mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]),
      },
      {
        name: "the address the connection signs in as (mailto:Mila@DAV...), the organizer that address, no mailbox has it", whose: "own", principal: PRINCIPAL, confirmedOrganizer: PRINCIPAL.slice("mailto:".length),
        text: series("w7", ["ORGANIZER;CN=Mila:mailto:mila@dav.example.test", `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]),
      },
      { name: "no organizer and no invitee, an account with no mailbox", whose: "own", mailboxes: [], text: series("w6b", []) },
    ];
    const madeFields = {
      title: "My way from 14 December", start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), notes: null, place: null, callLink: null, busy: true,
      private: false, repeat: "FREQ=WEEKLY;BYDAY=MO", invitees: [], alarms: [],
    };
    /** What a press comes to: the door's answer, and what the drain does with the row (the door's, or one recorded past the door where the door refused it). */
    const each = async (c: Case, name: string): Promise<{ door: string; past: string }> => {
      const b = await bench({ "s.ics": c.text }, {
        autoSchedule: true, mailboxes: c.mailboxes ?? [MILA], principal: c.principal ?? null, ...(c.single === true ? { proven: PROVEN_REPEATS } : {}),
      });
      const [row] = await b.rows("s.ics");
      const newEventId = randomUUID();
      const audience = c.confirmedOrganizer ? { organizer: c.confirmedOrganizer, guests: [GIULIA] } : undefined;
      const act = ACTS[name]!(row!, newEventId, audience);
      const door = await b.door("k", act);
      if (door !== "pending") {
        const key = door === "refused version_stale" ? "drain" : "k";
        if (name === "split") {
          const first = await b.plant(key, act, { part: { of: key, n: 1 } });
          await b.plant(`${key}:2`, { kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(), event: madeFields }, {
            after: first.id, part: { of: key, n: 2, from: { eventId: row!.id, at: DEC_14, named: ["title"] } },
          });
        } else await b.plant(key, act);
      }
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      return { door, past: `${(await b.writes()).join("; ")} | ${b.sent(from, "s.ics").map((x) => x.method).join(", ") || "nothing written"}` };
    };
    const expected = ({ whose, deletionUnconfirmed, single }: Case, name: string): { door: string; past: string } => {
      // Without an organizer, neither recurring changes nor cancellations can confirm the audience.
      if (deletionUnconfirmed && (name === "remove" || name === "cancel-a-day" || (!single && (name === "retitle" || name === "split")))) {
        const refusedSplit = name === "split" ? "; drain:2 refused earlier_refused" : "";
        return { door: "refused version_stale", past: `k refused version_stale; drain refused version_stale${refusedSplit} | nothing written` };
      }
      const theirs = whose !== "own";
      if (name === "answer") {
        return whose === "theirs, invited" ? { door: "pending", past: "k applied | PUT" } : { door: "409 calendar_read_only", past: "k refused read_only | nothing written" };
      }
      if (theirs) {
        return { door: "409 calendar_read_only", past: name === "split" ? "k refused read_only; k:2 refused earlier_refused | nothing written" : "k refused read_only | nothing written" };
      }
      return { door: "pending", past: name === "split" ? "k applied; k:2 applied | PUT, PUT" : `k applied | ${name === "remove" ? "DELETE" : "PUT"}` };
    };

    it("takes an event whose own component names an organizer that is no address of the account's, in any spelling, for someone else's: door and drain alike", async () => {
      const seen: Record<string, Record<string, { door: string; past: string }>> = {};
      for (const c of CASES) {
        seen[c.name] = {};
        for (const name of c.single === true ? ONE_ACTS : SERIES_ACTS) seen[c.name]![name] = await each(c, name);
      }
      expect(seen).toEqual(Object.fromEntries(CASES.map((c) => [c.name,
        Object.fromEntries((c.single === true ? ONE_ACTS : SERIES_ACTS).map((name) => [name, expected(c, name)]))])));
    }, 300_000);

    /**
     * The second recheck's third finding, as a class: an event is the account's own only where its stored text shows it so: no
     * ORGANIZER line in any spelling and no invitee the reader takes no address from, or an ORGANIZER line that is one of the
     * account's own addresses. Every other event is someone else's. Each spelling as a series and as one event.
     */
    const GIULIA_LINE = `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`;
    const SPELLINGS: { readonly name: string; readonly people: readonly string[]; readonly whose: Whose; readonly principal?: string; readonly text?: string; readonly confirmedOrganizer?: string; readonly deletionUnconfirmed?: true }[] = [
      // The second recheck's seven.
      { name: "an ORGANIZER line with no colon (no content line)", people: ["ORGANIZER;CN=Anna", GIULIA_LINE], whose: "theirs, not invited" },
      { name: "an opening quote never closed", people: [`ORGANIZER;CN="Anna:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "one stray quote in an unquoted name", people: [`ORGANIZER;CN=Anna "A:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "a fold broken before the value", people: ["ORGANIZER;CN=Anna of the long name", `:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "a fold broken inside the parameters", people: ["ORGANIZER;CN=Anna of the long name;SCHEDULE-STATUS", `=1.1:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "a space before the colon", people: [`ORGANIZER :mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "a tab before the parameters", people: [`ORGANIZER\t;CN=Anna:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "a group before the name", people: [`item1.ORGANIZER;CN=Anna:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      {
        name: "no ORGANIZER line; the account's own line a principal's path, another invitee by address",
        people: ["ATTENDEE;CN=Mila;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:/principals/mila/", GIULIA_LINE], whose: "theirs, not invited", principal: "/principals/mila/",
      },
      // Five of this round's own.
      { name: "a control character after the name", people: [`ORGANIZER\u007f;CN=Anna:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "a zero-width space before the name", people: [`​ORGANIZER;CN=Anna:mailto:${ANNA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "the account's own address on a line in a group's spelling (not shown the account's own: refused)", people: [`item1.ORGANIZER;CN=Mila:mailto:${MILA}`, GIULIA_LINE], whose: "theirs, not invited" },
      { name: "no ORGANIZER line; an invitee told by a urn", people: ["ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:urn:uuid:5f6a0c1e-0000-4000-8000-00000000a44a"], whose: "theirs, not invited" },
      {
        name: "the series' own component names nobody; a changed day of it names Anna as its organizer", people: [], whose: "theirs, not invited",
        text: memberText({
          uid: "f5@elsewhere.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze group",
          days: [{ was: "20261130T090000", start: "20261130T140000", end: "20261130T150000", summary: "Glaze group at Anna's" }],
        }).replace("SUMMARY:Glaze group at Anna's\r\n", `SUMMARY:Glaze group at Anna's\r\nORGANIZER;CN=Anna:mailto:${ANNA}\r\n${GIULIA_LINE}\r\n`),
      },
      // What held stays held: lines that show the event the account's own.
      { name: "the account's own: a quoted name that holds a colon", people: [`ORGANIZER;CN="Mila: the studio":mailto:${MILA}`, GIULIA_LINE], whose: "own", confirmedOrganizer: MILA },
      { name: "the account's own: capitals and a query after the address", people: ["ORGANIZER;CN=Mila:MAILTO:Mila@Studio.Example.Test?subject=x", GIULIA_LINE], whose: "own", confirmedOrganizer: MILA },
      { name: "no ORGANIZER line; an invitee by mail address, not the account", people: [GIULIA_LINE], whose: "own", deletionUnconfirmed: true },
    ];
    // Each spelling's member under a name of its own, by its place in the list.
    const SPELLED: Case[] = SPELLINGS.flatMap(({ name, people, text, ...ownership }, i) => [
      { ...ownership, name: `${name} (a series)`, text: text ?? series(`spelling${i}`, people) },
      ...(text !== undefined ? [] : [{
        ...ownership, name: `${name} (one event)`, single: true, text: one(`spelling${i}o`, people),
      }]),
    ]);

    it("takes an event whose stored text does not show it the account's own, in any spelling, for someone else's: door and drain alike (the second recheck's third finding)", async () => {
      const seen: Record<string, Record<string, { door: string; past: string }>> = {};
      for (const c of SPELLED) {
        seen[c.name] = {};
        for (const name of c.single === true ? ONE_ACTS : SERIES_ACTS) seen[c.name]![name] = await each(c, name);
      }
      expect(seen).toEqual(Object.fromEntries(SPELLED.map((c) => [c.name,
        Object.fromEntries((c.single === true ? ONE_ACTS : SERIES_ACTS).map((name) => [name, expected(c, name)]))])));
    }, 300_000);
  });

  describe("a write that waited behind another, where someone else's copy came between", () => {
    /** Mondays at 09:00 in Zurich, with no end. */
    const MONDAYS = memberText({ uid: "n@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "N weekly" });
    /** Someone else's copy, made on `text`: 11 January moved to the 12th, and a room for the whole series. */
    const theirs = (text: string) => text
      .replace("SUMMARY:N weekly\r\n", "LOCATION:Their room\r\nSUMMARY:N weekly\r\n")
      .replace("END:VCALENDAR\r\n", [
        "BEGIN:VEVENT", "UID:n@studio.example.test", "DTSTAMP:20261114T120000Z", `RECURRENCE-ID;TZID=${ZH}:20270111T090000`,
        `DTSTART;TZID=${ZH}:20270112T150000`, `DTEND;TZID=${ZH}:20270112T160000`, "SUMMARY:Theirs\\, 11 January moved", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR", "",
      ].join("\r\n"));
    const firsts = {
      "one day's change": (s: { id: string; updatedAt: Date }) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "occurrence", at: String(Date.UTC(2026, 11, 7, 8)) }, change: { title: "Mine, that day" } }),
      "the whole series' new title": (s: { id: string; updatedAt: Date }) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { title: "Mine, the series" } }),
    };

    for (const [name, firstAct] of Object.entries(firsts)) {
      it(`is not re-based onto the copy a write found done stands on (the first: ${name}): it is refused for its version, and their copy stands`, async () => {
        let cut = true;
        const b = await bench({ "n.ics": MONDAYS }, {
          wrap: (real) => ({
            ...real,
            async change(...args: Parameters<CalendarWriter["change"]>) {
              const done = await real.change(...args);
              if (cut) throw new Error("the connection dropped after the server answered");
              return done;
            },
          }),
        });
        const [series] = await b.rows("n.ics");
        expect(await b.door("c1", firstAct(series!))).toBe("pending");
        // The person then presses on a day and the days after it, on the copy the device holds (its own first act over it).
        expect(await b.door("c2", {
          kind: "calendar_event_update", ...on(series!), after: "c1", scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId: randomUUID() },
          change: { place: "Studio 3" },
        })).toBe("pending");
        // The first lands and its answer is lost; the turn's reading takes in the copy it made.
        expect(await b.turn()).toBe("synced");
        expect(await b.writes()).toEqual(["c1 pending", "c2 pending", "c2:2 pending"]);
        // Someone else writes on top of that copy: 11 January moved, a room for the series.
        const their = theirs(b.held().get("n.ics")!);
        b.dav.put("studio", "n.ics", their, '"n.ics-3"');
        cut = false;
        const from = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        // The first is found done on their copy; the one behind it keeps its version, and nothing lands on their copy: the series'
        // end, made on a copy the store no longer holds, reads the member, finds it is not ended there, and sends nothing.
        expect(await b.writes()).toEqual(["c1 applied", "c2 refused version_stale", "c2:2 refused earlier_refused"]);
        expect(b.sent(from, "n.ics").map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch])).toEqual([["PUT", "n.ics", '"n.ics-1"', null]]);
        expect([b.held().get("n.ics") === their, [...b.held().keys()]]).toEqual([true, ["n.ics"]]);
      });
    }

    it("is not re-based onto the copy its own read-back found, where someone else wrote between the write and that read", async () => {
      const b = await bench({ "n.ics": MONDAYS });
      const [series] = await b.rows("n.ics");
      expect(await b.door("c1", firsts["the whole series' new title"](series!))).toBe("pending");
      expect(await b.door("c2", {
        kind: "calendar_event_update", ...on(series!), after: "c1", scope: { kind: "record" }, change: { place: "Studio 3" },
      })).toBe("pending");
      // The server takes the first write and answers its tag; before the writer reads the member back, someone else writes it.
      let their = "";
      b.dav.afterNextWrite(() => {
        their = theirs(b.held().get("n.ics")!);
        b.dav.put("studio", "n.ics", their, '"n.ics-3"');
      });
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["c1 applied", "c2 refused version_stale"]);
      expect(b.sent(from, "n.ics").map((x) => [x.method, x.member, x.ifMatch])).toEqual([["PUT", "n.ics", '"n.ics-1"'], ["PUT", "n.ics", '"n.ics-1"']]);
      expect(b.held().get("n.ics")).toBe(their);
    });
  });

  describe("a press on a day and the days after it, made on a copy someone else has since ended earlier", () => {
    const GIULIA = "giulia@example.test";
    const MILA = "mila@studio.example.test";
    const press = async (b: Awaited<ReturnType<typeof bench>>, member: string, audience?: { organizer: string; guests: string[] }) => {
      const [series] = await b.rows(member);
      return b.door("term", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId: randomUUID() },
        change: { title: "From 14 December" }, ...(audience ? { audience } : {}),
      });
    };
    const MONDAYS = memberText({ uid: "n@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "N weekly" });
    /** Their copy: the series ended after 30 November, before the day the press ends it. */
    const endedEarlier = (text: string) => text.replace("RRULE:FREQ=WEEKLY;BYDAY=MO\r\n", "RRULE:FREQ=WEEKLY;UNTIL=20261201T000000Z;BYDAY=MO\r\n");

    for (const readFirst of [false, true]) {
      it(`is refused for its version and makes no series of the days they ended${readFirst ? ", their copy read before the turn" : ""}`, async () => {
        const b = await bench({ "n.ics": MONDAYS });
        expect(await press(b, "n.ics")).toBe("pending");
        const their = endedEarlier(MONDAYS);
        b.dav.put("studio", "n.ics", their, '"n.ics-2"');
        if (readFirst) expect(await b.read()).toBe("synced");
        const from = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        expect(await b.writes()).toEqual(["term refused version_stale", "term:2 refused earlier_refused"]);
        // Sent under the copy it was made on and refused for it; with their copy in the store already, nothing is sent at all.
        expect(b.sent(from, "n.ics").map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch])).toEqual(readFirst ? [] : [["PUT", "n.ics", '"n.ics-1"', null]]);
        expect([b.held().get("n.ics") === their, [...b.held().keys()]]).toEqual([true, ["n.ics"]]);
      });
    }

    it("is refused for its version on a later attempt too (its first cut off before it asked anything): an end found earlier than its own is not its own", async () => {
      let cut = true;
      const b = await bench({ "n.ics": MONDAYS }, {
        wrap: (real) => ({
          ...real,
          async endSeries(...args: Parameters<CalendarWriter["endSeries"]>) {
            if (cut) {
              cut = false;
              throw new Error("the connection dropped before anything was asked");
            }
            return real.endSeries(...args);
          },
        }),
      });
      expect(await press(b, "n.ics")).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term pending", "term:2 pending"]);
      // Then someone ends the series after 30 November; the press's next attempt may find an end of its own, and finds theirs.
      const their = endedEarlier(MONDAYS);
      b.dav.put("studio", "n.ics", their, '"n.ics-2"');
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term refused version_stale", "term:2 refused earlier_refused"]);
      expect(b.sent(from, "n.ics").map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch])).toEqual([["PUT", "n.ics", '"n.ics-1"', null]]);
      expect([b.held().get("n.ics") === their, [...b.held().keys()]]).toEqual([true, ["n.ics"]]);
    });

    it("sends no invitation for the days they ended, at a server that sends invitations itself", async () => {
      const OWN = memberText({
        uid: "critique@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze critique",
        more: [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      });
      const b = await bench({ "critique.ics": OWN }, { autoSchedule: true, mailboxes: [MILA] });
      expect(await press(b, "critique.ics", { organizer: MILA, guests: [GIULIA] })).toBe("pending");
      const their = OWN.replace("RRULE:FREQ=WEEKLY;BYDAY=MO\r\n", "RRULE:FREQ=WEEKLY;UNTIL=20261130T090000Z;BYDAY=MO\r\n");
      b.dav.put("studio", "critique.ics", their, '"critique.ics-2"');
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term refused version_stale", "term:2 refused earlier_refused"]);
      expect(b.sent(from, "critique.ics")).toEqual([]);
      expect([b.held().get("critique.ics") === their, [...b.held().keys()]]).toEqual([true, ["critique.ics"]]);
    });
  });

  describe("a series' end is found done only as the press's own (the recheck's fifth finding)", () => {
    const MILA = "mila@studio.example.test";
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const MONDAYS = memberText({ uid: "n@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "N weekly" });
    const press = (s: { id: string; updatedAt: Date }, change: Record<string, unknown>) =>
      ({ kind: "calendar_event_update", ...on(s), scope: { kind: "following", at: DEC_14, newEventId: randomUUID() }, change });
    /** The series ended where the press ends it, by someone else: the same end, another tag. */
    const endedThere = MONDAYS.replace("RRULE:FREQ=WEEKLY;BYDAY=MO\r\n", "RRULE:FREQ=WEEKLY;UNTIL=20261214T075959Z;BYDAY=MO\r\n");
    /** A writer whose series' ends go as `plan` says, call by call: the end sent and its answer lost, cut off before it asked anything, or as it is. */
    const ends = (plan: readonly ("lost" | "cut" | "real")[]) => (real: CalendarWriter): CalendarWriter => {
      let n = 0;
      return {
        ...real,
        async endSeries(...args: Parameters<CalendarWriter["endSeries"]>) {
          const how = plan[n++] ?? "real";
          if (how === "cut") throw new Error("the connection dropped before anything was asked");
          const done = await real.endSeries(...args);
          if (how === "lost") throw new Error("the connection dropped after the server answered");
          return done;
        },
      };
    };
    const held = (b: Awaited<ReturnType<typeof bench>>) => {
      const all = [...b.held().entries()];
      return { members: all.length, days14: all.flatMap(([, t]) => daysOf(t)).filter((d) => d === "2026-12-14T08:00:00.000Z").length };
    };

    it("takes no press's end for another's: two presses on one day, the first one's answer lost, make one series", async () => {
      const seen: Record<string, unknown> = {};
      const CASES: Record<string, readonly ("lost" | "cut" | "real")[]> = {
        // The first press's end lands and its answer is lost; the next turn finds it done (its own), and the second press is refused for its copy.
        "the first press's end lands, its answer lost": ["lost"],
        // The same, the second press's first attempt cut off before it asked anything: on its second it still does not take the first's end for its own.
        "the same, the second press's first attempt cut off": ["lost", "real", "cut"],
      };
      for (const [name, plan] of Object.entries(CASES)) {
        const b = await bench({ "n.ics": MONDAYS }, { autoSchedule: true, mailboxes: [MILA], wrap: ends(plan) });
        const [series] = await b.rows("n.ics");
        const doors = [await b.door("a", press(series!, { title: "A: from 14 December" })), await b.door("b", press(series!, { place: "B: Studio 3" }))];
        const from = b.dav.seen.length;
        for (let i = 0; i < 3; i++) expect(await b.turn()).toBe("synced");
        seen[name] = { doors, writes: await b.writes(), written: b.sent(from, "n.ics").map((x) => `${x.method} ${x.member} ${x.ifMatch ?? x.ifNoneMatch}`), ...held(b) };
      }
      expect(seen).toEqual(Object.fromEntries(Object.keys(CASES).map((name) => [name, {
        doors: ["pending", "pending"], writes: ["a applied", "a:2 applied", "b refused version_stale", "b:2 refused earlier_refused"],
        written: ['PUT n.ics "n.ics-1"', "PUT a new member *"], members: 2, days14: 1,
      }])));
    }, 120_000);

    it("takes no end someone else made exactly where the press ends it for the press's own on its first attempt, read first or found by its refused precondition", async () => {
      const seen: Record<string, unknown> = {};
      for (const readFirst of [false, true]) {
        const b = await bench({ "n.ics": MONDAYS }, { autoSchedule: true, mailboxes: [MILA] });
        const [series] = await b.rows("n.ics");
        expect(await b.door("term", press(series!, { title: "From 14 December" }))).toBe("pending");
        b.dav.put("studio", "n.ics", endedThere, '"n.ics-2"');
        if (readFirst) expect(await b.read()).toBe("synced");
        const from = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        seen[readFirst ? "their copy read in first" : "found by the refused precondition"] = {
          writes: await b.writes(), written: b.sent(from, "n.ics").map((x) => `${x.method} ${x.member} ${x.ifMatch ?? x.ifNoneMatch}`),
          theirs: b.held().get("n.ics") === endedThere, members: b.held().size,
        };
      }
      expect(seen).toEqual({
        "found by the refused precondition": { writes: ["term refused version_stale", "term:2 refused earlier_refused"], written: ['PUT n.ics "n.ics-1"'], theirs: true, members: 1 },
        "their copy read in first": { writes: ["term refused version_stale", "term:2 refused earlier_refused"], written: [], theirs: true, members: 1 },
      });
    }, 120_000);

    it("takes the end for a press's own where another press on that day stands refused after its end landed: a refused press bars nothing, and its retry is refused by the day the other's row keeps (the third recheck's first finding)", async () => {
      const b = await bench({ "n.ics": MONDAYS }, { autoSchedule: true, mailboxes: [MILA], wrap: ends(["lost"]) });
      const [series] = await b.rows("n.ics");
      expect([await b.door("p1", press(series!, { title: "The first press" })), await b.door("p2", press(series!, { place: "The second press" }))]).toEqual(["pending", "pending"]);
      // The first press's end lands and its answer is lost; then (as after eight more attempts that never heard back) it stands refused with its word.
      expect(await b.turn()).toBe("synced");
      await w.db.update(calWrites).set({ state: "refused", refusal: "unavailable", attempts: 8, nextAttemptAt: null })
        .where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "p1")));
      await w.db.update(calWrites).set({ state: "refused", refusal: "earlier_refused", nextAttemptAt: null })
        .where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "p1:2")));
      // The second press was tried once already (its attempt cut off before it asked anything): on this attempt it finds the end at the server, and
      // no press that is owed with an attempt stands beside it: the end is its own, and it makes the days from 14 December a series.
      await w.db.update(calWrites).set({ attempts: 1 }).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "p2")));
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["p1 refused unavailable", "p1:2 refused earlier_refused", "p2 applied", "p2:2 applied"]);
      const sent = b.sent(from, "n.ics");
      expect(sent.map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch])).toEqual([["PUT", "a new member", null, "*"]]);
      expect(masterOf(sent[0]!.body).filter((l) => /^(DTSTART|RRULE|SUMMARY|LOCATION)[;:]/.test(l))).toEqual([
        `DTSTART;TZID=${ZH}:20261214T090000`, "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:N weekly", "LOCATION:The second press",
      ]);
      expect(held(b)).toEqual({ members: 2, days14: 1 });
      // The first press's retry: the day the second's applied row keeps bars it. Nothing is sent, and no day is there twice.
      expect(await b.retry("p1")).toBe("pending");
      const fromRetry = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["p1 refused version_stale", "p1:2 refused earlier_refused", "p2 applied", "p2:2 applied"]);
      expect(b.sent(fromRetry, "n.ics")).toEqual([]);
      expect(held(b)).toEqual({ members: 2, days14: 1 });
    });
  });

  describe("a press's own end, its answer lost, is found its own beside writes that never ended the series there (the second recheck's first finding)", () => {
    const MILA = "mila@studio.example.test";
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const DEC_21 = String(Date.UTC(2026, 11, 21, 8));
    const DEC_28 = String(Date.UTC(2026, 11, 28, 8));
    type Row = { id: string; updatedAt: Date };
    type B = Awaited<ReturnType<typeof bench>>;
    /** Ten Mondays at 09:00 in Zurich, from 23 November, these days excluded. */
    const MONDAYS = (uid: string, excluded: string[] = []) => memberText({
      uid: `${uid}@studio.example.test`, tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln", excluded,
    });
    const split = (s: Row, day: string, change: Record<string, unknown>) =>
      ({ kind: "calendar_event_update", ...on(s), scope: { kind: "following", at: day, newEventId: randomUUID() }, change });
    const letGo = (s: Row, day: string) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "following", at: day } });
    const cancelDay = (s: Row, day: string) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "occurrence", at: day } });
    /** A writer whose first series' end that reaches it lands at the server and loses its answer; the ends after it, to the `silentUntil`-th, never reach the server. */
    const losing = (silentUntil = 0) => (real: CalendarWriter): CalendarWriter => {
      let calls = 0;
      return {
        ...real,
        async endSeries(...args: Parameters<CalendarWriter["endSeries"]>) {
          calls += 1;
          if (calls === 1) {
            await real.endSeries(...args);
            throw new Error("the connection dropped after the server answered");
          }
          if (calls <= silentUntil) throw new Error("the connection is down");
          return real.endSeries(...args);
        },
      };
    };
    const ENDED_14 = "RRULE:FREQ=WEEKLY;UNTIL=20261214T075959Z;BYDAY=MO";
    /** Every writing request the server received from `from` on, whole: method, member, preconditions and body. */
    const whole = (b: B, from: number) => b.sent(from, "s.ics").map((x) => ({ ...x, body: steady(x.body) }));
    const daysAtTheServer = (b: B): number => [...b.held().values()].flatMap((t) => daysOf(t)).length;
    /** The press on the days from 14 December, with a new title; its end lands and its answer is lost; the next turn tries it again. */
    const pressLosingItsAnswer = async (b: B, key: string): Promise<{ readonly door: string; readonly text: string; readonly from: number }> => {
      const text = b.held().get("s.ics")!;
      const [s] = await b.rows("s.ics");
      const from = b.dav.seen.length;
      const door = await b.door(key, split(s!, DEC_14, { title: "The new term" }));
      expect(await b.turn()).toBe("synced");
      expect(await b.turn()).toBe("synced");
      return { door, text, from };
    };
    const payloads = async (b: B): Promise<Record<string, unknown>> => Object.fromEntries((await w.db.select({ key: calWrites.idempotencyKey, payload: calWrites.payload })
      .from(calWrites).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.state, "applied")))).map((r) => [r.key, r.payload]));

    it("(a) is found its own beside an applied write of the series that ended nothing: a cancel of a day it does not have, one day cancelled twice", async () => {
      const BEFORE: Record<string, {
        readonly text: string;
        readonly acts: (s: Row) => [string, unknown][];
        readonly again?: (s: Row) => unknown;
      }> = {
        "nothing before (the control)": { text: MONDAYS("q1n", ["20261228T090000"]), acts: () => [] },
        "a cancel of a day the series does not have (done as it stands, nothing sent)": { text: MONDAYS("q1a", ["20261228T090000"]), acts: (s) => [["c", cancelDay(s, DEC_28)]] },
        "a cancel of a day the series has (written; the control)": { text: MONDAYS("q1w", ["20261228T090000"]), acts: (s) => [["c", cancelDay(s, DEC_21)]] },
        "one day cancelled twice (the first written, the second finds it done)": {
          text: MONDAYS("q1b", ["20261228T090000"]), acts: (s) => [["c1", cancelDay(s, DEC_21)]],
          again: (s) => cancelDay(s, DEC_21),
        },
      };
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      for (const [name, c] of Object.entries(BEFORE)) {
        const b = await bench({ "s.ics": c.text }, { mailboxes: [MILA], wrap: losing() });
        const [s] = await b.rows("s.ics");
        const doors0: string[] = [];
        for (const [key, act] of c.acts(s!)) doors0.push(await b.door(key, act));
        if (doors0.length > 0) expect(await b.turn()).toBe("synced");
        if (c.again !== undefined) {
          expect(await b.writes()).toEqual(["c1 applied"]);
          const [refreshed] = await b.rows("s.ics");
          const beforeRepeat = b.dav.seen.length;
          doors0.push(await b.door("c2", c.again(refreshed!)));
          expect(await b.turn()).toBe("synced");
          expect(await b.writes()).toEqual(["c1 applied", "c2 applied"]);
          expect(whole(b, beforeRepeat)).toEqual([]);
        }
        const before = await b.writes();
        const { door, text, from } = await pressLosingItsAnswer(b, "k");
        seen[name] = {
          doors0, door, rows: await b.writes(), sent: whole(b, from), days: [daysOf(c.text).length, daysAtTheServer(b)], members: b.held().size,
          retries: [await b.retry("k"), await b.retry("k:2")], kept: await payloads(b),
        };
        // Where 21 December was cancelled before the press (an EXDATE line more), the new series carries that day too.
        const written = name.includes("written") || name.includes("twice");
        const days = written ? 8 : 9;
        want[name] = {
          doors0: doors0.map(() => "pending"), door: "pending", rows: [...before, "k applied", "k:2 applied"],
          sent: [
            { method: "PUT", member: "s.ics", ifMatch: written ? '"studio-s.ics-2"' : '"s.ics-1"', ifNoneMatch: null, body: endedFrom(text, ENDED_14) },
            {
              method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*",
              body: madeOf(text, {
                rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO", exdates: [`EXDATE;TZID=${ZH}:20261228T090000`, ...(written ? [`EXDATE;TZID=${ZH}:20261221T090000`] : [])],
              }),
            },
          ],
          days: [9, days], members: 2, retries: ["409 calendar_write_left", "409 calendar_write_left"],
          // Applied rows keep the retry fingerprint and, for the split, the day the series ended.
          kept: Object.fromEntries([...before.map((r) => r.split(" ")[0]!), "k", "k:2"].map((key) => [
            key, { fingerprint: expect.stringMatching(/^v1:[0-9a-f]{64}$/), ...(key === "k" ? { ended: DEC_14 } : {}) },
          ])),
        };
      }
      expect(seen).toEqual(want);
    }, 120_000);

    it("(b) is found its own beside an earlier press on the same day that the drain refused before anything of it was sent", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      for (const earlier of [false, true]) {
        const b = await bench({ "s.ics": MONDAYS("q7") }, { mailboxes: [MILA], wrap: losing() });
        const steps: Record<string, unknown> = {};
        if (earlier) {
          // A change of the series' repeat, and a press right behind it on the copy before it: the drain refuses the press
          // content_refused ("press again once the change before it is done"), nothing of it sent.
          const [s0] = await b.rows("s.ics");
          const from0 = b.dav.seen.length;
          steps.doors0 = [
            await b.door("c", { kind: "calendar_event_update", ...on(s0!), scope: { kind: "record" }, change: { repeat: "FREQ=WEEKLY;BYDAY=MO;COUNT=12" } }),
            await b.door("k1", split(s0!, DEC_14, { title: "The new term" })),
          ];
          expect(await b.turn()).toBe("synced");
          steps.first = await b.writes();
          steps.firstSent = b.sent(from0, "s.ics").map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch]);
        }
        const { door, text, from } = await pressLosingItsAnswer(b, "k2");
        seen[earlier ? "after an earlier press refused" : "the control"] = {
          ...steps, door, rows: await b.writes(), sent: whole(b, from), days: daysAtTheServer(b), members: b.held().size,
          retries: [await b.retry("k2"), await b.retry("k2:2")],
        };
        want[earlier ? "after an earlier press refused" : "the control"] = {
          ...(earlier ? {
            doors0: ["pending", "pending"], first: ["c applied", "k1 refused content_refused", "k1:2 refused earlier_refused"],
            firstSent: [["PUT", "s.ics", '"s.ics-1"', null]],
          } : {}),
          door: "pending", rows: [...(earlier ? ["c applied", "k1 refused content_refused", "k1:2 refused earlier_refused"] : []), "k2 applied", "k2:2 applied"],
          sent: [
            { method: "PUT", member: "s.ics", ifMatch: earlier ? '"studio-s.ics-2"' : '"s.ics-1"', ifNoneMatch: null, body: endedFrom(text, ENDED_14) },
            { method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeOf(text, { rule: `FREQ=WEEKLY;COUNT=${earlier ? 9 : 7};BYDAY=MO` }) },
          ],
          days: earlier ? 12 : 10, members: 2, retries: ["409 calendar_write_left", "409 calendar_write_left"],
        };
      }
      expect(seen).toEqual(want);
    }, 120_000);

    it("(c) is found its own on the person's retry, after its end landed and its eight attempts never heard back", async () => {
      const b = await bench({ "s.ics": MONDAYS("q3") }, { mailboxes: [MILA], wrap: losing(8) });
      const text = b.held().get("s.ics")!;
      const [s] = await b.rows("s.ics");
      const from = b.dav.seen.length;
      expect(await b.door("k", split(s!, DEC_14, { title: "The new term" }))).toBe("pending");
      for (let i = 0; i < 8; i++) expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["k refused unknown", "k:2 refused earlier_refused"]);
      // Only the first attempt reached the server: it ended the series there.
      expect(whole(b, from)).toEqual([{ method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null, body: endedFrom(text, ENDED_14) }]);
      expect(await b.retry("k")).toBe("pending");
      const fromRetry = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["k applied", "k:2 applied"]);
      // The retry finds the end its own (read, nothing sent of it again) and makes the days from 14 December a series of their own.
      expect(whole(b, fromRetry)).toEqual([{ method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeOf(text, { rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" }) }]);
      expect([daysAtTheServer(b), b.held().size]).toEqual([10, 2]);
    }, 120_000);

    it("takes the end for its own where another press on that day stands refused, for its version or with a word that waits for time: the press makes the series, and the other's retry is refused by the kept day (the third recheck's first finding)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      for (const [refusal, attempts] of [["version_stale", 2], ["timeout", 8]] as const) {
        const b = await bench({ "s.ics": MONDAYS("q8") }, { mailboxes: [MILA], wrap: losing() });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        expect([await b.door("p1", split(s!, DEC_14, { place: "Studio 1" })), await b.door("p2", split(s!, DEC_14, { title: "The new term" }))]).toEqual(["pending", "pending"]);
        // The first press's end lands and its answer is lost; then it stands refused with that word.
        expect(await b.turn()).toBe("synced");
        await w.db.update(calWrites).set({ state: "refused", refusal, attempts, nextAttemptAt: null })
          .where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "p1")));
        await w.db.update(calWrites).set({ state: "refused", refusal: "earlier_refused", nextAttemptAt: null })
          .where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "p1:2")));
        // The second press was tried once already (cut off before it asked anything): a refused press bars nothing, so the end at the server is the second's to find.
        await w.db.update(calWrites).set({ attempts: 1 }).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "p2")));
        const from = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        const taken = { rows: await b.writes(), sent: whole(b, from), members: b.held().size, days: daysAtTheServer(b) };
        // The other press's retry (the door takes none of a press refused for its version): barred by the day the second press's row keeps.
        const retry = await b.retry("p1");
        const fromRetry = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        seen[refusal] = { taken, retry, rows: await b.writes(), sent: whole(b, fromRetry), members: b.held().size, days: daysAtTheServer(b) };
        want[refusal] = {
          taken: {
            rows: [`p1 refused ${refusal}`, "p1:2 refused earlier_refused", "p2 applied", "p2:2 applied"],
            sent: [{ method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeOf(text, { rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" }) }],
            members: 2, days: 10,
          },
          retry: refusal === "version_stale" ? "409 calendar_write_left" : "pending",
          rows: ["p1 refused version_stale", "p1:2 refused earlier_refused", "p2 applied", "p2:2 applied"], sent: [], members: 2, days: 10,
        };
      }
      expect(seen).toEqual(want);
    }, 120_000);

    /** A writer whose series' ends go as the plan says, call by call, whoever's they are: "lost" lands at the server and loses its answer, "cut" never reaches it. */
    const going = (plan: readonly string[]) => (real: CalendarWriter): CalendarWriter => {
      let n = 0;
      return {
        ...real,
        async endSeries(...args: Parameters<CalendarWriter["endSeries"]>) {
          const how = plan[n++] ?? "real";
          if (how === "cut") throw new Error("the connection is down");
          const done = await real.endSeries(...args);
          if (how === "lost") throw new Error("the connection dropped after the server answered");
          return done;
        },
      };
    };
    const times = (how: string, n: number): string[] => Array.from({ length: n }, () => how);
    const turns = async (b: B, n: number): Promise<void> => {
      for (let i = 0; i < n; i++) expect(await b.turn()).toBe("synced");
    };
    /** A writer whose new series go as the plan says, call by call: "refused" is answered 403 by the server, "cut" never reaches it. */
    const making = (plan: readonly string[], at: { b?: B }) => (real: CalendarWriter): CalendarWriter => {
      let n = 0;
      return {
        ...real,
        async continueSeries(...args: Parameters<CalendarWriter["continueSeries"]>) {
          const how = plan[n++] ?? "real";
          if (how === "cut") throw new Error("the connection is down");
          if (how === "refused") {
            const uid = args[2].key.hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
            at.b!.dav.refuseNextWriteOf(`${uid}.ics`, 403);
          }
          return real.continueSeries(...args);
        },
      };
    };
    const benchMaking = async (uid: string, plan: readonly string[]): Promise<B> => {
      const at: { b?: B } = {};
      at.b = await bench({ "s.ics": MONDAYS(uid) }, { mailboxes: [MILA], wrap: making(plan, at) });
      return at.b;
    };
    const NEW_TERM = { title: "The new term" };
    const STUDIO_3 = { place: "Studio 3" };
    /** The two requests of a press, whole: the series' end under its tag, and the series the days from 14 December on become. */
    const endOf = (text: string, tag = '"s.ics-1"') => ({ method: "PUT", member: "s.ics", ifMatch: tag, ifNoneMatch: null, body: endedFrom(text, ENDED_14) });
    const seriesOfTheRest = (text: string, exdates: string[] = []) =>
      ({ method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeOf(text, { rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO", exdates }) });

    it("is barred by no refused press on that day: in each of the third recheck's five orders one press takes the end and makes the series, and no day is lost or twice (its first finding)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const after = async (b: B, fromRetry: number) => ({ rows: await b.counted(), sent: whole(b, fromRetry), days: daysAtTheServer(b), members: b.held().size });
      {
        const name = "1 two devices press before the first turn; the first's end lands, eight attempts unheard; the second is tried; then the first's retry";
        const b = await bench({ "s.ics": MONDAYS("h1a") }, { mailboxes: [MILA], wrap: going(["lost", ...times("cut", 7)]) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("a", split(s!, DEC_14, NEW_TERM)), await b.door("b", split(s!, DEC_14, STUDIO_3))];
        await turns(b, 9);
        const before = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const fromRetry = b.dav.seen.length;
        const retry = await b.retry("a");
        await turns(b, 2);
        seen[name] = { doors, before, retry, ...(await after(b, fromRetry)), retries: [await b.retry("a"), await b.retry("b")] };
        want[name] = {
          doors: ["pending", "pending"],
          before: { rows: ["a refused unknown attempts=8", "a:2 refused earlier_refused attempts=0", "b refused version_stale attempts=1", "b:2 refused earlier_refused attempts=0"], sent: [endOf(text)], days: 3 },
          retry: "pending",
          rows: ["a applied attempts=2", "a:2 applied attempts=1", "b refused version_stale attempts=1", "b:2 refused earlier_refused attempts=0"],
          sent: [seriesOfTheRest(text)], days: 10, members: 2, retries: ["409 calendar_write_left", "409 calendar_write_left"],
        };
      }
      {
        const name = "2 after a day's cancel is applied, a press is refused for time with nothing at the server; pressed again, that end lands and its answer is lost; then the first's retry";
        const b = await bench({ "s.ics": MONDAYS("h1b") }, { mailboxes: [MILA], wrap: going([...times("cut", 8), "lost"]) });
        const [s0] = await b.rows("s.ics");
        const doors = [await b.door("c", cancelDay(s0!, DEC_21))];
        await turns(b, 1);
        const text = b.held().get("s.ics")!;
        const [s1] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        doors.push(await b.door("p1", split(s1!, DEC_14, STUDIO_3)));
        await turns(b, 8);
        const [s2] = await b.rows("s.ics");
        doors.push(await b.door("p2", split(s2!, DEC_14, NEW_TERM)));
        await turns(b, 2);
        const before = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const fromRetry = b.dav.seen.length;
        const retry = await b.retry("p1");
        await turns(b, 1);
        seen[name] = { doors, before, retry, ...(await after(b, fromRetry)), retries: [await b.retry("p1"), await b.retry("p2")] };
        want[name] = {
          doors: ["pending", "pending", "pending"],
          before: {
            rows: ["c applied attempts=1", "p1 refused unknown attempts=8", "p1:2 refused earlier_refused attempts=0", "p2 applied attempts=2", "p2:2 applied attempts=1"],
            sent: [endOf(text, '"studio-s.ics-2"'), seriesOfTheRest(text, [`EXDATE;TZID=${ZH}:20261221T090000`])], days: 9,
          },
          retry: "pending",
          rows: ["c applied attempts=1", "p1 refused version_stale attempts=2", "p1:2 refused earlier_refused attempts=0", "p2 applied attempts=2", "p2:2 applied attempts=1"],
          sent: [], days: 9, members: 2, retries: ["409 calendar_write_left", "409 calendar_write_left"],
        };
      }
      {
        const name = "3 both presses refused for time, the first's end at the server; both retried in one turn";
        const b = await bench({ "s.ics": MONDAYS("h1c") }, { mailboxes: [MILA], wrap: going(["lost", ...times("cut", 15)]) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("a", split(s!, DEC_14, STUDIO_3)), await b.door("b", split(s!, DEC_14, NEW_TERM))];
        await turns(b, 16);
        const before = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const fromRetry = b.dav.seen.length;
        const retry = [await b.retry("a"), await b.retry("b")];
        await turns(b, 1);
        seen[name] = { doors, before, retry, ...(await after(b, fromRetry)), retries: [await b.retry("a"), await b.retry("b")] };
        want[name] = {
          doors: ["pending", "pending"],
          before: { rows: ["a refused unknown attempts=8", "a:2 refused earlier_refused attempts=0", "b refused unknown attempts=8", "b:2 refused earlier_refused attempts=0"], sent: [endOf(text)], days: 3 },
          retry: ["pending", "pending"],
          // The first, tried first, is barred by the second (owed, with an attempt counted); the second then finds the end its own.
          rows: ["a refused version_stale attempts=2", "a:2 refused earlier_refused attempts=0", "b applied attempts=2", "b:2 applied attempts=1"],
          sent: [seriesOfTheRest(text)], days: 10, members: 2, retries: ["409 calendar_write_left", "409 calendar_write_left"],
        };
      }
      {
        const name = "4 the first refused for time with nothing at the server, and retried while the second's lost end waits";
        const b = await bench({ "s.ics": MONDAYS("h1d") }, { mailboxes: [MILA], wrap: going([...times("cut", 8), "lost"]) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("a", split(s!, DEC_14, STUDIO_3)), await b.door("b", split(s!, DEC_14, NEW_TERM))];
        await turns(b, 9);
        const before = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const fromRetry = b.dav.seen.length;
        const retry = await b.retry("a");
        await turns(b, 1);
        seen[name] = { doors, before, retry, ...(await after(b, fromRetry)), retries: [await b.retry("a"), await b.retry("b")] };
        want[name] = {
          doors: ["pending", "pending"],
          before: { rows: ["a refused unknown attempts=8", "a:2 refused earlier_refused attempts=0", "b pending attempts=1", "b:2 pending attempts=0"], sent: [endOf(text)], days: 3 },
          retry: "pending",
          rows: ["a refused version_stale attempts=2", "a:2 refused earlier_refused attempts=0", "b applied attempts=2", "b:2 applied attempts=1"],
          sent: [seriesOfTheRest(text)], days: 10, members: 2, retries: ["409 calendar_write_left", "409 calendar_write_left"],
        };
      }
      {
        const name = "5 a letting go of those days pressed beside the press; the press's retry after eight unheard attempts";
        const b = await bench({ "s.ics": MONDAYS("h1e") }, { mailboxes: [MILA], wrap: going(["lost", ...times("cut", 7)]) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM)), await b.door("l", letGo(s!, DEC_14))];
        await turns(b, 9);
        const before = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const fromRetry = b.dav.seen.length;
        const retry = await b.retry("k");
        await turns(b, 1);
        seen[name] = { doors, before, retry, ...(await after(b, fromRetry)), retries: [await b.retry("k"), await b.retry("l")] };
        want[name] = {
          doors: ["pending", "pending"],
          before: { rows: ["k refused unknown attempts=8", "k:2 refused earlier_refused attempts=0", "l refused version_stale attempts=1"], sent: [endOf(text)], days: 3 },
          retry: "pending",
          rows: ["k applied attempts=2", "k:2 applied attempts=1", "l refused version_stale attempts=1"],
          sent: [seriesOfTheRest(text)], days: 10, members: 2, retries: ["409 calendar_write_left", "409 calendar_write_left"],
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("is barred where another press on that day is owed with an attempt counted: of two presses the one whose own end landed makes the series, with its own change (the third recheck's first unheld half)", async () => {
      // The first press never reaches the server and is refused for time; the second's end lands and its answer is lost: it is owed,
      // with an attempt. The first is retried (one attempt counted) and tried first: the end at the server is not its to take.
      const b = await bench({ "s.ics": MONDAYS("h1i") }, { mailboxes: [MILA], wrap: going([...times("cut", 8), "lost"]) });
      const text = b.held().get("s.ics")!;
      const [s] = await b.rows("s.ics");
      expect([await b.door("a", split(s!, DEC_14, STUDIO_3)), await b.door("b", split(s!, DEC_14, NEW_TERM))]).toEqual(["pending", "pending"]);
      await turns(b, 9);
      expect(await b.counted()).toEqual(["a refused unknown attempts=8", "a:2 refused earlier_refused attempts=0", "b pending attempts=1", "b:2 pending attempts=0"]);
      expect(await b.retry("a")).toBe("pending");
      expect(await b.counted()).toEqual(["a pending attempts=1", "a:2 pending attempts=0", "b pending attempts=1", "b:2 pending attempts=0"]);
      const from = b.dav.seen.length;
      await turns(b, 1);
      expect(await b.counted()).toEqual(["a refused version_stale attempts=2", "a:2 refused earlier_refused attempts=0", "b applied attempts=2", "b:2 applied attempts=1"]);
      // One request: the series the second press makes, with its title; the first press's place is nowhere.
      expect(whole(b, from)).toEqual([seriesOfTheRest(text)]);
      expect([...b.held().values()].some((t) => t.includes("LOCATION:Studio 3"))).toBe(false);
      expect([daysAtTheServer(b), b.held().size]).toEqual([10, 2]);
    }, 120_000);

    it("keeps the attempt of a series' end the worker gave back: stopped, or its turn out of time, as the end's request was carried out, the next turn finds the end its own (the third recheck's second finding)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const RUNS: Record<string, { readonly reason: Error | undefined; readonly before: boolean; readonly ended: string; readonly removal?: boolean; readonly letGo?: boolean }> = {
        "the worker stops as the end's request is carried out": { reason: undefined, before: false, ended: "halted" },
        "the turn's own time runs out as the end's request is carried out": { reason: new CalendarTurnOverdue(), before: false, ended: "backed_off" },
        "the worker stops as the request that lets the days from 14 December go is carried out": { reason: undefined, before: false, ended: "halted", removal: true },
        "the worker stops as the end's request is carried out, and the person lets the press go before the next turn": { reason: undefined, before: false, ended: "halted", letGo: true },
        "the worker stopped before anything was asked (the control)": { reason: undefined, before: true, ended: "halted" },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const b = await bench({ "s.ics": MONDAYS("h2") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("k", run.removal === true ? letGo(s!, DEC_14) : split(s!, DEC_14, NEW_TERM));
        const stop = new AbortController();
        // The request is carried out at the server; before its answer goes out, the turn's signal ends.
        if (run.before) stop.abort();
        else b.dav.afterNextWrite(() => stop.abort(run.reason));
        const cut = await b.turnOn(stop.signal);
        const afterTheCut = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b), lettingGo: run.letGo === true ? await b.dismiss("k") : "(not asked)" };
        const fromNext = b.dav.seen.length;
        await b.turn();
        await b.turn();
        const [now] = await b.rows("s.ics");
        seen[name] = {
          door, cut, afterTheCut, rows: await b.counted(), sent: whole(b, fromNext), days: daysAtTheServer(b), members: b.held().size,
          retry: await b.retry("k"), afresh: await b.door("k-afresh", split(now!, DEC_14, NEW_TERM)),
        };
        const second = run.removal === true ? [] : ["k:2 pending attempts=0"];
        want[name] = {
          door: "pending", cut: run.ended,
          afterTheCut: run.before
            ? { rows: ["k pending attempts=0", ...second], sent: [], days: 10, lettingGo: "(not asked)" }
            // Its attempt is kept: owed with an attempt, it is under way and cannot be let go.
            : { rows: ["k pending attempts=1", ...second], sent: [endOf(text)], days: 3, lettingGo: run.letGo === true ? "409 calendar_write_left" : "(not asked)" },
          rows: run.removal === true ? ["k applied attempts=2"] : run.before ? ["k applied attempts=1", "k:2 applied attempts=1"] : ["k applied attempts=2", "k:2 applied attempts=1"],
          // The store still holds the copy the press was made on: the same end goes again under its tag, the server refuses the
          // precondition, and the end read there is the press's own (an attempt of it was claimed before).
          sent: [endOf(text), ...(run.removal === true ? [] : [seriesOfTheRest(text)])],
          days: run.removal === true ? 3 : 10, members: run.removal === true ? 1 : 2, retry: "409 calendar_write_left", afresh: "400 validation_failed",
        };
      }
      expect(seen).toEqual(want);
    }, 120_000);

    it("is looked at, never sent, where a press too old to send was claimed before: closed as done where the member at the provider ends exactly where it ends it, on another version, and the end may be its own; otherwise it expires, and nothing goes late (the third recheck's third finding; the fourth recheck's, of the end cut and then too old)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const EARLIER = "RRULE:FREQ=WEEKLY;UNTIL=20261207T075959Z;BYDAY=MO";
      const RUNS: Record<string, {
        readonly plan: readonly string[]; readonly turns: number; readonly hours: number; readonly retry: boolean;
        /** The rule someone else leaves the series with, read into the store before the wait. */
        readonly theirs?: string;
        readonly other?: boolean;
        /** The letting go of those days recorded past the door on the copy someone else ended there, one attempt counted. */
        readonly planted?: boolean;
        /** The first turn cut as the end's request is carried out: the worker's stop, or the turn's own time (no reading follows). */
        readonly cut?: Error | "stop";
      }> = {
        "the end lands, eight attempts never hear back; the person's retry 73 hours after the press": { plan: ["lost", ...times("cut", 7)], turns: 8, hours: 73, retry: true },
        "the end lands, its answer is lost, and no turn runs for 73 hours": { plan: ["lost"], turns: 1, hours: 73, retry: false },
        "the end lands as the worker stops, no reading after it, and no turn runs for 73 hours (the fourth recheck's order)": { plan: [], turns: 0, hours: 73, retry: false, cut: "stop" },
        "the end lands as the turn's own time runs out, no reading after it, and no turn runs for 73 hours (the fourth recheck's order)": { plan: [], turns: 0, hours: 73, retry: false, cut: new CalendarTurnOverdue() },
        "the same retry 71 hours after the press (the control: sent, and found its own)": { plan: ["lost", ...times("cut", 7)], turns: 8, hours: 71, retry: true },
        "nothing of it at the server (its one attempt never landed), 73 hours": { plan: ["cut"], turns: 1, hours: 73, retry: false },
        "never claimed, someone else's end at that very day, 73 hours": { plan: [], turns: 0, hours: 73, retry: false, theirs: ENDED_14 },
        "claimed before (its one attempt never landed), someone else's end at an earlier day, 73 hours": { plan: ["cut"], turns: 1, hours: 73, retry: false, theirs: EARLIER },
        "recorded past the door on the very copy that ends there, claimed before, 73 hours": { plan: [], turns: 0, hours: 73, retry: false, theirs: ENDED_14, planted: true },
        "claimed before, 73 hours, and another press's applied row keeps that day": { plan: ["lost", "real", "cut"], turns: 2, hours: 73, retry: false, other: true },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const b = await bench({ "s.ics": MONDAYS("h3") }, { mailboxes: [MILA], wrap: going(run.plan) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [
          ...(run.other === true ? [await b.door("a", split(s!, DEC_14, STUDIO_3))] : []),
          ...(run.planted === true ? [] : [await b.door("k", split(s!, DEC_14, NEW_TERM))]),
        ];
        if (run.cut !== undefined) {
          const stop = new AbortController();
          b.dav.afterNextWrite(() => stop.abort(run.cut === "stop" ? undefined : run.cut));
          await b.turnOn(stop.signal);
        }
        await turns(b, run.turns);
        if (run.theirs !== undefined) {
          b.dav.put("studio", "s.ics", text.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", run.theirs), '"s.ics-theirs"');
          expect(await b.read()).toBe("synced");
        }
        if (run.planted === true) {
          const [ended] = await b.rows("s.ics");
          await b.plant("k", letGo(ended!, DEC_14));
          await w.db.update(calWrites).set({ attempts: 1 }).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "k")));
        }
        const before = { rows: await b.counted(), sent: whole(b, from).length, days: daysAtTheServer(b) };
        await b.age(run.hours);
        const fromWait = b.dav.seen.length;
        const retry = run.retry ? await b.retry("k") : "(none)";
        await turns(b, 1);
        const after = { rows: await b.counted(), sent: whole(b, fromWait), days: daysAtTheServer(b), members: b.held().size };
        seen[name] = { doors, before, retry, after, again: [await b.retry("k"), await b.retry("k:2")] };
        // The look is a claim: a row looked at counts one attempt more. Nothing of the end is sent; the second part is the repair.
        const done = { rows: ["k applied attempts=2", "k:2 applied attempts=1"], sent: [seriesOfTheRest(text)], days: 10, members: 2 };
        const expired = (attempts: number, days: number) => ({ rows: [`k refused expired attempts=${attempts}`, "k:2 refused earlier_refused attempts=0"], sent: [], days, members: 1 });
        want[name] = {
          doors: doors.map(() => "pending"), before: undefined as unknown, retry: run.retry ? "pending" : "(none)", after: undefined as unknown,
          again: ["409 calendar_write_left", "409 calendar_write_left"],
        };
        const w0 = want[name] as { before: unknown; after: unknown; again: unknown };
        if (name.startsWith("the end lands, eight")) {
          w0.before = { rows: ["k refused unknown attempts=8", "k:2 refused earlier_refused attempts=0"], sent: 1, days: 3 };
          w0.after = done;
        } else if (name.startsWith("the end lands, its answer") || name.startsWith("the end lands as")) {
          // The store has read the end (its answer lost) or has not (the turn cut before its reading): the provider is looked at.
          w0.before = { rows: ["k pending attempts=1", "k:2 pending attempts=0"], sent: 1, days: 3 };
          w0.after = done;
        } else if (name.startsWith("the same retry 71")) {
          w0.before = { rows: ["k refused unknown attempts=8", "k:2 refused earlier_refused attempts=0"], sent: 1, days: 3 };
          w0.after = done;
        } else if (name.startsWith("nothing of it")) {
          // The member at the provider is the copy the press was made on: not ended there. It expires.
          w0.before = { rows: ["k pending attempts=1", "k:2 pending attempts=0"], sent: 0, days: 10 };
          w0.after = expired(2, 10);
          // The retry of a write refused `expired` is taken, and takes its second part along; too old still, it expires again.
          w0.again = ["pending", "pending"];
        } else if (name.startsWith("never claimed")) {
          // Never claimed, it was never sent: nothing of it can be at the provider. It expires, and is not looked at.
          w0.before = { rows: ["k pending attempts=0", "k:2 pending attempts=0"], sent: 0, days: 3 };
          w0.after = expired(0, 3);
          // The retry of a write refused `expired` is taken, and takes its second part along; too old still, it expires again.
          w0.again = ["pending", "pending"];
        } else if (name.startsWith("claimed before (its one attempt")) {
          // The member at the provider is another version, and ends elsewhere: not where the press ends it. It expires.
          w0.before = { rows: ["k pending attempts=1", "k:2 pending attempts=0"], sent: 0, days: 2 };
          w0.after = expired(2, 2);
          w0.again = ["pending", "pending"];
        } else if (name.startsWith("recorded past the door")) {
          // The member ends there, on the very version the row was recorded on: no attempt of it made that end. It expires.
          w0.before = { rows: ["k pending attempts=1"], sent: 0, days: 3 };
          w0.after = { rows: ["k refused expired attempts=2"], sent: [], days: 3, members: 1 };
          w0.again = ["pending", "(no such write)"];
        } else {
          // The other press took the end and made the series; this one, tried once and never heard, is too old now: the day the
          // other's row keeps says the end at the provider is not its own, and it expires. No day is there twice.
          w0.before = { rows: ["a applied attempts=2", "a:2 applied attempts=1", "k pending attempts=1", "k:2 pending attempts=0"], sent: 2, days: 10 };
          w0.after = { rows: ["a applied attempts=2", "a:2 applied attempts=1", "k refused expired attempts=2", "k:2 refused earlier_refused attempts=0"], sent: [], days: 10, members: 2 };
          // The retry of a write refused `expired` is taken, and takes its second part along; too old still, it expires again.
          w0.again = ["pending", "pending"];
        }
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("waits, as any attempt does, where the look at the provider for a series' end too old to send cannot read the member; the next turn's look finds the end its own (the fourth recheck's, of the end cut and then too old)", async () => {
      const b = await bench({ "s.ics": MONDAYS("n4r") }, { mailboxes: [MILA] });
      const text = b.held().get("s.ics")!;
      const [s] = await b.rows("s.ics");
      const from = b.dav.seen.length;
      expect(await b.door("k", split(s!, DEC_14, NEW_TERM))).toBe("pending");
      const stop = new AbortController();
      b.dav.afterNextWrite(() => stop.abort());
      expect(await b.turnOn(stop.signal)).toBe("halted");
      expect([await b.counted(), whole(b, from), daysAtTheServer(b)]).toEqual([["k pending attempts=1", "k:2 pending attempts=0"], [endOf(text)], 3]);
      await b.age(73);
      // The look's read of the member is answered 503: it waits, its attempt counted; nothing is sent.
      const fromWait = b.dav.seen.length;
      b.dav.answerNext(503);
      await turns(b, 1);
      expect([await b.counted(), whole(b, fromWait), daysAtTheServer(b)]).toEqual([["k pending attempts=2", "k:2 pending attempts=0"], [], 3]);
      await turns(b, 1);
      expect([await b.counted(), whole(b, fromWait), daysAtTheServer(b), b.held().size]).toEqual([["k applied attempts=3", "k:2 applied attempts=1"], [seriesOfTheRest(text)], 10, 2]);
    }, 120_000);

    /** The series in its two spellings, each with the end another program leaves it at 14 December and the series that program makes of the rest. */
    const SPELLINGS: Record<string, { readonly text: string; readonly day: string; readonly ended: string; readonly theirs: string }> = {
      "a series at a time of day (their end the second before that day, as this program writes it)": {
        text: MONDAYS("m4"), day: DEC_14, ended: ENDED_14,
        theirs: memberText({ uid: "theirs@studio.example.test", tz: ZH, start: "20261214T090000", end: "20261214T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=7", summary: "Kiln, their way" }),
      },
      "a series of whole days (their end the day before, as every program writes it)": {
        text: memberText({ uid: "m4w@studio.example.test", tz: null, start: "20261123", end: "20261124", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln" }),
        day: String(Date.UTC(2026, 11, 14)), ended: "RRULE:FREQ=WEEKLY;UNTIL=20261213;BYDAY=MO",
        theirs: memberText({ uid: "theirsw@studio.example.test", tz: null, start: "20261214", end: "20261215", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=7", summary: "Kiln, their way" }),
      },
    };

    it("goes again from its first attempt where the provider answered it with a refusal: its retry takes no end someone else made since for its own, and no day is made twice (the third recheck's fourth finding)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      for (const [spelling, c] of Object.entries(SPELLINGS)) {
        for (const then of ["their end at that very day and their own series of the rest, then the retry", "the same, not retried (the control)", "nothing of theirs, then the retry (the control)"]) {
          const name = `${spelling}: ${then}`;
          const b = await bench({ "s.ics": c.text }, { mailboxes: [MILA] });
          const [s] = await b.rows("s.ics");
          const from = b.dav.seen.length;
          const door = await b.door("k", split(s!, c.day, NEW_TERM));
          // The provider answers the end with a refusal (the calendar takes no write just then): nothing of it lands.
          b.dav.answerNext(403);
          await turns(b, 1);
          const refused = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
          if (!then.startsWith("nothing of theirs")) {
            // Someone else, in another program: the series ended at that very day, the rest a series of their own.
            b.dav.put("studio", "s.ics", c.text.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", c.ended), '"s.ics-theirs"');
            b.dav.put("studio", "theirs.ics", c.theirs, '"theirs-1"');
            expect(await b.read()).toBe("synced");
          }
          const fromRetry = b.dav.seen.length;
          const retry = then.includes("not retried") ? "(none)" : await b.retry("k");
          await turns(b, 2);
          const all = [...b.held().values()].flatMap((t) => daysOf(t));
          seen[name] = {
            door, refused, retry, rows: await b.counted(), sent: whole(b, fromRetry).map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch]),
            days: all.length, twice: all.filter((d, i) => all.indexOf(d) !== i).length, members: b.held().size,
          };
          const answered = { rows: ["k refused read_only attempts=1", "k:2 refused earlier_refused attempts=0"], sent: [{ method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null, body: endedFrom(c.text, c.ended) }], days: 10 };
          want[name] = then.startsWith("nothing of theirs")
            // The half-done cell "first refused by the provider, retry the first": it goes again as a first attempt, and both parts are written.
            ? { door: "pending", refused: answered, retry: "pending", rows: ["k applied attempts=1", "k:2 applied attempts=1"], sent: [["PUT", "s.ics", '"s.ics-1"', null], ["PUT", "a new member", null, "*"]], days: 10, twice: 0, members: 2 }
            : then.includes("not retried")
              ? { door: "pending", refused: answered, retry: "(none)", rows: answered.rows, sent: [], days: 10, twice: 0, members: 2 }
              // On its first attempt again, the end it finds at the server is not its own: refused for its version, nothing sent.
              : { door: "pending", refused: answered, retry: "pending", rows: ["k refused version_stale attempts=1", "k:2 refused earlier_refused attempts=0"], sent: [], days: 10, twice: 0, members: 2 };
        }
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("gives the attempt of a series' end back whole where the provider asks for the person: it refused before it acted, so the next try is a first attempt again, takes no end someone else made since for its own and makes no day twice; an earlier attempt that waited for time stays counted (the sixth recheck's, of a sign-in refusal that kept the end's attempt)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const CLOCK = Object.keys(SPELLINGS)[0]!;
      type Then = "their end, a turn" | "a refusal, their end, the retry" | "a turn" | "the press let go" | "nothing more";
      const RUNS: readonly { readonly name: string; readonly spelling: string; readonly first?: number; readonly then: Then }[] = [
        ...Object.keys(SPELLINGS).flatMap((spelling) => [
          { name: `${spelling}: their end at that very day and their own series of the rest, then a turn`, spelling, then: "their end, a turn" as const },
          { name: `${spelling}: the next try answered with a refusal, then their end and their series, then the retry`, spelling, then: "a refusal, their end, the retry" as const },
        ]),
        { name: "nothing of theirs: the next turn makes the press, on its first attempt", spelling: CLOCK, then: "a turn" },
        { name: "the press let go before the next turn: owed with no attempt counted, it is let go", spelling: CLOCK, then: "the press let go" },
        { name: "an attempt that waited for time before the sign-in refusal (the control): that one stays counted", spelling: CLOCK, first: 503, then: "nothing more" },
      ];
      for (const run of RUNS) {
        const c = SPELLINGS[run.spelling]!;
        const b = await bench({ "s.ics": c.text }, { mailboxes: [MILA] });
        const [s] = await b.rows("s.ics");
        const door = await b.door("k", split(s!, c.day, NEW_TERM));
        if (run.first !== undefined) {
          b.dav.answerNext(run.first);
          await turns(b, 1);
        }
        // The provider answers the end 401: it asks for the person, and carried nothing out.
        b.dav.answerNext(401);
        await turns(b, 1);
        const asked = { rows: await b.counted(), days: daysAtTheServer(b) };
        // Someone else, in another program: the series ended at that very day, the rest a series of their own.
        const theirs = (): void => {
          b.dav.put("studio", "s.ics", c.text.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", c.ended), '"s.ics-theirs"');
          b.dav.put("studio", "theirs.ics", c.theirs, '"theirs-1"');
        };
        let said = "(none)";
        if (run.then === "their end, a turn") theirs();
        if (run.then === "a refusal, their end, the retry") {
          // The calendar takes no write just then: the provider answers the next try 403, and nothing of it lands.
          b.dav.answerNext(403);
          await turns(b, 1);
          theirs();
          said = await b.retry("k");
        }
        if (run.then === "the press let go") said = await b.dismiss("k");
        const from = b.dav.seen.length;
        if (run.then !== "nothing more") await turns(b, 2);
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        seen[run.name] = {
          door, asked, said, rows: await b.counted(), made: whole(b, from).filter((x) => x.member !== "s.ics").length,
          days: all.length, twice: all.filter((d, i) => all.indexOf(d) !== i).length, members: b.held().size,
        };
        const owed = [`k pending attempts=${run.first === undefined ? 0 : 1}`, "k:2 pending attempts=0"];
        // Their end is not the press's own on a first attempt: refused for its version, nothing made, their seven days once.
        const theirsStand = { rows: ["k refused version_stale attempts=1", "k:2 refused earlier_refused attempts=0"], made: 0, days: 10, twice: 0, members: 2 };
        want[run.name] = {
          door: "pending", asked: { rows: owed, days: 10 },
          ...(run.then === "their end, a turn" ? { said: "(none)", ...theirsStand }
            : run.then === "a refusal, their end, the retry" ? { said: "pending", ...theirsStand }
              : run.then === "a turn" ? { said: "(none)", rows: ["k applied attempts=1", "k:2 applied attempts=1"], made: 1, days: 10, twice: 0, members: 2 }
                : run.then === "the press let go" ? { said: "let go", rows: [], made: 0, days: 10, twice: 0, members: 1 }
                  : { said: "(none)", rows: owed, made: 0, days: 10, twice: 0, members: 1 }),
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("counts one attempt for the retry of a series' end where an attempt of it may have landed unheard: its only attempt refused with a word that waits for time, or expired; or more than one attempt claimed, whatever its word: every word of the closed list (the third recheck's fourth finding; the fourth recheck's, of an unheard end and then an answered refusal)", async () => {
      const b = await bench({ "s.ics": MONDAYS("m4r") }, { mailboxes: [MILA] });
      const [s] = await b.rows("s.ics");
      expect(await b.door("k", split(s!, DEC_14, NEW_TERM))).toBe("pending");
      const seen: Record<string, string> = {};
      const want: Record<string, string> = {};
      for (const attempts of [1, 3]) {
        for (const word of CALENDAR_WRITE_FAULTS) {
          // The press as it stands after this many attempts, refused with this word; its second part refused with it.
          await w.db.update(calWrites).set({ state: "refused", refusal: word, attempts, nextAttemptAt: null })
            .where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "k")));
          await w.db.update(calWrites).set({ state: "refused", refusal: "earlier_refused", attempts: 0, nextAttemptAt: null })
            .where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "k:2")));
          const said = await b.retry("k");
          const name = `${word} after ${attempts} attempt(s)`;
          seen[name] = `${said}: ${(await b.counted()).join(", ")}`;
          const waits = Object.hasOwn(WORD_PLAN, word) && WORD_PLAN[word as keyof typeof WORD_PLAN] === "retry";
          // A row reaches a second attempt only after one that ended unheard (a word that waits for time) or was cut: one of its
          // attempts may have landed, whatever its last word. On its only attempt, an answered word says nothing of it landed.
          want[name] = word === "version_stale"
            // Refused for the copy it was made on: never retried.
            ? `409 calendar_write_left: k refused ${word} attempts=${attempts}, k:2 refused earlier_refused attempts=0`
            : `pending: k pending attempts=${attempts > 1 || waits || word === "expired" ? 1 : 0}, k:2 pending attempts=0`;
        }
      }
      expect(seen).toEqual(want);
    }, 60_000);

    it("goes again as a later attempt where more than one attempt of it was claimed: its end landed unheard, then the provider answered the next attempt with a refusal; the retry finds the end its own (the fourth recheck's, of an unheard end and then an answered refusal)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const DAYS = memberText({ uid: "n3w@studio.example.test", tz: null, start: "20261123", end: "20261124", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln" });
      const DAYS_ENDED = "RRULE:FREQ=WEEKLY;UNTIL=20261213;BYDAY=MO";
      /** The new series of whole days the days from 14 December on become, as the writer makes it from the series' own component. */
      const madeOfDays = (text: string): string => madeOf(text, { rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" })
        .replace(`DTSTART;TZID=${ZH}:20261214T090000`, "DTSTART;VALUE=DATE:20261214").replace(`DTEND;TZID=${ZH}:20261214T100000`, "DTEND;VALUE=DATE:20261215");
      const RUNS: Record<string, { readonly text: string; readonly day: string; readonly ended: string; readonly first: "lost" | "stop" | "answered" }> = {
        "a series at a time of day: the end lands and its answer is lost; the next attempt's read of the member is answered 403": { text: MONDAYS("n3a"), day: DEC_14, ended: ENDED_14, first: "lost" },
        "a series of whole days: the same": { text: DAYS, day: String(Date.UTC(2026, 11, 14)), ended: DAYS_ENDED, first: "lost" },
        "the end lands as the worker stops; the next attempt's request (the same end) is answered 403": { text: MONDAYS("n3s"), day: DEC_14, ended: ENDED_14, first: "stop" },
        "the provider answers the only attempt 403, nothing of it lands (the control: the retry goes again from its first attempt)": { text: MONDAYS("n3c"), day: DEC_14, ended: ENDED_14, first: "answered" },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const b = await bench({ "s.ics": run.text }, { mailboxes: [MILA], wrap: going(run.first === "lost" ? ["lost"] : []) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("k", split(s!, run.day, NEW_TERM));
        if (run.first === "stop") {
          // The request is carried out at the server; before its answer goes out, the worker stops.
          const stop = new AbortController();
          b.dav.afterNextWrite(() => stop.abort());
          expect(await b.turnOn(stop.signal)).toBe("halted");
        } else if (run.first === "lost") await turns(b, 1);
        // The provider answers the turn's first request with a refusal: the calendar takes no write just then.
        b.dav.answerNext(403);
        await turns(b, 1);
        const refused = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const fromRetry = b.dav.seen.length;
        const retry = await b.retry("k");
        await turns(b, 1);
        seen[name] = {
          door, refused, retry, rows: await b.counted(), sent: whole(b, fromRetry), days: daysAtTheServer(b), members: b.held().size,
          again: [await b.retry("k"), await b.retry("k:2")],
        };
        const end = { method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null, body: endedFrom(text, run.ended) };
        const rest = { method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: run.text === DAYS ? madeOfDays(text) : madeOf(text, { rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" }) };
        want[name] = {
          door: "pending",
          refused: run.first === "answered"
            ? { rows: ["k refused read_only attempts=1", "k:2 refused earlier_refused attempts=0"], sent: [end], days: 10 }
            // The end landed unheard; the next attempt was refused by the provider: on a read of the member (nothing written), or on
            // the same end sent again under the copy the press was made on (the store had not read since).
            : run.first === "lost"
              ? { rows: ["k refused forbidden attempts=2", "k:2 refused earlier_refused attempts=0"], sent: [end], days: 3 }
              : { rows: ["k refused read_only attempts=2", "k:2 refused earlier_refused attempts=0"], sent: [end, end], days: 3 },
          retry: "pending",
          // More than one attempt claimed: the retry counts one, its next attempt finds the end its own and makes the rest a series of
          // their own. On its only attempt answered, it goes again from its first and both parts are written.
          rows: run.first === "answered" ? ["k applied attempts=1", "k:2 applied attempts=1"] : ["k applied attempts=2", "k:2 applied attempts=1"],
          sent: run.first === "answered" ? [end, rest] : [rest],
          days: 10, members: 2, again: ["409 calendar_write_left", "409 calendar_write_left"],
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("takes no other write that ends or re-shapes a series while a press on it is half carried out: its end at the server, its first part not done; tried again first, it makes its days (the fourth recheck's, of a later press on an earlier day)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const ENDED_21 = "RRULE:FREQ=WEEKLY;UNTIL=20261221T075959Z;BYDAY=MO";
      const SOLSTICE = { title: "After the solstice" };
      /** The series the days from 21 December on become, as the writer makes it from the series' own component. */
      const madeFrom21 = (text: string): string => madeOf(text, { rule: "FREQ=WEEKLY;COUNT=6;BYDAY=MO" })
        .replace(`DTSTART;TZID=${ZH}:20261214T090000`, `DTSTART;TZID=${ZH}:20261221T090000`).replace(`DTEND;TZID=${ZH}:20261214T100000`, `DTEND;TZID=${ZH}:20261221T100000`)
        .replace("SUMMARY:The new term", "SUMMARY:After the solstice");
      /** Every write that ends or re-shapes the series, pressed on the series' record as the store holds it, and one that does neither. */
      const others = async (b: B, tag: string): Promise<Record<string, string>> => {
        const [s] = await b.rows("s.ics");
        return {
          "the days from 14 December on, a new title": await b.door(`${tag}-press`, split(s!, DEC_14, NEW_TERM)),
          "the days from 14 December on let go": await b.door(`${tag}-let-go`, letGo(s!, DEC_14)),
          "a new repeat for the series": await b.door(`${tag}-repeat`, { kind: "calendar_event_update", ...on(s!), scope: { kind: "record" }, change: { repeat: "FREQ=WEEKLY;BYDAY=MO;COUNT=4" } }),
          "a new start for the series": await b.door(`${tag}-start`, {
            kind: "calendar_event_update", ...on(s!), scope: { kind: "record" }, change: { start: zoned("20261123T100000", ZH), end: zoned("20261123T110000", ZH) },
          }),
        };
      };
      const LEFT = "409 calendar_write_left";
      const refusedAll = { "the days from 14 December on, a new title": LEFT, "the days from 14 December on let go": LEFT, "a new repeat for the series": LEFT, "a new start for the series": LEFT };
      {
        const name = "its end landed unheard, its eight attempts never heard back (shown refused, not for its copy)";
        const b = await bench({ "s.ics": MONDAYS("n6a") }, { mailboxes: [MILA], wrap: going(["lost", ...times("cut", 7)]) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("r", split(s!, DEC_21, SOLSTICE));
        await turns(b, 8);
        const before = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const doors = await others(b, "x");
        // A day's cancel neither ends nor re-shapes the series: taken, and written.
        const [s1] = await b.rows("s.ics");
        const ended = b.held().get("s.ics")!;
        const fromCancel = b.dav.seen.length;
        const cancel = await b.door("c", cancelDay(s1!, String(Date.UTC(2026, 10, 30, 8))));
        await turns(b, 1);
        const cancelled = whole(b, fromCancel);
        const fromRetry = b.dav.seen.length;
        const retry = await b.retry("r");
        await turns(b, 1);
        const [s2] = await b.rows("s.ics");
        seen[name] = {
          door, before, doors, cancel, cancelled, retry, rows: await b.counted(), sent: whole(b, fromRetry), days: daysAtTheServer(b), members: b.held().size,
          afresh: await b.door("y-press", split(s2!, DEC_14, NEW_TERM)),
        };
        // The day's cancel: the series as its end left it at the server, one EXDATE line more, nothing else moved.
        const exdated = steady(ended.replace(/\r\nEND:VEVENT\r\n/, `\r\nEXDATE;TZID=${ZH}:20261130T090000\r\nEND:VEVENT\r\n`));
        want[name] = {
          door: "pending",
          before: {
            rows: ["r refused unknown attempts=8", "r:2 refused earlier_refused attempts=0"],
            sent: [{ method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null, body: endedFrom(text, ENDED_21) }], days: 4,
          },
          doors: refusedAll,
          cancel: "pending", cancelled: [{ method: "PUT", member: "s.ics", ifMatch: '"studio-s.ics-2"', ifNoneMatch: null, body: exdated }],
          retry: "pending",
          // Its end found its own (read, nothing of it sent again): the days from 21 December on a series of their own; 30 November cancelled.
          rows: ["r applied attempts=2", "r:2 applied attempts=1", "c applied attempts=1"],
          sent: [{ method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeFrom21(text) }], days: 9, members: 2,
          // Nothing is lost by the refusal: once the press is done, the same press is taken.
          afresh: "pending",
        };
      }
      {
        const name = "its end landed unheard, owed with an attempt counted";
        const b = await bench({ "s.ics": MONDAYS("n6b") }, { mailboxes: [MILA], wrap: going(["lost"]) });
        const [s] = await b.rows("s.ics");
        const door = await b.door("r", split(s!, DEC_21, SOLSTICE));
        await turns(b, 1);
        const before = { rows: await b.counted(), days: daysAtTheServer(b) };
        const doors = await others(b, "x");
        await turns(b, 1);
        const [s2] = await b.rows("s.ics");
        seen[name] = { door, before, doors, rows: await b.counted(), days: daysAtTheServer(b), members: b.held().size, afresh: await b.door("y-press", split(s2!, DEC_14, NEW_TERM)) };
        want[name] = {
          door: "pending", before: { rows: ["r pending attempts=1", "r:2 pending attempts=0"], days: 4 }, doors: refusedAll,
          rows: ["r applied attempts=2", "r:2 applied attempts=1"], days: 10, members: 2, afresh: "pending",
        };
      }
      for (const [control, plan, turnsBefore, stale] of [
        ["never tried (the control)", [], 0, false],
        ["its eight attempts never reached the server: the record is the copy it was made on (the control)", times("cut", 8), 8, false],
        ["its end landed unheard, and it stands refused for the copy it was made on (the control)", ["lost", ...times("cut", 7)], 8, true],
      ] as const) {
        const b = await bench({ "s.ics": MONDAYS("n6c") }, { mailboxes: [MILA], wrap: going(plan) });
        const [s] = await b.rows("s.ics");
        const door = await b.door("r", split(s!, DEC_21, SOLSTICE));
        await turns(b, turnsBefore);
        // As the queue shows a press refused for the copy it was made on: never sent again, and no press of the series' own.
        if (stale) await w.db.update(calWrites).set({ refusal: "version_stale" }).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "r")));
        const [s1] = await b.rows("s.ics");
        seen[control] = { door, rows: await b.counted(), press: await b.door("x-press", split(s1!, DEC_14, NEW_TERM)) };
        want[control] = {
          door: "pending",
          rows: turnsBefore === 0 ? ["r pending attempts=0", "r:2 pending attempts=0"]
            : [`r refused ${stale ? "version_stale" : "unknown"} attempts=8`, "r:2 refused earlier_refused attempts=0"],
          press: "pending",
        };
      }
      {
        const control = "never tried, and someone else's end at that very day read since, on another version (the control: nothing of the press can be at the server)";
        const b = await bench({ "s.ics": MONDAYS("n6d") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const door = await b.door("r", split(s!, DEC_21, SOLSTICE));
        b.dav.put("studio", "s.ics", text.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", ENDED_21), '"s.ics-theirs"');
        expect(await b.read()).toBe("synced");
        const [s1] = await b.rows("s.ics");
        seen[control] = { door, rows: await b.counted(), press: await b.door("x-press", split(s1!, DEC_14, NEW_TERM)) };
        want[control] = { door: "pending", rows: ["r pending attempts=0", "r:2 pending attempts=0"], press: "pending" };
      }
      {
        const control = "its eight attempts never reached the server, and someone else's end at another day read since, on another version (the control: the record does not end where the press ends it)";
        const b = await bench({ "s.ics": MONDAYS("n6e") }, { mailboxes: [MILA], wrap: going(times("cut", 8)) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const door = await b.door("r", split(s!, DEC_21, SOLSTICE));
        await turns(b, 8);
        // Another program ends the series before 4 January: on from 21 December it still runs, so nothing of the press is at the server.
        b.dav.put("studio", "s.ics", text.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", "RRULE:FREQ=WEEKLY;UNTIL=20270104T075959Z;BYDAY=MO"), '"s.ics-theirs"');
        expect(await b.read()).toBe("synced");
        const [s1] = await b.rows("s.ics");
        seen[control] = { door, rows: await b.counted(), press: await b.door("x-press", split(s1!, DEC_14, NEW_TERM)) };
        want[control] = { door: "pending", rows: ["r refused unknown attempts=8", "r:2 refused earlier_refused attempts=0"], press: "pending" };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("never gives the attempt of any write back to zero where the turn was cut as its request was carried out: owed with an attempt, it is not let go until the drain has answered it (the fourth recheck's, of a day's cancel cut as the worker stops)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const COUNT_10 = "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10";
      const RUNS: Record<string, { readonly reason: Error | undefined; readonly before: boolean; readonly ended: string; readonly write: "cancel" | "title" }> = {
        "a day's cancel, carried out as the worker stops": { reason: undefined, before: false, ended: "halted", write: "cancel" },
        "a day's cancel, carried out as the turn's own time runs out": { reason: new CalendarTurnOverdue(), before: false, ended: "backed_off", write: "cancel" },
        "a new title for the whole series, carried out as the worker stops": { reason: undefined, before: false, ended: "halted", write: "title" },
        "a day's cancel, the worker stopped before anything was asked (the control)": { reason: undefined, before: true, ended: "halted", write: "cancel" },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const b = await bench({ "s.ics": MONDAYS("n2") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("c", run.write === "cancel"
          ? cancelDay(s!, DEC_28)
          : { kind: "calendar_event_update", ...on(s!), scope: { kind: "record" }, change: { title: "Kiln renamed" } });
        const stop = new AbortController();
        // The request is carried out at the server; before its answer goes out, the turn's signal ends.
        if (run.before) stop.abort();
        else b.dav.afterNextWrite(() => stop.abort(run.reason));
        const cut = await b.turnOn(stop.signal);
        const afterTheCut = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b), lettingGo: await b.dismiss("c") };
        const fromNext = b.dav.seen.length;
        await turns(b, 1);
        seen[name] = { door, cut, afterTheCut, rows: await b.counted(), sent: whole(b, fromNext), days: daysAtTheServer(b) };
        const request = {
          method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null,
          body: run.write === "cancel"
            ? steady(text.replace(/\r\nEND:VEVENT\r\n/, `\r\nEXDATE;TZID=${ZH}:20261228T090000\r\nEND:VEVENT\r\n`))
            : endedFrom(text, COUNT_10).replace("SUMMARY:Kiln\r\n", "SUMMARY:Kiln renamed\r\n"),
        };
        want[name] = {
          door: "pending", cut: run.ended,
          afterTheCut: run.before
            // Nothing was asked: the attempt was the turn's, given back, and the write not yet tried is let go.
            ? { rows: ["c pending attempts=0"], sent: [], days: 10, lettingGo: "let go" }
            // Its attempt is kept: owed with an attempt, it is under way and cannot be let go.
            : { rows: ["c pending attempts=1"], sent: [request], days: run.write === "cancel" ? 9 : 10, lettingGo: "409 calendar_write_left" },
          // The store still holds the copy the write was made on: it goes again under its tag, the server refuses the precondition,
          // and the member read there already holds it (the day cancelled, the title as asked): done, nothing written twice.
          rows: run.before ? [] : ["c applied attempts=2"],
          sent: run.before ? [] : [request],
          days: run.write === "cancel" && !run.before ? 9 : 10,
        };
      }
      expect(seen).toEqual(want);
    }, 120_000);

    it("refuses a removal recorded before a press of the queue gave its days a series of their own, nothing sent; and a day's cancel past the series' end is no day cancelled (the fourth recheck's, of a removal shown done while its days stand)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const DEC_15 = String(Date.UTC(2026, 11, 15, 8));
      const ENDED_21 = "RRULE:FREQ=WEEKLY;UNTIL=20261221T075959Z;BYDAY=MO";
      /** The series the days from 21 December on become, as the writer makes it from the series' own component. */
      const madeFrom21 = (text: string): string => madeOf(text, { rule: "FREQ=WEEKLY;COUNT=6;BYDAY=MO" })
        .replace(`DTSTART;TZID=${ZH}:20261214T090000`, `DTSTART;TZID=${ZH}:20261221T090000`).replace(`DTEND;TZID=${ZH}:20261214T100000`, `DTEND;TZID=${ZH}:20261221T100000`)
        .replace("SUMMARY:The new term", "SUMMARY:After the solstice");
      /** A day's cancel as the writer writes it: the series as the text has it, one EXDATE line more. */
      const cancelled = (text: string, day: string, tag = '"s.ics-1"') => ({
        method: "PUT", member: "s.ics", ifMatch: tag, ifNoneMatch: null,
        body: steady(text.replace(/\r\nEND:VEVENT\r\n/, `\r\nEXDATE;TZID=${ZH}:${day}T090000\r\nEND:VEVENT\r\n`)),
      });
      const after = async (b: B, from: number) => {
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        return { rows: await b.counted(), sent: whole(b, from), days: all.length, twice: all.filter((d, i) => all.indexOf(d) !== i).length, members: b.held().size };
      };
      for (const [name, second, day] of [
        ["the days from 14 December let go on the copy the press on 14 December was made on", "let-go", DEC_14],
        ["28 December cancelled on the copy the press on 14 December was made on", "cancel", DEC_28],
      ] as const) {
        const b = await bench({ "s.ics": MONDAYS("n1a") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("p", split(s!, DEC_14, NEW_TERM)), await b.door("x", second === "let-go" ? letGo(s!, day) : cancelDay(s!, day))];
        await turns(b, 1);
        seen[name] = { doors, ...(await after(b, from)), retry: await b.retry("x") };
        want[name] = {
          doors: ["pending", "pending"],
          // The press first: its end and its new series. The removal names days the series no longer has, which stand in the new
          // series now: refused for its copy, nothing sent (the letting go before it is sent; the cancel on the copy it was re-based on).
          rows: ["p applied attempts=1", "p:2 applied attempts=1", `x refused version_stale attempts=${second === "let-go" ? 0 : 1}`],
          sent: [endOf(text), seriesOfTheRest(text)], days: 10, twice: 0, members: 2, retry: "409 calendar_write_left",
        };
      }
      {
        const name = "the days from 14 December let go on the copy a press on 21 December was made on";
        const b = await bench({ "s.ics": MONDAYS("n1b") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("r", split(s!, DEC_21, { title: "After the solstice" })), await b.door("x", letGo(s!, DEC_14))];
        await turns(b, 1);
        seen[name] = { doors, ...(await after(b, from)) };
        want[name] = {
          doors: ["pending", "pending"], rows: ["r applied attempts=1", "r:2 applied attempts=1", "x refused version_stale attempts=0"],
          sent: [{ method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null, body: endedFrom(text, ENDED_21) }, { method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeFrom21(text) }],
          days: 10, twice: 0, members: 2,
        };
      }
      {
        const name = "the days from 14 December let go after the press on 21 December was done, on the record it left (the control: written)";
        const b = await bench({ "s.ics": MONDAYS("n1f") }, { mailboxes: [MILA] });
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("r", split(s!, DEC_21, { title: "After the solstice" }))];
        await turns(b, 1);
        const ended = b.held().get("s.ics")!;
        const [s1] = await b.rows("s.ics");
        doors.push(await b.door("x", letGo(s1!, DEC_14)));
        const from = b.dav.seen.length;
        await turns(b, 1);
        seen[name] = { doors, ...(await after(b, from)) };
        want[name] = {
          doors: ["pending", "pending"], rows: ["r applied attempts=1", "r:2 applied attempts=1", "x applied attempts=1"],
          sent: [{ method: "PUT", member: "s.ics", ifMatch: '"studio-s.ics-2"', ifNoneMatch: null, body: endedFrom(ended, ENDED_14) }], days: 9, twice: 0, members: 2,
        };
      }
      {
        const name = "28 December cancelled, refused by the provider; a press on 14 December whose end lands as the worker stops; the cancel's retry (the member read after its refused precondition)";
        const b = await bench({ "s.ics": MONDAYS("n1c") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("c", cancelDay(s!, DEC_28))];
        b.dav.answerNext(403);
        await turns(b, 1);
        const [s1] = await b.rows("s.ics");
        doors.push(await b.door("p", split(s1!, DEC_14, NEW_TERM)));
        const stop = new AbortController();
        b.dav.afterNextWrite(() => stop.abort());
        expect(await b.turnOn(stop.signal)).toBe("halted");
        const before = await b.counted();
        const retry = await b.retry("c");
        const from = b.dav.seen.length;
        await turns(b, 1);
        seen[name] = { doors, before, retry, ...(await after(b, from)) };
        want[name] = {
          doors: ["pending", "pending"], before: ["c refused read_only attempts=1", "p pending attempts=1", "p:2 pending attempts=0"], retry: "pending",
          // The cancel goes again under the copy it was made on; the server refuses the precondition; the member read there ends before
          // 28 December: that day is past its end, and stands in a series of its own: refused for its copy. The press then finds its own end.
          rows: ["c refused version_stale attempts=1", "p applied attempts=2", "p:2 applied attempts=1"],
          sent: [cancelled(text, "20261228"), endOf(text), seriesOfTheRest(text)], days: 10, twice: 0, members: 2,
        };
      }
      for (const [name, theirs] of [
        ["28 December cancelled; before it is sent, another program ends the series by a count (its last day 7 December) and makes the days from 14 December a series of its own", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3"],
        ["the same, the series ended on a day (UNTIL) in place of the count", ENDED_14],
      ] as const) {
        const b = await bench({ "s.ics": MONDAYS("n1d") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("c", cancelDay(s!, DEC_28))];
        b.dav.put("studio", "s.ics", text.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", theirs), '"s.ics-theirs"');
        b.dav.put("studio", "theirs.ics", memberText({ uid: "theirs@studio.example.test", tz: ZH, start: "20261214T090000", end: "20261214T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=7", summary: "Kiln, their way" }), '"theirs-1"');
        const from = b.dav.seen.length;
        await turns(b, 1);
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        seen[name] = { doors, ...(await after(b, from)), on28: all.filter((d) => d === "2026-12-28T08:00:00.000Z").length };
        // Their series holds 28 December: the cancel was made on a copy before their end, and is refused for it, nothing written.
        want[name] = { doors: ["pending"], rows: ["c refused version_stale attempts=1"], sent: [cancelled(text, "20261228")], days: 10, twice: 0, members: 2, on28: 1 };
      }
      {
        const name = "15 December cancelled, a day the series' rule does not name (the control: done as it stands, nothing sent)";
        const b = await bench({ "s.ics": MONDAYS("n1e") }, { mailboxes: [MILA] });
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("c", cancelDay(s!, DEC_15))];
        await turns(b, 1);
        seen[name] = { doors, ...(await after(b, from)) };
        want[name] = { doors: ["pending"], rows: ["c applied attempts=1"], sent: [], days: 10, twice: 0, members: 1 };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("finds a day's cancel done where the series itself excludes that day, also past the series' end: its own request was carried out and never heard, then the series was ended; only a day past the end that the series does not exclude is refused for its copy", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const ENDED_21 = "RRULE:FREQ=WEEKLY;UNTIL=20261221T075959Z;BYDAY=MO";
      const EXCLUDED_28 = `EXDATE;TZID=${ZH}:20261228T090000`;
      const SOLSTICE = { title: "After the solstice" };
      /** The series with 28 December cancelled, as the writer writes a day's cancel: one EXDATE line more, nothing else moved. */
      const excluding = (text: string): string => text.replace(/\r\nEND:VEVENT\r\n/, `\r\n${EXCLUDED_28}\r\nEND:VEVENT\r\n`);
      const cancelled = (text: string) => ({ method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null, body: steady(excluding(text)) });
      /** The series the days from 21 December on become, as the writer makes it from the series' own component, 28 December excluded. */
      const madeFrom21 = (text: string): string => madeOf(text, { rule: "FREQ=WEEKLY;COUNT=6;BYDAY=MO", exdates: [EXCLUDED_28] })
        .replace(`DTSTART;TZID=${ZH}:20261214T090000`, `DTSTART;TZID=${ZH}:20261221T090000`).replace(`DTEND;TZID=${ZH}:20261214T100000`, `DTEND;TZID=${ZH}:20261221T100000`)
        .replace("SUMMARY:The new term", "SUMMARY:After the solstice");
      const after = async (b: B, from: number) => {
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        return {
          rows: await b.counted(), sent: whole(b, from), days: all.length, twice: all.filter((d, i) => all.indexOf(d) !== i).length, members: b.held().size,
          on28: all.filter((d) => d === "2026-12-28T08:00:00.000Z").length,
        };
      };
      /** A writer none of whose day's cancels reaches the server while the connection is down; its first series' end lands and loses its answer. */
      const unheard = (down: { on: boolean }) => (real: CalendarWriter): CalendarWriter => {
        const ends = going(["lost"])(real);
        return { ...ends, remove: (...args: Parameters<CalendarWriter["remove"]>) => (down.on ? Promise.reject(new Error("the connection is down")) : real.remove(...args)) };
      };
      for (const [name, then] of [
        ["28 December cancelled, carried out and answered 500, then never heard for seven attempts; a press on 21 December on the record read since, its end's answer lost; the cancel's retry", "press"],
        ["the same, the days from 14 December let go in place of the press", "let-go"],
      ] as const) {
        const down = { on: false };
        const b = await bench({ "s.ics": MONDAYS("past-end") }, { mailboxes: [MILA], wrap: unheard(down) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("c", cancelDay(s!, DEC_28))];
        b.dav.doneThen(500);
        await turns(b, 1);
        down.on = true;
        await turns(b, 7);
        down.on = false;
        const heard = { rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b) };
        const [s1] = await b.rows("s.ics");
        doors.push(await b.door("x", then === "press" ? split(s1!, DEC_21, SOLSTICE) : letGo(s1!, DEC_14)));
        const fromEnd = b.dav.seen.length;
        await turns(b, 1);
        const ended = { rows: await b.counted(), sent: whole(b, fromEnd), days: daysAtTheServer(b) };
        const retry = await b.retry("c");
        const fromRetry = b.dav.seen.length;
        await turns(b, 1);
        seen[name] = { doors, heard, ended, retry, ...(await after(b, fromRetry)) };
        const end = { method: "PUT", member: "s.ics", ifMatch: '"studio-s.ics-2"', ifNoneMatch: null, body: endedFrom(excluding(text), then === "press" ? ENDED_21 : ENDED_14) };
        want[name] = {
          doors: ["pending", "pending"],
          // The cancel's one request: carried out. The calendar shows 28 December cancelled; the write reads refused, never heard.
          heard: { rows: ["c refused unknown attempts=8"], sent: [cancelled(text)], days: 9 },
          // The series' end keeps the line that excludes 28 December.
          ended: {
            rows: ["c refused unknown attempts=8", "x pending attempts=1", ...(then === "press" ? ["x:2 pending attempts=0"] : [])], sent: [end], days: then === "press" ? 4 : 3,
          },
          retry: "pending",
          // 28 December lies past the series' end, and the series excludes it by its own line: the cancel is done as it stands, nothing
          // sent. The end is found its own; the new series carries the excluded day.
          rows: ["c applied attempts=1", "x applied attempts=2", ...(then === "press" ? ["x:2 applied attempts=1"] : [])],
          sent: then === "press" ? [{ method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeFrom21(text) }] : [],
          days: then === "press" ? 9 : 3, twice: 0, members: then === "press" ? 2 : 1, on28: 0,
        };
      }
      for (const [name, theirExcluded, rows, on28] of [
        ["28 December cancelled, carried out as the worker stops; another program ends the series before 21 December, the line kept, and makes the days after it a series of its own; the cancel's next attempt (the member read after its refused precondition)", "20261228T090000", ["c applied attempts=2"], 0],
        ["the same, but the cancel never carried out and their series excluding 4 January alone (the control: no line excludes the cancelled day)", "20270104T090000", ["c refused version_stale attempts=1"], 1],
      ] as const) {
        const b = await bench({ "s.ics": MONDAYS("past-their-end") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("c", cancelDay(s!, DEC_28))];
        const control = on28 === 1;
        if (!control) {
          const stop = new AbortController();
          b.dav.afterNextWrite(() => stop.abort());
          expect(await b.turnOn(stop.signal)).toBe("halted");
        }
        const theirLine = `EXDATE;TZID=${ZH}:${theirExcluded}`;
        const standing = control ? text.replace(/\r\nEND:VEVENT\r\n/, `\r\n${theirLine}\r\nEND:VEVENT\r\n`) : b.held().get("s.ics")!;
        b.dav.put("studio", "s.ics", standing.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", ENDED_21), '"s.ics-theirs"');
        b.dav.put("studio", "theirs.ics", memberText({
          uid: "theirs@studio.example.test", tz: ZH, start: "20261221T090000", end: "20261221T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=6", summary: "Kiln, their way",
          excluded: [theirExcluded],
        }), '"theirs-1"');
        const from = b.dav.seen.length;
        await turns(b, 1);
        seen[name] = { doors, ...(await after(b, from)) };
        // The cancel goes under the copy it was made on; the server refuses the precondition; the member read there ends before 28
        // December. Where its own line excludes that day, the cancel is done; where none does, the day stands in their series.
        want[name] = { doors: ["pending"], rows, sent: [cancelled(text)], days: 9, twice: 0, members: 2, on28 };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("does not remove the whole series under a press half carried out: refused at the door while its first part is not done, and not sent while its second part stands refused; that part made or let go, the removal's retry goes (the fifth recheck's, of the whole series removed)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const LEFT = "409 calendar_write_left";
      const removeSeries = (s: Row) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } });
      const removal = (tag: string) => ({ method: "DELETE", member: "s.ics", ifMatch: tag, ifNoneMatch: null, body: "" });
      const stands = async (b: B, from: number) => ({ rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b), members: b.held().size });
      const HALF = ["k applied attempts=1", "k:2 refused read_only attempts=1", "d refused earlier_refused attempts=0"];
      for (const [name, repair] of [
        ["the new series refused by the provider, then the whole series removed; the new series tried again, then the removal", "retry"],
        ["the same; the new series let go, then the removal tried again", "let go"],
      ] as const) {
        const b = await benchMaking("r51a", ["refused"]);
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM))];
        await turns(b, 1);
        const [ended] = await b.rows("s.ics");
        doors.push(await b.door("d", removeSeries(ended!)));
        await turns(b, 1);
        const half = await stands(b, from);
        // Tried again before the new series is made or let go, the removal is refused with it again: nothing is sent.
        const fromEarly = b.dav.seen.length;
        const early = [await b.retry("d")];
        await turns(b, 1);
        const tooEarly = { early, ...(await stands(b, fromEarly)) };
        const fromRepair = b.dav.seen.length;
        const presses = [repair === "retry" ? await b.retry("k:2") : await b.dismiss("k:2")];
        if (repair === "retry") await turns(b, 1);
        presses.push(await b.retry("d"));
        await turns(b, 1);
        seen[name] = { doors, half, tooEarly, presses, ...(await stands(b, fromRepair)) };
        want[name] = {
          doors: ["pending", "pending"],
          // The series ends before 14 December at the server; the days from it on are nowhere yet; the removal is not sent.
          half: { rows: HALF, sent: [endOf(text), seriesOfTheRest(text)], days: 3, members: 1 },
          tooEarly: { early: ["pending"], rows: HALF, sent: [], days: 3, members: 1 },
          ...(repair === "retry"
            // The new series stands with its seven days; the series the person removed is gone.
            ? { presses: ["pending", "pending"], rows: ["k applied attempts=1", "k:2 applied attempts=1", "d applied attempts=1"], sent: [seriesOfTheRest(text), removal('"studio-s.ics-2"')], days: 7, members: 1 }
            // The person gave the days from 14 December up; the series is gone.
            : { presses: ["let go", "pending"], rows: ["k applied attempts=1", "d applied attempts=1"], sent: [removal('"studio-s.ics-2"')], days: 0, members: 0 }),
        };
      }
      {
        const name = "the whole series removed before the press is carried out; then the new series refused by the provider in the turn its end is carried out";
        const b = await benchMaking("r51c", ["refused"]);
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM)), await b.door("d", removeSeries(s!))];
        await turns(b, 1);
        const half = await stands(b, from);
        const fromRepair = b.dav.seen.length;
        const presses = [await b.retry("k:2")];
        await turns(b, 1);
        presses.push(await b.retry("d"));
        await turns(b, 1);
        const refused = await stands(b, fromRepair);
        const [refreshed] = await b.rows("s.ics");
        const fromFresh = b.dav.seen.length;
        const fresh = await b.door("d2", removeSeries(refreshed!));
        await turns(b, 1);
        seen[name] = { doors, half, presses, refused, fresh, ...(await stands(b, fromFresh)) };
        want[name] = {
          doors: ["pending", "pending"], half: { rows: HALF, sent: [endOf(text), seriesOfTheRest(text)], days: 3, members: 1 },
          presses: ["pending", "pending"],
          refused: { rows: ["k applied attempts=1", "k:2 applied attempts=1", "d refused version_stale attempts=1"], sent: [seriesOfTheRest(text)], days: 10, members: 2 },
          fresh: "pending", rows: ["k applied attempts=1", "k:2 applied attempts=1", "d2 applied attempts=1"],
          sent: [removal('"studio-s.ics-2"')], days: 7, members: 1,
        };
      }
      {
        const name = "the new series owed with an attempt when the whole series is removed, then never heard for its eight attempts";
        const b = await benchMaking("r51d", times("cut", 8));
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM))];
        await turns(b, 1);
        const [ended] = await b.rows("s.ics");
        doors.push(await b.door("d", removeSeries(ended!)));
        const from = b.dav.seen.length;
        const owed = await b.counted();
        // The removal waits behind the new series while that is owed: the queue's order.
        await turns(b, 7);
        const spent = await stands(b, from);
        await turns(b, 1);
        seen[name] = { doors, owed, spent, ...(await stands(b, from)) };
        want[name] = {
          doors: ["pending", "pending"], owed: ["k applied attempts=1", "k:2 pending attempts=1", "d pending attempts=0"],
          spent: { rows: ["k applied attempts=1", "k:2 refused unknown attempts=8", "d pending attempts=0"], sent: [], days: 3, members: 1 },
          rows: ["k applied attempts=1", "k:2 refused unknown attempts=8", "d refused earlier_refused attempts=0"], sent: [], days: 3, members: 1,
        };
      }
      for (const [name, plan, turnsBefore, rows] of [
        ["its first part not done: its end landed unheard, its eight attempts never heard back", ["lost", ...times("cut", 7)], 8, ["k refused unknown attempts=8", "k:2 refused earlier_refused attempts=0"]],
        ["its first part not done: its end landed unheard, owed with an attempt counted", ["lost"], 1, ["k pending attempts=1", "k:2 pending attempts=0"]],
      ] as const) {
        const b = await bench({ "s.ics": MONDAYS("r51e") }, { mailboxes: [MILA], wrap: going(plan) });
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM))];
        await turns(b, turnsBefore);
        const before = await b.counted();
        const [ended] = await b.rows("s.ics");
        doors.push(await b.door("d", removeSeries(ended!)));
        // Tried again (or its next turn), the press makes its days; then the removal is taken, and takes the series alone.
        const retry = turnsBefore === 8 ? await b.retry("k") : "(owed)";
        await turns(b, 1);
        const [done] = await b.rows("s.ics");
        doors.push(done === undefined ? "(the store holds no such series)" : await b.door("d2", removeSeries(done)));
        const from = b.dav.seen.length;
        await turns(b, 1);
        seen[name] = { doors, before, retry, ...(await stands(b, from)) };
        want[name] = {
          doors: ["pending", LEFT, "pending"], before: rows, retry: turnsBefore === 8 ? "pending" : "(owed)",
          rows: ["k applied attempts=2", "k:2 applied attempts=1", "d2 applied attempts=1"], sent: [removal('"studio-s.ics-2"')], days: 7, members: 1,
        };
      }
      for (const [control, plan, press, turnBetween, stale, rows, tag, days] of [
        ["no press on the series (the control)", [], false, false, false, ["d applied attempts=1"], '"s.ics-1"', 0],
        ["a press done whole, then the removal (the control)", [], true, true, false, ["k applied attempts=1", "k:2 applied attempts=1", "d applied attempts=1"], '"studio-s.ics-2"', 7],
        ["its second part refused for the copy it was made on: never sent again, no press's standing wish (the control)", ["refused"], true, true, true, ["k applied attempts=1", "k:2 refused version_stale attempts=1", "d applied attempts=1"], '"studio-s.ics-2"', 0],
      ] as const) {
        const b = await benchMaking("r51f", plan);
        const [s] = await b.rows("s.ics");
        const doors = press ? [await b.door("k", split(s!, DEC_14, NEW_TERM))] : [];
        if (turnBetween) await turns(b, 1);
        // As the queue shows a second part refused for its copy: never sent again.
        if (stale) await w.db.update(calWrites).set({ refusal: "version_stale" }).where(and(eq(calWrites.accountId, b.t.accountId), eq(calWrites.idempotencyKey, "k:2")));
        const [now] = await b.rows("s.ics");
        doors.push(await b.door("d", removeSeries(now!)));
        const from = b.dav.seen.length;
        await turns(b, 1);
        const after = await stands(b, from);
        seen[control] = { doors, rows: after.rows, removed: after.sent.at(-1), days: after.days };
        want[control] = { doors: press ? ["pending", "pending"] : ["pending"], rows, removed: removal(tag), days };
      }
      {
        const control = "an earlier split completes before the queued removal, then the person confirms the current copy";
        const b = await benchMaking("r51g", []);
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM)), await b.door("d", removeSeries(s!))];
        const from = b.dav.seen.length;
        await turns(b, 1);
        const refused = await stands(b, from);
        const [refreshed] = await b.rows("s.ics");
        const fromFresh = b.dav.seen.length;
        const fresh = await b.door("d2", removeSeries(refreshed!));
        await turns(b, 1);
        seen[control] = { doors, refused, fresh, ...(await stands(b, fromFresh)) };
        want[control] = {
          doors: ["pending", "pending"],
          refused: { rows: ["k applied attempts=1", "k:2 applied attempts=1", "d refused version_stale attempts=1"], sent: [endOf(text), seriesOfTheRest(text)], days: 10, members: 2 },
          fresh: "pending", rows: ["k applied attempts=1", "k:2 applied attempts=1", "d2 applied attempts=1"],
          sent: [removal('"studio-s.ics-2"')], days: 7, members: 1,
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("does not remove the whole series behind a press refused whole either: its first part refused, nothing of it at the server, the removal would take the press's days with the series; the press tried again or let go, the removal goes", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const removeSeries = (s: Row) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } });
      const removal = (tag: string) => ({ method: "DELETE", member: "s.ics", ifMatch: tag, ifNoneMatch: null, body: "" });
      const stands = async (b: B, from: number) => ({ rows: await b.counted(), sent: whole(b, from), days: daysAtTheServer(b), members: b.held().size });
      const HELD = "d refused earlier_refused attempts=0";
      const RUNS: Record<string, {
        readonly plan: readonly string[]; readonly refuse: "at once" | "before the removal" | null; readonly turns: number; readonly age: boolean;
        readonly press: string; readonly repair: "both tried again" | "the press let go";
      }> = {
        "the provider refuses the press's end; the removal behind it in the same turn": { plan: [], refuse: "at once", turns: 1, age: false, press: "k refused read_only attempts=1", repair: "both tried again" },
        "the provider refuses the press's end; the removal pressed after": { plan: [], refuse: "before the removal", turns: 1, age: false, press: "k refused read_only attempts=1", repair: "both tried again" },
        "the press's eight attempts never reach the server; the removal behind it": { plan: times("cut", 8), refuse: null, turns: 9, age: false, press: "k refused unknown attempts=8", repair: "the press let go" },
        "the press too old to send, never tried; the removal behind it": { plan: [], refuse: null, turns: 1, age: true, press: "k refused expired attempts=0", repair: "the press let go" },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const b = await bench({ "s.ics": MONDAYS("whole") }, { mailboxes: [MILA], wrap: going(run.plan) });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM))];
        if (run.refuse === "before the removal") {
          b.dav.answerNext(403);
          await turns(b, 1);
        }
        if (run.age) await b.age(73);
        doors.push(await b.door("d", removeSeries(s!)));
        if (run.refuse === "at once") b.dav.answerNext(403);
        await turns(b, run.turns);
        const held = await stands(b, from);
        const fromRepair = b.dav.seen.length;
        const presses = run.repair === "the press let go" ? [await b.dismiss("k"), await b.retry("d")] : [await b.retry("k"), await b.retry("d")];
        await turns(b, 1);
        const afterRepair = await stands(b, fromRepair);
        if (run.repair === "both tried again") {
          const [refreshed] = await b.rows("s.ics");
          const fromFresh = b.dav.seen.length;
          const fresh = await b.door("d2", removeSeries(refreshed!));
          await turns(b, 1);
          seen[name] = { doors, held, presses, afterRepair, fresh, ...(await stands(b, fromFresh)) };
        } else seen[name] = { doors, held, presses, ...afterRepair };
        want[name] = {
          doors: ["pending", "pending"],
          // Nothing of the press is at the server; the removal is not sent: every day stands.
          held: { rows: [run.press, "k:2 refused earlier_refused attempts=0", HELD], sent: run.refuse === null ? [] : [endOf(text)], days: 10, members: 1 },
          ...(run.repair === "both tried again"
            // The press makes its days a series of their own. The person confirms removal of the remaining series.
            ? {
              presses: ["pending", "pending"],
              afterRepair: { rows: ["k applied attempts=1", "k:2 applied attempts=1", "d refused version_stale attempts=1"], sent: [endOf(text), seriesOfTheRest(text)], days: 10, members: 2 },
              fresh: "pending", rows: ["k applied attempts=1", "k:2 applied attempts=1", "d2 applied attempts=1"],
              sent: [removal('"studio-s.ics-2"')], days: 7, members: 1,
            }
            // The press let go, its days are the series' again: the removal takes all ten.
            : { presses: ["let go", "pending"], rows: ["d applied attempts=1"], sent: [removal('"s.ics-1"')], days: 0, members: 0 }),
        };
      }
      {
        // A press refused for the copy it was made on is never sent again, but its days are still this series': the removal pressed
        // while it was owed meant the series without them. It waits for the press to be let go, as behind any other refusal.
        const name = "the press refused for the copy it was made on (another program renamed the series since), the removal pressed on the copy read since; the press let go, then the removal";
        const b = await bench({ "s.ics": MONDAYS("whole-stale") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM))];
        b.dav.put("studio", "s.ics", text.replace("SUMMARY:Kiln", "SUMMARY:Kiln, as they call it"), '"s.ics-theirs"');
        expect(await b.read()).toBe("synced");
        const [theirs] = await b.rows("s.ics");
        doors.push(await b.door("d", removeSeries(theirs!)));
        const from = b.dav.seen.length;
        await turns(b, 1);
        const held = await stands(b, from);
        const fromRepair = b.dav.seen.length;
        const presses = [await b.retry("k"), await b.dismiss("k"), await b.retry("d")];
        await turns(b, 1);
        seen[name] = { doors, held, presses, ...(await stands(b, fromRepair)) };
        want[name] = {
          doors: ["pending", "pending"],
          held: { rows: ["k refused version_stale attempts=1", "k:2 refused earlier_refused attempts=0", HELD], sent: [], days: 10, members: 1 },
          // No retry of a change made on an older copy; let go, the removal takes the series whole.
          presses: ["409 calendar_write_left", "let go", "pending"], rows: ["d applied attempts=1"], sent: [removal('"s.ics-theirs"')], days: 0, members: 0,
        };
      }
      {
        const control = "a press half carried out on ANOTHER series of the calendar (the control: it bars nothing here)";
        const at: { b?: B } = {};
        at.b = await bench({ "s.ics": MONDAYS("whole-here"), "o.ics": MONDAYS("whole-other") }, { mailboxes: [MILA], wrap: making(["refused"], at) });
        const b = at.b;
        const [other] = await b.rows("o.ics");
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("k", split(other!, DEC_14, NEW_TERM))];
        await turns(b, 1);
        doors.push(await b.door("d", removeSeries(s!)));
        const from = b.dav.seen.length;
        await turns(b, 1);
        seen[control] = { doors, ...(await stands(b, from)) };
        // The other series ends before 14 December, its new series refused; this one is removed whole.
        want[control] = {
          doors: ["pending", "pending"], rows: ["k applied attempts=1", "k:2 refused read_only attempts=1", "d applied attempts=1"], sent: [removal('"s.ics-1"')], days: 3, members: 1,
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("keeps the split series when removal and cancellation are queued before the worker", async () => {
      const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
      const removeSeries = (s: Row) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } });
      for (const [cancellation, freshResult, cancellationAttempts] of [
        [(s: Row) => letGo(s, DEC_14), "400 validation_failed", 0],
        [(s: Row) => cancelDay(s, DEC_28), "pending", 1],
        [(s: Row) => cancelDay(s, DEC_7), "pending", 1],
      ] as const) {
        const b = await bench({ "s.ics": MONDAYS("queued") }, { mailboxes: [MILA] });
        const text = b.held().get("s.ics")!;
        const [original] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        expect(await b.door("k", split(original!, DEC_14, NEW_TERM))).toBe("pending");
        expect(await b.door("d", removeSeries(original!))).toBe("pending");
        expect(await b.door("x", cancellation(original!))).toBe("pending");
        await turns(b, 1);
        expect(await b.counted(), freshResult + " / " + cancellationAttempts).toEqual([
          "k applied attempts=1",
          "k:2 applied attempts=1",
          "d refused version_stale attempts=1",
          `x refused version_stale attempts=${cancellationAttempts}`,
        ]);
        expect(whole(b, from)).toEqual([endOf(text), seriesOfTheRest(text)]);
        expect(daysAtTheServer(b)).toBe(10);
        expect(b.held().size).toBe(2);

        const [refreshed] = await b.rows("s.ics");
        const fromFresh = b.dav.seen.length;
        expect(await b.door("d2", removeSeries(refreshed!))).toBe("pending");
        expect(await b.door("x2", cancellation(refreshed!))).toBe(freshResult);
        await turns(b, 1);
        expect(await b.counted()).toEqual([
          "k applied attempts=1",
          "k:2 applied attempts=1",
          "d2 applied attempts=1",
          ...(freshResult === "pending" ? ["x2 applied attempts=0"] : []),
        ]);
        expect(whole(b, fromFresh)).toEqual([
          { method: "DELETE", member: "s.ics", ifMatch: '"studio-s.ics-2"', ifNoneMatch: null, body: "" },
        ]);
        expect(daysAtTheServer(b)).toBe(7);
        expect(b.held().size).toBe(1);
        expect([...b.held().values()].map(steady)).toEqual([seriesOfTheRest(text).body]);
        expect(daysOf([...b.held().values()][0]!)).toEqual(daysOf(text).slice(3));
      }
    }, 240_000);

    it("shows no removal of days done where its series is gone from the store and a press gave those days a series of their own since it was recorded: nothing of it is left to change; a day the press did not take, and a removal with no press, are done as they stand", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
      const removeSeries = (s: Row) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } });
      const RUNS: Record<string, { readonly press: boolean; readonly then: (s: Row) => unknown; readonly left: readonly string[] }> = {
        "the days from 14 December let go before the split, then the original disappears at the provider": { press: true, then: (s) => letGo(s, DEC_14), left: [] },
        "the same, 28 December cancelled in place of the letting go": { press: true, then: (s) => cancelDay(s, DEC_28), left: [] },
        "the same, 7 December cancelled: a day before the press's (done as it stands: it went with the series)": { press: true, then: (s) => cancelDay(s, DEC_7), left: ["x applied attempts=0"] },
        "no press: the whole series removed, then the days from 14 December let go (the control: done as it stands)": { press: false, then: (s) => letGo(s, DEC_14), left: ["x applied attempts=0"] },
        "no press: the whole series removed, then 28 December cancelled (the control: done as it stands)": { press: false, then: (s) => cancelDay(s, DEC_28), left: ["x applied attempts=0"] },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const handle: { accountId?: string } = {};
        const b = await bench({ "s.ics": MONDAYS("gone") }, {
          mailboxes: [MILA],
          wrap: (writer) => ({
            ...writer,
            async continueSeries(...args) {
              const result = await writer.continueSeries(...args);
              // Keep the queued cancellation until the next turn, so a read can see the original disappear.
              await w.db.update(calWrites).set({ nextAttemptAt: sql`now() + interval '1 hour'` }).where(and(
                eq(calWrites.accountId, handle.accountId!), eq(calWrites.idempotencyKey, "x"),
              ));
              return result;
            },
          }),
        });
        handle.accountId = b.t.accountId;
        const [s] = await b.rows("s.ics");
        const first = run.press ? b.door("k", split(s!, DEC_14, NEW_TERM)) : b.door("d", removeSeries(s!));
        const doors = [await first, await b.door("x", run.then(s!))];
        await turns(b, 1);
        if (run.press) {
          expect(await b.counted()).toEqual(["k applied attempts=1", "k:2 applied attempts=1", "x pending attempts=0"]);
          b.dav.remove("studio", "s.ics");
          expect(await b.read()).toBe("synced");
          expect(await b.rows("s.ics")).toEqual([]);
          await turns(b, 1);
        }
        seen[name] = { doors, rows: await b.counted(), days: daysAtTheServer(b), members: b.held().size };
        want[name] = {
          doors: doors.map(() => "pending"),
          // The press's seven days stand in their own series; a removal of them is not shown done.
          rows: [...(run.press ? ["k applied attempts=1", "k:2 applied attempts=1"] : ["d applied attempts=1"]), ...run.left],
          days: run.press ? 7 : 0, members: run.press ? 1 : 0,
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("writes no new repeat for the whole series onto a copy a write of the queue has ended since it was recorded: it would give the series those days back, twice where a press made them a series of their own; refused for its copy, nothing sent", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const TWELVE = "FREQ=WEEKLY;BYDAY=MO;COUNT=12";
      const whole = (s: Row, change: Record<string, unknown>) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change });
      const RUNS: Record<string, { readonly first: ((s: Row) => unknown) | null; readonly between: boolean; readonly change: Record<string, unknown>; readonly rows: readonly string[]; readonly days: number; readonly twice: number }> = {
        "a press on the days from 14 December, then a new repeat for the whole series (twelve Mondays), both before the turn": {
          first: (s) => split(s, DEC_14, NEW_TERM), between: false, change: { repeat: TWELVE }, rows: ["k applied attempts=1", "k:2 applied attempts=1", "u refused version_stale attempts=0"], days: 10, twice: 0,
        },
        "the days from 14 December let go, then the new repeat, both before the turn": {
          first: (s) => letGo(s, DEC_14), between: false, change: { repeat: TWELVE }, rows: ["k applied attempts=1", "u refused version_stale attempts=0"], days: 3, twice: 0,
        },
        "a press, then a new title for the whole series (the control: no repeat, written onto the series as the press left it)": {
          first: (s) => split(s, DEC_14, NEW_TERM), between: false, change: { title: "Kiln, mornings" }, rows: ["k applied attempts=1", "k:2 applied attempts=1", "u applied attempts=1"], days: 10, twice: 0,
        },
        "the new repeat pressed once the press is done, on the copy the calendar shows then (the control: the person's own word, written)": {
          first: (s) => split(s, DEC_14, NEW_TERM), between: true, change: { repeat: TWELVE }, rows: ["k applied attempts=1", "k:2 applied attempts=1", "u applied attempts=1"], days: 19, twice: 7,
        },
        "the new repeat with nothing before it (the control)": { first: null, between: false, change: { repeat: TWELVE }, rows: ["u applied attempts=1"], days: 12, twice: 0 },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const b = await bench({ "s.ics": MONDAYS("again") }, { mailboxes: [MILA] });
        const [s] = await b.rows("s.ics");
        const doors = run.first === null ? [] : [await b.door("k", run.first(s!))];
        if (run.between) await turns(b, 1);
        const [now] = await b.rows("s.ics");
        doors.push(await b.door("u", whole(now!, run.change)));
        await turns(b, 1);
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        seen[name] = { doors, rows: await b.counted(), days: all.length, twice: all.filter((d, i) => all.indexOf(d) !== i).length };
        want[name] = { doors: doors.map(() => "pending"), rows: run.rows, days: run.days, twice: run.twice };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("makes a press's second part only where the series it comes from has no day from its day on: given a new repeat since its end (by the person, or by another program), the days stand there, and the retry makes nothing twice: refused for its copy", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      const TWELVE = "FREQ=WEEKLY;BYDAY=MO;COUNT=12";
      const COUNT_10 = "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10";
      const SOLSTICE = { title: "After the solstice" };
      const at = async (b: B, from: number) => {
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        return { rows: await b.counted(), made: whole(b, from).filter((x) => x.member !== "s.ics").length, days: all.length, twice: all.filter((d, i) => all.indexOf(d) !== i).length };
      };
      const RUNS: Record<string, { readonly since: "their repeat" | "the person's repeat" | "the store's old copy" | "nothing"; readonly rows: readonly string[]; readonly made: number; readonly days: number; readonly again: string }> = {
        "the person gives the series a new repeat (twelve Mondays) while the new series stands refused, then tries the new series again": {
          since: "the person's repeat", rows: ["k applied attempts=1", "k:2 refused version_stale attempts=1", "u applied attempts=1"], made: 0, days: 12, again: "409 calendar_write_left",
        },
        "another program gives the series its ten days back, read since; then the new series is tried again": {
          since: "their repeat", rows: ["k applied attempts=1", "k:2 refused version_stale attempts=1"], made: 0, days: 10, again: "409 calendar_write_left",
        },
        "the store still holds the copy the press was made on, the series ended at the server (the control: the member is read, and the days made from it)": {
          since: "the store's old copy", rows: ["k applied attempts=1", "k:2 applied attempts=1"], made: 1, days: 10, again: "409 calendar_write_left",
        },
        "nothing in between (the control: the half-done repair)": { since: "nothing", rows: ["k applied attempts=1", "k:2 applied attempts=1"], made: 1, days: 10, again: "409 calendar_write_left" },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        const b = await benchMaking("again2", ["refused"]);
        const text = b.held().get("s.ics")!;
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("k", split(s!, DEC_14, NEW_TERM))];
        await turns(b, 1);
        const [ended] = await b.rows("s.ics");
        if (run.since === "the person's repeat") {
          doors.push(await b.door("u", { kind: "calendar_event_update", ...on(ended!), scope: { kind: "record" }, change: { repeat: TWELVE } }));
          await turns(b, 1);
        }
        if (run.since === "their repeat") {
          b.dav.put("studio", "s.ics", text, '"s.ics-theirs"');
          expect(await b.read()).toBe("synced");
        }
        // As where the series' end could not be kept in the store: its row still holds the copy the press was made on.
        if (run.since === "the store's old copy") {
          await w.db.update(calEvents).set({ original: text, repeatRule: COUNT_10.slice("RRULE:".length) }).where(and(eq(calEvents.accountId, b.t.accountId), eq(calEvents.id, ended!.id)));
        }
        const from = b.dav.seen.length;
        const retry = await b.retry("k:2");
        await turns(b, 1);
        seen[name] = { doors, retry, ...(await at(b, from)), again: await b.retry("k:2") };
        want[name] = { doors: doors.map(() => "pending"), retry: "pending", rows: run.rows, made: run.made, days: run.days, twice: 0, again: run.again };
      }
      {
        const control = "the series ended earlier since, by another press of the person's before that day (the control: it has no day from the second part's day on, and the days are made)";
        const b = await benchMaking("again3", ["refused"]);
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("r", split(s!, DEC_21, SOLSTICE))];
        await turns(b, 1);
        const [ended] = await b.rows("s.ics");
        doors.push(await b.door("k", split(ended!, DEC_14, NEW_TERM)));
        await turns(b, 1);
        const from = b.dav.seen.length;
        const retry = await b.retry("r:2");
        await turns(b, 1);
        seen[control] = { doors, retry, ...(await at(b, from)) };
        want[control] = {
          doors: ["pending", "pending"], retry: "pending",
          rows: ["r applied attempts=1", "r:2 applied attempts=1", "k applied attempts=1", "k:2 applied attempts=1"], made: 1, days: 10, twice: 0,
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("keeps an applied row that holds the day it ended a series at past its seven days while an older write of that series stands owed or refused: tried again eight days on, a press or a letting go that was never heard of takes no later press's end for its own (the sixth recheck's, of the cleanup after seven days)", async () => {
      const seen: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      /** Every write of the account recorded, and last touched, this many hours earlier: the queue's age and the days its applied rows are kept. */
      const older = (b: B, hours: number) => w.db.update(calWrites).set({
        createdAt: sql`${calWrites.createdAt} - make_interval(hours => ${hours})`, updatedAt: sql`${calWrites.updatedAt} - make_interval(hours => ${hours})`,
      }).where(eq(calWrites.accountId, b.t.accountId));
      const at = async (b: B, from: number) => {
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        return { rows: await b.counted(), sent: whole(b, from).length, days: all.length, twice: all.filter((d, i) => all.indexOf(d) !== i).length, members: b.held().size };
      };
      const RUNS: Record<string, { readonly first: "press" | "let-go"; readonly then: "retry" | "retry, unheard" | "let go" }> = {
        "a press never heard of in eight attempts, the same day pressed again and made; eight days on the first is tried again": { first: "press", then: "retry" },
        "the days from 14 December let go, never heard of in eight attempts, then a press on them made; eight days on the letting go is tried again": { first: "let-go", then: "retry" },
        "the first press tried again eight days on before any turn, its look at the server never answered: owed, it keeps the row too": { first: "press", then: "retry, unheard" },
        "the first press let go eight days on (the control: no older write stands, and the row goes with the next turn's cleanup)": { first: "press", then: "let go" },
      };
      for (const [name, run] of Object.entries(RUNS)) {
        // The first write's request never reaches the server, eight times: it stands refused with a word that waits for time. (Of
        // the series' ends the writer is asked for, the ninth is the second press's; in one run the tenth is not answered either.)
        const b = await bench({ "s.ics": MONDAYS("pr") }, { mailboxes: [MILA], wrap: going([...times("cut", 8), "real", ...(run.then === "retry, unheard" ? ["cut"] : [])]) });
        const [s] = await b.rows("s.ics");
        const doors = [await b.door("a", run.first === "press" ? split(s!, DEC_14, NEW_TERM) : letGo(s!, DEC_14))];
        await turns(b, 8);
        const unheard = await b.counted();
        // The person presses that day again, on the copy the store holds: the series ends there, and the rest is a series of its own.
        const [again] = await b.rows("s.ics");
        doors.push(await b.door("b", split(again!, DEC_14, STUDIO_3)));
        await turns(b, 1);
        // Eight days on (applied rows are kept seven), a turn cleans up.
        await older(b, 8 * 24);
        let said = run.then === "retry, unheard" ? await b.retry("a") : "";
        await turns(b, 1);
        const eightDaysOn = await b.counted();
        const from = b.dav.seen.length;
        if (run.then === "retry") said = await b.retry("a");
        if (run.then === "let go") said = await b.dismiss("a");
        await turns(b, 1);
        seen[name] = { doors, unheard, eightDaysOn, said, ...(await at(b, from)) };
        const second = run.first === "press" ? ["a:2 refused earlier_refused attempts=0"] : [];
        const stood = ["a refused unknown attempts=8", ...second];
        want[name] = {
          doors: ["pending", "pending"], unheard: stood,
          // The second press's first part keeps the day it ended the series at, and stays while the older write stands refused, or
          // owed (tried again, its look waiting); its second part's row keeps no day, and goes.
          eightDaysOn: [...(run.then === "retry, unheard" ? ["a pending attempts=2", "a:2 pending attempts=0"] : stood), "b applied attempts=1"],
          ...(run.then === "let go"
            ? { said: "let go", rows: [] }
            // The end at the server is the second press's, as its row says: the first press, too old to send, is looked at and
            // expires; the letting go is refused for its copy at its claim. Nothing is sent, and no day is made twice.
            : { said: "pending", rows: [run.first === "let-go" ? "a refused version_stale attempts=1" : `a refused expired attempts=${run.then === "retry" ? 2 : 3}`, ...second, "b applied attempts=1"] }),
          sent: 0, days: 10, twice: 0, members: 2,
        };
      }
      {
        const control = "a write of the series recorded after the press's end was closed, and an older write of another series, both refused (the control: neither keeps the row, and it goes after its seven days)";
        const TUESDAYS = memberText({ uid: "pr3@studio.example.test", tz: ZH, start: "20261124T090000", end: "20261124T100000", rule: "FREQ=WEEKLY;BYDAY=TU;COUNT=10", summary: "Wheel" });
        const retitle = (row: Row, title: string) => ({ kind: "calendar_event_update", ...on(row), scope: { kind: "record" }, change: { title } });
        const b = await bench({ "s.ics": MONDAYS("pr2"), "o.ics": TUESDAYS }, { mailboxes: [MILA] });
        const [other] = await b.rows("o.ics");
        const doors = [await b.door("o", retitle(other!, "Wheel, mornings"))];
        b.dav.answerNext(403);
        await turns(b, 1);
        const [s] = await b.rows("s.ics");
        doors.push(await b.door("b", split(s!, DEC_14, STUDIO_3)));
        await turns(b, 1);
        const [ended] = await b.rows("s.ics");
        doors.push(await b.door("t", retitle(ended!, "Kiln, mornings")));
        b.dav.answerNext(403);
        await turns(b, 1);
        const refused = await b.counted();
        await older(b, 8 * 24);
        const from = b.dav.seen.length;
        await turns(b, 1);
        seen[control] = { doors, refused, ...(await at(b, from)) };
        want[control] = {
          doors: ["pending", "pending", "pending"],
          refused: ["o refused read_only attempts=1", "b applied attempts=1", "b:2 applied attempts=1", "t refused read_only attempts=1"],
          rows: ["o refused read_only attempts=1", "t refused read_only attempts=1"], sent: 0, days: 20, twice: 0, members: 3,
        };
      }
      expect(seen).toEqual(want);
    }, 240_000);

    it("still makes one end and no day twice of two presses on one series, the first one's answer lost (the second recheck's four pairs)", async () => {
      const PAIRS: Record<string, (s: Row) => [unknown, unknown]> = {
        "A lets the days from 14 December go, B changes them": (s) => [letGo(s, DEC_14), split(s, DEC_14, { title: "B" })],
        "A changes the days from 14 December, B lets them go": (s) => [split(s, DEC_14, { title: "A" }), letGo(s, DEC_14)],
        "A changes the days from 14 December, B the days from 21 December": (s) => [split(s, DEC_14, { title: "A" }), split(s, DEC_21, { title: "B" })],
        "A lets the days from 14 December go, B lets them go too": (s) => [letGo(s, DEC_14), letGo(s, DEC_14)],
      };
      const seen: Record<string, unknown> = {};
      for (const [name, acts] of Object.entries(PAIRS)) {
        const b = await bench({ "s.ics": MONDAYS("q6") }, { mailboxes: [MILA], wrap: losing() });
        const [s] = await b.rows("s.ics");
        const [a, bb] = acts(s!);
        const from = b.dav.seen.length;
        const doors = [await b.door("a", a), await b.door("b", bb)];
        for (let i = 0; i < 3; i++) expect(await b.turn()).toBe("synced");
        const all = [...b.held().values()].flatMap((t) => daysOf(t));
        seen[name] = {
          doors, rows: await b.writes(), written: b.sent(from, "s.ics").map((x) => `${x.method} ${x.member} ${x.ifMatch ?? x.ifNoneMatch}`),
          members: b.held().size, days: all.length, on14: all.filter((d) => d === "2026-12-14T08:00:00.000Z").length,
        };
      }
      const ended = ['PUT s.ics "s.ics-1"'];
      const made = ['PUT s.ics "s.ics-1"', "PUT a new member *"];
      expect(seen).toEqual({
        "A lets the days from 14 December go, B changes them": {
          doors: ["pending", "pending"], rows: ["a applied", "b refused version_stale", "b:2 refused earlier_refused"], written: ended, members: 1, days: 3, on14: 0,
        },
        "A changes the days from 14 December, B lets them go": {
          doors: ["pending", "pending"], rows: ["a applied", "a:2 applied", "b refused version_stale"], written: made, members: 2, days: 10, on14: 1,
        },
        "A changes the days from 14 December, B the days from 21 December": {
          doors: ["pending", "pending"], rows: ["a applied", "a:2 applied", "b refused version_stale", "b:2 refused earlier_refused"], written: made, members: 2, days: 10, on14: 1,
        },
        "A lets the days from 14 December go, B lets them go too": {
          doors: ["pending", "pending"], rows: ["a applied", "b refused version_stale"], written: ended, members: 1, days: 3, on14: 0,
        },
      });
    }, 120_000);
  });

  describe("a press's parts go only as the door records them (the recheck's sixth finding)", () => {
    const MILA = "mila@studio.example.test";
    const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
    const TEN = memberText({ uid: "s@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln" });
    const OTHER = memberText({ uid: "t@studio.example.test", tz: ZH, start: "20261123T150000", end: "20261123T160000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Other" });
    type Row = { id: string; updatedAt: Date };
    type B = Awaited<ReturnType<typeof bench>>;
    const change = (s: Row, newEventId: string) =>
      ({ kind: "calendar_event_update", ...on(s), scope: { kind: "following", at: DEC_14, newEventId }, change: { title: "The new term" } });
    const remove = (s: Row) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "following", at: DEC_14 } });
    const made = (b: B, newEventId: string, title = "The new term") => b.calendarId().then((calendarId) => ({
      kind: "calendar_event_create", eventId: newEventId, calendarId,
      event: {
        title, start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), notes: null, place: null, callLink: null, busy: true, private: false,
        repeat: "FREQ=WEEKLY;COUNT=7;BYDAY=MO", invitees: [], alarms: [],
      },
    }));
    const ROWS: Record<string, (b: B, s: Row, t: Row) => Promise<void>> = {
      "a change of a day and the days after it, with no mark of its part": async (b, s) => { await b.plant("k", change(s, randomUUID())); },
      "the same, marked the first part of a press whose second is not there": async (b, s) => {
        await b.plant("k", change(s, randomUUID()), { part: { of: "k", n: 1 } });
      },
      "the same, marked a press's second part": async (b, s) => { await b.plant("k", change(s, randomUUID()), { part: { of: "k", n: 2 } }); },
      "a removal of a day and the days after it, marked the first part of a press, a second part after it": async (b, s) => {
        const id = randomUUID();
        const first = await b.plant("k", remove(s), { part: { of: "k", n: 1 } });
        await b.plant("k:2", await made(b, id), { after: first.id, part: { of: "k", n: 2, from: { eventId: s.id, at: DEC_14, named: ["title"] } } });
      },
      "the same removal, marked the first part of a press, no second part": async (b, s) => {
        await b.plant("k", remove(s), { part: { of: "k", n: 1 } });
      },
      "a new series marked a press's second part, after a write that is not that press's first part (a retitle, done)": async (b, s) => {
        const r = await b.plant("r", { kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { title: "Kiln, renamed" } });
        expect(await b.turn()).toBe("synced");
        await b.plant("k:2", await made(b, randomUUID()), { after: r.id, part: { of: "k", n: 2, from: { eventId: s.id, at: DEC_14, named: ["title"] } } });
      },
      "a press whose second part names another series, the store's copy of the series newer than the press's": async (b, s, t) => {
        const id = randomUUID();
        const first = await b.plant("k", change(s, id), { part: { of: "k", n: 1 } });
        await b.plant("k:2", await made(b, id), { after: first.id, part: { of: "k", n: 2, from: { eventId: t.id, at: DEC_14, named: ["title"] } } });
        b.dav.put("studio", "s.ics", TEN.replace("SUMMARY:Kiln", "SUMMARY:Kiln, theirs"), '"s.ics-2"');
        expect(await b.read()).toBe("synced");
      },
    };
    const REFUSED: Record<string, string[]> = {
      "a change of a day and the days after it, with no mark of its part": ["k refused content_refused"],
      "the same, marked the first part of a press whose second is not there": ["k refused content_refused"],
      "the same, marked a press's second part": ["k refused content_refused"],
      "a removal of a day and the days after it, marked the first part of a press, a second part after it": ["k refused content_refused", "k:2 refused earlier_refused"],
      "the same removal, marked the first part of a press, no second part": ["k refused content_refused"],
      "a new series marked a press's second part, after a write that is not that press's first part (a retitle, done)": ["r applied", "k:2 refused content_refused"],
      "a press whose second part names another series, the store's copy of the series newer than the press's": ["k refused content_refused", "k:2 refused earlier_refused"],
    };

    it("sends nothing of a row no door makes: a part of a press out of its press, or a press's second part not after its own first", async () => {
      const seen: Record<string, unknown> = {};
      for (const [name, plant] of Object.entries(ROWS)) {
        const b = await bench({ "s.ics": TEN, "t.ics": OTHER }, { mailboxes: [MILA] });
        const [s] = await b.rows("s.ics");
        const [t] = await b.rows("t.ics");
        await plant(b, s!, t!);
        const from = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        // Every writing request the server received, whichever member it names.
        seen[name] = { writes: await b.writes(), written: b.sent(from, "s.ics").length, members: b.held().size };
      }
      expect(seen).toEqual(Object.fromEntries(Object.entries(REFUSED).map(([name, writes]) => [name, { writes, written: 0, members: 2 }])));
    }, 120_000);

    it("still carries out the press the door records: a change of a day and the days after it as two parts, their removal alone", async () => {
      const seen: Record<string, unknown> = {};
      for (const [name, act] of Object.entries({ change, remove: (s: Row) => remove(s) })) {
        const b = await bench({ "s.ics": TEN }, { mailboxes: [MILA] });
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("k", act(s!, randomUUID()));
        expect(await b.turn()).toBe("synced");
        seen[name] = { door, writes: await b.writes(), written: b.sent(from, "s.ics").map((x) => x.member) };
      }
      expect(seen).toEqual({
        change: { door: "pending", writes: ["k applied", "k:2 applied"], written: ["s.ics", "a new member"] },
        remove: { door: "pending", writes: ["k applied"], written: ["s.ics"] },
      });
    }, 60_000);

    it("sends nothing of a second part after a write that ended no series at its day: an applied retitle under the press's key (the second recheck's seen row)", async () => {
      const b = await bench({ "s.ics": TEN }, { mailboxes: [MILA] });
      const [s] = await b.rows("s.ics");
      const from = b.dav.seen.length;
      // A whole series' retitle under the key k, done; then a new series recorded past the door as k's second part (no door makes it).
      const first = await b.plant("k", { kind: "calendar_event_update", ...on(s!), scope: { kind: "record" }, change: { title: "Retitled" } });
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["k applied"]);
      await b.plant("k:2", await made(b, randomUUID()), { after: first.id, part: { of: "k", n: 2, from: { eventId: s!.id, at: DEC_14, named: ["title"] } } });
      const fromSecond = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      // Its first ended no series there (its applied row keeps no day): the new series is not made, and no day is there twice.
      expect(await b.writes()).toEqual(["k applied", "k:2 refused content_refused"]);
      expect(b.sent(fromSecond, "s.ics")).toEqual([]);
      expect(b.sent(from, "s.ics").map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch])).toEqual([["PUT", "s.ics", '"s.ics-1"', null]]);
      expect([[...b.held().values()].flatMap((t) => daysOf(t)).length, b.held().size]).toEqual([10, 1]);
    });
  });

  describe("a press half carried out, and the queue's age", () => {
    const MONDAYS = memberText({ uid: "n@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "N weekly" });
    const split = async (b: Awaited<ReturnType<typeof bench>>) => {
      const [series] = await b.rows("n.ics");
      return b.door("term", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId: randomUUID() },
        change: { title: "From 14 December" },
      });
    };

    it("is still repaired by its retry after 72 hours: the series ended, the new series refused, then made once", async () => {
      let refuse = true;
      const b = await bench({ "n.ics": MONDAYS }, {
        wrap: (real) => ({
          ...real,
          async continueSeries(...args: Parameters<CalendarWriter["continueSeries"]>) {
            return refuse ? { ok: false, reason: "read_only", retryAfterMs: null } : real.continueSeries(...args);
          },
        }),
      });
      expect(await split(b)).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term applied", "term:2 refused read_only"]);
      // Three days and an hour later, the person repairs it.
      await b.age(73);
      refuse = false;
      expect(await b.retry("term:2")).toBe("pending");
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term applied", "term:2 applied"]);
      expect(b.sent(from, "n.ics").map((x) => [x.method, x.member, x.ifMatch, x.ifNoneMatch])).toEqual([["PUT", "a new member", null, "*"]]);
      expect(b.held().size).toBe(2);
    });

    it("is still repaired by its retry eight days later: the first part's row is kept while the second names it, and pruned once nothing does (the second recheck's second finding)", async () => {
      const TEN = memberText({ uid: "q2@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln" });
      let refuse = true;
      const b = await bench({ "s.ics": TEN }, {
        mailboxes: ["mila@studio.example.test"],
        wrap: (real) => ({
          ...real,
          async continueSeries(...args: Parameters<CalendarWriter["continueSeries"]>) {
            return refuse ? { ok: false, reason: "too_large", retryAfterMs: null } : real.continueSeries(...args);
          },
        }),
      });
      /** Every write of the account recorded, and last touched, this many hours earlier: the queue's age and the days its applied rows are kept. */
      const older = (hours: number) => w.db.update(calWrites).set({
        createdAt: sql`${calWrites.createdAt} - make_interval(hours => ${hours})`, updatedAt: sql`${calWrites.updatedAt} - make_interval(hours => ${hours})`,
      }).where(eq(calWrites.accountId, b.t.accountId));
      const [series] = await b.rows("s.ics");
      const from = b.dav.seen.length;
      expect(await b.door("k", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId: randomUUID() },
        change: { title: "The new term" },
      })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["k applied", "k:2 refused too_large"]);
      const ended = b.sent(from, "s.ics").map((x) => ({ ...x, body: steady(x.body) }));
      expect(ended).toEqual([{ method: "PUT", member: "s.ics", ifMatch: '"s.ics-1"', ifNoneMatch: null, body: endedFrom(TEN, "RRULE:FREQ=WEEKLY;UNTIL=20261214T075959Z;BYDAY=MO") }]);
      // Eight days later (applied rows are kept seven): a turn prunes what is old; the first part stays while the second names it.
      await older(8 * 24);
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["k applied", "k:2 refused too_large"]);
      refuse = false;
      expect(await b.retry("k:2")).toBe("pending");
      const fromRetry = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      // The second part made, nothing names the first any more: older than seven days, its row goes with that same turn's prune.
      expect(await b.writes()).toEqual(["k:2 applied"]);
      expect(b.sent(fromRetry, "s.ics").map((x) => ({ ...x, body: steady(x.body) }))).toEqual([
        { method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeOf(TEN, { rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" }) },
      ]);
      expect([[...b.held().values()].flatMap((t) => daysOf(t)).length, b.held().size]).toEqual([10, 2]);
      // And the second's goes as any applied row does, seven days on.
      await older(8 * 24);
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual([]);
    });

    it("keeps the first part's row while its second part is owed too: tried and waiting when the turn prunes, it is made on the next (the third recheck's second unheld half)", async () => {
      const TEN = memberText({ uid: "q2o@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10", summary: "Kiln" });
      // The new series is refused once (too large), then its request never reaches the server once, then it is taken.
      const plan = ["413", "cut"];
      let n = 0;
      const b = await bench({ "s.ics": TEN }, {
        mailboxes: ["mila@studio.example.test"],
        wrap: (real) => ({
          ...real,
          async continueSeries(...args: Parameters<CalendarWriter["continueSeries"]>) {
            const how = plan[n++] ?? "real";
            if (how === "413") return { ok: false, reason: "too_large", retryAfterMs: null };
            if (how === "cut") throw new Error("the connection is down");
            return real.continueSeries(...args);
          },
        }),
      });
      const older = (hours: number) => w.db.update(calWrites).set({
        createdAt: sql`${calWrites.createdAt} - make_interval(hours => ${hours})`, updatedAt: sql`${calWrites.updatedAt} - make_interval(hours => ${hours})`,
      }).where(eq(calWrites.accountId, b.t.accountId));
      const [series] = await b.rows("s.ics");
      expect(await b.door("k", {
        kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId: randomUUID() },
        change: { title: "The new term" },
      })).toBe("pending");
      expect(await b.turn()).toBe("synced");
      expect(await b.counted()).toEqual(["k applied attempts=1", "k:2 refused too_large attempts=1"]);
      // Eight days later the person retries the second part; that turn's request is never heard, and the turn prunes what is old.
      await older(8 * 24);
      expect(await b.retry("k:2")).toBe("pending");
      expect(await b.turn()).toBe("synced");
      // The second part is owed (tried, waiting) and names the first: the first's row, older than seven days, stays.
      expect(await b.counted()).toEqual(["k applied attempts=1", "k:2 pending attempts=1"]);
      const fromNext = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.counted()).toEqual(["k:2 applied attempts=2"]);
      expect(b.sent(fromNext, "s.ics").map((x) => ({ ...x, body: steady(x.body) }))).toEqual([
        { method: "PUT", member: "a new member", ifMatch: null, ifNoneMatch: "*", body: madeOf(TEN, { rule: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" }) },
      ]);
      expect([[...b.held().values()].flatMap((t) => daysOf(t)).length, b.held().size]).toEqual([10, 2]);
    });

    it("still sends no other write late: a press neither half of which was sent, and a change, are refused expired after 72 hours", async () => {
      const b = await bench({ "n.ics": MONDAYS });
      expect(await split(b)).toBe("pending");
      const [series] = await b.rows("n.ics");
      expect(await b.door("retitle", { kind: "calendar_event_update", ...on(series!), after: "term", scope: { kind: "record" }, change: { title: "Late" } })).toBe("pending");
      await b.age(73);
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["term refused expired", "term:2 refused earlier_refused", "retitle refused earlier_refused"]);
      expect(b.sent(from, "n.ics")).toEqual([]);
    });
  });

  describe("a mark that changes on the new series' record", () => {
    const MONDAYS = memberText({ uid: "n@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "N weekly" });

    for (const why of ["read_only", "version_stale"] as const) {
      it(`is told to devices when the press's first half is refused ${why} and its second with it, and again when the first is put back`, async () => {
        let refuse = why === "read_only";
        const b = await bench({ "n.ics": MONDAYS }, {
          wrap: (real) => ({
            ...real,
            async endSeries(...args: Parameters<CalendarWriter["endSeries"]>) {
              return refuse ? { ok: false, reason: "read_only", retryAfterMs: null } : real.endSeries(...args);
            },
          }),
        });
        const [series] = await b.rows("n.ics");
        const newEventId = randomUUID();
        expect(await b.door("term", {
          kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: String(Date.UTC(2026, 11, 14, 8)), newEventId }, change: { title: "From 14 December" },
        })).toBe("pending");
        expect(await b.changes(newEventId)).toEqual(["create"]);
        if (why === "version_stale") b.dav.put("studio", "n.ics", MONDAYS.replace("SUMMARY:N weekly", "SUMMARY:Theirs"), '"n.ics-2"');
        expect(await b.turn()).toBe("synced");
        expect(await b.writes()).toEqual([`term refused ${why}`, "term:2 refused earlier_refused"]);
        // The new series' record now carries the second half refused with the first: its devices are told.
        expect(await b.changes(newEventId)).toEqual(["create", "update"]);
        if (why === "read_only") {
          refuse = false;
          expect(await b.retry("term")).toBe("pending");
          expect(await b.writes()).toEqual(["term pending", "term:2 pending"]);
          expect(await b.changes(newEventId)).toEqual(["create", "update", "update"]);
        }
      });
    }
  });

  describe("a series with invitees, at a server that does not send invitations itself", () => {
    const MILA = "mila@studio.example.test";
    const GIULIA = "giulia@example.test";
    const people = [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${GIULIA}`];
    const OWN = memberText({ uid: "critique@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze critique", more: people });
    /** One event with the same invitee, no repeat. */
    const ONE = OWN.replace("RRULE:FREQ=WEEKLY;BYDAY=MO\r\n", "").replace("UID:critique@", "UID:one@");
    const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
    const audience = { organizer: MILA, guests: [GIULIA] };
    const ACTS: Record<string, { readonly member: "own" | "one"; readonly act: (s: { id: string; updatedAt: Date }) => unknown }> = {
      "the whole series retitled": { member: "own", act: (s) => ({ kind: "calendar_event_update", ...on(s), audience, scope: { kind: "record" }, change: { title: "Renamed" } }) },
      "the whole series at a new time": { member: "own", act: (s) => ({ kind: "calendar_event_update", ...on(s), audience, scope: { kind: "record" }, change: { start: zoned("20261123T110000", ZH), end: zoned("20261123T120000", ZH) } }) },
      "the whole series removed": { member: "own", act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" }, audience }) },
      "one day moved": { member: "own", act: (s) => ({ kind: "calendar_event_update", ...on(s), audience, scope: { kind: "occurrence", at: DEC_7 }, change: { start: zoned("20261207T140000", ZH), end: zoned("20261207T150000", ZH) } }) },
      "one day cancelled": { member: "own", act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "occurrence", at: DEC_7 }, audience }) },
      "a repeat put on one event": { member: "one", act: (s) => ({ kind: "calendar_event_update", ...on(s), audience, scope: { kind: "record" }, change: { repeat: "FREQ=WEEKLY;BYDAY=MO" } }) },
    };

    for (const autoSchedule of [false, true]) {
      it(`${autoSchedule ? "writes" : "writes none of"} a series' change or removal, a day's move or cancel, or a repeat put on an event${autoSchedule ? " where the server tells the invitees" : ": its invitees would never hear"}`, async () => {
        const outcome: Record<string, string> = {};
        for (const [name, c] of Object.entries(ACTS)) {
          const member = `${c.member}.ics`;
          const b = await bench({ [member]: c.member === "own" ? OWN : ONE }, { autoSchedule, mailboxes: [MILA] });
          const [row] = await b.rows(member);
          expect(await b.door("k", c.act(row!))).toBe("pending");
          const from = b.dav.seen.length;
          expect(await b.turn()).toBe("synced");
          outcome[name] = `${(await b.writes()).join("; ")} | ${b.sent(from, member).map((x) => x.method).join(", ") || "nothing written"}`;
        }
        expect(outcome).toEqual(Object.fromEntries(Object.entries(ACTS).map(([name, c]) => [name, autoSchedule
          ? `k applied | ${name === "the whole series removed" ? "DELETE" : "PUT"}`
          : "k refused invitees_unsupported | nothing written"])));
      });
    }
  });

  it("moves an organizerless shared event without changing guests or another calendar's copy", async () => {
    const guest = "ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED:mailto:guest@example.test";
    const text = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:shared-workshop",
      "DTSTAMP:20261101T000000Z", "DTSTART:20261123T100000Z", "DTEND:20261123T110000Z",
      "SUMMARY:Workshop", guest, "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const b = await bench({ "shared.ics": text }, { autoSchedule: true });
    b.dav.addCalendar("neighbour");
    b.dav.put("neighbour", "shared.ics", text, '"untouched"');
    expect(await b.access(false)).toBe("synced");
    const [selected] = await b.rows("shared.ics");
    const update = { kind: "calendar_event_update", ...on(selected!), scope: { kind: "record" } };
    const from = b.dav.seen.length;
    expect(await b.door("guests", { ...update, change: { invitees: [] } })).toBe("409 calendar_read_only");
    expect(b.dav.seen).toHaveLength(from);
    expect(await b.door("time", { ...update, change: {
      start: { kind: "instant", value: "20261123T120000Z" },
      end: { kind: "instant", value: "20261123T130000Z" },
    } })).toBe("pending");
    expect(await b.turn()).toBe("synced");
    expect(await b.writes()).toEqual(["time applied"]);
    const mutations = b.dav.seen.slice(from).filter(({ method }) => ["PUT", "DELETE", "MOVE", "POST"].includes(method));
    expect(mutations.map(({ method, path }) => [method, path])).toEqual([["PUT", b.dav.paths.member("studio", "shared.ics")]]);
    const [put] = mutations;
    expect(put?.headers["if-match"]).toBe('"shared.ics-1"');
    expect(put?.body).toContain("DTSTART:20261123T120000Z");
    expect(put?.body.split("\r\n").filter((line) => /^(ATTENDEE|ORGANIZER)/.test(line))).toEqual([guest]);
  });

  describe("an event with an invitee is written only where the server tells them (ruling ii: one rule for every write)", () => {
    const MILA = "mila@studio.example.test";
    const GIULIA = "giulia@example.test";
    const ANNA = "anna@example.test";
    /** One event with no repeat, with these lines of people. */
    const talk = (people: readonly string[]) => memberText({
      uid: "talk@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "X", summary: "Glaze talk", more: people,
    }).replace("RRULE:X\r\n", "");
    /** The account organizes it, Giulia is invited. */
    const ONE = talk([`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${GIULIA}`]);
    /** No organizer and no invitee. */
    const PLAIN = talk([]);
    /** Its one line of people besides the organizer's is the organizer's own, in capitals. */
    const ORGANIZER_ONLY = talk([`ORGANIZER;CN=Mila:mailto:${MILA}`, "ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:MAILTO:Mila@Studio.Example.Test"]);
    /** Its invitee told by a principal's path. */
    const BY_PATH = talk([`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;EMAIL=${GIULIA};PARTSTAT=ACCEPTED:/principals/giulia/`]);
    type Row = { id: string; updatedAt: Date };
    type B = Awaited<ReturnType<typeof bench>>;
    const record = (s: Row, change: Record<string, unknown>) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change });
    const ACTS: Record<string, {
      readonly text: string;
      readonly act: (s: Row, b: B) => unknown | Promise<unknown>;
      readonly told: boolean;
      readonly incomplete?: true;
    }> = {
      // The five ruling (ii) names: written before at a server that tells nobody.
      "an event with an invitee: retitled": { text: ONE, act: (s) => record(s, { title: "Renamed" }), told: true },
      "an event with an invitee: a new time": { text: ONE, act: (s) => record(s, { start: zoned("20261123T140000", ZH), end: zoned("20261123T150000", ZH) }), told: true },
      "an event with an invitee: a new place": { text: ONE, act: (s) => record(s, { place: "Studio 3" }), told: true },
      "an event with an invitee: removed": { text: ONE, act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" }, audience: { organizer: MILA, guests: [GIULIA] } }), told: true },
      "an event with an invitee: its invitees taken off (an empty list)": { text: ONE, act: (s) => record(s, { invitees: [] }), told: true },
      // The three refused before.
      "an event with an invitee: another invitee named": {
        text: ONE, act: (s) => record(s, { invitees: [{ address: GIULIA, name: "Giulia", role: "required" }, { address: ANNA, name: "Anna", role: "required" }] }), told: true,
      },
      "an event with no invitee: an invitee named": { text: PLAIN, act: (s) => record(s, { invitees: [{ address: GIULIA, name: "Giulia", role: "required" }] }), told: true },
      "a new event with an invitee": {
        text: PLAIN, told: true,
        act: async (_s, b) => ({ kind: "calendar_event_create", eventId: randomUUID(), calendarId: await b.calendarId(), event: {
          title: "New talk", start: zoned("20261124T090000", ZH), end: zoned("20261124T100000", ZH), notes: null, place: null, callLink: null, busy: true, private: false,
          repeat: null, invitees: [{ address: GIULIA, name: "Giulia", role: "required" }], alarms: [],
        } }),
      },
      // The other spellings of "an event with an invitee", and the one change no invitee hears of.
      "an event whose invitee is told by a principal's path: retitled": {
        text: BY_PATH, act: (s) => record(s, { title: "Renamed" }), told: true, incomplete: true,
      },
      "an event with an invitee: its reminders and its title": { text: ONE, act: (s) => record(s, { alarms: [30], title: "Renamed" }), told: true },
      "an event with an invitee: its reminders alone": { text: ONE, act: (s) => record(s, { alarms: [30] }), told: false },
      "an event whose one other line is its organizer's own: retitled": { text: ORGANIZER_ONLY, act: (s) => record(s, { title: "Renamed" }), told: false },
      "an event with no invitee: retitled": { text: PLAIN, act: (s) => record(s, { title: "Renamed" }), told: false },
    };

    for (const autoSchedule of [false, true]) {
      it(`${autoSchedule ? "writes each" : "writes none of the writes an invitee would hear of, but the account's reminders,"} at a server that ${autoSchedule ? "sends invitations itself" : "sends none"}`, async () => {
        const seen: Record<string, string> = {};
        for (const [name, c] of Object.entries(ACTS)) {
          const b = await bench({ "talk.ics": c.text }, { autoSchedule, mailboxes: [MILA], proven: PROVEN_REPEATS });
          const [row] = await b.rows("talk.ics");
          const door = await b.door("k", await c.act(row!, b));
          const from = b.dav.seen.length;
          if (door === "pending") expect(await b.turn()).toBe("synced");
          seen[name] = `door ${door} | ${(await b.writes()).join("; ")} | ${b.sent(from, "talk.ics").map((x) => `${x.method} ${x.member}`).join(", ") || "nothing written"}`;
        }
        const written = (name: string): string => (name === "a new event with an invitee" ? "PUT a new member" : `${name.endsWith("removed") ? "DELETE" : "PUT"} talk.ics`);
        expect(seen).toEqual(Object.fromEntries(Object.entries(ACTS).map(([name, c]) => {
          if (c.incomplete) return [name, "door 409 calendar_read_only |  | nothing written"];
          return [name, autoSchedule || !c.told
            ? `door pending | k applied | ${written(name)}`
            : "door pending | k refused invitees_unsupported | nothing written"];
        })));
      }, 120_000);
    }

    it("holds the one exception for a series and a day of it too: their reminders alone are written at a server that sends none, and nothing else of them", async () => {
      // The account's series, Giulia invited; the bench's row for the stand-in's place.
      const SERIES = memberText({
        uid: "critique@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Glaze critique",
        more: [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Giulia;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      });
      const DEC_7 = String(Date.UTC(2026, 11, 7, 8));
      const audience = { organizer: MILA, guests: [GIULIA] };
      const acts: Record<string, (s: Row) => unknown> = {
        "the series' reminders alone": (s) => ({ ...record(s, { alarms: [30] }), audience }),
        "one day's reminders alone": (s) => ({ kind: "calendar_event_update", ...on(s), audience, scope: { kind: "occurrence", at: DEC_7 }, change: { alarms: [30] } }),
        "the series' reminders and its title": (s) => ({ ...record(s, { alarms: [30], title: "Renamed" }), audience }),
        "one day's reminders and its place": (s) => ({ kind: "calendar_event_update", ...on(s), audience, scope: { kind: "occurrence", at: DEC_7 }, change: { alarms: [30], place: "Studio 3" } }),
      };
      const seen: Record<string, string> = {};
      for (const [name, act] of Object.entries(acts)) {
        const b = await bench({ "critique.ics": SERIES }, { mailboxes: [MILA] });
        const [row] = await b.rows("critique.ics");
        const door = await b.door("k", act(row!));
        const from = b.dav.seen.length;
        if (door === "pending") expect(await b.turn()).toBe("synced");
        seen[name] = `door ${door} | ${(await b.writes()).join("; ")} | ${b.sent(from, "critique.ics").map((x) => `${x.method} ${x.member}`).join(", ") || "nothing written"}`;
      }
      expect(seen).toEqual({
        "the series' reminders alone": "door pending | k applied | PUT critique.ics",
        "one day's reminders alone": "door pending | k applied | PUT critique.ics",
        "the series' reminders and its title": "door pending | k refused invitees_unsupported | nothing written",
        "one day's reminders and its place": "door pending | k refused invitees_unsupported | nothing written",
      });
    }, 60_000);
  });

  describe("a series at a clock time that does not exist on the night the clocks go forward (the second recheck's fourth finding)", () => {
    const MILA = "mila@studio.example.test";
    type Row = { id: string; updatedAt: Date };
    type B = Awaited<ReturnType<typeof bench>>;
    /** A series at 02:30 in Zurich, as another program writes it, with its zone defined over 2026 to 2028. */
    const nightly = (uid: string, start: string, end: string, rule: string) => [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//calendar//EN", ...zoneLines(ZH, Date.UTC(2026, 0, 1), Date.UTC(2029, 0, 1)), "BEGIN:VEVENT",
      `UID:${uid}@studio.example.test`, "DTSTAMP:20260301T120000Z", `DTSTART;TZID=${ZH}:${start}`, `DTEND;TZID=${ZH}:${end}`, `RRULE:${rule}`,
      "SUMMARY:Night kiln check", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR", "",
    ].map((l) => (l === "" ? l : fold(l))).join("\r\n");
    /** Daily at 02:30 from 20 March 2026, three hundred days (to January 2027, before the clocks skip again): 29 March 2026 has no 02:30. */
    const SKIPPING = nightly("e1", "20260320T023000", "20260320T030000", "FREQ=DAILY;COUNT=300");
    /** 29 March 2026: the calendar core places that night's 02:30 at 01:30 UTC (03:30 summer time); the night after it is 02:30 again. */
    const SKIPPED = String(Date.UTC(2026, 2, 29, 1, 30));
    const NEXT = String(Date.UTC(2026, 2, 30, 0, 30));
    /** Daily at 02:30 from 20 March 2027, ended by an UNTIL as given: 28 March 2027 has no 02:30. */
    const ENDING = (until: string) => nightly("e2", "20270320T023000", "20270320T030000", `FREQ=DAILY;UNTIL=${until}`);
    const MAR_24 = String(Date.UTC(2027, 2, 24, 1, 30));
    const field = (start: string, end: string, repeat: string, title: string) => ({
      title, start: zoned(start, ZH), end: zoned(end, ZH), notes: null, place: null, callLink: null, busy: true, private: false, repeat, invitees: [], alarms: [],
    });
    interface Row4 {
      readonly name: string;
      readonly text: string;
      readonly act: (s: Row, newEventId: string) => Record<string, unknown>;
      /** A press's second part as the door recorded it before this round, for the run past the door. */
      readonly second?: Record<string, unknown>;
    }
    const split = (at: string, change: Record<string, unknown>) => (s: Row, newEventId: string) =>
      ({ kind: "calendar_event_update", ...on(s), scope: { kind: "following", at, newEventId }, change });
    const REFUSED: Row4[] = [
      {
        name: "(a) from the skipped night on, a new title", text: SKIPPING, act: split(SKIPPED, { title: "From that night on" }),
        second: field("20260329T033000", "20260329T040000", "FREQ=DAILY;COUNT=291", "From that night on"),
      },
      { name: "(a) from the skipped night on, let go", text: SKIPPING, act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "following", at: SKIPPED } }) },
      { name: "(a) the skipped night cancelled", text: SKIPPING, act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "occurrence", at: SKIPPED } }) },
      {
        name: "(a) the skipped night's place", text: SKIPPING,
        act: (s) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "occurrence", at: SKIPPED }, change: { place: "Studio 3" } }),
      },
      {
        name: "(b) UNTIL in the stretch (01:00 UTC): the whole series at 09:00", text: ENDING("20270328T010000Z"),
        act: (s) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { start: zoned("20270320T090000", ZH), end: zoned("20270320T093000", ZH) } }),
      },
      {
        name: "(b) UNTIL in the stretch (01:00 UTC): from 24 March on at 09:00", text: ENDING("20270328T010000Z"),
        act: split(MAR_24, { start: zoned("20270324T090000", ZH), end: zoned("20270324T093000", ZH) }),
        second: field("20270324T090000", "20270324T093000", "FREQ=DAILY;UNTIL=20270327T080000Z", "Night kiln check"),
      },
      {
        name: "(b) UNTIL at the stretch's start (00:30 UTC): the whole series at 09:00", text: ENDING("20270328T003000Z"),
        act: (s) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { start: zoned("20270320T090000", ZH), end: zoned("20270320T093000", ZH) } }),
      },
    ];
    /** A press recorded past the door, as the door recorded it: one row, or a press's two parts. */
    const plant = async (b: B, r: Row4, s: Row) => {
      const newEventId = randomUUID();
      const act = r.act(s, newEventId);
      if (r.second === undefined) {
        await b.plant("k", act);
        return;
      }
      const first = await b.plant("k", act, { part: { of: "k", n: 1 } });
      const named = ["title", "notes", "place", "callLink", "busy", "private", "alarms"].filter((f) => (act.change as Record<string, unknown>)[f] !== undefined) as "title"[];
      await b.plant("k:2", { kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(), event: r.second }, {
        after: first.id, part: { of: "k", n: 2, from: { eventId: s.id, at: (act.scope as { at: string }).at, named } },
      });
    };

    it("refuses an act on a day whose clock time is not the series' own, and a new time where the series' end lies in the stretch its zone skips: at the door, and past it nothing is sent", async () => {
      const seen: Record<string, unknown> = {};
      for (const r of REFUSED) {
        const atDoor = await bench({ "s.ics": r.text }, { mailboxes: [MILA] });
        const [s] = await atDoor.rows("s.ics");
        const fromDoor = atDoor.dav.seen.length;
        const door = await atDoor.door("k", r.act(s!, randomUUID()));
        if (door === "pending") expect(await atDoor.turn()).toBe("synced");
        const past = await bench({ "s.ics": r.text }, { mailboxes: [MILA] });
        const [planted] = await past.rows("s.ics");
        await plant(past, r, planted!);
        const from = past.dav.seen.length;
        expect(await past.turn()).toBe("synced");
        seen[r.name] = {
          door, doorSent: atDoor.sent(fromDoor, "s.ics").length, writes: await past.writes(), sent: past.sent(from, "s.ics"),
          asItWas: past.held().get("s.ics") === r.text && past.held().size === 1,
        };
      }
      expect(seen).toEqual(Object.fromEntries(REFUSED.map((r) => [r.name, {
        door: "400 validation_failed", doorSent: 0, writes: r.second === undefined ? ["k refused repeat_unsupported"] : ["k refused repeat_unsupported", "k:2 refused earlier_refused"],
        sent: [], asItWas: true,
      }])));
    }, 240_000);

    it("still writes the series from the night after the skipped one, and a series ending in that stretch where nothing moves its end, as before", async () => {
      const WRITTEN: { readonly name: string; readonly text: string; readonly act: (s: Row, newEventId: string) => Record<string, unknown>; readonly rows: string[]; readonly days: [number, number] }[] = [
        { name: "from the night after the skipped one, a new title", text: SKIPPING, act: split(NEXT, { title: "From the next night on" }), rows: ["k applied", "k:2 applied"], days: [300, 300] },
        {
          name: "UNTIL in the stretch: retitled (its end kept as it is)", text: ENDING("20270328T010000Z"),
          act: (s) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { title: "Renamed" } }), rows: ["k applied"], days: [8, 8],
        },
        {
          name: "UNTIL in the stretch: from 24 March on, a new title (its end kept as it is)", text: ENDING("20270328T010000Z"), act: split(MAR_24, { title: "From the 24th" }),
          rows: ["k applied", "k:2 applied"], days: [8, 8],
        },
        {
          name: "UNTIL outside it (the 27th's own day): the whole series at 09:00", text: ENDING("20270327T013000Z"),
          act: (s) => ({ kind: "calendar_event_update", ...on(s), scope: { kind: "record" }, change: { start: zoned("20270320T090000", ZH), end: zoned("20270320T093000", ZH) } }),
          rows: ["k applied"], days: [8, 8],
        },
      ];
      const seen: Record<string, unknown> = {};
      for (const c of WRITTEN) {
        const b = await bench({ "s.ics": c.text }, { mailboxes: [MILA] });
        const [s] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("k", c.act(s!, randomUUID()));
        if (door === "pending") expect(await b.turn()).toBe("synced");
        seen[c.name] = {
          door, rows: await b.writes(), written: b.sent(from, "s.ics").map((x) => `${x.method} ${x.member} ${x.ifMatch ?? x.ifNoneMatch}`),
          days: [daysOf(c.text).length, [...b.held().values()].flatMap((t) => daysOf(t)).length],
        };
      }
      expect(seen).toEqual(Object.fromEntries(WRITTEN.map((c) => [c.name, {
        door: "pending", rows: c.rows, written: c.rows.length === 2 ? ['PUT s.ics "s.ics-1"', "PUT a new member *"] : ['PUT s.ics "s.ics-1"'], days: c.days,
      }])));
    }, 120_000);
  });

  describe("the series as it stands after its end", () => {
    const MONDAYS = memberText({ uid: "n@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "N weekly" });

    it("is asked of the proof too: where a weekly series with no end and one with a count are proven and one ended by a day is not, neither its split nor the removal of its days from one on is written", async () => {
      const b = await bench({ "n.ics": MONDAYS }, { shapes: ["weekly/never", "weekly/count"] });
      const [series] = await b.rows("n.ics");
      const DEC_14 = String(Date.UTC(2026, 11, 14, 8));
      const newEventId = randomUUID();
      const split = { kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: DEC_14, newEventId }, change: { title: "From 14 December" } };
      const drop = { kind: "calendar_event_delete", ...on(series!), scope: { kind: "following", at: DEC_14 } };
      // The door asks it as the drain does, and records neither.
      expect([await b.door("split", split), await b.door("drop", drop)]).toEqual(["400 validation_failed", "400 validation_failed"]);
      // Recorded past the door, the drain refuses both.
      const first = await b.plant("split", split, { part: { of: "split", n: 1 } });
      await b.plant("split:2", {
        kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(),
        event: {
          title: "From 14 December", start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), notes: null, place: null, callLink: null, busy: true,
          private: false, repeat: "FREQ=WEEKLY;BYDAY=MO", invitees: [], alarms: [],
        },
      }, { after: first.id, part: { of: "split", n: 2, from: { eventId: series!.id, at: DEC_14, named: ["title"] } } });
      await b.plant("drop", drop);
      const from = b.dav.seen.length;
      expect(await b.turn()).toBe("synced");
      expect(await b.writes()).toEqual(["split refused repeat_unsupported", "split:2 refused earlier_refused", "drop refused repeat_unsupported"]);
      expect(b.sent(from, "n.ics")).toEqual([]);
    });
  });

  describe("a press on a day and the days after it, from the door through the drain to the server, for each kind of series the door takes", () => {
    const MILA = "mila@studio.example.test";
    const GIULIA = "giulia@example.test";
    const zh = (m: number, d: number, y = 2026, h = 9) => String(Date.UTC(y, m - 1, d, h - 1));
    const utcDay = (m: number, d: number, y = 2026) => String(Date.UTC(y, m - 1, d));
    interface Kind {
      readonly name: string;
      readonly member: Member;
      /** The day the press is made on, by its key. */
      readonly at: string;
      readonly change?: Record<string, unknown>;
      readonly autoSchedule?: boolean;
      /** Days of the series, of its end, and of the new series (in the window the core is asked over). */
      readonly days: readonly [number, number, number];
    }
    const Z = (rule: string, more: Partial<Member> = {}): Member =>
      ({ uid: `${rule.replace(/\W/g, "").toLowerCase()}@studio.example.test`, tz: ZH, start: "20261123T090000", end: "20261123T100000", rule, summary: "Kiln", ...more });
    const KINDS: Kind[] = [
      { name: "a clock time, weekly, no end", member: Z("FREQ=WEEKLY;BYDAY=MO"), at: zh(12, 14), days: [215, 3, 212] },
      { name: "a clock time, weekly, a count", member: Z("FREQ=WEEKLY;BYDAY=MO;COUNT=10"), at: zh(12, 14), days: [10, 3, 7] },
      { name: "a clock time, weekly, ended on a day by its last day's own start", member: Z("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270125T080000Z"), at: zh(12, 14), days: [10, 3, 7] },
      { name: "a clock time, daily, ended at the end of a day", member: Z("FREQ=DAILY;UNTIL=20261202T225959Z"), at: zh(11, 28), days: [10, 5, 5] },
      { name: "a clock time, weekly, a count, days excluded before and after the day", member: Z("FREQ=WEEKLY;BYDAY=MO;COUNT=10", { excluded: ["20261130T090000", "20261228T090000"] }), at: zh(12, 14), days: [8, 2, 6] },
      {
        name: "a clock time, weekly, a count, a day after the day cancelled by a component of its own",
        member: Z("FREQ=WEEKLY;BYDAY=MO;COUNT=10", { days: [{ was: "20261228T090000", start: "20261228T090000", end: "20261228T100000", summary: "Kiln", status: "CANCELLED" }] }),
        at: zh(12, 14), days: [9, 3, 6],
      },
      { name: "a clock time, weekly, a day changed before the day and one after it (not carried)", member: Z("FREQ=WEEKLY;BYDAY=MO;COUNT=10", {
        days: [{ was: "20261130T090000", start: "20261130T140000", end: "20261130T150000", summary: "Kiln, moved" }, { was: "20270111T090000", start: "20270111T090000", end: "20270111T100000", summary: "Kiln, retitled" }],
      }), at: zh(12, 14), days: [10, 3, 7] },
      { name: "a clock time, monthly by its date, a count", member: Z("FREQ=MONTHLY;COUNT=6"), at: zh(1, 23, 2027), days: [6, 2, 4] },
      { name: "a clock time, weekdays, a count", member: Z("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10"), at: zh(11, 30), days: [10, 5, 5] },
      { name: "a clock time, weekly, a new time from the day on", member: Z("FREQ=WEEKLY;BYDAY=MO;COUNT=10"), at: zh(12, 14), change: { start: zoned("20261214T110000", ZH), end: zoned("20261214T120000", ZH) }, days: [10, 3, 7] },
      { name: "a clock time, weekly, ended on a day by its last day's own start, a new time from the day on", member: Z("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270125T080000Z"), at: zh(12, 14), change: { start: zoned("20261214T110000", ZH), end: zoned("20261214T120000", ZH) }, days: [10, 3, 7] },
      { name: "whole days, daily, a count, days excluded after the day", member: { uid: "b@studio.example.test", tz: null, start: "20261123", end: "20261124", rule: "FREQ=DAILY;COUNT=10", summary: "Kiln", excluded: ["20261130"] }, at: utcDay(11, 28), days: [9, 5, 4] },
      { name: "whole days, weekly, ended on a day", member: { uid: "c@studio.example.test", tz: null, start: "20261123", end: "20261124", rule: "FREQ=WEEKLY;UNTIL=20270125", summary: "Kiln" }, at: utcDay(12, 14), days: [10, 3, 7] },
      { name: "whole days, yearly, a count", member: { uid: "d@studio.example.test", tz: null, start: "20261123", end: "20261124", rule: "FREQ=YEARLY;COUNT=4", summary: "Kiln" }, at: utcDay(11, 23, 2028), days: [4, 2, 2] },
      { name: "a clock time, weekly, with invitees, at a server that sends invitations itself", member: Z("FREQ=WEEKLY;BYDAY=MO;COUNT=10", {
        more: [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      }), at: zh(12, 14), autoSchedule: true, days: [10, 3, 7] },
    ];
    /** What a new series of the days writes anew in the series' own component; every other line is carried as it is. */
    const audience = { organizer: MILA, guests: [GIULIA] };
    const anew = /^(UID|DTSTAMP|DTSTART|DTEND|RRULE|EXDATE|SEQUENCE|CREATED|LAST-MODIFIED|SUMMARY|ATTENDEE)[;:]/;

    it("ends the series and makes the days after it a series of their own: two writes, no day lost, none come back, every line carried", async () => {
      const seen: Record<string, unknown> = {};
      for (const k of KINDS) {
        const text = memberText(k.member);
        const b = await bench({ "s.ics": text }, { autoSchedule: k.autoSchedule ?? false, mailboxes: [MILA] });
        const [series] = await b.rows("s.ics");
        const from = b.dav.seen.length;
        const door = await b.door("term", {
          kind: "calendar_event_update", ...on(series!), scope: { kind: "following", at: k.at, newEventId: randomUUID() },
          change: { title: "Kiln, the new term", ...k.change }, ...(k.autoSchedule ? { audience } : {}),
        });
        const turn = door === "pending" ? await b.turn() : "(no turn)";
        const sent = b.sent(from, "s.ics");
        const made = sent[k.autoSchedule ? 0 : 1]?.body ?? "";
        const shortened = sent[k.autoSchedule ? 1 : 0]?.body;
        seen[k.name] = {
          door, turn, writes: await b.writes(),
          requests: sent.map((x) => [x.method, x.member, x.ifMatch === null ? null : "the press's own", x.ifNoneMatch]),
          days: [daysOf(text).length, shortened === undefined ? null : daysOf(shortened).length, made === "" ? null : daysOf(made).length],
          // Every line of the series' own component, but what a new series writes anew, is in the new one as it was.
          carried: made === "" ? null : masterOf(text).filter((l) => !anew.test(l)).every((l) => masterOf(made).includes(l)),
          // The series' end leaves the object outside its own component as it was, but the changed days from that day on.
          zones: shortened === undefined ? null : JSON.stringify(partsOf(shortened).components.filter((c) => c.name === "VTIMEZONE")) === JSON.stringify(partsOf(text).components.filter((c) => c.name === "VTIMEZONE")),
        };
      }
      expect(seen).toEqual(Object.fromEntries(KINDS.map((k) => [k.name, {
        door: "pending", turn: "synced", writes: ["term applied", "term:2 applied"],
        requests: k.autoSchedule
          ? [["PUT", "a new member", null, "*"], ["PUT", "s.ics", "the press's own", null]]
          : [["PUT", "s.ics", "the press's own", null], ["PUT", "a new member", null, "*"]],
        days: [...k.days], carried: true, zones: true,
      }])));
      // No day is lost and none comes back: the series' days are its end's and the new series'.
      expect(KINDS.filter((k) => k.days[0] !== k.days[1] + k.days[2]).map((k) => k.name)).toEqual([]);
    }, 120_000);
  });

  describe("door and drain refuse the same things (the second review's 44 cases, at the door and recorded past it)", () => {
    const MILA = "mila@studio.example.test";
    const GIULIA = "giulia@example.test";
    const ANNA = "anna@example.test";
    const at = (y: number, m: number, d: number, h = 8) => String(Date.UTC(y, m - 1, d, h));
    const NOV_23 = at(2026, 11, 23);
    const DEC_7 = at(2026, 12, 7);
    const DEC_8 = at(2026, 12, 8);
    const DEC_14 = at(2026, 12, 14);
    const zh = (start: string, rule: string, summary: string, more: Partial<Member> = {}) =>
      memberText({ uid: `${summary.replace(/\W/g, "").toLowerCase()}@studio.example.test`, tz: ZH, start, end: start.replace(/T(\d\d)/, (_, h: string) => `T${String(Number(h) + 1).padStart(2, "0")}`), rule, summary, ...more });
    /** A member written whole, for the kinds `memberText` does not write (UTC, no zone, listed days, UNTIL told as a day). */
    const raw = (uid: string, lines: readonly string[]) => [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//elsewhere//calendar//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20261113T120000Z", ...lines, "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    const MEMBERS: Record<string, string> = {
      plain: zh("20261123T090000", "FREQ=WEEKLY;BYDAY=MO;COUNT=10", "Glaze class"),
      weekly: memberText({
        uid: "weekly@studio.example.test", tz: ZH, start: "20261123T090000", end: "20261123T100000", rule: "FREQ=WEEKLY;BYDAY=MO", summary: "Weekly kiln",
        days: [{ was: "20261130T090000", start: "20261130T140000", end: "20261130T150000", summary: "Weekly kiln, moved" }],
      }),
      excl: zh("20261123T090000", "FREQ=WEEKLY;BYDAY=MO", "Weekly wheel", { excluded: ["20261130T090000"] }),
      single: raw("single@studio.example.test", [`DTSTART;TZID=${ZH}:20261123T090000`, `DTEND;TZID=${ZH}:20261123T100000`, "SUMMARY:One firing"]).replace("BEGIN:VEVENT", [...zoneLines(ZH), "BEGIN:VEVENT"].join("\r\n")),
      unproven: zh("20261123T090000", "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO", "Every third week"),
      outofstep: zh("20261123T090000", "FREQ=WEEKLY;BYDAY=TU", "Tuesdays from a Monday"),
      untilkind: zh("20261123T090000", "FREQ=WEEKLY;BYDAY=MO;UNTIL=20270131", "Ended on a day"),
      skip: zh("20261123T023000", "FREQ=DAILY", "At half past two"),
      utc: raw("utc@studio.example.test", ["DTSTART:20261123T080000Z", "DTEND:20261123T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:In UTC"]),
      floating: raw("floating@studio.example.test", ["DTSTART:20261123T090000", "DTEND:20261123T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:On no zone"]),
      rdate: zh("20261123T090000", "FREQ=WEEKLY;BYDAY=MO", "With listed days", { more: [`RDATE;TZID=${ZH}:20261125T090000`] }),
      chair: zh("20261123T090000", "FREQ=WEEKLY;BYDAY=MO", "Glaze critique", {
        more: [`ORGANIZER;CN=Mila:mailto:${MILA}`, `ATTENDEE;CN=Mila;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      }),
      theirs: zh("20261123T090000", "FREQ=WEEKLY;BYDAY=MO", "Glaze group", {
        more: [`ORGANIZER;CN=Anna:mailto:${ANNA}`, `ATTENDEE;CN=Mila;PARTSTAT=ACCEPTED:mailto:${MILA}`, `ATTENDEE;CN=Giulia;PARTSTAT=ACCEPTED:mailto:${GIULIA}`],
      }),
    };
    type Row = { id: string; updatedAt: Date };
    type B = Awaited<ReturnType<typeof bench>>;
    const fields = (more: Record<string, unknown> = {}) => ({
      title: "From that day on", start: zoned("20261214T090000", ZH), end: zoned("20261214T100000", ZH), notes: null, place: null, callLink: null,
      busy: true, private: false, repeat: "FREQ=WEEKLY;BYDAY=MO", invitees: [], alarms: [], ...more,
    });
    const retitle = (s: Row, scope: unknown = { kind: "record" }, change: Record<string, unknown> = { title: "Renamed" }) => ({ kind: "calendar_event_update", ...on(s), scope, change });
    const splitAct = (s: Row, day: string, change: Record<string, unknown> = { title: "From that day on" }, newEventId = randomUUID()) =>
      ({ kind: "calendar_event_update", ...on(s), scope: { kind: "following", at: day, newEventId }, change });
    /** A press on a day and the days after it recorded past the door: its two rows, the second naming where it comes from. */
    const plantSplit = async (b: B, s: Row, day: string, change: Record<string, unknown>, made: Record<string, unknown>, key = "k") => {
      const newEventId = randomUUID();
      const first = await b.plant(key, splitAct(s, day, change, newEventId), { part: { of: key, n: 1 } });
      const named = ["title", "notes", "place", "callLink", "busy", "private", "alarms"].filter((f) => change[f] !== undefined) as ("title")[];
      await b.plant(`${key}:2`, { kind: "calendar_event_create", eventId: newEventId, calendarId: await b.calendarId(), event: made }, {
        after: first.id, part: { of: key, n: 2, from: { eventId: s.id, at: day, named } },
      });
    };
    const newSeries = async (b: B, repeat: string, start = zoned("20261123T090000", ZH), end = zoned("20261123T100000", ZH)) =>
      ({ kind: "calendar_event_create", eventId: randomUUID(), calendarId: await b.calendarId(), event: fields({ title: "A new series", start, end, repeat }) });
    interface Case {
      readonly name: string;
      readonly member: string;
      readonly row?: 0 | 1;
      readonly key?: string;
      /** The act as the door is handed it; absent for a row no door makes (a press's first half alone). */
      readonly act?: (s: Row, b: B) => unknown;
      /** How it is recorded past the door, where that is more than the one act. */
      readonly plant?: (s: Row, b: B) => Promise<void>;
    }
    const CASES: Case[] = [
      { name: "a series in no proven shape: retitled", member: "unproven", act: (s) => retitle(s) },
      { name: "a series in no proven shape: removed", member: "unproven", act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } }) },
      { name: "a series in no proven shape: one day cancelled", member: "unproven", act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "occurrence", at: DEC_14 } }) },
      { name: "a start the rule does not name: retitled", member: "outofstep", act: (s) => retitle(s) },
      { name: "UNTIL told as a day for a clock time: retitled", member: "untilkind", act: (s) => retitle(s) },
      { name: "a clock time the zone skips on a day of it: retitled", member: "skip", act: (s) => retitle(s) },
      { name: "a series in UTC: retitled", member: "utc", act: (s) => retitle(s) },
      { name: "a series on no zone: retitled", member: "floating", act: (s) => retitle(s) },
      { name: "a new series in no proven shape", member: "plain", act: (_s, b) => newSeries(b, "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO") },
      { name: "a new series at a skipped clock time", member: "plain", act: (_s, b) => newSeries(b, "FREQ=DAILY", zoned("20261123T023000", ZH), zoned("20261123T033000", ZH)) },
      { name: "a new series from a start its rule does not name", member: "plain", act: (_s, b) => newSeries(b, "FREQ=WEEKLY;BYDAY=TU") },
      { name: "an unproven repeat put on one event", member: "single", act: (s) => retitle(s, { kind: "record" }, { repeat: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO" }) },
      { name: "a proven series moved to a start its rule does not name", member: "plain", act: (s) => retitle(s, { kind: "record" }, { start: zoned("20261124T090000", ZH), end: zoned("20261124T100000", ZH) }) },
      { name: "a changed day addressed as a record: retitled", member: "weekly", row: 1, act: (s) => retitle(s) },
      { name: "a changed day addressed as a record: removed", member: "weekly", row: 1, act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } }) },
      { name: "a new start for a series with a changed day", member: "weekly", act: (s) => retitle(s, { kind: "record" }, { start: zoned("20261123T110000", ZH), end: zoned("20261123T120000", ZH) }) },
      { name: "a new repeat for a series with a changed day", member: "weekly", act: (s) => retitle(s, { kind: "record" }, { repeat: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" }) },
      { name: "invitees for a series with a changed day", member: "weekly", act: (s) => retitle(s, { kind: "record" }, { invitees: [{ address: GIULIA, name: "Giulia", role: "required" }] }) },
      { name: "a new start for a series with an excluded day", member: "excl", act: (s) => retitle(s, { kind: "record" }, { start: zoned("20261123T110000", ZH), end: zoned("20261123T120000", ZH) }) },
      { name: "no repeat any more for a series with a changed day", member: "weekly", act: (s) => retitle(s, { kind: "record" }, { repeat: null }) },
      { name: "a series with listed days: retitled", member: "rdate", act: (s) => retitle(s) },
      { name: "no such day: changed", member: "plain", act: (s) => retitle(s, { kind: "occurrence", at: DEC_8 }) },
      { name: "no such day: cancelled", member: "plain", act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "occurrence", at: DEC_8 } }) },
      { name: "a repeat in a day's change", member: "plain", act: (s) => retitle(s, { kind: "occurrence", at: DEC_7 }, { repeat: "FREQ=DAILY" }) },
      { name: "invitees in a day's change", member: "plain", act: (s) => retitle(s, { kind: "occurrence", at: DEC_7 }, { invitees: [{ address: GIULIA, name: null, role: "required" }] }) },
      { name: "a day of one event", member: "single", act: (s) => retitle(s, { kind: "occurrence", at: NOV_23 }) },
      { name: "a day named by no key", member: "plain", act: (s) => retitle(s, { kind: "occurrence", at: "the seventh" }) },
      { name: "a day and the days after it: from the first day", member: "plain", act: (s) => splitAct(s, NOV_23), plant: (s, b) => plantSplit(b, s, NOV_23, { title: "From that day on" }, fields({ start: zoned("20261123T090000", ZH), end: zoned("20261123T100000", ZH), repeat: "FREQ=WEEKLY;COUNT=10;BYDAY=MO" })) },
      { name: "a day and the days after it: from a moment before the first day", member: "plain", act: (s) => splitAct(s, at(2026, 11, 16)), plant: (s, b) => plantSplit(b, s, at(2026, 11, 16), { title: "From that day on" }, fields()) },
      { name: "a day and the days after it: under a key of 63 characters", member: "plain", key: "k".repeat(63), act: (s) => splitAct(s, DEC_14), plant: async (s, b) => { await b.plant("k".repeat(63), splitAct(s, DEC_14), { part: { of: "k".repeat(63), n: 1 } }); } },
      { name: "a day and the days after it: of a series whose organizer's own line chairs it", member: "chair", act: (s) => ({ ...splitAct(s, DEC_14), audience: { organizer: MILA, guests: [GIULIA] } }) },
      { name: "a day and the days after it: with no repeat for the days after", member: "plain", act: (s) => splitAct(s, DEC_14, { repeat: null }), plant: (s, b) => plantSplit(b, s, DEC_14, { repeat: null }, fields()) },
      { name: "a day and the days after it: with invitees named in the change", member: "plain", act: (s) => splitAct(s, DEC_14, { invitees: [{ address: GIULIA, name: null, role: "required" }] }), plant: (s, b) => plantSplit(b, s, DEC_14, { invitees: [{ address: GIULIA, name: null, role: "required" }] }, fields()) },
      { name: "a day and the days after it: at a day that is none of the series'", member: "plain", act: (s) => splitAct(s, DEC_8), plant: (s, b) => plantSplit(b, s, DEC_8, { title: "From that day on" }, fields({ start: zoned("20261208T090000", ZH), end: zoned("20261208T100000", ZH), repeat: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" })) },
      { name: "a day and the days after it: the day named by its clock time, not its moment", member: "plain", act: (s) => splitAct(s, `${ZH}|20261214T0900|false`), plant: (s, b) => plantSplit(b, s, `${ZH}|20261214T0900|false`, { title: "From that day on" }, fields({ repeat: "FREQ=WEEKLY;COUNT=7;BYDAY=MO" })) },
      { name: "a day and the days after it: a first part with no second", member: "plain", plant: async (s, b) => { await b.plant("k", splitAct(s, DEC_14), { part: { of: "k", n: 1 } }); } },
      { name: "a day and the days after it: of a series in no proven shape", member: "unproven", act: (s) => splitAct(s, DEC_14), plant: (s, b) => plantSplit(b, s, DEC_14, { title: "From that day on" }, fields({ repeat: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO" })) },
      { name: "a day and the days after it: with an unproven repeat for the days after", member: "plain", act: (s) => splitAct(s, DEC_14, { repeat: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO" }), plant: (s, b) => plantSplit(b, s, DEC_14, { repeat: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO" }, fields({ repeat: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO" })) },
      { name: "a move between calendars at CalDAV", member: "single", act: async (s, b) => ({ kind: "calendar_event_move", ...on(s), toCalendarId: await b.calendarId() }) },
      { name: "a series' move at CalDAV", member: "plain", act: async (s, b) => ({ kind: "calendar_event_move", ...on(s), toCalendarId: await b.calendarId() }) },
      { name: "someone else's series: retitled", member: "theirs", act: (s) => retitle(s) },
      { name: "someone else's series: one day cancelled", member: "theirs", act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "occurrence", at: DEC_7 } }) },
      { name: "someone else's series: a day and the days after it", member: "theirs", act: (s) => splitAct(s, DEC_14), plant: (s, b) => plantSplit(b, s, DEC_14, { title: "From that day on" }, fields({ invitees: [{ address: ANNA, name: "Anna", role: "required" }, { address: GIULIA, name: "Giulia", role: "required" }] })) },
      { name: "someone else's series: removed", member: "theirs", act: (s) => ({ kind: "calendar_event_delete", ...on(s), scope: { kind: "record" } }) },
    ];
    /** Taken by both: a day the series does not have, cancelled, is done as it stands; a series whose organizer chairs it is split. */
    const TAKEN = new Set(["no such day: cancelled", "a day and the days after it: of a series whose organizer's own line chairs it"]);

    it("refuses at the door exactly what the drain refuses past it, each with a closed word, and writes nothing of it", async () => {
      expect(CASES.length).toBe(44);
      const closed: ReadonlySet<string> = new Set(CALENDAR_WRITE_FAULTS);
      const lines: string[] = [];
      for (const c of CASES) {
        const fresh = async () => {
          const b = await bench({ [`${c.member}.ics`]: MEMBERS[c.member]! }, { autoSchedule: true, mailboxes: [MILA] });
          return { b, s: (await b.rows(`${c.member}.ics`))[c.row ?? 0]! };
        };
        // At the door.
        let door = "never made by the door";
        let drain: string[];
        let written: number;
        if (c.act !== undefined) {
          const { b, s } = await fresh();
          door = await b.door(c.key ?? "k", await c.act(s, b));
          if (door === "pending") {
            const from = b.dav.seen.length;
            expect(await b.turn()).toBe("synced");
            drain = await b.writes();
            written = b.sent(from, `${c.member}.ics`).length;
            lines.push(`${c.name} | door: taken | drain: ${drain.join("; ")} | written: ${written}`);
            continue;
          }
        }
        // Past the door.
        const { b, s } = await fresh();
        if (c.plant !== undefined) await c.plant(s, b);
        else await b.plant(c.key ?? "k", await c.act!(s, b));
        const from = b.dav.seen.length;
        expect(await b.turn()).toBe("synced");
        drain = await b.writes();
        written = b.sent(from, `${c.member}.ics`).length;
        const words = drain.map((x) => / refused (\S+)$/.exec(x)?.[1]);
        lines.push(`${c.name} | door: ${door} | drain: ${drain.join("; ")} | written: ${written} | closed words: ${words.every((x) => x !== undefined && closed.has(x))}`);
      }
      console.info(`door and drain, case by case:\n${lines.join("\n")}`);
      // What the door takes, the drain carries out; what the door refuses, the drain refuses, writing nothing, with a word of the closed list.
      expect(lines.filter((l) => l.includes("| door: taken |") !== TAKEN.has(l.split(" | ")[0]!))).toEqual([]);
      expect(lines.filter((l) => l.includes("| door: taken |") && / refused /.test(l))).toEqual([]);
      expect(lines.filter((l) => !l.includes("| door: taken |") && !(l.includes("| written: 0 |") && l.endsWith("closed words: true")))).toEqual([]);
      expect(lines.filter((l) => !l.includes("| door: taken |") && !/\| door: (4\d\d \w+|never made by the door) \|/.test(l))).toEqual([]);
    }, 240_000);
  });
});
