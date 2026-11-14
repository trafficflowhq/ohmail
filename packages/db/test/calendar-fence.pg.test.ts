import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AccountErasedError, MailboxErasedError, accounts, calCalendars, calConnections, calLinks, calSuggestions, fencedAccountWrite,
  mailboxes, sweepMailboxData, type LedgerTx, type Tx,
} from "../src/index.js";
import { CalendarConnectionGone, fencedConnectionWrite, holdCalendarMailbox } from "../src/calendar/fence.js";
import { declaredTableNames } from "./_calendar-family.js";

/**
 * THE CALENDAR WRITER'S FENCE ON REAL POSTGRES, two sessions apart as an erasure and a sync page
 * are in production: PGlite is one connection, so no lock order can be seen there. A write under a
 * connection holds the account, the mailbox the connection rides and the connection, in that order;
 * a write that names a mailbox alone holds the account and the mailbox. Either way an erasure that
 * finished first refuses it, and one that starts while a page is in flight waits for that page and
 * then takes what it wrote.
 */
const PG_UP = await realPgAvailable();

type Db = ReturnType<typeof drizzle<typeof schema>>;
const clients: Array<ReturnType<typeof postgres>> = [];
/** A handle whose backends carry `app` as their application name, so each party can be watched. */
function named(app: string): Db {
  const client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {}, connection: { application_name: app } });
  clients.push(client);
  return brandDialect(drizzle(client, { schema }), "pg");
}

let writer: Db;
let eraser: Db;
beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  writer = named("cal-fence-writer");
  eraser = named("cal-fence-eraser");
}, 240_000);
afterAll(async () => { for (const c of clients) await c.end({ timeout: 5 }); });

const NOW = new Date("2026-11-14T12:00:00.000Z");

async function world() {
  const accountId = randomUUID();
  await writer.insert(accounts).values({ id: accountId, name: "cal fence" });
  const [mb] = await writer.insert(mailboxes).values({ accountId, provider: "imap", address: `me-${accountId}@fence.test` })
    .returning({ id: mailboxes.id });
  const riding = randomUUID();
  const alone = randomUUID();
  await writer.insert(calConnections).values([
    { id: riding, accountId, provider: "google", mailboxId: mb!.id },
    { id: alone, accountId, provider: "ics", label: "Holidays" },
  ]);
  return { accountId, mailboxId: mb!.id, riding, alone };
}

/** The mailbox's erasure, reduced to the stamp every fence is ordered against, on its own session. */
const stampMailbox = (mailboxId: string) =>
  eraser.update(mailboxes).set({ erasedAt: NOW, status: "disabled" }).where(eq(mailboxes.id, mailboxId));

const calendarOf = (db: Db, connectionId: string) =>
  db.select({ id: calCalendars.id }).from(calCalendars).where(eq(calCalendars.connectionId, connectionId));

const aCalendar = (accountId: string, connectionId: string) =>
  ({ id: randomUUID(), accountId, connectionId, providerId: `p-${randomUUID()}` });

