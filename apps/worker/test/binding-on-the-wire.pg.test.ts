import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { carries, flightsOf, recordPgWire, type PgWireFlight } from "@trafficflow/db/testing";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "../../../packages/organizer/test/_fakeadapter.js";
import { doorOf, namedBy, refusedOf, unmetOf } from "../../../test/support/wire-doors.js";

/**
 * THE BINDING AT EVERY DOOR OF THE ORGANIZER, READ OFF THE WIRE.
 *
 * Two accounts, A and B, one mailbox each, and the worker as it starts: its roster pass, both
 * attaches, a cycle that visits each mailbox, and one walk of the cycle's tail over both accounts.
 * Everything the process wrote to the database in that time is read through `flightsOf`:
 *
 * - what is done for one mailbox or one account rides transactions that name that account, and
 *   never carries the other's ids;
 * - what the roster reads, and what runs for no account, rides transactions that name none, and
 *   names only tables the worker reads for the whole service, the prunes' own, or the operations';
 * - a statement outside any transaction names no table an account owns.
 *
 * And a served mailbox whose row comes to name another account: the runtime attached under the first
 * is ended, never moved, and what is done for the mailbox after rides the account its row names.
 *
 * The store is this file's own, so every account a flight names is A or B.
 */
const wire = recordPgWire();
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 29));
let DB = "";

type Db = ReturnType<typeof makeDb>;
interface Served { accountId: string; mailboxId: string }

/**
 * What this file's own waits read while the worker is read off the wire ends with this mark: such a
 * statement, sent outside any transaction, is the file's and not the worker's. A worker statement of
 * the same text carries no mark and is held to the lists like any other.
 */
const SEED_MARK = "/* wire-seed */";
const isSeeds = (f: PgWireFlight): boolean => f.door === "plain" && f.statements[0]!.trimEnd().endsWith(SEED_MARK);

/** How many letters the store holds, read with {@link SEED_MARK}. */
async function storedCount(db: Db): Promise<number> {
  return (await db.execute(sql`select "id" from "messages" ${sql.raw(SEED_MARK)}`) as unknown as unknown[]).length;
}

/**
 * Move `mailboxId`, and every row that names it beside its account, to `accountId`: one statement, so
 * the foreign keys from those rows to the mailbox's id and account hold at its end. No product path
 * moves a mailbox between accounts; this is the row edited by hand that a roster reading must meet.
 */
async function moveMailbox(db: Db, mailboxId: string, accountId: string): Promise<void> {
  const tables = await db.execute(sql`
    select c.relname as "t" from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.mailboxes'::regclass and cardinality(k.confkey) = 2
    order by c.relname`) as unknown as Array<{ t: string }>;
  const rows = tables.map(({ t }, i) => sql`, ${sql.raw(`r${i}`)} as (
    update ${sql.identifier(t)} set "account_id" = ${accountId} where "mailbox_id" = ${mailboxId} returning 1)`);
  await db.execute(sql`with m as (update "mailboxes" set "account_id" = ${accountId} where "id" = ${mailboxId} returning 1)${sql.join(rows)} select 1`);
}

/** Whether `mailboxId` still carries a stamp that asks for a sync, read with {@link SEED_MARK}. */
async function stampedNow(db: Db, mailboxId: string): Promise<boolean> {
  const rows = await db.execute(
    sql`select "sync_requested_at" as "at" from "mailboxes" where "id" = ${mailboxId} ${sql.raw(SEED_MARK)}`,
  ) as unknown as Array<{ at: unknown }>;
  return rows[0]!.at !== null;
}

async function seedMailbox(db: Db): Promise<Served> {
  const [acct] = await db.insert(accounts).values({ name: `wire-${randomUUID().slice(0, 8)}` }).returning();
  const [row] = await db.insert(mailboxes)
    .values({ accountId: acct!.id, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId: acct!.id, mailboxId: row!.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** Wait until the wire has been quiet for a moment. */
async function settled(): Promise<void> {
  let last = -1;
  for (;;) {
    const n = wire.read().flushes.length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 60));
  }
}

function walksLogged(): { log: Logger; walks: Array<Record<string, unknown>> } {
  const walks: Array<Record<string, unknown>> = [];
  const log = createLogger({
    service: "worker", level: "info",
    sink: (line) => {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.event === "cycle_phases") walks.push(o);
    },
  });
  return { log, walks };
}

