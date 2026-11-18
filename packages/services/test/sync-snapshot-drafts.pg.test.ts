import type { SnapshotResponse } from "@ohmail/wire";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { drafts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { SNAPSHOT_DRAFT_PAGE, syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * THE SNAPSHOT'S DRAFT KEYSET, AGAINST REAL POSTGRES.
 *
 * Page 1 emitted every draft row the account holds with no limit applied; drafts now ride the
 * pages newest-first on `(updated_at desc, id desc)`. The PGlite twin (`sync-snapshot.test.ts`)
 * proves the paging, the phase and the cursor's refusals. Two things are worth measuring here and
 * cannot be measured there:
 *
 *  1. THE TIE. `drafts.updated_at` defaults to `now()`, which is the transaction's clock — so
 *     drafts saved together share one timestamp, and in production they do. A keyset on the
 *     timestamp ALONE would either skip the rest of a tied block at a page boundary or serve it
 *     for ever; the `id desc` tiebreak is what makes the walk total. The fixture puts a tied block
 *     straddling the boundary on purpose.
 *  2. THE COMPARISON. The keyset binds a JS `Date` against a `timestamptz` column through
 *     drizzle's parameter path, which PGlite and postgres@3 have disagreed about before.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof brandDialect<ReturnType<typeof drizzle<typeof schema>>>>;

const NOW = new Date("2026-08-07T12:00:00.000Z");
const PAGE = SNAPSHOT_DRAFT_PAGE;
/** A tied block wider than one page, so the tie straddles a boundary rather than ending on one. */
const TIED = PAGE + 20;
const DISTINCT = PAGE + 30;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "snapshot-drafts",
});

const idsOf = (r: SnapshotResponse): string[] =>
  r.changes.filter((c) => c.type === "draft").map((c) => c.id);

/** Drain the whole snapshot; return every draft id in delivery order plus the page count. */
async function drainDrafts(accountId: string): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const page = await syncService.getSnapshot(ctx(accountId), {
      limit: 500, ...(cursor ? { cursor } : {}),
    });
    ids.push(...idsOf(page));
    if (page.nextCursor === null) return { ids, pages };
    cursor = page.nextCursor;
    if (pages > 50) throw new Error("the draft drain did not terminate");
  }
}

describe.skipIf(!PG_UP)("the snapshot's draft keyset (real Postgres)", () => {
  let accountId: string;
  let mailboxId: string;
  /** Every draft id in the order the server owes them: `updated_at desc, id desc`. */
  let owed: string[];

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);

    accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `drafts-${accountId}@tf.example`,
    }).returning();
    mailboxId = mb!.id;

    // Newest: DISTINCT rows one minute apart. Then TIED rows sharing ONE instant, below them.
    const rows = [
      ...Array.from({ length: DISTINCT }, (_, i) => ({
        accountId, mailboxId, subject: `d${i}`,
        updatedAt: new Date(NOW.getTime() - i * 60_000),
      })),
      ...Array.from({ length: TIED }, (_, i) => ({
        accountId, mailboxId, subject: `t${i}`,
        updatedAt: new Date(NOW.getTime() - DISTINCT * 60_000),
      })),
    ];
    for (let i = 0; i < rows.length; i += 200) await db.insert(drafts).values(rows.slice(i, i + 200));

    owed = (await db.select({ id: drafts.id }).from(drafts)
      .where(eq(drafts.accountId, accountId))
      .orderBy(sql`${drafts.updatedAt} desc`, sql`${drafts.id} desc`)).map((r) => r.id);
  }, 300_000);

  afterAll(async () => {
    // What this test created, this test removes: a shared table must not carry the fixture into
    // somebody else's read.
    if (!client) return;
    await db.delete(drafts).where(eq(drafts.accountId, accountId));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
    await client.end({ timeout: 5 });
  }, 120_000);

  it("the fixture ties a block across a page boundary", () => {
    expect(owed).toHaveLength(DISTINCT + TIED);
    expect(TIED, "a tie inside one page would end on the boundary, not straddle it")
      .toBeGreaterThan(PAGE);
  });

  it("page 1 carries one page of drafts, not the account's whole set", async () => {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 500 });
    expect(idsOf(page)).toHaveLength(PAGE);
    expect(idsOf(page)).toEqual(owed.slice(0, PAGE));
  }, 60_000);

  it("the drain delivers every draft exactly once, in the order the server owes them", async () => {
    const { ids, pages } = await drainDrafts(accountId);
    expect(new Set(ids).size, "a draft was delivered more than once").toBe(ids.length);
    expect(ids, "the keyset skipped or reordered a draft across a page boundary").toEqual(owed);
    // Not a one-page drain dressed up as a walk.
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(owed.length / PAGE));
  }, 120_000);
});
