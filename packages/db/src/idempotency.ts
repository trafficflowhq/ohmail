import { and, eq, isNull, lte, or, type SQL } from "drizzle-orm";
/* The mail half directly — see the note in `change-log.ts`. `idempotency_keys` is a mail table. */
import { idempotencyKeys } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { fenceErased } from "./erasure-fence.js";
import { dialect } from "./dialect/index.js";

/**
 * The `idempotency_keys` WRITE primitive, in `packages/db` because six services need it and
 * `packages/services` may not import `packages/api`. A CLAIM, not an insert. Committing the dedup
 * row with the effect was not sufficient: two concurrent invocations both miss the autocommit
 * lookup, both apply the effect, and with `ON CONFLICT DO NOTHING` the second insert quietly does
 * nothing. So the claim's result is load-bearing: the second INSERT BLOCKS until the first
 * transaction ends; a caller that did not claim throws — rolling back its own effect — and the
 * request replays the winner's stored response. Expiry is enforced: the claim takes over an
 * EXPIRED row, and {@link pruneIdempotencyKeys} deletes what aged out.
 */

/** The TTL of a stored idempotent response. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** `expires_at` for a row written now. */
export function idempotencyExpiry(now: Date, ttlMs: number = IDEMPOTENCY_TTL_MS): Date {
  return new Date(now.getTime() + ttlMs);
}

/**
 * A KEY CLAIMED BEFORE ITS ANSWER EXISTS — the status and body of a PENDING row. A request whose
 * effect is many transactions long (the Screener's suggestion purchase) binds its key to its body
 * first and settles the answer onto the row at the end. 102 is never a stored answer: the one
 * replay renderer turns it into a retryable "still running" refusal, never a response.
 */
export const IDEMPOTENCY_PENDING_STATUS = 102;
export const IDEMPOTENCY_PENDING_BODY = "pending";

export interface IdempotencyClaimInput {
  accountId: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  /** The verbatim response body to replay. */
  responseJson: unknown;
  /** `change_log` seq to re-emit as `X-Sync-Seq` on replay (null when the mutation emitted none). */
  seq: number | null;
  /** The request clock (`ctx.now()`), used for both `expires_at` and the expired-row takeover. */
  now: Date;
  /** How long the row binds the key; absent is {@link IDEMPOTENCY_TTL_MS}. A pending claim's is short. */
  ttlMs?: number;
}

/**
 * Claim `(account_id, key)` for THIS transaction and store the response to replay.
 *
 * Returns `true` when this transaction owns the key, `false` when a concurrent
 * transaction already committed it — in which case the caller MUST throw so its own
 * effect rolls back (see the module doc). An expired row is taken over rather than
 * treated as a conflict.
 */
export async function claimIdempotencyKey(tx: Tx, i: IdempotencyClaimInput): Promise<boolean> {
  return writeClaim(tx, i, lte(idempotencyKeys.expiresAt, i.now));
}

/**
 * SETTLE THE ANSWER ONTO A KEY THIS REQUEST CLAIMED PENDING. It takes the row over while it is
 * still pending under the SAME request hash and unerased — this request's own claim, or a
 * same-body twin's after an expiry — or once it has expired, like any claim. A row somebody else
 * settled, another body's claim or an erasure's stamp answers `false`, and the caller throws so
 * the request replays whatever the key now holds.
 */
export async function settleIdempotencyKey(tx: Tx, i: IdempotencyClaimInput): Promise<boolean> {
  return writeClaim(tx, i, or(
    lte(idempotencyKeys.expiresAt, i.now),
    and(
      eq(idempotencyKeys.responseStatus, IDEMPOTENCY_PENDING_STATUS),
      eq(idempotencyKeys.requestHash, i.requestHash),
      isNull(idempotencyKeys.erasedAt),
    ),
  )!);
}

/**
 * HAND BACK A PENDING KEY this request will not answer — a run that faulted or refused mid-way —
 * so its retry runs instead of waiting out the TTL. Only the pending row under this request's
 * hash: a settled answer is never deleted, since that would let a retry apply the effect twice.
 */
export async function releasePendingIdempotencyKey(
  tx: Tx, i: { accountId: string; key: string; requestHash: string },
): Promise<boolean> {
  const gone = await tx
    .delete(idempotencyKeys)
    .where(and(
      eq(idempotencyKeys.accountId, i.accountId),
      eq(idempotencyKeys.key, i.key),
      eq(idempotencyKeys.requestHash, i.requestHash),
      eq(idempotencyKeys.responseStatus, IDEMPOTENCY_PENDING_STATUS),
    ))
    .returning({ key: idempotencyKeys.key });
  return gone.length > 0;
}

