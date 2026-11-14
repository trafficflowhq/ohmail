import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { folderState, mailboxes, messages, recordChange } from "@trafficflow/db";
import { schema, pruneChangeLogForAccount } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { syncService } from "@trafficflow/services";
import type { ServiceContext, SyncChange } from "@trafficflow/services";
import { ClientMirror, flatten } from "./_apply-harness.js";

/**
 * THE RETENTION FLOOR AT THE SERVICE — the 410 arm made LIVE, and what a pruned log still serves.
 *
 * `sync-cursor-ceiling.pg.test.ts` is this file's twin for the other end of the window. Here the
 * retention pass (`@trafficflow/db/cloud`'s `retention.ts`) has actually run, so three things are
 * measured that were unmeasurable while nothing pruned:
 *
 *  1. **A cursor below `pruned_through_seq` answers 410** — the arm the review called dead code.
 *     Without the explicit floor it cannot fire here at all: compaction RETAINS each live
 *     entity's first row, so `min(seq)` stays at 1 and the min-based belt sees nothing, while
 *     the deleted rows in between are exactly what that cursor would silently never receive.
 *  2. **A cursor at the floor replays exactly** — the floor is "seen everything at or below",
 *     not "seen everything below", and an off-by-one here re-bootstraps every healthy client.
 *  3. **`since=0` after pruning is still a COMPLETE bootstrap** — the desktop Cloud mirror's
 *     whole-feed replay converges on every live entity, because compaction keeps first rows.
 *     This is the invariant that forbids naive truncation, measured at the surface that needs it.
 *
 * MUTATION-WATCHED: the floor arm in `sync-service.ts#getChanges`
 * (`prunedThrough > 0n && sinceSeq < prunedThrough`) — removed, case 1's `rejects` resolves with
 * a 200 that silently omits the pruned update, which is the data-loss shape the arm exists for.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-09-01T12:00:00.000Z");
const DAY = 86_400_000;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "retention-floor",
});

async function seedAccount(): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `floor-${accountId}@tf.example`,
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

/** One committed message + its `change_log` create, the way the worker does it. */
async function commitMessage(
  accountId: string, mailboxId: string, tag: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [m] = await tx.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `floor:${tag}`,
      subject: tag, fromAddress: "anna@x.example", date: new Date(NOW.getTime() - DAY),
      nativeLocator: { folder: "INBOX", ref: `1:${tag}` },
    }).returning();
    await tx.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    await recordChange(tx, {
      accountId, entityType: "message", entityId: m!.id, op: "create", meta: null,
    });
    return m!.id;
  });
}

/** A committed non-create change for an existing message — the churn compaction removes. */
async function commitUpdate(accountId: string, messageId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await recordChange(tx, {
      accountId, entityType: "message", entityId: messageId, op: "update", meta: null,
    });
  });
}

/** Age every row of the account past the horizon (`created_at` is stamped at insert). */
async function ageAll(accountId: string): Promise<void> {
  await db.execute(sql`
    update change_log set created_at = ${new Date(NOW.getTime() - 60 * DAY).toISOString()}::timestamptz
     where account_id = ${accountId}`);
}

/** A whole snapshot walk, the way a window bootstraps; returns the `asOfSeq` it states. */
async function snapshotAsOf(accountId: string): Promise<number> {
  let cursor: string | undefined;
  let asOfSeq = -1;
  for (let guard = 0; ; guard += 1) {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 5, ...(cursor ? { cursor } : {}) });
    if (asOfSeq === -1) asOfSeq = page.asOfSeq;
    if (page.nextCursor === null) return asOfSeq;
    cursor = page.nextCursor;
    if (guard > 50) throw new Error("snapshot walk did not terminate");
  }
}

