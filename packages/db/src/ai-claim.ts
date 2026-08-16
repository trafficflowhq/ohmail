import { and, eq, lte, sql } from "drizzle-orm";
import { aiAttemptClaims } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * THE EXCLUSIVE WORK CLAIM — the primitive that turns "this was paid for" into "and I am the one
 * doing it".
 *
 * ## The hole it fills, stated once
 *
 * `debitCredits` is idempotent on `UNIQUE (account_id, source)`, and the AI gate reads a
 * `duplicate` as *"this exact work is already paid for, so proceed and charge nothing"*. That is
 * correct and load-bearing: a worker re-planning the same mail after a restart, a re-sync months
 * later, a client retrying a lost response — all of them must get the work they already bought,
 * and must not be charged twice for it.
 *
 * But a ledger row is a fact about the PAST. It says an attempt was made; it cannot say whether
 * the caller that made it has finished. So "a free retry of a crashed attempt" and "a second
 * caller still inside its model call" reach the gate looking identical, and the second one was
 * given leave to spend OUR money on a model call it had not bought. With `POST /screener/suggest`
 * accepting distinct `Idempotency-Key`s and no edge rate limit in front of it, N concurrent
 * requests bought N model calls for one credit.
 *
 * A row in `ai_attempt_claims` is the missing present-tense fact. It is written in the SAME
 * transaction as the debit, before any model call, and removed when that call ends.
 *
 * ## Why an INSERT and not a lock
 *
 * The obvious shapes do not survive this deployment:
 *
 *  · a **transaction-scoped advisory lock** (`pg_advisory_xact_lock`) releases at COMMIT, and the
 *    commit is what has to happen before the model call — the gate opens its own short
 *    transaction precisely so no network latency is held inside one. The lock would be gone at
 *    the exact moment exclusivity starts mattering;
 *  · a **session advisory lock** would span the call, and is unusable here: production runs
 *    through a transaction-pooling connection pooler, where no session is pinned to a caller.
 *
 * So the claim has to be a durable row, and the serialization comes from where it already comes
 * from in this codebase: `INSERT … ON CONFLICT` BLOCKS on the conflicting tuple until the other
 * transaction ends, then reports whether it wrote anything. `claimIdempotencyKey` is the same
 * mechanism against the same hazard; this is that idea applied to the money rather than to the
 * response.
 *
 * ## Why it must expire, and why the clock is the DATABASE's
 *
 * Anything that can be held can be held by something that died. An unbounded claim turns one
 * crashed serverless invocation into a sender no retry can ever unstick — worse than the defect
 * it fixes. So a claim carries `expires_at` and the next arrival TAKES OVER an expired row, which
 * makes the recovery self-healing rather than a maintenance obligation.
 *
 * This is not a new shape for this codebase, which is why it is the one chosen: `runAlertPass`
 * already claims a notification with a TTL and releases it when delivery ends, for the identical
 * reason (a driver that claims a page and dies before sending it must not silence that page for
 * ever). Same protocol, applied to money instead of to an alert — see {@link DEFAULT_CLAIM_TTL_MS}
 * in `alerts.ts`, including its rule that TESTS shorten the TTL to make expiry observable.
 *
 * `now()` is evaluated IN POSTGRES on both sides — the expiry it writes and the takeover
 * predicate it compares against. Passing a caller's clock would have been the natural signature
 * (every other dated primitive here takes one) and it would be wrong: the holders are separate
 * processes on separate machines, so a bound each caller measures on its own wall clock is not a
 * shared bound. It also removes a trap the gate's own docs already name for `retryWindowMs` — a test
 * clock frozen at a fixed literal writes an `expires_at` in the past, every claim reads as
 * expired, and the exclusivity is silently off while the suite is green.
 */