describe("the binding at every door of the organizer, on the wire (the worker, real Postgres)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_wire"); }, 120_000);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a start, a cycle over two mailboxes and one walk of the tail: every statement rides the account it is for, or none", async () => {
    await truncateAll(DB);
    const seed = makeDb(DB);
    const a = await seedMailbox(seed);
    const b = await seedMailbox(seed);
    // A's mailbox is stamped for a sync, as the API stamps one after a send: the kick serves it.
    await seed.update(mailboxes).set({ syncRequestedAt: new Date() }).where(eq(mailboxes.id, a.mailboxId));
    const fleet = new FakeAdapterFleet();
    // Two letters wait in each mailbox: the cycle's visit stores them under the mailbox's account.
    for (const [who, tag] of [[a, "a"], [b, "b"]] as const) {
      fleet.behave(who.mailboxId, {
        deliver: [1, 2].map((n) => ({
          from: `writer${n}@elsewhere.test`, subject: `note ${tag}${n}`, messageId: `<${tag}${n}-${randomUUID()}@elsewhere.test>`,
        })),
      });
    }
    const { log, walks } = walksLogged();
    const config: WorkerConfig = {
      databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      pollIntervalMs: 600_000, rosterIntervalMs: 600_000, lockHeartbeatMs: 60_000,
      alertIntervalMs: 600_000, mailboxRetryMs: 60_000, maxSyncFailures: 50, logger: log,
      tailTurn: { minTurnMs: 1, turnBudgetMs: 600_000 }, syncKickFloorMs: 50,
    };

    await settled();
    wire.start();
    const worker = await startWorker(config);
    let stopped = false;
    const stop = async (): Promise<void> => { if (!stopped) { stopped = true; await worker.stop(); } };
    closers.push(stop);
    await waitFor(() => worker.stats().mailboxes === 2, 30_000, "both mailboxes attached");
    await waitFor(() => walks.length >= 1, 30_000, "the first walk of the tail to finish");
    await waitFor(async () => (await storedCount(seed)) === 4, 30_000, "the four letters stored");
    await waitFor(async () => !(await stampedNow(seed, a.mailboxId)), 30_000, "the kick to clear A's stamp");
    // The reading ends with the worker's own stop: what it writes on its way out is held to the same lists.
    await stop();
    // The waits above read through this file's own handle, outside any transaction, and carry the mark.
    const flights = flightsOf(wire.read()).filter((f) => !isSeeds(f));

    // ── No statement names what its door does not reach ──
    const met = new Set<string>();
    expect(refusedOf("worker", flights, [], met)).toEqual([]);
    // And every owed row this walk is said to meet was met: the list holds nothing that is no longer true.
    expect(unmetOf("worker", met)).toEqual([]);

    // The worker has no keyed door, and its store holds A and B alone.
    expect(flights.filter((f) => f.keyed)).toEqual([]);
    const bound = flights.filter((f) => f.account !== null);
    expect(new Set(bound.map((f) => f.account))).toEqual(new Set([a.accountId, b.accountId]));

    // ── What is done for one account never carries the other's ids ──
    for (const [own, other] of [[a, b], [b, a]] as const) {
      // One mailbox's statement never rides the roster's view: a flight that names no account and carries this mailbox's id carries the other's too.
      expect(flights.filter((f) => doorOf(f) === "nothing" && carries(f, own.mailboxId) && !carries(f, other.mailboxId))).toEqual([]);
      const theirs = bound.filter((f) => f.account === own.accountId);
      expect(theirs.filter((f) => carries(f, other.accountId) || carries(f, other.mailboxId))).toEqual([]);
      // The visit: the mailbox's own rows are read and written under its account, its letters stored there.
      expect(theirs.some((f) => carries(f, own.mailboxId))).toBe(true);
      const storing = flights.filter((f) => f.statements.some((s) => namedBy(s).writes === "messages"));
      expect(storing.filter((f) => carries(f, own.mailboxId)).map((f) => f.account))
        .toEqual(storing.filter((f) => carries(f, own.mailboxId)).map(() => own.accountId));
      expect(storing.some((f) => f.account === own.accountId)).toBe(true);
      // The tail's walk: a pass that runs for each account of the walk rides that account.
      expect(theirs.some((f) => f.statements.some((s) => namedBy(s).reads.includes("workflows")))).toBe(true);
    }
    const letters = await seed.select({ accountId: messages.accountId, mailboxId: messages.mailboxId }).from(messages);
    expect(letters.filter((m) => m.accountId === a.accountId && m.mailboxId === a.mailboxId)).toHaveLength(2);
    expect(letters.filter((m) => m.accountId === b.accountId && m.mailboxId === b.mailboxId)).toHaveLength(2);

    // ── What runs for no account ──
    const roster = flights.filter((f) => doorOf(f) === "nothing");
    // The roster's read of the mailboxes this shard serves, and nothing of one account's letters.
    expect(roster.some((f) => f.statements.some((s) => namedBy(s).reads.includes("mailboxes")))).toBe(true);
    expect(roster.filter((f) => f.statements.some((s) => namedBy(s).writes === "messages"))).toEqual([]);
    expect(roster.filter((f) => f.statements.some((s) => namedBy(s).reads.includes("workflows")))).toEqual([]);
  }, 120_000);

  it("a served mailbox whose row comes to name another account: its runtime is ended, and what is done for it after rides that account", async () => {
    await truncateAll(DB);
    const seed = makeDb(DB);
    const a = await seedMailbox(seed);
    const [other] = await seed.insert(accounts).values({ name: `wire-${randomUUID().slice(0, 8)}` }).returning();
    const b = other!.id;
    const events: Array<Record<string, unknown>> = [];
    const log = createLogger({
      service: "worker", level: "info", sink: (line) => { events.push(JSON.parse(line) as Record<string, unknown>); },
    });
    const ended = (): number => events.filter((e) => e.event === "cycle_phases").length;
    const said = (event: string): Array<Record<string, unknown>> =>
      events.filter((e) => e.event === event && e.mailboxId === a.mailboxId);
    const config: WorkerConfig = {
      databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: new FakeAdapterFleet().factory,
      // The roster is read every few hundred milliseconds; a cycle is woken only by an attach and the kick.
      pollIntervalMs: 600_000, rosterIntervalMs: 300, lockHeartbeatMs: 60_000,
      alertIntervalMs: 600_000, mailboxRetryMs: 60_000, maxSyncFailures: 50, logger: log,
      tailTurn: { minTurnMs: 1, turnBudgetMs: 600_000 }, syncKickFloorMs: 50,
    };
    const worker = await startWorker(config);
    let stopped = false;
    const stop = async (): Promise<void> => { if (!stopped) { stopped = true; await worker.stop(); } };
    closers.push(stop);
    await waitFor(() => worker.stats().mailboxes === 1 && ended() >= 1, 30_000, "the mailbox attached under A, and its first cycle");

    // The mailbox's row, and every row that names it beside its account, come to name B between two
    // readings of the roster.
    await moveMailbox(seed, a.mailboxId, b);
    await waitFor(() => said("mailbox_account_changed").length > 0, 30_000, "the roster to read the mailbox under B");
    // The runtime attached under A is ended: by the roster at once, or by its cycle once its lanes joined.
    await waitFor(() => said("mailbox_detached").length > 0, 10_000, "the runtime attached under A to end").catch(() => undefined);

    // From here, a sync asked for the mailbox: whatever serves it now visits it. The worker is running,
    // so the reading begins where it stands: a flight cut in half by its start names no account.
    wire.start();
    const before = ended();
    await seed.execute(sql`update "mailboxes" set "sync_requested_at" = now() where "id" = ${a.mailboxId} ${sql.raw(SEED_MARK)}`);
    await waitFor(async () => !(await stampedNow(seed, a.mailboxId)), 30_000, "the kick to clear the mailbox's stamp");
    await waitFor(() => ended() > before, 30_000, "a cycle after the stamp to end");
    await stop();
    const flights = flightsOf(wire.read()).filter((f) => !isSeeds(f));

    // Every flight after it that names an account and carries the mailbox's id names B, and there is one.
    const named = flights.filter((f) => f.account !== null && carries(f, a.mailboxId));
    expect(named.length).toBeGreaterThan(0);
    expect(named.map((f) => f.account)).toEqual(named.map(() => b));
    // The roster said so, and the runtime attached under A was ended for it.
    const changed = said("mailbox_account_changed");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.map((e) => e.accountId)).toEqual(changed.map(() => a.accountId));
    expect(changed.map((e) => e.namedAccountId)).toEqual(changed.map(() => b));
    const endedUnderA = said("mailbox_detached").filter((e) => e.accountId === a.accountId);
    expect(endedUnderA.length).toBeGreaterThan(0);
    expect(endedUnderA.map((e) => e.reason)).toEqual(endedUnderA.map(() => "the roster names another account for this mailbox"));
  }, 120_000);
});