describe.skipIf(!PG_UP)("the /sync retention floor (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("prune → a stale cursor 410s, the floor cursor replays exactly, and since=0 stays complete", async () => {
    const { accountId, mailboxId } = await seedAccount();
    const m1 = await commitMessage(accountId, mailboxId, `m1-${accountId}`); // seq 1
    const m2 = await commitMessage(accountId, mailboxId, `m2-${accountId}`); // seq 2
    await commitUpdate(accountId, m1);                                       // seq 3 — churn
    const m3 = await commitMessage(accountId, mailboxId, `m3-${accountId}`); // seq 4 — young

    // Age seqs 1–3 past the horizon (`created_at` is stamped at insert; retention reads age).
    await db.execute(sql`
      update change_log set created_at = ${new Date(NOW.getTime() - 60 * DAY).toISOString()}::timestamptz
       where account_id = ${accountId} and seq <= 3`);

    const pruned = await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW);
    expect(pruned.prunedThroughSeq).toBe(3n);
    expect(pruned.deleted).toBe(1); // exactly the churn row; both creates stay

    // 1 — BELOW the floor: the rows in (2, 3] are gone, so the answer is 410, never a silent gap.
    await expect(syncService.getChanges(ctx(accountId), { since: syncService.encodeCursor(2n) }))
      .rejects.toMatchObject({ code: "cursor_expired", httpStatus: 410 });

    // 2 — AT the floor: everything at or below is claimed seen, everything above is retained.
    const atFloor = await syncService.getChanges(ctx(accountId), { since: syncService.encodeCursor(3n) });
    const ids = flatten(atFloor).map((c) => c.id);
    expect(ids).toEqual([m3]);
    expect(atFloor.hasMore).toBe(false);

    // 3 — THE RECOVERY the 410 points at: a full since=0 replay (the desktop mirror's bootstrap
    //     shape) converges on every live message, because compaction kept each first row.
    const mirror = new ClientMirror();
    let since = "0";
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getChanges(ctx(accountId), { since, limit: 2 });
      mirror.applyChanges(flatten(page) as SyncChange[]);
      since = page.cursor;
      if (!page.hasMore) break;
      if (guard > 50) throw new Error("bootstrap replay did not terminate");
    }
    const live = mirror.snapshot();
    for (const id of [m1, m2, m3]) {
      expect(live.has(`message:${id}`), `message ${id} missing from the re-bootstrapped mirror`).toBe(true);
    }

    // …and the healed cursor keeps working: the steady-state poll is an empty 200, not a 410.
    const idle = await syncService.getChanges(ctx(accountId), { since });
    expect(flatten(idle)).toHaveLength(0);
    expect(idle.cursor).toBe(since);

    // The messages themselves were never the prune's to touch.
    const rows = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId));
    expect(rows.map((r) => r.id).sort()).toEqual([m1, m2, m3].sort());
  });

  it("an idle account after the prune: the caught-up cursor and each snapshot's cursor resume", async () => {
    // The last change is a month old and churn, so the floor lands on the newest row. Before
    // the fix the prune deleted it: the caught-up cursor read 410 "ahead", and every snapshot
    // stated asOfSeq 2 under floor 3, so its own cursor read 410 on every drain.
    const { accountId, mailboxId } = await seedAccount();
    const m1 = await commitMessage(accountId, mailboxId, `i1-${accountId}`); // seq 1
    await commitMessage(accountId, mailboxId, `i2-${accountId}`);            // seq 2
    await commitUpdate(accountId, m1);                                       // seq 3 — newest, churn
    await ageAll(accountId);
    expect((await pruneChangeLogForAccount(db as unknown as Tx, accountId, NOW)).prunedThroughSeq).toBe(3n);

    const caughtUp = await syncService.getChanges(ctx(accountId), { since: syncService.encodeCursor(3n) });
    expect(flatten(caughtUp)).toHaveLength(0);
    expect(caughtUp.cursor).toBe(syncService.encodeCursor(3n));

    for (let round = 0; round < 2; round += 1) {
      const asOf = await snapshotAsOf(accountId);
      expect(asOf).toBe(3);
      const pull = await syncService.getChanges(ctx(accountId), { since: syncService.encodeCursor(BigInt(asOf)) });
      expect(flatten(pull)).toHaveLength(0);
    }
  });

  it("a log an earlier prune left below its floor heals on the next read, with no migration", async () => {
    // What the old predicate did to an idle account: floor raised onto seq 3, then seq 3 deleted.
    // Every door reads the floor as the high-water mark, so each cursor resumes, and a change
    // written afterwards still reaches all three.
    const { accountId, mailboxId } = await seedAccount();
    const m1 = await commitMessage(accountId, mailboxId, `h1-${accountId}`); // seq 1
    const m2 = await commitMessage(accountId, mailboxId, `h2-${accountId}`); // seq 2
    await commitUpdate(accountId, m1);                                       // seq 3
    await db.execute(sql`update account_sync_state set pruned_through_seq = 3 where account_id = ${accountId}`);
    await db.execute(sql`delete from change_log where account_id = ${accountId} and seq = 3`);

    const caughtUp = await syncService.getChanges(ctx(accountId), { since: syncService.encodeCursor(3n) });
    expect(flatten(caughtUp)).toHaveLength(0);
    const asOf = await snapshotAsOf(accountId);
    expect(asOf).toBe(3);
    const afterSnapshot = await syncService.getChanges(ctx(accountId), { since: syncService.encodeCursor(3n) });
    expect(flatten(afterSnapshot)).toHaveLength(0);

    // The desktop mirror's since=0 replay, then two steady polls: none of them a 410.
    const mirror = new ClientMirror();
    let since = "0";
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getChanges(ctx(accountId), { since, limit: 1 });
      mirror.applyChanges(flatten(page) as SyncChange[]);
      since = page.cursor;
      if (!page.hasMore) break;
      if (guard > 50) throw new Error("bootstrap replay did not terminate");
    }
    for (let poll = 0; poll < 2; poll += 1) {
      since = (await syncService.getChanges(ctx(accountId), { since })).cursor;
    }
    for (const id of [m1, m2]) expect(mirror.snapshot().has(`message:${id}`)).toBe(true);

    const m3 = await commitMessage(accountId, mailboxId, `h3-${accountId}`); // seq 4
    for (const cursor of [syncService.encodeCursor(3n), since]) {
      const next = await syncService.getChanges(ctx(accountId), { since: cursor });
      expect(flatten(next).map((c) => c.id)).toEqual([m3]);
    }
  });

  it("an unpruned account is untouched by the arm: floor 0 never 410s a legitimate cursor", async () => {
    const { accountId, mailboxId } = await seedAccount();
    await commitMessage(accountId, mailboxId, `q1-${accountId}`); // seq 1
    const m2 = await commitMessage(accountId, mailboxId, `q2-${accountId}`); // seq 2
    const page = await syncService.getChanges(ctx(accountId), { since: syncService.encodeCursor(1n) });
    expect(flatten(page).map((c) => c.id)).toEqual([m2]);
  });
});
