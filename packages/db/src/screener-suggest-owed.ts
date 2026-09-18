import { and, asc, eq, lte, sql } from "drizzle-orm";
import { screenerSuggestOwed } from "./schema-cloud.js";
import { accountSettings } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * THE SUGGEST-OWED MARK (cloud 0039) — one row per account whose ingest HELD a first-contact
 * sender since the worker's suggest pass last visited it. The three verbs live together because
 * they are one contract: the writer is gated on the account's opt-in, the reader orders by the
 * FIRST unserved hold, and the clear takes only what the reader saw, so a hold landing mid-pass
 * survives into the next cycle. Hosted worker only — the standalone engine's pass runs at its
 * drain tail and never sees this table — and Postgres only, which is why `mark` may use a raw
 * INSERT … SELECT (the sqlite-proxy handle that lacks `execute` never reaches this module).
 */

/**
 * Mark `accountId` owed a suggest visit — IF the account has opted in (`auto_suggest_at IS NOT
 * NULL`, read in the same statement, so an opted-out account never gains a row) and is not
 * already owed (`ON CONFLICT DO NOTHING` keeps the first unserved hold's instant, so the owed
 * order is arrival order and a flood from one account cannot re-jump the queue). One indexed
 * read and one idempotent upsert; safe to call per held ingest.
 */
export async function markScreenerSuggestOwed(db: Tx, accountId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${screenerSuggestOwed} (account_id, owed_at)
    SELECT ${accountSettings.accountId}, now()
      FROM ${accountSettings}
     WHERE ${accountSettings.accountId} = ${accountId}
       AND ${accountSettings.autoSuggestAt} IS NOT NULL
    ON CONFLICT (account_id) DO NOTHING
  `);
}

/** One owed account, and the instant its first unserved hold arrived. */
export interface SuggestOwedRow {
  accountId: string;
  owedAt: Date;
}

/**
 * The owed accounts, oldest first — the order the cycle serves them in. Bounded: the table only
 * grows by opted-in accounts with unserved holds and every serve deletes, so `limit` is a fuse,
 * not a pager. The caller intersects with ITS OWN served set — a shard must neither serve nor
 * clear another shard's accounts.
 */
export async function owedSuggestAccounts(db: Tx, limit = 1000): Promise<SuggestOwedRow[]> {
  return await db.select({
    accountId: screenerSuggestOwed.accountId,
    owedAt: screenerSuggestOwed.owedAt,
  }).from(screenerSuggestOwed)
    .orderBy(asc(screenerSuggestOwed.owedAt))
    .limit(limit);
}

/**
 * Retire one served mark — only up to the instant the reader SAW (`notAfter`), so a hold that
 * landed while the pass was running keeps its newer row and the next cycle serves it. Called
 * after the pass RAN for the account, whatever it bought: an opted-out account's no-op pass
 * clears too, or a stale mark would put it at the front of every cycle for ever.
 */
export async function clearScreenerSuggestOwed(db: Tx, accountId: string, notAfter: Date): Promise<void> {
  await db.delete(screenerSuggestOwed).where(and(
    eq(screenerSuggestOwed.accountId, accountId),
    lte(screenerSuggestOwed.owedAt, notAfter),
  ));
}
