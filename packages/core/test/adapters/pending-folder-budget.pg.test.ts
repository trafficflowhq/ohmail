import { accountOfMessage } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, messages, folderState, flagState } from "@trafficflow/db";
import { makeOwnedDb, schema, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";

/**
 * THE FILING QUEUE HAS A BUDGET, AND A BUDGET WITHOUT AN ORDER IS A QUEUE THAT STARVES.
 *
 * `listPendingFolderStates` had no limit for its whole life. One production screening session left
 * a long queue of rows pending and `reconcileFolders` drained every one of them inside the worker's SERIAL
 * cycle — minutes during which every other mailbox received no mail. The reconciler now
 * asks for {@link RECONCILE_MOVES_PER_CYCLE} rows and re-kicks, which turns that monopoly into a
 * rotation.
 *
 * ── WHY REAL POSTGRES, AND WHY THIS FILE CANNOT BE A PGlite TEST ────────────────────────────
 *
 * A LIMIT with no ORDER BY reads PostgreSQL's PHYSICAL row order, which moves under UPDATE and
 * VACUUM — so the same rows could be handed over pass after pass while the rest waited for
 * ever, and the mailbox would look like it was filing while making no progress. **PGlite returns
 * stable insertion order**, so under it an unordered LIMIT looks perfectly fair and this whole
 * class of defect is invisible; the repository has already been caught by exactly this once, in
 * `listRules`, where physical order made one message route differently on different days.
 *
 * The rows below are therefore inserted OUT of desired-state order and then UPDATEd, which is what
 * moves a tuple in a heap. The assertion is that the oldest desired state still comes first.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("listPendingFolderStates — the reconciler's budget", () => {
  let owned: OwnedDb;
  let accountId: string;
  let mailboxId: string;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `budget-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@budget.test` }).returning();
    mailboxId = mb!.id;
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /**
   * `n` pending moves whose `updated_at` runs oldest-first by INDEX, inserted in an order that
   * does not match, then churned so the heap order matches neither.
   */
  async function seed(n: number): Promise<string[]> {
    const ids: string[] = [];
    const base = Date.UTC(2026, 0, 1);
    // Insert back-to-front, so insertion order is the REVERSE of desired-state order.
    for (let i = n - 1; i >= 0; i--) {
      const [row] = await owned.db.insert(messages).values({
        accountId, mailboxId,
        messageIdHeader: `budget-${i}@x`,
        bodyHash: `hash-${i}`,
        dedupKey: `dedup-${randomUUID()}`,
        subject: `budget ${i}`,
        fromAddress: "anna@example.com",
        date: new Date(base + i * 1000),
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${100 + i}` },
      }).returning({ id: messages.id });
      ids[i] = row!.id;
      await owned.db.insert(folderState).values({
        messageId: row!.id, accountId: accountOfMessage(row!.id), desiredFolder: "INBOX", observedFolder: "ohmail/Screener",
        lastSetBy: "us", reconcileStatus: "pending", conflict: false,
        updatedAt: new Date(base + i * 1000),
      });
    }
    // Churn: an UPDATE rewrites the tuple at the end of the heap, so physical order after this is
    // neither insertion order nor `updated_at` order. This is the step PGlite cannot reproduce.
    for (let i = 0; i < n; i += 3) {
      await owned.db.update(folderState)
        .set({ conflict: false })
        .where(sql`${folderState.messageId} = ${ids[i]}`);
    }
    return ids;
  }

  it("returns the OLDEST desired states first, and exactly `limit` of them", async () => {
    const ids = await seed(30);
    const repo = makeDrizzleRepo(owned.db);

    const page = await repo.listPendingFolderStates(mailboxId, 10);

    expect(page).toHaveLength(10);
    // The mail somebody filed FIRST reaches their server first — and, more to the point, the rows
    // this pass skips are a suffix, so the next pass makes progress instead of re-serving these.
    expect(page.map((p) => p.messageId)).toEqual(ids.slice(0, 10));
  });

  it("is stable across passes, so a budgeted queue drains instead of re-serving its head", async () => {
    const repo = makeDrizzleRepo(owned.db);
    const first = await repo.listPendingFolderStates(mailboxId, 10);
    const again = await repo.listPendingFolderStates(mailboxId, 10);
    expect(again.map((p) => p.messageId)).toEqual(first.map((p) => p.messageId));

    // …and once the head is settled the next page is the CONTINUATION, not the same rows.
    for (const p of first) {
      await repo.upsertFolderState(p.messageId, {
        desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us",
      });
    }
    const next = await repo.listPendingFolderStates(mailboxId, 10);
    expect(next).toHaveLength(10);
    expect(next.map((p) => p.messageId)).not.toEqual(first.map((p) => p.messageId));
    expect(first.map((p) => p.messageId)).not.toContain(next[0]!.messageId);
  });

  it("without a limit it still answers everything, so no other caller changes behaviour", async () => {
    const repo = makeDrizzleRepo(owned.db);
    const all = await repo.listPendingFolderStates(mailboxId);
    expect(all.length).toBe(20);   // the ten settled above are no longer pending
  });
});

/**
 * MAIL 0181: each queue's poll reads a partial index of its pending rows, entered at the mailbox's
 * account and in its ORDER BY, instead of every row of the table (16–34 polls a minute on Cloud,
 * almost all answering nothing) or every account's queue. The repo's own statements, captured by
 * drizzle's logger and EXPLAINed with their own parameters; scans and sorts priced out, so the plan
 * names the index only when its predicate and order serve the read. The device stores' half is
 * `reconcile-pending-index-dialect.test.ts`.
 */
describe.skipIf(!AVAILABLE)("mail 0181 — the reconcile polls ride their pending indexes", () => {
  const client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
  const logged: Array<{ query: string; params: unknown[] }> = [];
  const db = brandDialect(drizzle(client, {
    schema, logger: { logQuery: (query, params) => { logged.push({ query, params }); } },
  }), "pg");
  let mailboxId: string;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `queue-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${accountId}@queue.test` }).returning();
    mailboxId = mb!.id;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `d:${randomUUID()}`, fromAddress: "a@example.com",
      nativeLocator: { folder: "INBOX", ref: "1:1" },
    }).returning({ id: messages.id });
    await db.insert(folderState).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: "INBOX", observedFolder: "Junk", lastSetBy: "us" });
    await db.insert(flagState).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), desiredSeen: true, observedSeen: false, lastSetBy: "us" });
  }, 180_000);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  const planOf = async (table: string, read: () => Promise<unknown[]>): Promise<string> => {
    logged.length = 0;
    expect(await read()).toHaveLength(1);
    const s = logged.find((l) => l.query.includes(`from "${table}"`))!;
    const rows = await client.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_sort = off`;
      return tx.unsafe(`explain ${s.query}`, s.params as never[]);
    });
    return rows.map((r) => String(Object.values(r)[0])).join("\n");
  };

  it("listPendingFolderStates reads folder_state_pending_queue_idx at the mailbox's account, in queue order", async () => {
    const plan = await planOf("folder_state", () => makeDrizzleRepo(db).listPendingFolderStates(mailboxId, 11));
    expect(plan).toContain("Index Scan using folder_state_pending_queue_idx on folder_state");
    expect(plan).toMatch(/Index Cond: \(account_id = /);
    expect(plan).not.toMatch(/\bSort\b/);
    const [ix] = await client`select indexdef from pg_indexes where indexname = 'folder_state_pending_queue_idx'`;
    expect(ix!.indexdef).toContain("(account_id, updated_at, message_id) WHERE (reconcile_status = 'pending'::text)");
  });

  it("listPendingFlagStates reads flag_state_pending_queue_idx at the mailbox's account, in queue order", async () => {
    const plan = await planOf("flag_state", () => makeDrizzleRepo(db).listPendingFlagStates(mailboxId, 11));
    expect(plan).toContain("Index Scan using flag_state_pending_queue_idx on flag_state");
    expect(plan).toMatch(/Index Cond: \(account_id = /);
    expect(plan).not.toMatch(/\bSort\b/);
    const [ix] = await client`select indexdef from pg_indexes where indexname = 'flag_state_pending_queue_idx'`;
    expect(ix!.indexdef).toContain("(account_id, updated_at, message_id) WHERE (reconcile_status = 'pending'::text)");
  });
});
