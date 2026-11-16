import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { accounts, drafts, mailboxes, outboundSends, ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage, SendOptions } from "@trafficflow/core";
import { SendService } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { deleteAccount } from "../src/account-deletion-service.js";
import { accountScopedTables, EXPIRED_NOT_DELETED, RETAINED, rowsOf, type Db } from "./helpers/erasure-fixture.js";

/**
 * A LATE DELIVERY'S SETTLE AGAINST THE ACCOUNT'S ERASURE, on real Postgres and with the real
 * `deleteAccount`.
 *
 * The settle that follows a server's 250 writes into tables the erasure empties, and it is the one
 * such writer that may not be refused: the letter has left, so its record is written whatever
 * became of the account. It opens on the account's erasure stamp all the same, read FOR SHARE as
 * the first statement of its transaction (`settleLocks`), and the erasure stamps that row as the
 * first statement of its own. So the two meet on one row, in either order:
 *
 *  - the erasure committed while the letter was at the server: the press is answered `sent`, and
 *    the settle finds nothing to write on;
 *  - the settle first: the erasure's stamp waits for it, and the sweep then takes what it wrote;
 *  - the erasure first: the settle waits on the stamp while it holds no row the sweep deletes, and
 *    then writes nothing.
 *
 * After each, no table that carries the account holds a row of it. The two races are forced by
 * gates read in `pg_stat_activity`, never by a sleep. PGlite cannot run them: it is one connection.
 *
 * Each case asserts ONE reading, so a red shows every line of it at once: where each side waited,
 * what a transaction ended on, what the press was told, what the sweep counted, what stands.
 *
 * WATCHED RED: the stamp's read taken out of `settleLocks`. Both races go red, each on its own
 * reading. The settle first: the erasure runs on past its stamp, deletes the reservation and waits
 * at the draft row behind the settle, the settle then waits on that reservation, and Postgres ends
 * one of the two (40P01); when it ends the erasure, the account stands unerased. The erasure
 * first: the settle waits nowhere, and teaches the address book of an account whose erasure has
 * already stamped it. The first case stays green there, since the sweep took the rows a settle
 * writes on; it is red when the settle goes through the fence's door, which refuses on a stamp.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-11-17T09:00:00.000Z");

const watch = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const dbW = brandDialect(drizzle(watch, { schema }), "pg");
const sleep15 = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 15); });
const codeOf = (e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  return String(x?.code ?? x?.cause?.code ?? x?.message ?? e);
};
type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };
const settled = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

/** One party of a race: its own pool under its own application name, and every error a transaction of it ended on. */
function party(name: string) {
  const app = `${name}-${randomUUID().slice(0, 8)}`;
  const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {}, connection: { application_name: app } });
  const db = brandDialect(drizzle(client, { schema }), "pg");
  const ended: string[] = [];
  const h = db as unknown as { transaction: (fn: unknown, ...rest: unknown[]) => Promise<unknown> };
  const inner = h.transaction.bind(h);
  Object.defineProperty(h, "transaction", {
    configurable: true, writable: true,
    value: (fn: unknown, ...rest: unknown[]) => inner(fn, ...rest).catch((e: unknown) => { ended.push(codeOf(e)); throw e; }),
  });
  return { app, client, db, ended };
}
type Party = ReturnType<typeof party>;

/** A connection that takes one lock in a transaction and keeps it until `release()`. */
function holder(name: string) {
  const app = `${name}-${randomUUID().slice(0, 8)}`;
  const client = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, connection: { application_name: app } });
  let release: () => void = () => {};
  let done: Promise<unknown> = Promise.resolve();
  return {
    app,
    /** Resolves once `take` has run inside the open transaction. */
    hold(take: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
      return new Promise<void>((took, failed) => {
        const released = new Promise<void>((r) => { release = r; });
        done = client.begin(async (tx) => { await take(tx); took(); await released; }).catch(failed);
      });
    },
    async release(): Promise<void> { release(); await done; },
    async end(): Promise<void> { release(); await done; await client.end({ timeout: 5 }); },
  };
}

/** The statement a backend of `waiter` waits for a lock at while one of `holder` blocks it; null when it never does. */
async function blockedOn(waiter: string, holder: string, ms = 10_000): Promise<string | null> {
  const end = Date.now() + ms;
  for (;;) {
    const rows = await watch<{ q: string }[]>`
      select w.query as q from pg_stat_activity w
       where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'
         and exists (select 1 from pg_stat_activity h
                      where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`;
    if (rows[0]) return rows[0].q.replace(/\s+/g, " ");
    if (Date.now() >= end) return null;
    await sleep15();
  }
}

