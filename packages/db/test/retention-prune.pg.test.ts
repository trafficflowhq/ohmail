import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, sql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { schema } from "../src/schema.js";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { accounts, accountSyncState, auditLog, changeLog, devices, sessions, users } from "../src/schema-mail.js";
import { authEvents, connectAttempts } from "../src/schema-cloud.js";
import { seqBounds, type Tx } from "../src/change-log.js";
import {
  pruneChangeLogForAccount, pruneAuditLog, pruneAuthEvents, pruneConnectAttempts,
  CHANGE_LOG_RETENTION_GRACE_MS, CHANGE_LOG_HOLDBACK_LIVE_MS,
  AUDIT_LOG_RETENTION_MS, AUTH_EVENTS_RETENTION_MS, CONNECT_ATTEMPTS_RETENTION_MS,
} from "../src/retention.js";

/**
 * THE RETENTION PASS ON REAL POSTGRES — what it deletes, what it may NEVER delete, and the floor.
 *
 * The window-function DELETE and the correlated floor UPDATE are raw SQL a PGlite single
 * connection would also run, but the subjects here are the deletion PREDICATE and the horizon
 * ARITHMETIC, and both are asserted against rows this file plants with explicit seqs and ages.
 *
 * MUTATION-WATCHED (via kit/mutate/mutation-control.sh, red then restored):
 *  - the holdback line in `retention.ts#changeLogHorizon` (`where x >= liveAfter`): without it a
 *    200-day-stale device drags the horizon to nothing and "two devices, one stale" reads
 *    floor 0 instead of the fresh device's floor;
 *  - the user-wins exemption in `pruneChangeLogForAccount`: without it the move-to-INBOX row is
 *    deleted and the exemption case goes red.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-09-01T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number): Date => new Date(NOW.getTime() - daysAgo * DAY);

/** An account with a counter row, no clients — the horizon is `now - grace` exactly. */
async function seedAccount(nextSeq: number): Promise<string> {
  const accountId = randomUUID();
  await db.insert(accountSyncState).values({ accountId, nextSeq: BigInt(nextSeq) });
  return accountId;
}

interface Row {
  seq: number;
  type?: string;
  id: string;
  op: "create" | "update" | "move" | "delete";
  ageDays: number;
  meta?: Record<string, string> | null;
}

async function plant(accountId: string, rows: Row[]): Promise<void> {
  for (const r of rows) {
    await db.insert(changeLog).values({
      accountId, seq: BigInt(r.seq), entityType: r.type ?? "message", entityId: r.id,
      op: r.op, meta: r.meta ?? null, createdAt: at(r.ageDays),
    });
  }
}

async function remainingSeqs(accountId: string): Promise<number[]> {
  const rows = await db.select({ seq: sql<string>`${changeLog.seq}::text` }).from(changeLog)
    .where(eq(changeLog.accountId, accountId)).orderBy(changeLog.seq);
  return rows.map((r) => Number(r.seq));
}