/**
 * How long a claim is honoured before another caller may take it over.
 *
 * It is a bound on how long a HOLDER can still plausibly be working, and both hosts are bounded
 * by something smaller: the API's Anthropic client is 10 s with one retry inside a serverless
 * invocation capped at 60 s, and the worker's model timeout is 30 s. 60 s is the larger of the
 * two ceilings, so a claim cannot outlive the invocation that took it — which is the property
 * that matters. Anything much shorter would let a slow-but-alive model call be overtaken, which
 * is the defect coming back; anything much longer buys nothing and lengthens the wedge a crash
 * costs.
 */
export const AI_CLAIM_TTL_MS = 60_000;

/**
 * Take the exclusive claim on `source` for THIS transaction's caller.
 *
 * @returns `true` ⇒ the caller owns the work and may call the model once this transaction
 *   commits. `false` ⇒ someone else holds a LIVE claim on it; the caller must NOT proceed to the
 *   model. An EXPIRED row is taken over rather than treated as a conflict.
 *
 * `source` is the BASE ledger source, never a resolved `<base>~<n>` attempt: attempts are two
 * tries at one unit of work, and exactly one caller may be trying at a time.
 *
 * The caller owes a {@link releaseAiAttempt} when the work ends, succeeded or failed. Forgetting
 * it costs at most {@link AI_CLAIM_TTL_MS} of exclusivity on one source and never any money,
 * which is why the TTL is the real guarantee and the release is the optimisation.
 */
export async function claimAiAttempt(
  tx: Tx, accountId: string, source: string, ttlMs: number = AI_CLAIM_TTL_MS,
): Promise<boolean> {
  // Milliseconds, as an interval Postgres computes from its OWN clock. Bound as a parameter and
  // multiplied server-side rather than interpolated: `ttlMs` is a caller-supplied number and this
  // is a statement, not a format string.
  const expiry = sql`now() + (${ttlMs}::double precision * interval '1 millisecond')`;
  const claimed = await tx
    .insert(aiAttemptClaims)
    .values({ accountId, source, expiresAt: expiry as never })
    .onConflictDoUpdate({
      target: [aiAttemptClaims.accountId, aiAttemptClaims.source],
      set: { claimedAt: sql`now()`, expiresAt: expiry },
      // ONLY an already-expired claim may be taken over. A live one belongs to whoever committed
      // it, and this update matching nothing is precisely the answer "do not proceed".
      setWhere: lte(aiAttemptClaims.expiresAt, sql`now()`),
    })
    .returning({ source: aiAttemptClaims.source });
  return claimed.length > 0;
}

/**
 * Give up the claim on `source`. Idempotent, and safe to call when nothing is held.
 *
 * Called when the work ENDS, whichever way it ended. Releasing after a FAILURE is as important as
 * after a success: the charge stays (an open attempt is what makes the retry free), so a claim
 * left behind would make that retry wait out the TTL for no reason.
 *
 * It deletes unconditionally rather than only its own row. A caller reaching here has just
 * finished the work for `source`, and the only way another claim exists under that key is that
 * this caller's own claim already expired and was taken over — in which case the taker is doing
 * work this caller has just done, and clearing it lets the next arrival read the stored result
 * instead. Guarding on `claimed_at` would need a token the gate does not carry, to protect a case
 * the TTL already bounds.
 */
export async function releaseAiAttempt(tx: Tx, accountId: string, source: string): Promise<void> {
  await tx.delete(aiAttemptClaims).where(and(
    eq(aiAttemptClaims.accountId, accountId),
    eq(aiAttemptClaims.source, source),
  ));
}

/**
 * Delete every claim whose TTL has passed — the worker's maintenance pass, beside
 * `pruneIdempotencyKeys`.
 *
 * It is a SIZE control and never a correctness one: an expired row is already claimable, so
 * nothing waits on this sweep. Without it the abandoned tail (a holder that died and a source
 * nobody ever asked about again) only grows.
 */
export async function pruneAiAttemptClaims(tx: Tx, now: Date): Promise<number> {
  const gone = await tx
    .delete(aiAttemptClaims)
    .where(lte(aiAttemptClaims.expiresAt, now))
    .returning({ source: aiAttemptClaims.source });
  return gone.length;
}