/** Whether a row can be taken right now: `free`, or the code Postgres refused with. */
async function rowIs(table: "drafts" | "outbound_sends", id: string): Promise<string> {
  try {
    await watch.begin(async (tx) => { await tx`select id from ${tx(table)} where id = ${id} for update nowait`; });
    return "free";
  } catch (e) {
    return codeOf(e);
  }
}

/**
 * A transport shaped as production's: the release gate is passed, the server's 250 is held until
 * `accept()`, and the Sent copy is the caller's to file.
 */
function transport() {
  let arrived: () => void = () => {};
  const atServer = new Promise<"at the server">((r) => { arrived = () => r("at the server"); });
  let accept: () => void = () => {};
  const accepted = new Promise<void>((r) => { accept = r; });
  const open: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage, opts?: SendOptions) {
      await opts?.beforeRelease?.();
      arrived();
      await accepted;
      return {
        providerMessageId: msg.messageId!,
        ...(opts?.copy === "caller" ? { unfiledCopy: Buffer.from("the sent copy") } : {}),
      };
    },
    async fileSentCopy() { return null; },
    async messageInSent() { return false; },
    async close() { /* nothing to tear down */ },
  });
  return { open, atServer, accept: (): void => accept() };
}

/** An account with its row, one mailbox, and a draft to one person. */
async function world() {
  const accountId = randomUUID();
  await dbW.insert(accounts).values({ id: accountId, name: `settle-${accountId.slice(0, 8)}` });
  const [mb] = await dbW.insert(mailboxes).values({
    accountId, provider: "imap", address: `settle-${accountId.slice(0, 8)}@erasure.test`, status: "connected",
  }).returning();
  const [d] = await dbW.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the letter", body: "words",
    to: [{ name: null, address: `you-${accountId.slice(0, 8)}@erasure.test` }], status: "draft", createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx = (p: Party): ServiceContext =>
    ({ db: p.db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: p.app });
  return { accountId, draftId: d!.id, ctx };
}
type World = Awaited<ReturnType<typeof world>>;

/** The press, carried to the moment its letter is at the server and the 250 is held. */
async function pressed(w: World, p: Party) {
  const t = transport();
  const press = settled(new SendService().send(w.ctx(p), w.draftId, `key-${randomUUID()}`, { openSendAdapter: t.open }));
  expect(await Promise.race([t.atServer, press.then(() => "answered before its 250")])).toBe("at the server");
  const [row] = await dbW.select({ id: outboundSends.id }).from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
  return { press, accept: t.accept, sendId: row!.id };
}

/** What stands of the account, table by table out of the catalogue: every table that carries it, less what an erasure keeps by ruling. */
async function standing(accountId: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of await accountScopedTables(dbW as unknown as Db)) {
    if (RETAINED.has(t) || EXPIRED_NOT_DELETED.has(t)) continue;
    const [r] = rowsOf<{ c: number }>(await dbW.execute(
      sql`select count(*)::int as c from ${sql.identifier(t)} where account_id = ${accountId}`,
    ));
    if ((r?.c ?? 0) > 0) out.push(`${t} (${r!.c})`);
  }
  return out;
}

/** What a lock wait is for, by its statement; the statement itself where it is none of the four met here. */
function waitOf(q: string | null): string {
  if (q === null) return "nowhere";
  if (/from "accounts".*for share/i.test(q)) return "the account row, for share";
  if (/from "drafts".*for no key update/i.test(q)) return "the draft row";
  if (/^update "accounts"/i.test(q)) return "the account row, to stamp it";
  if (/pg_advisory_xact_lock/i.test(q)) return "its own pause";
  return q;
}

/**
 * How a race ended: every error a transaction of either side ended on, what the press was told,
 * what the sweep counted in the three tables a settle writes rows of, what still stands of the
 * account, and whether its row carries the stamp.
 */
