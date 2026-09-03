import { eq } from "drizzle-orm";
import { accounts } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ERASURE FENCE'S PRIMITIVE — moved down the spine for the request drain (0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `packages/services/src/erasure-fence.ts#fenceErasedAccount` is the ORIGINAL and remains the
 * one every HTTP writer of `account_settings` calls — read its own header for the full argument
 * (why a `FOR SHARE` read on `accounts`, first in the transaction, closes the late-recreation race
 * against `deleteAccount`). This file holds the SQL that decision rests on, so a SECOND caller can
 * reach it without importing `@trafficflow/services`: the organizer's request drain
 * (`apps/worker/src/request-drain.ts`) applies a reader's screener decision, which is a settings
 * writer too (it stamps `account_settings.screening_baseline_at` on a first decide, exactly as
 * `ScreenerService.decide` does), and the worker may not import the services package at runtime
 * (`apps/worker/package.json` "//services-is-test-only"). `learning-signal.ts` beside this file
 * makes the identical move for the identical reason.
 *
 * `packages/services/src/erasure-fence.ts` now calls THIS function and translates its answer into
 * a `ServiceError` for HTTP callers — one implementation of the read, two idiomatic error shapes
 * for two runtimes.
 */

/**
 * `accounts.erased_at`, read `FOR SHARE` — the interlock's own half. `undefined` when no row
 * exists at all (not erased; `accounts` survives erasure by design, so an absent row means the id
 * was never real), `null` when the row exists and is not erased, a `Date` when it is.
 *
 * MUST be the FIRST statement in the caller's transaction — see the module header for the lock
 * order this holds against `deleteAccount`'s own first statement.
 */
export async function readAccountErasedAt(tx: Tx, accountId: string): Promise<Date | null | undefined> {
  const [row] = await tx.select({ erasedAt: accounts.erasedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .for("share");
  if (row === undefined) return undefined;
  return row.erasedAt;
}
