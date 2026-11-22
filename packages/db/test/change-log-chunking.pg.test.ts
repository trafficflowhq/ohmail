import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { recordChanges } from "../src/change-log.js";
import { changeLog } from "../src/schema-mail.js";
import { schema } from "../src/schema.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A BIG BATCH OF CHANGES IS STILL ONE BATCH — the bind-parameter ceiling
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `recordChanges` built ONE `INSERT` for however many rows it was handed. Each row binds six
 * parameters and PostgreSQL's wire protocol caps the count per statement, so past **a sixth of that in rows the
 * statement does not truncate or slow down — it errors**.
 *
 * Nothing reached it while the only callers were per-cycle batches. A MAILBOX REMOVAL did: it
 * closes every pending appointment on the mailbox inside `MailboxService.delete`'s transaction,
 * and the batch size is then a property of the account's data rather than of the code. There the
 * failure is unrecoverable rather than transient — the error propagates out of `delete`, rolls
 * back the tombstone AND the credential delete, and does so identically on every retry, so the
 * mailbox becomes impossible to remove. Raised by review against.
 *
 * ── WHY REAL POSTGRES, AND WHY THE COUNT IS PAST THE WALL AND NOT MERELY PAST A CHUNK ───────
 *
 * The ceiling is the SERVER's, enforced at bind time; a driver-level or PGlite check would be
 * testing something else.
 *
 * The count is **above that wall**, and it has to be. It was one chunk and a row for one round — one row past a
 * chunk boundary, which proves the loop runs twice and that nothing is dropped at the seam, and
 * which review correctly refused: that many rows is bind values comfortably UNDER the limit,
 * so restoring the single `values(rows)` statement left this file GREEN. A regression test that
 * stays green with the fix removed is not a guard, whatever its name says (AGENTS.md). The count
 * now sits past the wall, so the committed test fails against the committed bug — which is the
 * only version of this file worth having.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Replace the loop in `recordChanges` with the single `values(rows)` it used to be: the insert
 * errors with `MAX_PARAMETERS_EXCEEDED: Max number of parameters (65534) exceeded`, at this
 * count, with no other edit. With the loop in place, deleting the `slice` so every chunk inserts
 * the whole array reddens the uniqueness assertion on a duplicate key instead. Both were run.
 */

const PG_UP = await realPgAvailable();
const sql = postgres(PG_TEST_URL, { max: 5, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg");

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sql.end({ timeout: 5 }); });

/**
 * PAST THE BIND WALL, not merely past a chunk.
 *
 * Six parameters per row against PostgreSQL's bind ceiling puts the hard limit at a sixth of it in rows, so this
 * is the smallest round number that makes the OLD single-statement implementation fail. It also
 * spans three chunks of {@link CHANGE_INSERT_CHUNK}, so the seam is exercised more than once.
 */
const N = 11_000;

describe.skipIf(!PG_UP)("recordChanges splits a large batch and loses nothing", () => {
  it(`writes ${N} changes across chunks with contiguous, unique, ordered seqs`, async () => {
    const accountId = randomUUID();
    const entityId = randomUUID();
    const changes = Array.from({ length: N }, () => ({
      accountId, entityType: "draft" as const, entityId, op: "update" as const, meta: null,
    }));

    // Inside a transaction, which `recordChanges` requires and says so: a top-level handle would
    // auto-commit the seq allocation before the rows land, and a poller could advance past a seq
    // that is not there yet.
    const seqs = await db.transaction(async (tx) => recordChanges(tx as never, changes));

    // Every row got a seq, and they are the account's own contiguous run.
    expect(seqs).toHaveLength(N);
    expect(new Set(seqs.map(String)).size, "a seq was reused across chunks").toBe(N);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]! - seqs[i - 1]!, `seqs are not contiguous at ${i}`).toBe(1n);
    }

    // And every one of them is actually IN the table — the seam between chunks is where a
    // partially-applied batch would show up, and a gap-free per-account seq is the "Delta-first client contract" invariant.
    const rows = await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, entityId)));
    expect(rows.length, "rows were lost at a chunk boundary").toBe(N);
    const stored = rows.map((r) => r.seq).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(stored[0]).toBe(seqs[0]);
    expect(stored[stored.length - 1]).toBe(seqs[seqs.length - 1]);
  }, 120_000);

  it("a batch that fits one chunk is unchanged", async () => {
    const accountId = randomUUID();
    const entityId = randomUUID();
    const seqs = await db.transaction(async (tx) => recordChanges(tx as never, [
      { accountId, entityType: "draft" as const, entityId, op: "update" as const, meta: null },
    ]));
    expect(seqs).toHaveLength(1);
    const rows = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, entityId)));
    expect(rows).toHaveLength(1);
  }, 60_000);
});
