import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages, flagState, upsertDesiredSeen, type Tx } from "../src/index.js";
import { schema } from "../src/cloud.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * THE ONE SPELLING'S OWN CONTRACT, against real Postgres — the branch its consumers' suites do
 * not reach.
 *
 * The INSERT branch was proven where it was used (watched red under mutation, 2026-08-30, by the
 * read-state retro and the Screener's read-mark, both since retired).
 * The CONFLICT branch was not: mutating the update arm's `case when observed_seen = desired`
 * recompute to a constant `'reconciled'` left both green, because their scenarios always insert
 * fresh rows. This file pins that arm directly, because it carries the writer's two promises:
 *
 *  1. `observed_seen` is NEVER touched on conflict — the worker owns it, and an API write that
 *     overwrote it would make the reconciler believe it had already converged;
 *  2. `reconcile_status` is recomputed against the STORED observed value, not the caller's
 *     stale guess — so a no-op click never queues an IMAP round trip, and a real change always
 *     does.
 */
/**
 * `PG_TEST_URL`, NOT a locally-spelled session-URL fallback chain — the canonical helper prefers
 * `DATABASE_URL_PG_TEST`, and that ordering is the safety property: a box whose session URL names
 * a real deployment would otherwise have this file run `runMigrations` and insert fixture accounts
 * THERE. `realPgAvailable()` + `describe.skipIf` is the house shape for the reason every other
 * `*.pg.test.ts` uses it: a laptop with no container skips, and `TF_REQUIRE_PG=1` (CI,
 * `pnpm test:pg`) turns that skip back into a loud failure.
 */
const PG_UP = await realPgAvailable();

const sql = postgres(PG_TEST_URL, { max: 2 });
const db = brandDialect(drizzle(sql, { schema }), "pg");

async function seedMessage(): Promise<string> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "flag-intent" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `fi-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `fi:${randomUUID()}`,
    subject: "flag intent", fromAddress: "sender@example.test",
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  return m!.id;
}

const rowOf = async (id: string) =>
  (await db.select().from(flagState).where(eq(flagState.messageId, id)))[0]!;

describe.skipIf(!PG_UP)("upsertDesiredSeen — the read-state intent's one spelling", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("INSERT: desired ≠ observed is pending; desired = observed is reconciled", async () => {
    const a = await seedMessage();
    await upsertDesiredSeen(db as unknown as Tx, a, false, true, new Date());
    expect(await rowOf(a)).toMatchObject({
      desiredSeen: true, observedSeen: false, lastSetBy: "us",
      reconcileStatus: "pending", conflict: false,
    });

    const b = await seedMessage();
    await upsertDesiredSeen(db as unknown as Tx, b, true, true, new Date());
    expect(await rowOf(b)).toMatchObject({ reconcileStatus: "reconciled" });
  });

  it("CONFLICT: observed_seen is preserved, and reconcile_status is recomputed against the STORED value", async () => {
    const id = await seedMessage();
    // The worker has observed \Seen on the real mailbox.
    await db.insert(flagState).values({
      messageId: id, desiredSeen: true, observedSeen: true,
      lastSetBy: "them", reconcileStatus: "reconciled", conflict: true,
    });

    // The caller's guess says unread (`observedSeen: false` — stale by definition on the
    // update path). Desired true against STORED observed true ⇒ reconciled: a no-op click
    // must not queue an IMAP round trip — and the stored observation must survive.
    await upsertDesiredSeen(db as unknown as Tx, id, false, true, new Date());
    expect(await rowOf(id)).toMatchObject({
      desiredSeen: true, observedSeen: true, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false,
    });

    // Mark unread: desired false against stored observed true ⇒ a real `\Seen` removal is
    // owed ⇒ pending. The recompute reads the stored truth, not the caller's argument.
    await upsertDesiredSeen(db as unknown as Tx, id, true, false, new Date());
    expect(await rowOf(id)).toMatchObject({
      desiredSeen: false, observedSeen: true, reconcileStatus: "pending",
    });
  });
});
