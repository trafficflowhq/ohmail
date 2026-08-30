import { sql } from "drizzle-orm";
import { flagState } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * Upsert `flag_state` desired=<seen>, us — preserving `observed_seen` on conflict.
 *
 * THE ONE SPELLING of the read-state INTENT, for every writer in the system. It lived in
 * `@trafficflow/services` while only `MessageService`'s PATCH routes wrote it; two more writers
 * accreted their own inline copies of the same upsert — `ScreenerService.decide`'s
 * mark-read-on-dismiss and the worker's read-state retro pass — because the worker may not
 * import the services package at runtime (its barrel drags an HTML sanitiser into the worker's
 * boot graph, where it is a hard `ERR_REQUIRE_CYCLE_MODULE` on Node 23; see
 * `apps/worker/package.json` "//services-is-test-only"). Three spellings of one write is three
 * answers to when a `\Seen` round trip is owed, so the module moved DOWN the spine instead:
 * this package holds the table, both writers already depend on it, and it reaches
 * `schema-mail.js` alone, which keeps it inside the desktop engine's closure rule
 * (`index.ts`'s barrel header).
 *
 * The reconciler's own writer is NOT this function and must not become it:
 * `DrizzleRepo.upsertFlagState` writes desired AND observed together with a backoff reset —
 * that is the worker convergence contract, where this is the user-intent contract. The census
 * test beside this module (`test/flag-intent-census.test.ts`) pins every other
 * `insert(flagState)` out of the tree.
 *
 * `observedSeen` is only ever supplied for the INSERT, and the fallback is the message's
 * current `messages.unread`: before anyone has expressed an intent, the read model IS what the
 * server last told us. On conflict the column is deliberately omitted from the `set`, exactly
 * as the folder twin omits `observedFolder` — the worker owns it, and an API request that
 * overwrote it would erase the record of what IMAP actually says and make the reconciler
 * believe it had already converged.
 *
 * `reconcileStatus` is therefore recomputed IN SQL against the STORED `observed_seen`, not
 * against the value guessed at call time: on the update path the caller's guess is stale by
 * definition. Both branches use the same rule — `pending` only when desired ≠ observed — so a
 * no-op click never queues an IMAP round trip.
 */
export async function upsertDesiredSeen(
  tx: Tx, id: string, observedSeen: boolean, desiredSeen: boolean, now: Date,
): Promise<void> {
  await tx.insert(flagState).values({
    messageId: id, desiredSeen, observedSeen,
    lastSetBy: "us", reconcileStatus: desiredSeen === observedSeen ? "reconciled" : "pending",
    conflict: false,
  }).onConflictDoUpdate({
    target: flagState.messageId,
    set: {
      desiredSeen, lastSetBy: "us", conflict: false, updatedAt: now,
      reconcileStatus: sql`case when ${flagState.observedSeen} = ${desiredSeen} then 'reconciled' else 'pending' end`,
    },
  });
}
