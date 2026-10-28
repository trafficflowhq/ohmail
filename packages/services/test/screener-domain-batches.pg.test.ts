import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messages, folderState, flagState, changeLog, idempotencyKeys } from "@trafficflow/db";
import { schema, makePooledDb, closePooledDbs } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { FILING_BATCH_MAX } from "@trafficflow/core/adapters/imap-types";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";

/**
 * A DOMAIN DECISION WRITTEN IN SETS, ON REAL POSTGRES. Two things PGlite cannot show: a rival
 * holding a row of the SECOND set while that set's multi-row upsert waits (the guard is
 * re-checked on the committed version and that row alone is skipped), and the production
 * driver's round trips, read off the wire. Reads are scoped to each case's own account; the
 * heavy rows go in `afterEach`.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const made: string[] = [];

const ctx = (accountId: string, handle: unknown = db): ServiceContext => ({
  db: handle as ServiceContext["db"], accountId, userId: null, now: () => new Date(),
  requestId: `batches-${randomUUID().slice(0, 8)}`,
});

/** `held` letters at corp.test, one sender each, newest first in the returned order. */
async function newWorld(held: number): Promise<{ accountId: string; ids: string[]; unread: Map<string, boolean> }> {
  const accountId = randomUUID();
  made.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `batches-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `batches-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const rows = Array.from({ length: held }, (_x, i) => ({
    id: randomUUID(), accountId, mailboxId: mb!.id, bodyHash: `b${i}`, dedupKey: `batches:${randomUUID()}`,
    subject: `Note ${i}`, fromAddress: `sender-${i}@corp.test`, unread: i % 3 !== 0,
    date: new Date(Date.UTC(2026, 8, 1) + (held - i) * 60_000),
    nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    // Checked at ingest, as every row since mail 0148.
    senderCheck: "none" as const,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await db.insert(messages).values(part);
    await db.insert(folderState).values(part.map((r) => ({
      messageId: r.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    })));
  }
  return { accountId, ids: rows.map((r) => r.id), unread: new Map(rows.map((r) => [r.id, r.unread])) };
}

async function waitForLockWait(deadlineMs = 10_000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const [row] = await client<Array<{ n: number }>>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and state = 'active'
         and query ilike '%folder_state%'`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!PG_UP)("a domain decision written in sets, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterEach(async () => {
    for (const accountId of made.splice(0)) {
      const ids = db.select({ id: messages.id }).from(messages).where(eq(messages.accountId, accountId));
      await db.delete(changeLog).where(eq(changeLog.accountId, accountId));
      await db.delete(flagState).where(inArray(flagState.messageId, ids));
      await db.delete(folderState).where(inArray(folderState.messageId, ids));
      await db.delete(messages).where(eq(messages.accountId, accountId));
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.accountId, accountId));
    }
  });
  afterAll(async () => { await closePooledDbs(); await client?.end({ timeout: 5 }); });

  it("A: a row of the second set moved away while its upsert waits is skipped, the rest land in order", async () => {
    const w = await newWorld(2 * FILING_BATCH_MAX + 20);
    const victim = w.ids[FILING_BATCH_MAX + 9]!;
    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      await rival`select 1 from folder_state where message_id = ${victim}::uuid for update`;
      const decided = new ScreenerService({}).decide(ctx(w.accountId), w.ids[0]!, { decision: "no", scope: "domain" });
      blocked = await waitForLockWait();
      await rival`update folder_state set desired_folder = 'ohmail/News', reconcile_status = 'pending'
                   where message_id = ${victim}::uuid`;
      await rival`commit`;
      await decided;
    } finally {
      rival.release();
    }
    expect(blocked, "the second set's upsert never waited on the rival, so this proved nothing").toBe(true);

    const kept = w.ids.filter((id) => id !== victim);
    const desired = new Map((await db.select({ id: folderState.messageId, d: folderState.desiredFolder })
      .from(folderState).where(inArray(folderState.messageId, w.ids))).map((r) => [r.id, r.d]));
    expect(desired.get(victim)).toBe("ohmail/News");
    for (const id of kept) expect(desired.get(id)).toBe("ohmail/Screened");

    // Every moved letter's move, in the order the decision walked them, and nothing else.
    const log = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    expect(log.filter((r) => r.entityType === "message").map((r) => `${r.op}:${r.entityId}`))
      .toEqual(kept.map((id) => `move:${id}`));
    const seqs = log.map((r) => Number(r.seq));
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);

    // The screen-out marks nothing read: no read intent, every letter's unread as seeded.
    expect(await db.select().from(flagState).where(inArray(flagState.messageId, w.ids))).toEqual([]);
    const unread = new Map((await db.select({ id: messages.id, u: messages.unread }).from(messages)
      .where(eq(messages.accountId, w.accountId))).map((r) => [r.id, r.u]));
    for (const id of w.ids) expect(unread.get(id), id).toBe(w.unread.get(id));
  }, 120_000);

  it("C: a last set the rival took whole still leaves the decision's seq on its idempotency row", async () => {
    const w = await newWorld(FILING_BATCH_MAX + 10);
    const lastSet = w.ids.slice(FILING_BATCH_MAX);
    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      await rival`select 1 from folder_state where message_id = any(${lastSet}::uuid[]) for update`;
      const decided = new ScreenerService({}).decide(ctx(w.accountId), w.ids[0]!, { decision: "no", scope: "domain" },
        { idempotency: { key: `c-${w.accountId}`, requestHash: "c" } });
      blocked = await waitForLockWait();
      await rival`update folder_state set desired_folder = 'ohmail/News' where message_id = any(${lastSet}::uuid[])`;
      await rival`commit`;
      await decided;
    } finally {
      rival.release();
    }
    expect(blocked, "the last set's upsert never waited on the rival, so this proved nothing").toBe(true);
    const log = await db.select({ seq: changeLog.seq, id: changeLog.entityId }).from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    for (const id of lastSet) expect(log.some((r) => r.id === id)).toBe(false);
    const [claim] = await db.select({ seq: idempotencyKeys.seq }).from(idempotencyKeys)
      .where(eq(idempotencyKeys.accountId, w.accountId));
    expect(claim?.seq).toBe(Number(log[log.length - 1]!.seq));
  }, 120_000);

  it("B: on the production driver its round trips grow by set, not by message", async () => {
    const pooled = makePooledDb(PG_TEST_URL);
    await pooled.execute(sql`select 1`); // the connection's own opening is not the decision's
    const trips = async (held: number): Promise<number> => {
      const w = await newWorld(held);
      wire.start();
      await new ScreenerService({}).decide(ctx(w.accountId, pooled), w.ids[0]!, { decision: "no", scope: "domain" });
      const n = wire.read().roundTrips;
      const moved = await db.select({ id: folderState.messageId }).from(folderState)
        .where(and(inArray(folderState.messageId, w.ids), eq(folderState.desiredFolder, "ohmail/Screened")));
      expect(moved).toHaveLength(held);
      return n;
    };
    const small = await trips(200);
    const large = await trips(2000);
    const perSet = (large - small) / (2000 / FILING_BATCH_MAX - 200 / FILING_BATCH_MAX);
    console.log(`round trips: 200 -> ${small}, 2000 -> ${large}, ${perSet.toFixed(2)} a set`);
    expect(perSet).toBeLessThanOrEqual(7);
  }, 240_000);
});
