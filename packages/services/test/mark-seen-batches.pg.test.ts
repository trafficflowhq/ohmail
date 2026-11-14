import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messages, folderState, flagState, changeLog, DECISION_BATCH_MAX } from "@trafficflow/db";
import { schema, makePooledDb, closePooledDbs } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { MessageService, MARK_SEEN_MAX_IDS, type ServiceContext } from "@trafficflow/services";

/**
 * MARK ALL READ WRITTEN IN SETS, ON REAL POSTGRES. Two things PGlite cannot show: a rival that
 * moves a letter of the SECOND set and holds its row while that set's update waits (the set
 * lands whole after the rival commits, the rival's move stands, the change rows keep the order
 * sent), and the production driver's round trips, read off the wire. Reads are scoped to each
 * case's own account; the rows go in `afterEach`.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const made: string[] = [];

const ctx = (accountId: string, handle: unknown = db): ServiceContext => ({
  db: handle as ServiceContext["db"], accountId, userId: null, now: () => new Date(),
  requestId: `mark-seen-${randomUUID().slice(0, 8)}`,
});

/** `letters` letters in INBOX, a third of them already read, in the order a client would send them. */
async function newWorld(letters: number): Promise<{ accountId: string; ids: string[]; unread: Map<string, boolean> }> {
  const accountId = randomUUID();
  made.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `mark-seen-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `mark-seen-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const rows = Array.from({ length: letters }, (_x, i) => ({
    id: randomUUID(), accountId, mailboxId: mb!.id, bodyHash: `b${i}`, dedupKey: `mark-seen:${randomUUID()}`,
    subject: `Note ${i}`, fromAddress: `sender-${i}@corp.test`, unread: i % 3 !== 0,
    date: new Date(Date.UTC(2026, 8, 1) + i * 60_000), nativeLocator: { folder: "INBOX", ref: `1:${i}` },
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await db.insert(messages).values(part);
    await db.insert(folderState).values(part.map((r) => ({
      messageId: r.id, accountId: r.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
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
         and query ilike 'update "messages"%'`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!PG_UP)("mark all read written in sets, on real Postgres", () => {
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
    }
  });
  afterAll(async () => { await closePooledDbs(); await client?.end({ timeout: 5 }); });

  it("A: a letter of the second set moved by a rival while its update waits: the set lands whole, in order", async () => {
    const w = await newWorld(2 * DECISION_BATCH_MAX + 20);
    const victim = w.ids[DECISION_BATCH_MAX + 9]!;
    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      await rival`update messages set updated_at = now() where id = ${victim}::uuid`;
      await rival`update folder_state set desired_folder = 'ohmail/Reads', reconcile_status = 'pending'
                   where message_id = ${victim}::uuid`;
      const marked = new MessageService().markSeen(ctx(w.accountId), { ids: w.ids, unread: false });
      blocked = await waitForLockWait();
      await rival`commit`;
      const answer = await marked;
      expect(answer.items).toHaveLength(w.ids.length);
    } finally {
      rival.release();
    }
    expect(blocked, "the second set's update never waited on the rival, so this proved nothing").toBe(true);

    const rows = new Map((await db.select({ id: messages.id, u: messages.unread }).from(messages)
      .where(eq(messages.accountId, w.accountId))).map((r) => [r.id, r.u]));
    for (const id of w.ids) expect(rows.get(id), id).toBe(false);
    const [moved] = await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, victim));
    expect(moved?.d, "the rival's move stands").toBe("ohmail/Reads");

    const log = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    expect(log.map((r) => `${r.op}:${r.entityId}`)).toEqual(w.ids.map((id) => `update:${id}`));
    const seqs = log.map((r) => Number(r.seq));
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
    const flags = new Map((await db.select().from(flagState).where(inArray(flagState.messageId, w.ids)))
      .map((r) => [r.messageId, r]));
    for (const id of w.ids) {
      expect(flags.get(id)).toMatchObject({ desiredSeen: true, observedSeen: !w.unread.get(id),
        reconcileStatus: w.unread.get(id) ? "pending" : "reconciled" });
    }
  }, 120_000);

  it("B: on the production driver its round trips grow by set, not by letter", async () => {
    const pooled = makePooledDb(PG_TEST_URL);
    await pooled.execute(sql`select 1`); // the connection's own opening is not the request's
    const trips = async (letters: number): Promise<number> => {
      const w = await newWorld(letters);
      wire.start();
      for (let i = 0; i < w.ids.length; i += MARK_SEEN_MAX_IDS) {
        await new MessageService().markSeen(ctx(w.accountId, pooled), { ids: w.ids.slice(i, i + MARK_SEEN_MAX_IDS), unread: false });
      }
      const n = wire.read().roundTrips;
      const all = await db.select({ u: messages.unread }).from(messages).where(eq(messages.accountId, w.accountId));
      expect(all).toHaveLength(letters);
      expect(all.filter((r) => r.u)).toHaveLength(0);
      return n;
    };
    const small = await trips(200);
    const large = await trips(2000);
    const perSet = (large - small) / (2000 / DECISION_BATCH_MAX - 200 / DECISION_BATCH_MAX);
    console.log(`round trips: 200 -> ${small}, 2000 -> ${large}, ${perSet.toFixed(2)} a set`);
    expect(perSet).toBeLessThanOrEqual(9);
  }, 240_000);
});
