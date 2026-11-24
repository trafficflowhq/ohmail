import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
/* From the BARREL: the sqlite project substitutes the schema at `./schema-mail.js` inside `src`,
   so a relative import of the schema from here would keep the server's column types. */
import {
  accounts, accountSyncState, auditLog, changeLog, devices, seqBounds, sessions, users, type Tx,
} from "../src/index.js";
import {
  AUDIT_LOG_RETENTION_MS, CHANGE_LOG_HOLDBACK_LIVE_MS, CHANGE_LOG_RETENTION_GRACE_MS,
  pruneAuditLog, pruneChangeLogForAccount,
} from "../src/change-log-retention.js";

/**
 * THE MAIL HALF OF RETENTION ON BOTH STORES — the local engine runs it on a desktop's PGlite and
 * a phone's SQLite, so the same cases the server's file pins (`retention-prune.pg.test.ts`) run
 * here through `makeTestDb`, in the default project and in `test/vitest.sqlite.config.ts`. The server
 * spelling (`::timestamptz`, `greatest`, `bool_or`, `->>`, a raw `execute`) is what the device store
 * refused; each went behind the dialect seam or a builder both stores run.
 */
const NOW = new Date("2026-09-01T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number): Date => new Date(NOW.getTime() - daysAgo * DAY);

type Db = Awaited<ReturnType<typeof makeTestDb>>;
interface Row { seq: number; id: string; op: "create" | "update" | "move" | "delete"; ageDays: number; meta?: Record<string, string> }

async function seedAccount(db: Db, nextSeq: number): Promise<string> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId });
  await db.insert(accountSyncState).values({ accountId, nextSeq: BigInt(nextSeq) });
  return accountId;
}

async function plant(db: Db, accountId: string, rows: Row[]): Promise<void> {
  for (const r of rows) {
    await db.insert(changeLog).values({
      accountId, seq: BigInt(r.seq), entityType: "message", entityId: r.id,
      op: r.op, meta: r.meta ?? null, createdAt: at(r.ageDays),
    });
  }
}

async function remaining(db: Db, accountId: string): Promise<number[]> {
  const rows = await db.select({ seq: changeLog.seq }).from(changeLog)
    .where(eq(changeLog.accountId, accountId)).orderBy(changeLog.seq);
  return rows.map((r) => Number(r.seq));
}

