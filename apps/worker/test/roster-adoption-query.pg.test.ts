import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { loadEnabledMailboxes } from "../src/mailboxes.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THE ROSTER QUERY IS NOT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The gap listed four candidate mechanisms, and three of them live in this one function: a
 * boot-time snapshot, a filter a brand-new row fails (`last_sync_at IS NOT NULL`, an
 * `updated_at` watermark, a lease column), and a shard hash computed over a set fixed at boot.
 * This file eliminates all three against REAL Postgres, which is the only place they could be
 * eliminated: `sync-stamp.pg.test.ts` records the precedent — a `coalesce(...)` fragment that
 * PGlite bound happily and postgres-js did not, green in the unit suite while every production
 * alert pass died.
 *
 * The row seeded here is the one the adoption fix measured, column for column: `status='connected'`,
 * `last_sync_at` NULL, no `error_code`, not quarantined, no kickstart mark, billing
 * `trialing` with `mailbox_limit 5`, one shard. Nothing in it explains an omission, which is
 * the gap's own sentence — and after this file that sentence is a proven fact about the query
 * rather than an inference from the row.
 *
 * The real mechanism is scheduling, not selection, and it is in `apps/worker/src/index.ts`:
 * this query is starved by the cycle it shares a serial queue with. See
 * `roster-preemption.e2e.test.ts`.
 */
const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("the roster query returns a mailbox created after it last ran", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  /** An account, and one mailbox in the exact state the gap reported. */
  const seed = async (): Promise<{ accountId: string; mailboxId: string }> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `adopt-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `adopt-${accountId.slice(0, 8)}@example.test`,
      status: "connected",
    }).returning();
    return { accountId, mailboxId: mb!.id };
  };

  const idsOf = async (): Promise<Set<string>> =>
    new Set((await loadEnabledMailboxes(db as never)).map((m) => m.mailboxId));

  it("is a live read: a row inserted between two calls is in the second", async () => {
    const before = await idsOf();
    const fresh = await seed();
    expect(before.has(fresh.mailboxId)).toBe(false);
    // NO restart, no new handle, no cache invalidation — the same `db` that just answered
    // without this row. A snapshot taken at boot could not produce this.
    expect((await idsOf()).has(fresh.mailboxId)).toBe(true);
  }, 30_000);

  it("returns a mailbox that has never synced, and reports it as unsynced rather than omitting it", async () => {
    const fresh = await seed();
    const rows = await loadEnabledMailboxes(db as never);
    const row = rows.find((m) => m.mailboxId === fresh.mailboxId);
    // The three columns a "brand-new row fails a filter" mechanism would have keyed on. They
    // are all in the null/absent state, and the row is selected anyway.
    expect(row).toBeDefined();
    expect(row!.status).toBe("connected");
    expect(row!.takeoverAuthorizedAt).toBeNull();
    expect(row!.disabledReason).toBeNull();
    expect(row!.syncBlockedReason).toBeNull();
    // …and `last_sync_at` is not even in the projection, so it CANNOT be filtered on.
    expect(Object.keys(row!)).not.toContain("lastSyncAt");
  }, 30_000);

  it("NOBODY is parked when no reader says so, and the reader is what parks", async () => {
    // THE SEAM, in both directions. The roster's own query knows nothing about standing: an
    // absent reader means nobody is parked, which is the whole of the self-hosted and desktop
    // answer and the reason the reader is optional rather than defaulted.
    const fresh = await seed();
    const open = await loadEnabledMailboxes(db as never);
    expect(open.some((m) => m.mailboxId === fresh.mailboxId)).toBe(true);

    // …and a reader that names the account DOES drop it, which is what makes the assertion
    // above evidence rather than a query that selects everything. The reader is handed the
    // account ids the query found and answers with the subset that may not sync.
    const asked: string[][] = [];
    const parked = await loadEnabledMailboxes(
      db as never, {}, new Date(),
      async (ids) => { asked.push([...ids]); return new Set([fresh.accountId]); },
    );
    expect(parked.some((m) => m.mailboxId === fresh.mailboxId)).toBe(false);
    // The reader was consulted ONCE, with the whole roster's accounts — a per-mailbox call would
    // be one network hop per mailbox on a metered deployment.
    expect(asked).toHaveLength(1);
    expect(asked[0], "the reader was not asked about the account it must park")
      .toContain(fresh.accountId);
  }, 30_000);

  it("the shard predicate is evaluated per row per call, so a new row lands in exactly one shard", async () => {
    const fresh = await seed();
    // `hashtext` is a Postgres-internal function and this is the only place its behaviour is
    // exercised against the real server. Every shard is asked; the row is in one of them, so
    // the hash cannot be silently excluding it from all of them — which is what a shard set
    // computed once at boot would look like from the outside.
    const found: number[] = [];
    for (let i = 0; i < 4; i++) {
      const rows = await loadEnabledMailboxes(db as never, { shards: 4, shardIndex: i });
      if (rows.some((m) => m.mailboxId === fresh.mailboxId)) found.push(i);
    }
    expect(found).toHaveLength(1);
  }, 30_000);
});
