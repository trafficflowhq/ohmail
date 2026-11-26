import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type ApiDeps } from "@trafficflow/api";
import {
  calendarNoticeRoutes, makeCalendarNoticeDoor, DOOR_LINE_EVERY_MS, MICROSOFT_NOTICE_ENTRIES_MAX, NOTICE_IN_FLIGHT_MAX,
  VALIDATION_TOKEN_MAX_CHARS,
} from "@trafficflow/api/calendar-notices";
import { createLogger } from "@trafficflow/core";
import { POOLED_MAX_CONNECTIONS, WORKER_POOL_MAX } from "@trafficflow/db/cloud";
import type { Db } from "@trafficflow/services";

/**
 * THE DOOR A CALENDAR'S PROVIDER RINGS, through the composed pipeline, on a store the file that
 * runs this suite opens: a real Postgres with the lock forced and the API's own login (the proof),
 * and an in-process store with no roles (the same cases, where no server is at hand).
 *
 * What is held: every call is answered with the same bytes; only a live channel's own calendar and
 * connection move, by one row each, and only their `next_poll_at`; nothing a call names is
 * followed; a connection or a calendar that waits for a word is not pulled; a storm of notices moves
 * the rows once, never sooner than thirty seconds after the reading they last recorded; a call past
 * the door's cap of calls in flight runs no statement, a call still sending its body holds no place,
 * and the calls at the store at once leave the API's smallest pool room; the validation echo is
 * Microsoft's alone and only where it is switched on; and the door's log line holds counts and a
 * provider's word, and nothing of any call.
 *
 * Every id, word and address here is made at run time. Nothing is a real provider's.
 */
export interface DoorWorld {
  /** The handle the API's requests run on. */
  readonly api: Db;
  /** Reads and plants past the lock: the migrator's connection, or the same store where there are no roles. */
  sql(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const ORIGIN = "https://api.notices.example.test";
const word = (): string => randomBytes(32).toString("base64url");
const digest = (w: string): string => createHash("sha256").update(w, "utf8").digest("hex");
const HOUR = "now() + interval '1 hour'";

interface Channel { readonly id: string; readonly word: string; readonly resourceId: string | null }
interface Seeded {
  readonly accountId: string;
  readonly connectionId: string;
  readonly calendars: readonly string[];
  /** The channel on the first calendar. */
  readonly channel: Channel;
}
interface SeedOptions {
  readonly provider?: "google" | "microsoft";
  readonly calendars?: number;
  readonly status?: string;
  readonly connectionWord?: string | null;
  readonly calendarWord?: string | null;
  /** SQL for both rows' `last_synced_at`; `null` for never. */
  readonly synced?: string | null;
  /** SQL for both rows' `next_poll_at`. */
  readonly next?: string;
  /** SQL for the channel's end. */
  readonly ends?: string;
  readonly resourceId?: string | null;
  /** The channel names no calendar: it stands for the whole connection. */
  readonly wholeConnection?: boolean;
}

/** Every value a call or a row of this run carried that must never be read in a log line. */
const NEVER_LOGGED: string[] = [];
const kept = <T extends string | null>(v: T): T => { if (v !== null) NEVER_LOGGED.push(v); return v; };

async function channelOn(
  w: DoorWorld, at: { accountId: string; connectionId: string; calendarId: string | null }, o: SeedOptions = {},
): Promise<Channel> {
  const made: Channel = {
    id: kept(randomUUID()), word: kept(word()),
    resourceId: o.resourceId === undefined ? (o.provider === "microsoft" ? null : kept(`res-${randomUUID()}`)) : o.resourceId,
  };
  NEVER_LOGGED.push(digest(made.word));
  await w.sql(
    `insert into cal_push_channels (account_id, connection_id, calendar_id, provider, channel_id, token_hash, resource_id, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, ${o.ends ?? "now() + interval '1 day'"})`,
    [at.accountId, at.connectionId, at.calendarId, o.provider ?? "google", made.id, digest(made.word), made.resourceId],
  );
  return made;
}

/** An account with one connection, its calendars, and a channel on the first of them. */
async function seed(w: DoorWorld, o: SeedOptions = {}): Promise<Seeded> {
  const accountId = kept(randomUUID());
  const connectionId = kept(randomUUID());
  const synced = o.synced === undefined ? "now() - interval '10 minutes'" : o.synced ?? "null";
  const next = o.next ?? HOUR;
  await w.sql(`insert into accounts (id, name) values ($1, $2)`, [accountId, `notices-${accountId.slice(0, 8)}`]);
  await w.sql(
    `insert into cal_connections (id, account_id, provider, status, error_code, last_synced_at, next_poll_at)
     values ($1, $2, $3, $4, $5, ${synced}, ${next})`,
    [connectionId, accountId, o.provider ?? "google", o.status ?? "active", o.connectionWord ?? null],
  );
  const calendars: string[] = [];
  for (let i = 0; i < (o.calendars ?? 2); i++) {
    const id = kept(randomUUID());
    calendars.push(id);
    await w.sql(
      `insert into cal_calendars (id, account_id, connection_id, provider_id, error_code, last_synced_at, next_poll_at)
       values ($1, $2, $3, $4, $5, ${synced}, ${next})`,
      [id, accountId, connectionId, kept(`cal-${id}@group.calendar.example.test`), i === 0 ? o.calendarWord ?? null : null],
    );
  }
  const channel = await channelOn(w, { accountId, connectionId, calendarId: o.wholeConnection ? null : calendars[0]! }, o);
  return { accountId, connectionId, calendars, channel };
}

/** Every calendar row of these accounts as text, by its kind and id: what a call may and may not have moved. */
async function stateOf(w: DoorWorld, accounts: readonly Seeded[]): Promise<Record<string, Record<string, unknown>>> {
  const ids = accounts.map((a) => a.accountId).join(",");
  const rows = await w.sql(
    `select 'connection:' || id::text as key, next_poll_at::text as next, updated_at::text as updated, last_synced_at::text as synced,
            status, error_code as word, list_token as token
       from cal_connections where account_id::text = any(string_to_array($1, ','))
     union all
     select 'calendar:' || id::text, next_poll_at::text, updated_at::text, last_synced_at::text, name, error_code, sync_token
       from cal_calendars where account_id::text = any(string_to_array($1, ','))
     union all
     select 'channel:' || channel_id, expires_at::text, created_at::text, resource_id, provider, token_hash, calendar_id::text
       from cal_push_channels where account_id::text = any(string_to_array($1, ','))
     union all
     select 'changes:' || account_id::text, count(*)::text, null, null, null, null, null
       from change_log where account_id::text = any(string_to_array($1, ',')) group by account_id
     union all
     select 'events:' || account_id::text, count(*)::text, null, null, null, null, null
       from cal_events where account_id::text = any(string_to_array($1, ',')) group by account_id`,
    [ids],
  );
  return Object.fromEntries(rows.map(({ key, ...rest }) => [String(key), rest]));
}

/** The keys whose row differs between two readings, each with the columns that differ. */
function moved(before: Record<string, Record<string, unknown>>, after: Record<string, Record<string, unknown>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key] ?? {};
    const b = after[key] ?? {};
    const cols = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((c) => a[c] !== b[c]);
    if (cols.length > 0) out[key] = cols.sort();
  }
  return out;
}