describe("the change log's retention, on this store", () => {
  it("compacts below the floor: churn and dead entities go, first rows and user-wins moves stay", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, 8);
    const [m1, m2, m3, m4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await plant(db, accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 60 },
      { seq: 2, id: m1, op: "update", ageDays: 60 },
      { seq: 3, id: m2, op: "create", ageDays: 60 },
      { seq: 4, id: m2, op: "delete", ageDays: 60 },
      { seq: 5, id: m3, op: "create", ageDays: 60 },
      { seq: 6, id: m3, op: "move", ageDays: 60, meta: { from: "PAPERTRAIL", to: "INBOX" } },
      { seq: 7, id: m4, op: "create", ageDays: 1 },
      { seq: 8, id: m1, op: "update", ageDays: 1 },
    ]);
    const r = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW);
    expect(r).toEqual({ prunedThroughSeq: 6n, deleted: 3 });
    expect(await remaining(db, accountId)).toEqual([1, 5, 6, 7, 8]);
    expect(await seqBounds(db as unknown as Tx, accountId)).toEqual({ min: 1n, max: 8n, prunedThrough: 6n });
    expect(await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW))
      .toEqual({ prunedThroughSeq: 6n, deleted: 0 });
  });

  it("a fresh device and a live session hold the horizon; a stale device holds nothing", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, 5);
    const [u] = await db.insert(users).values({ accountId, email: `r-${accountId}@tf.test` }).returning();
    await db.insert(devices).values([
      { accountId, userId: u!.id, kind: "web", createdAt: at(300), lastSeenAt: at(10), lastSyncedAt: at(10) },
      { accountId, userId: u!.id, kind: "web", createdAt: at(300), lastSeenAt: at(200), lastSyncedAt: at(200) },
    ]);
    const m1 = randomUUID();
    await plant(db, accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 60 },
      { seq: 2, id: m1, op: "update", ageDays: 60 },
      { seq: 3, id: m1, op: "update", ageDays: 5 },
    ]);
    // Horizon = the fresh stamp (10 d) - 30 d grace = 40 d ago.
    expect(await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW))
      .toEqual({ prunedThroughSeq: 2n, deleted: 1 });

    const held = await seedAccount(db, 2);
    const [u2] = await db.insert(users).values({ accountId: held, email: `s-${held}@tf.test` }).returning();
    await db.insert(sessions).values({
      accountId: held, userId: u2!.id, familyId: randomUUID(),
      accessExpiresAt: new Date(NOW.getTime() + DAY), refreshExpiresAt: new Date(NOW.getTime() + 30 * DAY),
      createdAt: at(70), lastSyncedAt: at(50),
    });
    const m2 = randomUUID();
    await plant(db, held, [
      { seq: 1, id: m2, op: "create", ageDays: 100 },
      { seq: 2, id: m2, op: "update", ageDays: 60 },
    ]);
    // Horizon = the session's stamp (50 d) - 30 d = 80 d: seq 1 falls, seq 2 is held.
    expect((await pruneChangeLogForAccount(db as unknown as Tx, held, NOW)).prunedThroughSeq).toBe(1n);
    expect(await remaining(db, held)).toEqual([1, 2]);
    expect([CHANGE_LOG_RETENTION_GRACE_MS, CHANGE_LOG_HOLDBACK_LIVE_MS]).toEqual([30 * DAY, 90 * DAY]);
  });

  it("one batch takes `batch` rows, and the account's newest row is never one", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, 6);
    const m1 = randomUUID();
    await plant(db, accountId, [1, 2, 3, 4, 5, 6].map((seq) => (
      { seq, id: m1, op: seq === 1 ? "create" as const : "update" as const, ageDays: 60 })));
    const first = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW, { batch: 2, maxBatches: 1 });
    expect(first).toEqual({ prunedThroughSeq: 6n, deleted: 2 });
    expect(await remaining(db, accountId)).toEqual([1, 4, 5, 6]);
    await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW, { batch: 2, maxBatches: 5 });
    expect(await remaining(db, accountId)).toEqual([1, 6]);
  });

  it("a younger log than the grace is left whole, and its floor stays 0", async () => {
    const db = await makeTestDb();
    const accountId = await seedAccount(db, 3);
    const m1 = randomUUID();
    await plant(db, accountId, [
      { seq: 1, id: m1, op: "create", ageDays: 20 },
      { seq: 2, id: m1, op: "update", ageDays: 20 },
      { seq: 3, id: m1, op: "update", ageDays: 20 },
    ]);
    expect(await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW))
      .toEqual({ prunedThroughSeq: 0n, deleted: 0 });
    expect(await remaining(db, accountId)).toEqual([1, 2, 3]);
  });

  it("audit_log ages out on its horizon, one bounded batch at a time", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(auditLog).values([
      { accountId, action: "workflow_step", createdAt: at(400) },
      { accountId, action: "workflow_step", createdAt: at(380) },
      { accountId, action: "workflow_step", createdAt: at(10) },
    ]);
    expect(await pruneAuditLog(db as unknown as Tx, NOW, AUDIT_LOG_RETENTION_MS, 1)).toBe(1);
    expect(await pruneAuditLog(db as unknown as Tx, NOW, AUDIT_LOG_RETENTION_MS, 100)).toBe(1);
    const left = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(left.map((a) => new Date(a.createdAt).getTime())).toEqual([at(10).getTime()]);
  });
});