/** The statement `waiter` is waiting on, held by `holder`'s backend, or null within `ms`. */
async function blockedOn(waiter: string, holder: string, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await writer.execute(sql`select w.query as q from pg_stat_activity w
      where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'
        and exists (select 1 from pg_stat_activity h
          where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`);
    const q = (rows as unknown as Array<{ q: string }>)[0]?.q;
    if (q !== undefined) return q;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe.skipIf(!PG_UP)("the calendar writer's fence", () => {
  it("writes under a live connection, riding a mailbox or not: the positive control", async () => {
    const w = await world();
    for (const connectionId of [w.riding, w.alone]) {
      const held = await fencedConnectionWrite(writer as unknown as Tx, { accountId: w.accountId, connectionId }, async (tx, h) => {
        await tx.insert(calCalendars).values(aCalendar(w.accountId, connectionId));
        return h;
      });
      expect(held.mailboxId).toBe(connectionId === w.riding ? w.mailboxId : null);
      expect(await calendarOf(writer, connectionId)).toHaveLength(1);
    }
  });

  it("an erasure that finished first refuses a page under a connection that rode the mailbox", async () => {
    const w = await world();
    await stampMailbox(w.mailboxId);
    await expect(fencedConnectionWrite(writer as unknown as Tx, { accountId: w.accountId, connectionId: w.riding }, async (tx) => {
      await tx.insert(calCalendars).values(aCalendar(w.accountId, w.riding));
    })).rejects.toBeInstanceOf(MailboxErasedError);
    expect(await calendarOf(writer, w.riding)).toEqual([]);
    // One riding no mailbox is not the mailbox's to refuse.
    await fencedConnectionWrite(writer as unknown as Tx, { accountId: w.accountId, connectionId: w.alone }, async (tx) => {
      await tx.insert(calCalendars).values(aCalendar(w.accountId, w.alone));
    });
    expect(await calendarOf(writer, w.alone)).toHaveLength(1);
  });

  it("an erasure that finished first refuses a suggestion and a link naming the mailbox", async () => {
    const w = await world();
    await stampMailbox(w.mailboxId);
    await expect(fencedAccountWrite(writer as unknown as Tx, { accountId: w.accountId }, async (tx) => {
      await holdCalendarMailbox(tx, dialect(writer), { accountId: w.accountId, mailboxId: w.mailboxId });
      await tx.insert(calSuggestions).values({
        accountId: w.accountId, messageId: randomUUID(), mailboxId: w.mailboxId, evidence: "dates", proposed: {}, sourceWords: "lunch",
      });
      await tx.insert(calLinks).values({ accountId: w.accountId, messageId: randomUUID(), mailboxId: w.mailboxId, uid: "u", kind: "invitation" });
    })).rejects.toBeInstanceOf(MailboxErasedError);
    expect(await writer.select().from(calSuggestions).where(eq(calSuggestions.mailboxId, w.mailboxId))).toEqual([]);
    expect(await writer.select().from(calLinks).where(eq(calLinks.mailboxId, w.mailboxId))).toEqual([]);
  });

  it("refuses a connection being removed, one that is gone, another account's, and another account's mailbox", async () => {
    const w = await world();
    const other = await world();
    await writer.update(calConnections).set({ status: "removing" }).where(eq(calConnections.id, w.alone));
    const write = (accountId: string, connectionId: string) =>
      fencedConnectionWrite(writer as unknown as Tx, { accountId, connectionId }, async (tx) => {
        await tx.insert(calCalendars).values(aCalendar(accountId, connectionId));
      });
    await expect(write(w.accountId, w.alone)).rejects.toMatchObject({ name: "CalendarConnectionGone", reason: "removing" });
    await expect(write(w.accountId, randomUUID())).rejects.toMatchObject({ name: "CalendarConnectionGone", reason: "absent" });
    await expect(write(w.accountId, other.riding)).rejects.toBeInstanceOf(CalendarConnectionGone);
    await expect(fencedAccountWrite(writer as unknown as Tx, { accountId: w.accountId }, (tx) =>
      holdCalendarMailbox(tx, dialect(writer), { accountId: w.accountId, mailboxId: other.mailboxId }))).rejects.toBeInstanceOf(MailboxErasedError);
    // The account's own stamp refuses whatever it names.
    await eraser.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, other.accountId));
    await expect(write(other.accountId, other.alone)).rejects.toBeInstanceOf(AccountErasedError);
    expect(await calendarOf(writer, w.alone)).toEqual([]);
    expect(await calendarOf(writer, other.alone)).toEqual([]);
  });

  it("a page in flight holds the mailbox's erasure until it commits, and the erasure then takes what it wrote", async () => {
    const w = await world();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let wrote!: () => void;
    const written = new Promise<void>((r) => { wrote = r; });
    const page = fencedConnectionWrite(writer as unknown as Tx, { accountId: w.accountId, connectionId: w.riding }, async (tx) => {
      await tx.insert(calCalendars).values(aCalendar(w.accountId, w.riding));
      wrote();
      await held;
    });
    await written;
    // Started now, on its own session (a query builder runs only once it is awaited).
    const stamp = (async () => { await stampMailbox(w.mailboxId); })();
    const waiting = await blockedOn("cal-fence-eraser", "cal-fence-writer", 10_000);
    release();
    await page;
    await stamp;
    expect(waiting ?? "never", "the stamp did not wait for the page in flight").toMatch(/update "mailboxes"/i);
    expect(await calendarOf(writer, w.riding)).toHaveLength(1);
    await eraser.transaction((tx) => sweepMailboxData(tx as unknown as LedgerTx, dialect(eraser), {
      accountId: w.accountId, mailboxId: w.mailboxId, now: NOW,
    }));
    expect(await calendarOf(writer, w.riding)).toEqual([]);
    expect(await writer.select().from(calConnections).where(eq(calConnections.id, w.riding))).toEqual([]);
    // And the next page finds the stamp.
    await expect(fencedConnectionWrite(writer as unknown as Tx, { accountId: w.accountId, connectionId: w.riding }, async () => {}))
      .rejects.toBeInstanceOf(CalendarConnectionGone);
  });

  /**
   * A NOTICE CHANNEL (cloud 0105) under a connection that rides the mailbox. The mailbox's calendar
   * step runs on a desktop's store too and may not name a Cloud table, so the channel's key onto its
   * connection must cascade, or every pass of the erasure stops on it and the mailbox is never done.
   * A store without the channels' table declares none either (a desktop's, or a server's before
   * that entry).
   */
  it("a notice channel under a riding connection does not hold the mailbox's erasure", async () => {
    const [present] = await writer.execute(sql`select 1 as one from information_schema.tables
      where table_schema = 'public' and table_name = 'cal_push_channels'`) as unknown as unknown[];
    if (present === undefined) {
      expect(declaredTableNames()).not.toContain("cal_push_channels");
      return;
    }
    const w = await world();
    const [sibling] = await writer.insert(mailboxes).values({ accountId: w.accountId, provider: "imap", address: `two-${w.accountId}@fence.test` })
      .returning({ id: mailboxes.id });
    const elsewhere = randomUUID();
    await writer.insert(calConnections).values({ id: elsewhere, accountId: w.accountId, provider: "google", mailboxId: sibling!.id });
    for (const connectionId of [w.riding, w.alone, elsewhere]) {
      await writer.execute(sql`insert into cal_push_channels (account_id, connection_id, provider, channel_id, token_hash, expires_at)
        values (${w.accountId}, ${connectionId}, 'google', ${randomUUID()}, 'hash', now() + interval '1 day')`);
    }
    await stampMailbox(w.mailboxId);
    await eraser.transaction((tx) => sweepMailboxData(tx as unknown as LedgerTx, dialect(eraser), {
      accountId: w.accountId, mailboxId: w.mailboxId, now: NOW,
    }));
    const [done] = await writer.select({ at: mailboxes.erasureDoneAt }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(done?.at).not.toBeNull();
    const channels = await writer.execute(sql`select connection_id::text as c from cal_push_channels where account_id = ${w.accountId}
      order by 1`) as unknown as Array<{ c: string }>;
    expect(channels.map((r) => r.c)).toEqual([w.alone, elsewhere].sort());
    expect((await writer.select({ id: calConnections.id }).from(calConnections).where(eq(calConnections.accountId, w.accountId)))
      .map((r) => r.id).sort()).toEqual([w.alone, elsewhere].sort());
  });
});
