import { eq } from "drizzle-orm";
import type { Dialect, LockMode } from "./dialect/index.js";
import { accounts } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * The erasure fence's primitive. `packages/services/src/erasure-fence.ts#fenceErasedAccount` is
 * the ORIGINAL and remains what every HTTP writer of `account_settings` calls — its header holds
 * the full argument. This file holds the SQL that decision rests on, so a second caller can reach
 * it without importing `@trafficflow/services`: the organizer's request drain applies a reader's
 * screener decision — a settings writer too — and the worker may not import the services package
 * at runtime; `learning-signal.ts` makes the identical move. The services module now calls THIS
 * function and translates the answer into a `ServiceError` — one implementation of the read, two
 * error shapes for two runtimes.
 */

/**
 * `accounts.erased_at`, read `FOR SHARE` — the interlock's own half. `undefined` when no row
 * exists at all (not erased; `accounts` survives erasure by design, so an absent row means the id
 * was never real), `null` when the row exists and is not erased, a `Date` when it is.
 *
 * MUST be the FIRST statement in the caller's transaction — see the module header for the lock
 * order this holds against `deleteAccount`'s own first statement.
 */
export async function readAccountErasedAt(
  tx: Tx, d: Dialect, accountId: string, mode: LockMode = "share",
): Promise<Date | null | undefined> {
  // SHARE by default, and the strength travels: fences read this row concurrently and must keep
  // doing so — only the erasure itself takes the exclusive lock they are ordered against. A
  // caller whose transaction will LATER take `accounts FOR UPDATE` (the mailbox allowance gate is
  // the one) passes `"update"` instead: a share taken first and upgraded later is a deadlock
  // between two such callers, and taking the strong lock at the head has the same effect as the
  // share against the sweep.
  const [row] = await d.forUpdate(
    tx.select({ erasedAt: accounts.erasedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
    { mode });
  if (row === undefined) return undefined;
  return row.erasedAt;
}
