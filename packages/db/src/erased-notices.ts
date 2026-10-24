import { inArray, lte, sql } from "drizzle-orm";
import { accounts } from "./schema-mail.js";
import { accountLifecycleNotices } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * WHAT AN ERASED ACCOUNT'S NOTICE LEDGER STILL HOLDS (cloud 0052): the delivered warning a retention
 * erasure keeps, so ohmail can show the warning went out, and at most a claim a pass raced the erasure
 * with. Each row is the account's random id, a CHECK-closed word and instants.
 */

/** How long those rows outlive the erasure: the ten years the billing record beside them is kept. */
export const ERASED_NOTICE_KEEP_YEARS = 10;

/** Delete the notice rows of accounts erased {@link ERASED_NOTICE_KEEP_YEARS} or more ago — the worker's hourly maintenance. */
export async function pruneErasedNotices(tx: Tx, now: Date): Promise<number> {
  const erasedBefore = sql`${now.toISOString()}::timestamptz - interval '1 year' * ${ERASED_NOTICE_KEEP_YEARS}::int`;
  const gone = await tx.delete(accountLifecycleNotices)
    .where(inArray(accountLifecycleNotices.accountId,
      tx.select({ id: accounts.id }).from(accounts).where(lte(accounts.erasedAt, erasedBefore))))
    .returning({ accountId: accountLifecycleNotices.accountId });
  return gone.length;
}