async function ending(
  w: World, sides: Party[], out: Settled<{ status: string }>, erased: Settled<{ deleted: Record<string, number> }>,
) {
  const [account] = await dbW.select({ erasedAt: accounts.erasedAt }).from(accounts).where(eq(accounts.id, w.accountId));
  return {
    endedOn: sides.flatMap((p) => p.ended),
    press: out.ok ? out.v.status : `threw ${codeOf(out.e)}`,
    swept: erased.ok
      ? { sends: erased.v.deleted.outbound_sends, drafts: erased.v.deleted.drafts, contacts: erased.v.deleted.contacts }
      : `threw ${codeOf(erased.e)}`,
    standing: await standing(w.accountId),
    stamped: account?.erasedAt instanceof Date,
  };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await watch.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a late delivery's settle against the account's erasure", () => {
  it("erased while the letter was at the server: the press is still answered sent, and nothing of the account is written", async () => {
    const sender = party("erased-settle");
    const eraser = party("erased-sweep");
    try {
      const w = await world();
      const { press, accept } = await pressed(w, sender);

      const erased = await settled(deleteAccount(w.ctx(eraser)));
      accept();
      const out = await press;

      // The letter went: its press is not refused for an erasure it cannot undo. The sweep took the
      // reservation and the draft before the 250, so the settle found nothing to write on.
      expect(await ending(w, [sender, eraser], out, erased)).toEqual({
        endedOn: [], press: "sent", swept: { sends: 1, drafts: 1, contacts: 0 }, standing: [], stamped: true,
      });
    } finally {
      await sender.client.end({ timeout: 5 });
      await eraser.client.end({ timeout: 5 });
    }
  }, 60_000);

  it("the settle first: the erasure's first statement waits for it, and the sweep takes what it wrote", async () => {
    const sender = party("first-settle");
    const eraser = party("first-sweep");
    const third = holder("first-draft");
    try {
      const w = await world();
      const { press, accept } = await pressed(w, sender);
      // The settle is stopped inside its transaction, past its first statement: its draft row is
      // held, as one of the draft's own writers holds it.
      await third.hold((tx) => tx`select id from drafts where id = ${w.draftId} for update`);
      accept();
      const settleWaits = waitOf(await blockedOn(sender.app, third.app));
      const erasure = settled(deleteAccount(w.ctx(eraser)));
      const erasureWaits = waitOf(await blockedOn(eraser.app, sender.app));
      await third.release();
      const [out, erased] = await Promise.all([press, erasure]);

      // The erasure waits on the open settle at the row both take first, so the settle commits
      // inside the sweep's reach: the person it taught is among what was swept.
      expect({ settleWaits, erasureWaits, ...await ending(w, [sender, eraser], out, erased) }).toEqual({
        settleWaits: "the draft row", erasureWaits: "the account row, to stamp it",
        endedOn: [], press: "sent", swept: { sends: 1, drafts: 1, contacts: 1 }, standing: [], stamped: true,
      });
    } finally {
      await third.end();
      await sender.client.end({ timeout: 5 });
      await eraser.client.end({ timeout: 5 });
    }
  }, 60_000);

  it("the erasure first: the settle waits on the stamp holding no row the sweep deletes, and then writes nothing", async () => {
    const sender = party("second-settle");
    const eraser = party("second-sweep");
    const third = holder("second-pause");
    try {
      const w = await world();
      const { press, accept, sendId } = await pressed(w, sender);
      // The erasure is stopped where it stops itself, on its thread-structure lock: the account
      // row is stamped and held, and nothing is deleted yet.
      await third.hold((tx) => tx`select pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}::int, hashtext(${w.accountId}::text))`);
      const erasure = settled(deleteAccount(w.ctx(eraser)));
      const erasureWaits = waitOf(await blockedOn(eraser.app, third.app));
      accept();
      const settleWaits = waitOf(await blockedOn(sender.app, eraser.app));
      // A row the settle held here would be half of a deadlock: the sweep deletes both.
      const whileItWaits = { draft: await rowIs("drafts", w.draftId), reservation: await rowIs("outbound_sends", sendId) };
      await third.release();
      const [out, erased] = await Promise.all([press, erasure]);

      // The settle read the stamp once the sweep had committed: nobody was taught, nothing was written.
      expect({ erasureWaits, settleWaits, whileItWaits, ...await ending(w, [sender, eraser], out, erased) }).toEqual({
        erasureWaits: "its own pause", settleWaits: "the account row, for share",
        whileItWaits: { draft: "free", reservation: "free" },
        endedOn: [], press: "sent", swept: { sends: 1, drafts: 1, contacts: 0 }, standing: [], stamped: true,
      });
    } finally {
      await third.end();
      await sender.client.end({ timeout: 5 });
      await eraser.client.end({ timeout: 5 });
    }
  }, 60_000);
});