/** Is this row's `next_poll_at` the database's own now, to the minute? */
async function dueNow(w: DoorWorld, table: "cal_calendars" | "cal_connections", id: string): Promise<boolean> {
  const [row] = await w.sql(
    `select (next_poll_at <= now() and next_poll_at > now() - interval '1 minute') as due from ${table} where id = $1`, [id],
  );
  return row?.due === true;
}

const google = (
  pair: { id?: string; word?: string; resource?: string | null },
  more: { query?: string; headers?: Record<string, string>; body?: string } = {},
): Request =>
  new Request(`${ORIGIN}/calendar/notices/google${more.query ?? ""}`, {
    method: "POST",
    headers: {
      ...(pair.id === undefined ? {} : { "x-goog-channel-id": pair.id }),
      ...(pair.word === undefined ? {} : { "x-goog-channel-token": pair.word }),
      ...(pair.resource === undefined || pair.resource === null ? {} : { "x-goog-resource-id": pair.resource }),
      ...more.headers,
    },
    ...(more.body === undefined ? {} : { body: more.body }),
  });
const ofChannel = (c: Channel): { id: string; word: string; resource: string | null } => ({ id: c.id, word: c.word, resource: c.resourceId });

const microsoft = (body: string | undefined, query = ""): Request =>
  new Request(`${ORIGIN}/calendar/notices/microsoft${query}`, {
    method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body }),
  });
const batch = (entries: readonly unknown[]): string => JSON.stringify({ value: entries });

/** An answer whole: its status, every header, and its body's bytes. The request's id is a fresh one each time, and is read as that. */
async function bytesOf(res: Response): Promise<string> {
  const headers = [...res.headers].map(([k, v]) => [k, k === "x-request-id" && /^[0-9a-f-]{36}$/.test(v) ? "<a fresh id>" : v]).sort();
  return JSON.stringify([res.status, res.statusText, headers, Buffer.from(await res.arrayBuffer()).toString("hex")]);
}
/** The one answer every call gets: accepted, nothing stored, no body. */
const ALIKE = JSON.stringify([202, "", [["cache-control", "no-store"], ["x-request-id", "<a fresh id>"]], ""]);