/** The one writer: insert, or take the live row over only where `takeOver` holds. */
async function writeClaim(tx: Tx, i: IdempotencyClaimInput, takeOver: SQL): Promise<boolean> {
  /* THE FENCE, HERE AND NOT AT NINETEEN CALL SITES. `idempotency_keys` is a table the Art. 17
     sweep empties, and a claim is written by a request that was valid when it started: the
     screener's suggest run reads a balance and awaits a model between its session check and this
     claim, and an erasure landing in that window left the claim behind. Local, so a twentieth
     caller inherits it; a second FOR SHARE read inside an already-fenced transaction re-takes a
     lock this transaction holds and costs one indexed row. */
  await fenceErased(tx, dialect(tx), { accountId: i.accountId });
  const row = {
    accountId: i.accountId,
    key: i.key,
    requestHash: i.requestHash,
    responseStatus: i.responseStatus,
    responseJson: i.responseJson,
    seq: i.seq,
    expiresAt: idempotencyExpiry(i.now, i.ttlMs),
    createdAt: i.now,
  };
  const claimed = await tx
    .insert(idempotencyKeys)
    .values(row)
    .onConflictDoUpdate({
      target: [idempotencyKeys.accountId, idempotencyKeys.key],
      set: {
        requestHash: row.requestHash,
        responseStatus: row.responseStatus,
        responseJson: row.responseJson,
        seq: row.seq,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        // A takeover writes a NEW answer, so an erasure's stamp on the row it replaces goes with
        // the old one; left standing, every replay of the new answer would be a 410.
        erasedAt: null,
      },
      // ONLY the row `takeOver` names — for a claim, an already-expired one. A live row belongs
      // to whoever committed it and must make this claim fail.
      setWhere: takeOver,
    })
    .returning({ key: idempotencyKeys.key });
  return claimed.length > 0;
}

/**
 * Delete every `idempotency_keys` row whose TTL has passed. Run from the worker's
 * maintenance pass — without it the table only grows, since a mutation never revisits
 * its own key.
 */
export async function pruneIdempotencyKeys(tx: Tx, now: Date): Promise<number> {
  const gone = await tx
    .delete(idempotencyKeys)
    .where(lte(idempotencyKeys.expiresAt, now))
    .returning({ key: idempotencyKeys.key });
  return gone.length;
}

/**
 * Read a stored idempotent response for `(accountId, key)` that has NOT expired.
 *
 * `erasedAt` travels with it rather than being filtered out here: an erased row is not absent —
 * absent means "replay the mutation", and this row exists precisely to say that the mutation
 * already happened and its answer is gone. The caller turns the stamp into a 410.
 */
export async function readIdempotencyKey(
  tx: Tx,
  accountId: string,
  key: string,
  now: Date,
): Promise<
  {
    requestHash: string; responseStatus: number; responseJson: unknown; seq: number | null;
    erasedAt: Date | null;
  } | null
> {
  const rows = await tx
    .select({
      requestHash: idempotencyKeys.requestHash,
      responseStatus: idempotencyKeys.responseStatus,
      responseJson: idempotencyKeys.responseJson,
      seq: idempotencyKeys.seq,
      expiresAt: idempotencyKeys.expiresAt,
      erasedAt: idempotencyKeys.erasedAt,
    })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;   // aged out ⇒ as good as absent
  return {
    requestHash: row.requestHash,
    responseStatus: row.responseStatus,
    responseJson: row.responseJson,
    seq: row.seq ?? null,
    erasedAt: row.erasedAt ?? null,
  };
}

/**
 * BLANK THE CONTENT OF EVERY IDEMPOTENCY ROW THIS ACCOUNT HOLDS, and stamp what was done.
 *
 * `response_json` holds a verbatim copy of what a mutation answered with — for a draft, the body
 * and the recipients — and nothing treated that as message content, so an erasure swept the mail
 * and left a 24-hour copy of it behind a retry. Run inside the erasure's own transaction.
 *
 * WHY THE WHOLE ACCOUNT on a MAILBOX erasure: a stored response carries no mailbox, so there is
 * no narrower question to ask. The cost of the wide answer is bounded — a retry of a surviving
 * mailbox's lost request gets 410 instead of its response, and its mutation still does not run
 * twice, which is the promise the key exists to keep. An already-stamped row is left alone so a
 * retried erasure keeps the first stamp.
 */
export const IDEMPOTENT_ERASED_BODY = "erased";

export async function eraseIdempotentResponses(
  tx: Tx, accountId: string, now: Date,
): Promise<number> {
  const gone = await tx
    .update(idempotencyKeys)
    // A JSON STRING, not `null`. The column is `not null`, and drizzle writes a JS `null` as SQL
    // NULL on both dialects, which the constraint refuses — measured, as a 500 on the erase route.
    // `"erased"` is a value both stores accept and reads as what it is; `erased_at` is the record
    // that decides, and the replay never serves this either way.
    .set({ responseJson: IDEMPOTENT_ERASED_BODY, erasedAt: now })
    .where(and(eq(idempotencyKeys.accountId, accountId), isNull(idempotencyKeys.erasedAt)))
    .returning({ key: idempotencyKeys.key });
  return gone.length;
}