describe.skipIf(!PG_UP)("the retention pass (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("compacts below the floor: churn and dead entities go, first rows and user-wins moves stay", async () => {
    const accountId = await seedAccount(8);
    const m1 = randomUUID(); const m2 = randomUUID(); const m3 = randomUUID(); const m4 = randomUUID();
    await plant(accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 60 },              // first row, alive → KEPT
      { seq: 2, id: m1, op: "update", ageDays: 60 },              // churn → deleted
      { seq: 3, id: m2, op: "create", ageDays: 60 },              // dead entity → deleted
      { seq: 4, id: m2, op: "delete", ageDays: 60 },              // tombstone → deleted
      { seq: 5, id: m3, op: "create", ageDays: 60 },              // first row, alive → KEPT
      // USER ALWAYS WINS — the ohbox-tidy probe's row. Churn by the rn rule, EXEMPT by name.
      { seq: 6, id: m3, op: "move", ageDays: 60, meta: { from: "PAPERTRAIL", to: "INBOX" } },
      { seq: 7, id: m4, op: "create", ageDays: 1 },               // above the horizon → untouched
      { seq: 8, id: m1, op: "update", ageDays: 1 },               // above the horizon → untouched
    ]);

    const r = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW);
    expect(r.prunedThroughSeq).toBe(6n);
    expect(r.deleted).toBe(3);
    expect(await remainingSeqs(accountId)).toEqual([1, 5, 6, 7, 8]);

    // The floor reaches the reader every resuming /sync goes through.
    const bounds = await seqBounds(db as unknown as Tx, accountId);
    expect(bounds).toEqual({ min: 1n, max: 8n, prunedThrough: 6n });

    // The exempt row is still exactly what the tidy probe's NOT EXISTS matches.
    const [probe] = await db.select({ n: sql<number>`count(*)::int` }).from(changeLog).where(sql`
      ${changeLog.accountId} = ${accountId} and ${changeLog.entityId} = ${m3}
      and ${changeLog.op} = 'move' and ${changeLog.meta} ->> 'to' = 'INBOX'`);
    expect(probe!.n).toBe(1);

    // Idempotent: a second tick re-derives no victims and moves nothing.
    const again = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW);
    expect(again).toEqual({ prunedThroughSeq: 6n, deleted: 0 });
    expect(await remainingSeqs(accountId)).toEqual([1, 5, 6, 7, 8]);
  });

  it("two devices, one stale: the fresh one holds the horizon at its stamp, the stale one holds nothing", async () => {
    const accountId = await seedAccount(5);
    await db.insert(accounts).values({ id: accountId });
    const [u] = await db.insert(users).values({
      accountId, email: `retention-${accountId}@tf.example`,
    }).returning();
    // The fresh device drained 10 days ago; the stale one 200 days ago — outside the 90-day
    // holdback window, so it must not drag the horizon to 230 days.
    await db.insert(devices).values([
      { accountId, userId: u!.id, kind: "web", createdAt: at(300), lastSeenAt: at(10), lastSyncedAt: at(10) },
      { accountId, userId: u!.id, kind: "web", createdAt: at(300), lastSeenAt: at(200), lastSyncedAt: at(200) },
    ]);
    const m1 = randomUUID(); const m2 = randomUUID();
    await plant(accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 60 },
      { seq: 2, id: m1, op: "update", ageDays: 60 },  // the only victim below the floor
      { seq: 3, id: m1, op: "update", ageDays: 5 },
      { seq: 4, id: m2, op: "create", ageDays: 30 },  // younger than the fresh stamp - grace → retained
      { seq: 5, id: m2, op: "delete", ageDays: 30 },  // tombstone ABOVE the floor → retained
    ]);

    // Horizon = (fresh stamp, 10 d ago) - 30 d grace = 40 d ago. Only seqs 1-2 are older.
    const r = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW);
    expect(r.prunedThroughSeq).toBe(2n);
    expect(r.deleted).toBe(1);
    expect(await remainingSeqs(accountId)).toEqual([1, 3, 4, 5]);

    // The constants this arithmetic is stated in — a drive-by change to either is a red here.
    expect(CHANGE_LOG_RETENTION_GRACE_MS).toBe(30 * DAY);
    expect(CHANGE_LOG_HOLDBACK_LIVE_MS).toBe(90 * DAY);
  });

  it("a live unexpired session holds the horizon the same way a device does", async () => {
    const accountId = await seedAccount(2);
    await db.insert(accounts).values({ id: accountId });
    const [u] = await db.insert(users).values({
      accountId, email: `retention-s-${accountId}@tf.example`,
    }).returning();
    await db.insert(sessions).values({
      accountId, userId: u!.id, familyId: randomUUID(),
      accessExpiresAt: new Date(NOW.getTime() + DAY), refreshExpiresAt: new Date(NOW.getTime() + 30 * DAY),
      createdAt: at(70), lastSyncedAt: at(50),
    });
    const m1 = randomUUID();
    await plant(accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 100 },
      { seq: 2, id: m1, op: "update", ageDays: 60 }, // younger than (stamp 50 d) + grace 30 d = 80 d → held
    ]);
    // Horizon = 50 d stamp - 30 d grace = 80 d ago: seq 1 falls, seq 2 is HELD by the session.
    const r = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW);
    expect(r.prunedThroughSeq).toBe(1n);
    expect(await remainingSeqs(accountId)).toEqual([1, 2]);
  });

  it("the DELETE is bounded: one batch takes `batch` rows and the next tick finishes the job", async () => {
    const accountId = await seedAccount(6);
    const m1 = randomUUID();
    await plant(accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 60 },
      { seq: 2, id: m1, op: "update", ageDays: 60 },
      { seq: 3, id: m1, op: "update", ageDays: 60 },
      { seq: 4, id: m1, op: "update", ageDays: 60 },
      { seq: 5, id: m1, op: "update", ageDays: 60 },
      { seq: 6, id: m1, op: "update", ageDays: 60 },
    ]);
    const first = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW, { batch: 2, maxBatches: 1 });
    expect(first.prunedThroughSeq).toBe(6n);
    expect(first.deleted).toBe(2);                       // exactly one bounded batch
    expect(await remainingSeqs(accountId)).toEqual([1, 4, 5, 6]);

    const rest = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW, { batch: 2, maxBatches: 5 });
    expect(rest.deleted).toBe(2);
    // The first row, alive, for ever — and the newest, which holds max(seq) at the floor.
    expect(await remainingSeqs(accountId)).toEqual([1, 6]);
  });

  it("an idle account keeps its newest row: max(seq) never falls below the floor", async () => {
    // Nothing written for a month and the last change churn: the floor lands ON the newest row.
    // Deleting it left max 2 under floor 3, and every cursor the account could hand out 410'd.
    const accountId = await seedAccount(3);
    const m1 = randomUUID(); const m2 = randomUUID();
    await plant(accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 60 },
      { seq: 2, id: m2, op: "create", ageDays: 60 },
      { seq: 3, id: m1, op: "update", ageDays: 60 }, // churn, but the account's newest → KEPT
    ]);
    const r = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW);
    expect(r).toEqual({ prunedThroughSeq: 3n, deleted: 0 });
    expect(await remainingSeqs(accountId)).toEqual([1, 2, 3]);
    expect(await seqBounds(db as unknown as Tx, accountId)).toEqual({ min: 1n, max: 3n, prunedThrough: 3n });
  });

  it("a log an earlier prune left below its floor reads the floor as its high-water mark", async () => {
    // The state the old predicate left behind: the newest row gone, the floor above what remains.
    // The read heals it, so no data migration is owed. An unpruned empty log still reads null.
    const accountId = await seedAccount(3);
    await plant(accountId, [
      { seq: 1, id: randomUUID(), op: "create", ageDays: 60 },
      { seq: 2, id: randomUUID(), op: "create", ageDays: 60 },
    ]);
    await db.update(accountSyncState).set({ prunedThroughSeq: 3n })
      .where(eq(accountSyncState.accountId, accountId));
    expect(await seqBounds(db as unknown as Tx, accountId)).toEqual({ min: 1n, max: 3n, prunedThrough: 3n });

    const emptied = await seedAccount(4); // every entity dead: the old pass could empty the log
    await db.update(accountSyncState).set({ prunedThroughSeq: 4n })
      .where(eq(accountSyncState.accountId, emptied));
    expect(await seqBounds(db as unknown as Tx, emptied)).toEqual({ min: null, max: 4n, prunedThrough: 4n });

    const untouched = await seedAccount(0);
    expect(await seqBounds(db as unknown as Tx, untouched)).toEqual({ min: null, max: null, prunedThrough: 0n });
  });

  it("audit_log and auth_events age out on their stated horizons, bounded per batch", async () => {
    const accountId = randomUUID();
    await db.insert(auditLog).values([
      { accountId, action: "workflow_step", createdAt: at(400) },
      { accountId, action: "workflow_step", createdAt: at(380) },
      { accountId, action: "workflow_step", createdAt: at(10) },
    ]);
    // One bounded batch takes exactly one row; the next takes the other expired one.
    expect(await pruneAuditLog(db as unknown as Tx, NOW, AUDIT_LOG_RETENTION_MS, 1)).toBe(1);
    // Drain the rest (a shared database may hold other expired rows; the bound is per batch).
    for (let g = 0; g < 50; g += 1) {
      if (await pruneAuditLog(db as unknown as Tx, NOW, AUDIT_LOG_RETENTION_MS, 100) < 100) break;
    }
    const audits = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(audits.map((a) => a.createdAt.getTime())).toEqual([at(10).getTime()]);

    await db.insert(authEvents).values([
      { accountId, event: "login", at: at(200) },
      { accountId, event: "login", at: at(5) },
    ]);
    for (let g = 0; g < 50; g += 1) {
      if (await pruneAuthEvents(db as unknown as Tx, NOW, AUTH_EVENTS_RETENTION_MS, 100) < 100) break;
    }
    const events = await db.select().from(authEvents).where(eq(authEvents.accountId, accountId));
    expect(events.map((e) => e.at.getTime())).toEqual([at(5).getTime()]);

    // The stated horizons, pinned: shortening either silently is a policy change, not a tweak.
    expect(AUDIT_LOG_RETENTION_MS).toBe(365 * DAY);
    expect(AUTH_EVENTS_RETENTION_MS).toBe(180 * DAY);
  });

  it("connect_attempts ages out at 30 days on its full key, bounded per batch (cloud 0054)", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await db.insert(accounts).values([{ id: mine, name: "ca" }, { id: theirs, name: "cb" }]);
    const row = { door: "connect", preset: "gmail", outcome: "refused", reason: "auth", transport: "imap" } as const;
    await db.insert(connectAttempts).values([
      { ...row, accountId: mine, at: at(31) }, { ...row, accountId: mine, at: at(31) },
      { ...row, accountId: mine, at: at(29) }, { ...row, accountId: theirs, at: at(29) },
    ]);
    // Two rows on one instant differ by `id` alone: one batch of one takes exactly one of them.
    expect(await pruneConnectAttempts(db as unknown as Tx, NOW, CONNECT_ATTEMPTS_RETENTION_MS, 1)).toBe(1);
    for (let g = 0; g < 50; g += 1) {
      if (await pruneConnectAttempts(db as unknown as Tx, NOW, CONNECT_ATTEMPTS_RETENTION_MS, 100) < 100) break;
    }
    const left = await db.select().from(connectAttempts).where(inArray(connectAttempts.accountId, [mine, theirs]));
    expect(left.map((r) => [r.accountId === mine ? "mine" : "theirs", r.at.getTime()]).sort())
      .toEqual([["mine", at(29).getTime()], ["theirs", at(29).getTime()]]);
    expect(CONNECT_ATTEMPTS_RETENTION_MS).toBe(30 * DAY);
  });
});
