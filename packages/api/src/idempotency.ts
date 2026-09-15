import {
  claimIdempotencyKey, readIdempotencyKey, idempotencyExpiry as dbIdempotencyExpiry,
  type Tx,
} from "@trafficflow/db";
import type { Db } from "@trafficflow/services/mail";
import { jsonResponse } from "./responses.js";

/** `expires_at = now + 24h`. The TTL itself lives in `packages/db`. */
export const idempotencyExpiry = dbIdempotencyExpiry;

export interface StoredIdempotent {
  requestHash: string;
  responseStatus: number;
  responseJson: unknown;
  seq: number | null;
}

export interface RecordIdempotentInput {
  accountId: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  /** change_log seq to re-emit as `X-Sync-Seq` on replay (null when the mutation emitted none). */
  seq: number | null;
  responseJson: unknown;
  /** The request clock — `expires_at` and the expired-row takeover are both derived from it. */
  now: Date;
}

/**
 * Claim the idempotency record. Called by a mutation's service inside its tx so the stored
 * response commits atomically with the write — closing the commit-then-crash re-execution
 * window. Returns false when a concurrent transaction already committed this key, and the
 * caller must then abort its transaction so its duplicate effect rolls back and the request
 * replays the winner's response. See `claimIdempotencyKey` in `packages/db` — `ON CONFLICT
 * DO NOTHING` with an ignored result was a genuine double-effect bug.
 */
export async function recordIdempotent(tx: Tx, i: RecordIdempotentInput): Promise<boolean> {
  return claimIdempotencyKey(tx, {
    accountId: i.accountId,
    key: i.key,
    requestHash: i.requestHash,
    responseStatus: i.responseStatus,
    responseJson: i.responseJson,
    seq: i.seq,
    now: i.now,
  });
}

/**
 * Look up a stored, UNEXPIRED response for `(accountId, key)`, or null.
 *
 * `expires_at` is enforced here rather than merely written: a key is a 24-hour promise, and
 * a lookup that ignored expiry made every key permanent — so a client reusing a key days
 * later would replay an ancient response, and `idempotency_keys` could only grow. Pruning
 * the aged-out rows is the worker's maintenance pass (`pruneIdempotencyKeys`).
 */
export async function lookupIdempotent(
  db: Db, accountId: string, key: string, now: Date,
): Promise<StoredIdempotent | null> {
  return readIdempotencyKey(db as unknown as Tx, accountId, key, now);
}

/**
 * THE ONE PLACE A STORED RESPONSE BECOMES A RESPONSE.
 *
 * A replay answers what the original answered — the stored STATUS CLASS and body, verbatim. Where
 * a route re-derived it instead, the retry of a QUEUED delete came back 204 "the rule is gone"
 * about a rule the offline organizer was still running. It takes the WHOLE row, so a caller has
 * no field to shape with and the three owners cannot drift. Bodiless statuses are
 * `jsonResponse`'s: a 204's stored `{}` is the column's NOT NULL requirement and never ships.
 */
export function storedResponse(found: StoredIdempotent): Response {
  return jsonResponse(found.responseJson, {
    status: found.responseStatus,
    seq: found.seq ?? undefined,
  });
}