export function noticeDoorSuite(name: string, open: () => Promise<DoorWorld>): void {
  describe(`the door a calendar's provider rings, ${name}`, { timeout: 120_000 }, () => {
    let w: DoorWorld;
    beforeAll(async () => { w = await open(); }, 300_000);
    afterAll(async () => { await w?.close(); });

    const app = createApp(calendarNoticeRoutes);
    /** A door of its own for a case, with its clock and the lines it said. */
    function rig(o: { microsoftValidation?: boolean; db?: unknown } = {}) {
      const lines: string[] = [];
      const clock = { at: 1_000_000 };
      const door = makeCalendarNoticeDoor({
        microsoftValidation: o.microsoftValidation ?? false,
        log: createLogger({ service: "api", level: "debug", sink: (line: string) => { lines.push(line); } }),
        now: () => clock.at,
      });
      const deps = (db: unknown): ApiDeps => ({
        db, now: () => new Date(), requestId: "", session: null, services: { calendarNotices: door },
      }) as unknown as ApiDeps;
      /** A call through the door, on the case's store or on a store of the call's own. */
      const call = (req: Request, db: unknown = o.db ?? w.api): Promise<Response> => app.handle(req, deps(db));
      /** The door's counts so far: its minute passed, and one more call (which is counted too) says them. */
      const said = async (): Promise<Record<string, Record<string, unknown>>> => {
        clock.at += DOOR_LINE_EVERY_MS;
        await call(google({}));
        const out: Record<string, Record<string, unknown>> = {};
        for (const line of lines.splice(0)) {
          const { event, kind, count, applied, expired, refused, dropped } = JSON.parse(line) as Record<string, unknown>;
          if (event === "cal_notice_door") out[String(kind)] = { count, applied, expired, refused, dropped };
        }
        return out;
      };
      return { call, said, lines, clock };
    }

    it("a live channel's notice pulls its own calendar and its connection, one row each, and moves nothing else", async () => {
      const a = await seed(w);
      const b = await seed(w);
      const r = rig();
      const before = await stateOf(w, [a, b]);
      expect(await bytesOf(await r.call(google(ofChannel(a.channel))))).toBe(ALIKE);
      // Only `next_poll_at`, of two rows: no `updated_at`, no change record, no event, no other calendar, no other account.
      expect(moved(before, await stateOf(w, [a, b]))).toEqual({
        [`connection:${a.connectionId}`]: ["next"], [`calendar:${a.calendars[0]}`]: ["next"],
      });
      expect([await dueNow(w, "cal_calendars", a.calendars[0]!), await dueNow(w, "cal_connections", a.connectionId)]).toEqual([true, true]);
      expect(await r.said()).toEqual({ google: { count: 2, applied: 1, expired: 0, refused: 1, dropped: 0 } });
    });

    it("an Outlook mailbox notice pulls its own calendars while shared calendars keep their schedule", async () => {
      const a = await seed(w, { provider: "microsoft", wholeConnection: true, resourceId: "me/events", calendars: 4 });
      const b = await seed(w);
      for (const id of a.calendars.slice(0, 3)) await w.sql("update cal_calendars set access = 'owner' where id = $1", [id]);
      await w.sql("update cal_calendars set access = 'writer' where id = $1", [a.calendars[3]!]);
      const r = rig();
      const before = await stateOf(w, [a, b]);
      expect(await bytesOf(await r.call(microsoft(batch([{ subscriptionId: a.channel.id, clientState: a.channel.word }]))))).toBe(ALIKE);
      expect(moved(before, await stateOf(w, [a, b]))).toEqual({
        [`connection:${a.connectionId}`]: ["next"],
        ...Object.fromEntries(a.calendars.slice(0, 3).map((id) => [`calendar:${id}`, ["next"]])),
      });
    });

    it("answers every call with the same bytes, and only the live one moves a row", async () => {
      const a = await seed(w);
      // A second live channel that no call here names rightly: whatever is wrong with a call, its rows have not moved before it.
      const q = await seed(w);
      const ended = await seed(w, { ends: "now() - interval '1 second'" });
      const m = await seed(w, { provider: "microsoft" });
      const r = rig();
      const all = [a, q, ended, m];
      const other = word();
      const nearly = `${q.channel.word.slice(0, 42)}${q.channel.word.endsWith("A") ? "B" : "A"}`;
      const calls: ReadonlyArray<readonly [string, () => Request, "moves" | "still"]> = [
        ["a known channel", () => google(ofChannel(a.channel)), "moves"],
        ["the same notice again", () => google(ofChannel(a.channel)), "still"],
        ["an unknown channel", () => google({ id: randomUUID(), word: word(), resource: "res" }), "still"],
        ["a known channel with another word", () => google({ ...ofChannel(q.channel), word: other }), "still"],
        ["a known channel with a word one character off", () => google({ ...ofChannel(q.channel), word: nearly }), "still"],
        ["a known channel with another channel's word", () => google({ ...ofChannel(q.channel), word: a.channel.word }), "still"],
        ["a known channel with another name for what it watches", () => google({ ...ofChannel(q.channel), resource: "res-of-another" }), "still"],
        ["a known channel without that name", () => google({ ...ofChannel(q.channel), resource: null }), "still"],
        ["an ended channel with its own word", () => google(ofChannel(ended.channel)), "still"],
        ["Google's channel asked at Microsoft's route", () => microsoft(batch([{ subscriptionId: q.channel.id, clientState: q.channel.word }])), "still"],
        ["Microsoft's channel asked at Google's route", () => google(ofChannel(m.channel)), "still"],
        ["no header at all", () => google({}), "still"],
        ["an id that is no id", () => google({ id: "not-an-id", word: q.channel.word }), "still"],
        ["a known id in capitals", () => google({ ...ofChannel(q.channel), id: q.channel.id.toUpperCase() }), "still"],
        ["a known id with a word that is no word", () => google({ ...ofChannel(q.channel), word: `${q.channel.word}=` }), "still"],
        ["a word of ten thousand characters", () => google({ ...ofChannel(q.channel), word: "A".repeat(10_000) }), "still"],
        ["a paging number that is none", () => google({ id: randomUUID(), word: word() }, { query: "?limit=minus-one&page=x" }), "still"],
        ["a body where Google sends none", () => google({ id: randomUUID(), word: word() }, { body: JSON.stringify({ value: [1, 2, 3] }) }), "still"],
        ["Microsoft: no body", () => microsoft(undefined), "still"],
        ["Microsoft: a body that is no JSON", () => microsoft("{ value: ["), "still"],
        ["Microsoft: a list where an object belongs", () => microsoft(JSON.stringify([{ subscriptionId: m.channel.id, clientState: m.channel.word }])), "still"],
        ["Microsoft: a value that is no list", () => microsoft(JSON.stringify({ value: { subscriptionId: m.channel.id, clientState: m.channel.word } })), "still"],
        ["Microsoft: a thousand entries that name nothing", () => microsoft(batch(Array.from({ length: 1_000 }, () => ({})))), "still"],
        ["Microsoft: an entry of the wrong types", () => microsoft(batch([{ subscriptionId: 7, clientState: ["x"] }, null, "text", [m.channel.id]])), "still"],
        ["Microsoft: a known subscription with another word", () => microsoft(batch([{ subscriptionId: m.channel.id, clientState: other }])), "still"],
        ["Microsoft: a body past what is read", () => microsoft(batch([{ subscriptionId: m.channel.id, clientState: m.channel.word, pad: "x".repeat(70_000) }])), "still"],
        ["Microsoft: a validation token where the echo is off", () => microsoft(undefined, "?validationToken=hello"), "still"],
      ];
      for (const [what, make, expected] of calls) {
        const before = await stateOf(w, all);
        expect(await bytesOf(await r.call(make())), what).toBe(ALIKE);
        const changed = Object.keys(moved(before, await stateOf(w, all))).length;
        expect(changed, what).toBe(expected === "moves" ? 2 : 0);
      }
      // And the live Microsoft one, so that the route which refused all of the above is shown to act at all.
      const before = await stateOf(w, all);
      expect(await bytesOf(await r.call(microsoft(batch([{ subscriptionId: m.channel.id, clientState: m.channel.word }]))))).toBe(ALIKE);
      expect(moved(before, await stateOf(w, all))).toEqual({
        [`connection:${m.connectionId}`]: ["next"], [`calendar:${m.calendars[0]}`]: ["next"],
      });
      // What the door counted: the two live notices of the first channel, the one ended channel, Microsoft's one live notice.
      const counts = await r.said();
      expect([counts.google!.applied, counts.google!.expired, counts.google!.dropped]).toEqual([2, 1, 0]);
      expect([counts.microsoft!.applied, counts.microsoft!.expired, counts.microsoft!.dropped]).toEqual([1, 0, 0]);
    });

    it("answers the same when the store cannot be read, and when its handling throws", async () => {
      const a = await seed(w);
      const before = await stateOf(w, [a]);
      const marker = kept(`store-fault-${randomUUID()}`);
      const broken = rig({ db: { select: () => { throw new Error(marker); } } });
      expect(await bytesOf(await broken.call(google(ofChannel(a.channel))))).toBe(ALIKE);
      expect(await bytesOf(await broken.call(microsoft(batch([{ subscriptionId: a.channel.id, clientState: a.channel.word }]))))).toBe(ALIKE);
      expect(moved(before, await stateOf(w, [a]))).toEqual({});
      const counts = await broken.said();
      expect(counts.google).toMatchObject({ applied: 0, dropped: 1 });
      expect(counts.microsoft).toMatchObject({ applied: 0, dropped: 1 });
    });

    it("follows nothing a call names: not an account, a connection, a calendar or an address", async () => {
      const a = await seed(w);
      const b = await seed(w);
      const m = await seed(w, { provider: "microsoft" });
      const r = rig();
      const before = await stateOf(w, [a, b, m]);
      const named = `account=${b.accountId}&connection=${b.connectionId}&calendar=${a.calendars[1]}&calendarId=${b.calendars[0]}`;
      await r.call(google(ofChannel(a.channel), {
        query: `?${named}`,
        headers: {
          "x-goog-resource-uri": `https://www.googleapis.com/calendar/v3/calendars/${b.calendars[0]}/events?alt=json`,
          "x-goog-channel-expiration": "Thu, 01 Jan 2099 00:00:00 GMT", "x-goog-resource-state": "exists",
          "x-ohmail-account": b.accountId, cookie: `tf_session=${word()}`, authorization: `Bearer ${word()}`,
        },
        body: JSON.stringify({ accountId: b.accountId, connectionId: b.connectionId, calendarId: a.calendars[1] }),
      }));
      await r.call(microsoft(batch([{
        subscriptionId: m.channel.id, clientState: m.channel.word, tenantId: b.accountId,
        resource: `me/calendars/${m.calendars[1]}/events`, resourceData: { id: b.calendars[0], calendarId: m.calendars[1] },
        accountId: b.accountId, connectionId: b.connectionId, calendarId: m.calendars[1],
      }]), `?${named}`));
      expect(moved(before, await stateOf(w, [a, b, m]))).toEqual({
        [`connection:${a.connectionId}`]: ["next"], [`calendar:${a.calendars[0]}`]: ["next"],
        [`connection:${m.connectionId}`]: ["next"], [`calendar:${m.calendars[0]}`]: ["next"],
      });
    });

    it("does not pull a connection or a calendar that waits for a word or the person", async () => {
      const r = rig();
      const reconnect = await seed(w, { status: "reconnect", connectionWord: "consent_needed" });
      const failing = await seed(w, { status: "failing", connectionWord: "unavailable" });
      const throttled = await seed(w, { connectionWord: "throttled" });
      const calendarWaits = await seed(w, { calendarWord: "token_gone" });
      const all = [reconnect, failing, throttled, calendarWaits];
      const before = await stateOf(w, all);
      for (const s of all) expect(await bytesOf(await r.call(google(ofChannel(s.channel))))).toBe(ALIKE);
      const after = moved(before, await stateOf(w, all));
      // No waiting connection moved, and not the calendar that waits; each was judged live all the same.
      expect(Object.keys(after).filter((k) => k.startsWith("connection:")).sort()).toEqual([`connection:${calendarWaits.connectionId}`]);
      expect(after[`calendar:${calendarWaits.calendars[0]}`]).toBeUndefined();
      expect((await r.said()).google).toMatchObject({ applied: 4 });
    });

    it("a storm of notices moves the rows once, never sooner than thirty seconds after the reading they last recorded", async () => {
      const r = rig();
      const fresh = await seed(w, { synced: "now()", next: "now() + interval '5 minutes'" });
      const never = await seed(w, { synced: null, next: "now() + interval '5 minutes'" });
      await r.call(google(ofChannel(fresh.channel)));
      const afterOne = await stateOf(w, [fresh]);
      for (let i = 0; i < 500; i++) await r.call(google(ofChannel(fresh.channel)));
      // The first notice moved the rows; the five hundred after it moved nothing.
      expect(moved(afterOne, await stateOf(w, [fresh]))).toEqual({});
      const spaced = await w.sql(
        `select kind, spaced, pulled from (
           select 'calendar' as kind, next_poll_at >= last_synced_at + interval '30 seconds' as spaced,
                  next_poll_at < now() + interval '4 minutes' as pulled from cal_calendars where id = $1
           union all
           select 'connection', next_poll_at >= last_synced_at + interval '30 seconds',
                  next_poll_at < now() + interval '4 minutes' from cal_connections where id = $2
         ) rows order by kind`,
        [fresh.calendars[0], fresh.connectionId],
      );
      expect(spaced).toEqual([{ kind: "calendar", spaced: true, pulled: true }, { kind: "connection", spaced: true, pulled: true }]);
      // A calendar never read has no last reading to wait after: it is due now.
      await r.call(google(ofChannel(never.channel)));
      expect([await dueNow(w, "cal_calendars", never.calendars[0]!), await dueNow(w, "cal_connections", never.connectionId)]).toEqual([true, true]);
    });

    it("keeps one notice for the next read when an overdue calendar is already reading", async () => {
      const a = await seed(w, { synced: "now() - interval '10 minutes'", next: "now() - interval '1 second'" });
      const id = a.calendars[0]!;
      await w.sql("update cal_calendars set read_owner = $1 where id = $2", [randomUUID(), id]);
      const r = rig();
      const before = await stateOf(w, [a]);
      expect(await bytesOf(await r.call(google(ofChannel(a.channel))))).toBe(ALIKE);
      const after = await stateOf(w, [a]);
      expect(moved(before, after)).toEqual({ [`calendar:${id}`]: ["next"] });
      expect(await w.sql("select next_poll_at > now() and next_poll_at <= now() + interval '30 seconds' as waits from cal_calendars where id = $1", [id]))
        .toEqual([{ waits: true }]);
      await r.call(google(ofChannel(a.channel)));
      expect(moved(after, await stateOf(w, [a]))).toEqual({});
    });

    it("a channel that names no calendar pulls its connection's calendars, and no other connection's", async () => {
      const r = rig();
      const whole = await seed(w, { wholeConnection: true, calendars: 3 });
      const other = await seed(w);
      const before = await stateOf(w, [whole, other]);
      await r.call(google(ofChannel(whole.channel)));
      expect(Object.keys(moved(before, await stateOf(w, [whole, other]))).sort()).toEqual(
        [`connection:${whole.connectionId}`, ...whole.calendars.map((c) => `calendar:${c}`)].sort(),
      );
    });

    it("judges Microsoft's entries one channel each: a channel named twice once, and none past the twentieth", async () => {
      const r = rig();
      const m = await seed(w, { provider: "microsoft" });
      const second = await channelOn(w, { accountId: m.accountId, connectionId: m.connectionId, calendarId: m.calendars[1]! }, { provider: "microsoft" });
      const late = await seed(w, { provider: "microsoft" });
      const entry = (c: Channel) => ({ subscriptionId: c.id, clientState: c.word });
      const filler = Array.from({ length: MICROSOFT_NOTICE_ENTRIES_MAX - 3 }, () => ({ subscriptionId: randomUUID(), clientState: word() }));
      const before = await stateOf(w, [m, late]);
      expect(await bytesOf(await r.call(microsoft(batch([entry(m.channel), entry(m.channel), entry(second), ...filler, entry(late.channel)]))))).toBe(ALIKE);
      // The twenty-first entry is the late account's: it is not looked at.
      expect(Object.keys(moved(before, await stateOf(w, [m, late]))).sort()).toEqual(
        [`connection:${m.connectionId}`, `calendar:${m.calendars[0]}`, `calendar:${m.calendars[1]}`].sort(),
      );
      expect((await r.said()).microsoft).toEqual({ count: 1, applied: 2, expired: 0, refused: MICROSOFT_NOTICE_ENTRIES_MAX - 3, dropped: 0 });
    });

    it("the call past the cap of calls in flight runs no statement, and is answered like the others", async () => {
      // A store that runs nothing: every member it is asked for is written down, and the asking throws.
      const asked: string[] = [];
      const recorder = new Proxy({}, {
        get: (_, door) => {
          if (typeof door !== "string" || door === "then") return undefined;
          asked.push(door);
          throw new Error(`the store was asked for ${door}`);
        },
      });
      const r = rig({ db: recorder });
      const a = await seed(w);
      const before = await stateOf(w, [a]);
      // As many calls as the cap, held at a store of their own: each one's look-up waits there until it is let go.
      const letGo: Array<() => void> = [];
      const lookUp: object = new Proxy({}, {
        get: (_, step) => step !== "then" ? () => lookUp : (found: (rows: unknown[]) => void) => { letGo.push(() => found([])); },
      });
      const held = Array.from({ length: NOTICE_IN_FLIGHT_MAX }, () =>
        r.call(microsoft(batch([{ subscriptionId: randomUUID(), clientState: word() }])), { select: () => lookUp }));
      for (let turn = 0; turn < 50 && letGo.length < held.length; turn++) await new Promise((go) => setImmediate(go));
      expect(letGo).toHaveLength(NOTICE_IN_FLIGHT_MAX);
      // The call past them names a live channel with its own word: it is answered, and the store is asked nothing.
      expect(await bytesOf(await r.call(google(ofChannel(a.channel))))).toBe(ALIKE);
      expect(asked).toEqual([]);
      // The held calls are let go and find no row: still nothing is asked.
      for (const go of letGo.splice(0)) go();
      for (const res of await Promise.all(held)) expect(await bytesOf(res)).toBe(ALIKE);
      expect(asked).toEqual([]);
      const counts = await r.said();
      expect(counts.google).toEqual({ count: 2, applied: 0, expired: 0, refused: 1, dropped: 1 });
      expect(counts.microsoft).toEqual({ count: NOTICE_IN_FLIGHT_MAX, applied: 0, expired: 0, refused: NOTICE_IN_FLIGHT_MAX, dropped: 0 });
      // With room, on a door over the store, the same call is applied.
      const roomy = rig();
      expect(await bytesOf(await roomy.call(google(ofChannel(a.channel))))).toBe(ALIKE);
      expect(Object.keys(moved(before, await stateOf(w, [a]))).sort()).toEqual([`calendar:${a.calendars[0]}`, `connection:${a.connectionId}`]);
      expect((await roomy.said()).google).toEqual({ count: 2, applied: 1, expired: 0, refused: 1, dropped: 0 });
    });

    it("a call still sending its body holds no place: a live channel's notice past as many of them as the cap is applied", async () => {
      const r = rig();
      const a = await seed(w);
      const before = await stateOf(w, [a]);
      // As many Microsoft calls as the cap, each still sending its body: none has reached the store.
      const ends: Array<() => void> = [];
      const sending = Array.from({ length: NOTICE_IN_FLIGHT_MAX }, () => {
        const body = new ReadableStream<Uint8Array>({ start(c) { ends.push(() => c.close()); } });
        return r.call(new Request(`${ORIGIN}/calendar/notices/microsoft`, { method: "POST", body, duplex: "half" } as RequestInit));
      });
      // A live channel's notice past them is applied, and answered like every call.
      expect(await bytesOf(await r.call(google(ofChannel(a.channel))))).toBe(ALIKE);
      expect(Object.keys(moved(before, await stateOf(w, [a]))).sort()).toEqual([`calendar:${a.calendars[0]}`, `connection:${a.connectionId}`]);
      // The bodies end empty, naming no channel.
      for (const end of ends) end();
      for (const res of await Promise.all(sending)) expect(await bytesOf(res)).toBe(ALIKE);
      const counts = await r.said();
      expect(counts.google).toEqual({ count: 2, applied: 1, expired: 0, refused: 1, dropped: 0 });
      expect(counts.microsoft).toEqual({ count: NOTICE_IN_FLIGHT_MAX, applied: 0, expired: 0, refused: NOTICE_IN_FLIGHT_MAX, dropped: 0 });
    });

    it("never has more calls at the store at once than its cap, which leaves the API's smallest pool room", async () => {
      // The API's pools: a server's own (its session cell is `WORKER_POOL_MAX`) and a hosted instance's.
      const pool = Math.min(WORKER_POOL_MAX, POOLED_MAX_CONNECTIONS);
      // A store that holds every statement until it is let go, as a busy connection would, and counts what it holds.
      let holding = 0;
      let most = 0;
      const letGo: Array<() => void> = [];
      const statement: object = new Proxy({}, {
        get: (_, step) => step !== "then" ? () => statement : (_done: unknown, fail: (e: unknown) => void) => {
          holding += 1;
          most = Math.max(most, holding);
          letGo.push(() => { holding -= 1; fail(new Error("let go")); });
        },
      });
      const r = rig({ db: { select: () => statement } });
      // A stranger's flood: three times the pool, each call with a well-shaped id and word.
      let answered = 0;
      const calls = Array.from({ length: 3 * pool }, () =>
        r.call(google({ id: randomUUID(), word: word() })).then((res) => { answered += 1; return res; }));
      for (let turn = 0; turn < 50 && answered + holding < calls.length; turn++) await new Promise((go) => setImmediate(go));
      expect(answered + holding).toBe(calls.length);
      expect(most).toBe(NOTICE_IN_FLIGHT_MAX);
      expect(most).toBeLessThan(pool);
      for (const go of letGo.splice(0)) go();
      for (const res of await Promise.all(calls)) expect(await bytesOf(res)).toBe(ALIKE);
    });

    it("echoes Microsoft's validation token only where the door is switched on, and only a token it may echo", async () => {
      const on = rig({ microsoftValidation: true });
      const off = rig({ microsoftValidation: false });
      const token = "Validation: token 123 <b>&amp;</b>";
      const echoed = await on.call(microsoft(undefined, `?validationToken=${encodeURIComponent(token)}`));
      expect([echoed.status, await echoed.text()]).toEqual([200, token]);
      expect(Object.fromEntries([...echoed.headers].filter(([k]) => k !== "x-request-id"))).toEqual({
        "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store",
      });
      const refused: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
        ["the echo is off", () => off.call(microsoft(undefined, `?validationToken=${encodeURIComponent(token)}`))],
        ["a token past its length", () => on.call(microsoft(undefined, `?validationToken=${"a".repeat(VALIDATION_TOKEN_MAX_CHARS + 1)}`))],
        ["a token with a line break", () => on.call(microsoft(undefined, `?validationToken=${encodeURIComponent("a\r\nb")}`))],
        ["a token outside ASCII", () => on.call(microsoft(undefined, `?validationToken=${encodeURIComponent("grüße")}`))],
        ["an empty token", () => on.call(microsoft(undefined, "?validationToken="))],
        ["Google's route", () => on.call(google({}, { query: `?validationToken=${encodeURIComponent(token)}` }))],
      ];
      for (const [what, ask] of refused) expect(await bytesOf(await ask()), what).toBe(ALIKE);
      // A token of exactly the length is echoed.
      const longest = "t".repeat(VALIDATION_TOKEN_MAX_CHARS);
      expect(await (await on.call(microsoft(undefined, `?validationToken=${longest}`))).text()).toBe(longest);
    });

    it("says its counts once a minute and never a line for a call, and no line holds anything of a call", async () => {
      const r = rig();
      const a = await seed(w);
      const m = await seed(w, { provider: "microsoft" });
      const bodyMarker = kept(`body-marker-${randomUUID()}`);
      for (let i = 0; i < 40; i++) {
        await r.call(google(ofChannel(a.channel), { headers: { "x-goog-resource-uri": kept(`https://www.googleapis.com/calendar/v3/calendars/${randomUUID()}/events`) } }));
        await r.call(microsoft(batch([{ subscriptionId: m.channel.id, clientState: m.channel.word, resource: bodyMarker }])));
        await r.call(google({ id: kept(randomUUID()), word: kept(word()) }));
      }
      // A hundred and twenty calls inside one minute: not one line.
      expect(r.lines).toEqual([]);
      r.clock.at += DOOR_LINE_EVERY_MS;
      await r.call(google({}));
      const lines = r.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.map((l) => [l.event, l.kind, l.count]).sort()).toEqual([["cal_notice_door", "google", 81], ["cal_notice_door", "microsoft", 40]]);
      for (const line of lines) {
        expect(Object.keys(line).filter((k) => !["ts", "time", "level", "service", "event"].includes(k)).sort())
          .toEqual(["applied", "count", "dropped", "expired", "kind", "refused"]);
      }
      // The minute after it, with no call but the one that asks: that call alone, and nothing of the old counts.
      r.lines.length = 0;
      r.clock.at += DOOR_LINE_EVERY_MS;
      await r.call(google({}));
      expect(r.lines.map((l) => (JSON.parse(l) as Record<string, unknown>).count)).toEqual([1]);
    });

    it("counts what a call in flight came to when the minute's line was said meanwhile, in the line after it", async () => {
      const r = rig();
      const m = await seed(w, { provider: "microsoft" });
      // A call that waits for its body while the minute's line is said.
      let send!: (text: string) => void;
      const body = new ReadableStream<Uint8Array>({
        start(c) { send = (text) => { c.enqueue(new TextEncoder().encode(text)); c.close(); }; },
      });
      const held = r.call(new Request(`${ORIGIN}/calendar/notices/microsoft`, { method: "POST", body, duplex: "half" } as RequestInit));
      expect((await r.said()).microsoft).toEqual({ count: 1, applied: 0, expired: 0, refused: 0, dropped: 0 });
      send(batch([{ subscriptionId: m.channel.id, clientState: m.channel.word }]));
      expect(await bytesOf(await held)).toBe(ALIKE);
      expect(await dueNow(w, "cal_calendars", m.calendars[0]!)).toBe(true);
      // It was applied after that line: the next one says so, and nothing is lost with the minute the call began in.
      expect((await r.said()).microsoft).toEqual({ count: 0, applied: 1, expired: 0, refused: 0, dropped: 0 });
    });

    it("leaves nothing of any call of this run in a line: no id, word, digest, address or body", async () => {
      // Every case above ran through a door whose lines were kept or read; this one reads a fresh door's whole output raw.
      const r = rig();
      const a = await seed(w);
      await r.call(google(ofChannel(a.channel)));
      await r.call(google({ ...ofChannel(a.channel), word: kept(word()) }));
      r.clock.at += DOOR_LINE_EVERY_MS;
      await r.call(google({}));
      const said = r.lines.join("\n");
      expect(said).toContain("cal_notice_door");
      expect(NEVER_LOGGED.length).toBeGreaterThan(50);
      expect(NEVER_LOGGED.filter((v) => said.includes(v))).toEqual([]);
    });
  });
}
