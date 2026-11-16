/**
 * THE CALENDAR'S TABLES, READ FROM A STORE'S OWN CATALOG — shared by the PGlite arm (the store a
 * desktop's engine runs: the same mail journal) and the real-Postgres arm. Every case asks the
 * database, never the source: which keys it enforces, which columns may be empty, and which rows
 * it refuses.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as mailSchema from "../src/schema-mail.js";
import * as cloudSchema from "../src/schema-cloud.js";
import { CALENDAR_TABLES, type CalendarTableName } from "../src/calendar/classes.js";
import { WORKER_WIDE_READ, tableClass } from "../src/row-security/policies.js";
import { STAFF_SELECT_GRANTS } from "../src/staff-grants.js";

/** One statement with positional parameters, answered as rows. */
export type Exec = (text: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;

export interface ForeignKey { name: string; table: string; columns: string[]; parent: string; parentColumns: string[] }

/** Every foreign key a `cal_*` table holds, as the catalog states it. */
export async function calendarKeys(exec: Exec): Promise<ForeignKey[]> {
  const rows = await exec(`
    select c.conname as name, c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as parent,
      array(select a.attname::text from unnest(c.conkey) with ordinality k(n, i)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i) as cols,
      array(select a.attname::text from unnest(c.confkey) with ordinality k(n, i)
              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.i) as pcols
      from pg_constraint c
     where c.contype = 'f' and c.conrelid::regclass::text like 'cal\\_%'
     order by 1`);
  return rows.map((r) => ({
    name: String(r.name), table: String(r.tbl), parent: String(r.parent),
    columns: r.cols as string[], parentColumns: r.pcols as string[],
  }));
}

/** The `cal_*` tables the store holds, and whether each one's `account_id` may be empty. */
export async function calendarAccountColumns(exec: Exec): Promise<Map<string, string | null>> {
  const tables = await exec(`select table_name::text as t from information_schema.tables
    where table_schema = 'public' and table_name like 'cal\\_%'`);
  const cols = await exec(`select table_name::text as t, is_nullable::text as n from information_schema.columns
    where table_schema = 'public' and table_name like 'cal\\_%' and column_name = 'account_id'`);
  const out = new Map<string, string | null>(tables.map((r) => [String(r.t), null]));
  for (const c of cols) out.set(String(c.t), String(c.n));
  return out;
}

/** What the family's declaration says the store's keys must be, one line per key. */
export function declaredKeys(): string[] {
  const out: string[] = [];
  for (const [table, row] of Object.entries(CALENDAR_TABLES)) {
    if (row.root) out.push(`${table}(account_id) -> accounts(id)`);
    for (const p of row.parents) out.push(`${table}(${p.column},account_id) -> ${p.parent}(id,account_id)`);
  }
  return out.sort();
}

export const keyLine = (k: ForeignKey): string =>
  `${k.table}(${k.columns.join(",")}) -> ${k.parent}(${k.parentColumns.join(",")})`;

/** Every table name the two schemas declare, by SQL name. */
export function declaredTableNames(): Set<string> {
  const names = new Set<string>();
  for (const v of [...Object.values(mailSchema), ...Object.values(cloudSchema)]) {
    if (is(v, PgTable)) names.add(getTableName(v));
  }
  return names;
}

/** The SQLSTATE a statement failed with, or `ok`. */
export async function outcome(exec: Exec, text: string, params: readonly unknown[]): Promise<string> {
  try {
    await exec(text, params);
    return "ok";
  } catch (err) {
    return String((err as { code?: unknown }).code ?? (err as Error).message);
  }
}

/** One account with a whole family: a connection, a calendar, an event. Ids returned. */
export async function seedFamily(exec: Exec, tag: string): Promise<Family> {
  const f: Family = { accountId: randomUUID(), connectionId: randomUUID(), calendarId: randomUUID(), eventId: randomUUID() };
  await exec(`insert into accounts (id, name) values ($1, $2)`, [f.accountId, `cal-${tag}`]);
  await exec(`insert into cal_connections (id, account_id, provider) values ($1, $2, 'google')`, [f.connectionId, f.accountId]);
  await exec(`insert into cal_calendars (id, account_id, connection_id, provider_id) values ($1, $2, $3, $4)`,
    [f.calendarId, f.accountId, f.connectionId, `p-${tag}`]);
  await exec(EVENT_INSERT, [f.eventId, f.accountId, f.calendarId, `e-${tag}`, `uid-${tag}`]);
  return f;
}

export interface Family { accountId: string; connectionId: string; calendarId: string; eventId: string }

const EVENT_INSERT = `insert into cal_events (id, account_id, calendar_id, provider_id, uid, start_kind, start_local, starts_at, ends_at)
  values ($1, $2, $3, $4, $5, 'instant', '20261114T080000Z', '2026-11-14T08:00:00Z', '2026-11-14T09:00:00Z')`;

/**
 * A child row of each key in the family, its account `own`'s and its parent reference resolved by
 * `parent` — so a case can point that one reference at another account's row and nothing else.
 */
export const CHILD_ROWS: Record<string, (own: Family, parent: Family, n: number) => [string, unknown[]]> = {
  "cal_credentials.connection_id": (o, p, n) => [`insert into cal_credentials (account_id, connection_id, kind, secret_enc, key_version)
    values ($1, $2, $3, 'sealed', 1)`, [o.accountId, p.connectionId, `k${n}`]],
  "cal_calendars.connection_id": (o, p, n) => [`insert into cal_calendars (account_id, connection_id, provider_id) values ($1, $2, $3)`,
    [o.accountId, p.connectionId, `c${n}-${randomUUID()}`]],
  "cal_events.calendar_id": (o, p, n) => [EVENT_INSERT, [randomUUID(), o.accountId, p.calendarId, `e${n}-${randomUUID()}`, `u${n}`]],
  "cal_attendees.event_id": (o, p, n) => [`insert into cal_attendees (account_id, event_id, address) values ($1, $2, $3)`,
    [o.accountId, p.eventId, `a${n}-${randomUUID()}@example.test`]],
  "cal_alarms.event_id": (o, p) => [`insert into cal_alarms (account_id, event_id, minutes_before) values ($1, $2, 10)`,
    [o.accountId, p.eventId]],
  "cal_alarms.calendar_id": (o, p) => [`insert into cal_alarms (account_id, calendar_id, minutes_before) values ($1, $2, 10)`,
    [o.accountId, p.calendarId]],
  "cal_writes.calendar_id": (o, p, n) => [`insert into cal_writes (account_id, calendar_id, op, payload, idempotency_key)
    values ($1, $2, 'create', '{}'::jsonb, $3)`, [o.accountId, p.calendarId, `w${n}-${randomUUID()}`]],
};

/**
 * The family's classes, read from the lock's list (`row-security/policies.ts`, the one list of a
 * table's class): every assertion the catalog cases share.
 */
export function assertClassesCover(catalogTables: readonly string[]): void {
  const declared = declaredTableNames();
  const calendarDeclared = [...declared].filter((t) => t.startsWith("cal_"));
  for (const t of [...catalogTables, ...calendarDeclared]) {
    expect(tableClass(t), `${t} has no class for row security`).not.toBeNull();
  }
  // The family's ten are the account's; the providers' notice channels, where the Cloud's journal
  // declares them, are read by their key before the account is known.
  expect(Object.fromEntries(FAMILY.map((t) => [t, tableClass(t)]))).toEqual(Object.fromEntries(FAMILY.map((t) => [t, "account"])));
  if (declared.has("cal_push_channels")) expect(tableClass("cal_push_channels"), "cal_push_channels").toBe("keyed");
  // The worker reads two of them before it binds an account: the roster of connections, and the
  // providers' notice channels where the Cloud's journal declares them.
  expect(WORKER_WIDE_READ.filter((t) => t.startsWith("cal_")).sort())
    .toEqual(["cal_connections", "cal_push_channels"].filter((t) => declared.has(t)));
  // The family's own word for that read is `roster`, exactly where the lock reads the table wide.
  expect(Object.fromEntries(FAMILY.map((t) => [t, CALENDAR_TABLES[t].worker === "roster"])))
    .toEqual(Object.fromEntries(FAMILY.map((t) => [t, (WORKER_WIDE_READ as readonly string[]).includes(t)])));
  const staff = Object.keys(STAFF_SELECT_GRANTS).filter((t) => t.startsWith("public.cal_"));
  expect(staff).toEqual(["public.cal_connections"]);
  expect([...STAFF_SELECT_GRANTS["public.cal_connections"]!].sort())
    .toEqual(["account_id", "error_code", "id", "last_synced_at", "provider", "status"]);
}

export const FAMILY: readonly CalendarTableName[] = Object.keys(CALENDAR_TABLES) as CalendarTableName[];

/**
 * Every case, against one store: the tables and their account, the keys, a row naming another
 * account's parent, and each CHECK's fault beside the row it lets through.
 */
export function calendarCatalogSuite(
  store: string, open: () => Promise<{ exec: Exec; close: () => Promise<void> }>, skip = false,
): void {
  describe.skipIf(skip)(`the calendar's tables on ${store}`, () => {
    let exec: Exec;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => { ({ exec, close } = await open()); }, 120_000);
    afterAll(async () => { await close?.(); });

    it("holds exactly the family's ten tables, each with an account it may not be without", async () => {
      const columns = await calendarAccountColumns(exec);
      const mailJournal = [...columns.keys()].filter((t) => t in CALENDAR_TABLES);
      expect(mailJournal.sort()).toEqual(Object.keys(CALENDAR_TABLES).sort());
      for (const [table, nullable] of columns) expect(nullable, `${table}.account_id`).toBe("NO");
      assertClassesCover([...columns.keys()]);
    });

    it("enforces every key the family declares, composite, and none into the mail tables", async () => {
      const keys = (await calendarKeys(exec)).filter((k) => k.table in CALENDAR_TABLES);
      expect(keys.map(keyLine).sort()).toEqual(declaredKeys());
      expect(keys.filter((k) => !k.parent.startsWith("cal_") && k.parent !== "accounts").map(keyLine)).toEqual([]);
    });

    describe("a row naming another account's parent is refused by the store itself", () => {
      let a: Family;
      let b: Family;
      beforeAll(async () => { a = await seedFamily(exec, "a"); b = await seedFamily(exec, "b"); });
      for (const [key, row] of Object.entries(CHILD_ROWS)) {
        it(key, async () => {
          const [foreignSql, foreignParams] = row(b, a, 1);
          expect(await outcome(exec, foreignSql, foreignParams), `${key} under B naming A's parent`).toBe("23503");
          const [ownSql, ownParams] = row(b, b, 2);
          expect(await outcome(exec, ownSql, ownParams), `${key} wholly under B`).toBe("ok");
        });
      }
      it("names every key of the family", async () => {
        const keys = (await calendarKeys(exec)).filter((k) => k.table in CALENDAR_TABLES && k.parent.startsWith("cal_"));
        expect(keys.map((k) => `${k.table}.${k.columns[0]}`).sort()).toEqual(Object.keys(CHILD_ROWS).sort());
      });
    });

    describe("each CHECK refuses its fault", () => {
      let f: Family;
      beforeAll(async () => { f = await seedFamily(exec, "checks"); });
      const event = (cols: string, vals: string) =>
        `insert into cal_events (account_id, calendar_id, provider_id, uid, ${cols}) values ($1, $2, gen_random_uuid()::text, 'u', ${vals})`;
      const refused: Array<[string, string]> = [
        ["a fifth kind of time", event("start_kind, start_local, starts_at, ends_at", "'week', '20261114', now(), now()")],
        ["a zone on a time that is not zoned", event("start_kind, start_local, start_zone, starts_at, ends_at", "'floating', '20261114T090000', 'Europe/Zurich', now(), now()")],
        ["a zoned time without its zone", event("start_kind, start_local, starts_at, ends_at", "'zoned', '20261114T090000', now(), now()")],
        ["half an end", event("start_kind, start_local, end_local, starts_at, ends_at", "'date', '20261114', '20261115', now(), now()")],
        ["an end and a length", event("start_kind, start_local, end_kind, end_local, duration, starts_at, ends_at", "'date', '20261114', 'date', '20261115', 'PT24H', now(), now()")],
        ["a changed occurrence that names no moment", event("start_kind, start_local, recurrence_id, starts_at, ends_at", "'date', '20261114', '1700000000000', now(), now()")],
        ["no end for an event that is no series", event("start_kind, start_local, starts_at", "'date', '20261114', now()")],
        ["no start moment", event("start_kind, start_local, ends_at", "'date', '20261114', now()")],
      ];
      for (const [fault, text] of refused) {
        it(fault, async () => {
          expect(await outcome(exec, text, [f.accountId, f.calendarId])).toMatch(/^23(514|502)$/);
        });
      }
      it("and the right event passes: a series that does not end", async () => {
        expect(await outcome(exec, event("start_kind, start_local, starts_at, repeat_rule", "'date', '20261114', now(), 'FREQ=WEEKLY'"),
          [f.accountId, f.calendarId])).toBe("ok");
      });
      it("a window of one date, and one backwards", async () => {
        const cal = (start: string, end: string) => [
          `insert into cal_calendars (account_id, connection_id, provider_id, window_start, window_end) values ($1, $2, gen_random_uuid()::text, ${start}, ${end})`,
          [f.accountId, f.connectionId],
        ] as const;
        expect(await outcome(exec, ...cal("'2026-11-01'", "null"))).toBe("23514");
        expect(await outcome(exec, ...cal("'2026-11-02'", "'2026-11-01'"))).toBe("23514");
        expect(await outcome(exec, ...cal("'2026-11-01'", "'2026-11-30'"))).toBe("ok");
      });
      it("a connection holds words, not sentences, and a subscription's host alone", async () => {
        const conn = (cols: string, vals: string) => [
          `insert into cal_connections (account_id, ${cols}) values ($1, ${vals})`, [f.accountId],
        ] as const;
        expect(await outcome(exec, ...conn("provider, error_code", "'google', 'The server said: no'"))).toBe("23514");
        expect(await outcome(exec, ...conn("provider, status", "'google', 'Reconnect please'"))).toBe("23514");
        expect(await outcome(exec, ...conn("provider", "'Google Calendar'"))).toBe("23514");
        expect(await outcome(exec, ...conn("provider, server_url", "'ics', 'https://cal.example.test/'"))).toBe("23514");
        for (const host of ["cal.example.test/feed", "user@cal.example.test", "cal.example.test:8443", "cal.example.test?x", "cal example"]) {
          expect(await outcome(exec, ...conn("provider, source_host", `'ics', '${host}'`)), host).toBe("23514");
        }
        expect(await outcome(exec, ...conn("provider, source_host, error_code", "'ics', 'cal.example.test', 'token_gone'"))).toBe("ok");
      });
    });
  });
}
