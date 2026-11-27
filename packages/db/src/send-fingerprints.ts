import { and, asc, eq, gt, lt, sql, type SQL } from "drizzle-orm";
/* Hosted maintenance for the send claim tables. The send path itself uses the mail schema. */
import { outboundSendFingerprints, outboundSends } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { rowsAffected } from "./rows-affected.js";

/**
 * How long a content claim is kept on disk — hygiene, NOT the duplicate window. The window a
 * duplicate send is refused inside is `SEND_DUPLICATE_WINDOW_MS` (`@trafficflow/services`, one
 * hour), compared against the request clock in the send path itself. This is a different number
 * for a different job: how long a spent row may sit before a sweep removes it. Twenty-four hours,
 * comfortably past the window, so a row this deletes can no longer refuse anything and the sweep
 * can never be the reason a send is admitted or refused. That separation is the point: a
 * standalone install runs the same send path and has NO maintenance pass, so anything the expiry
 * depended on would be unbounded there — identical re-sends refused forever on every desktop.
 */
export const SEND_FINGERPRINT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Delete every content claim older than {@link SEND_FINGERPRINT_RETENTION_MS}. Run from the
 * worker's maintenance pass beside `pruneIdempotencyKeys`.
 *
 * A SIZE control and never a correctness one. Row growth is bounded by DISTINCT sends rather than
 * by attempts — the send path re-points an existing claim instead of inserting a second — so the
 * table is small by construction and a failed sweep costs a little disk and nothing else. Nothing
 * waits on it and no send's answer changes because it did or did not run. A claim whose send is held
 * (`unverified`, nobody has answered for it) is kept whatever its age: Send again proves its message by it.
 */
export const SEND_FINGERPRINT_PRUNE_BATCH = 500;

export async function expiredFingerprintAccounts(
  db: Tx, now: Date, before: string | null, limit: number, shard?: SQL,
): Promise<string[]> {
  const rows = await db.selectDistinct({ id: outboundSendFingerprints.accountId }).from(outboundSendFingerprints)
    .where(and(
      lt(outboundSendFingerprints.createdAt, new Date(now.getTime() - SEND_FINGERPRINT_RETENTION_MS)),
      before ? gt(outboundSendFingerprints.accountId, before) : undefined, shard,
    )).orderBy(asc(outboundSendFingerprints.accountId)).limit(limit);
  return rows.map((r) => r.id);
}

export async function pruneSendFingerprints(
  tx: Tx, now: Date, opts: { accountId?: string; batch?: number } = {},
): Promise<number> {
  const { accountId, batch = SEND_FINGERPRINT_PRUNE_BATCH } = opts;
  const eligible = and(
    accountId === undefined ? undefined : eq(outboundSendFingerprints.accountId, accountId),
    lt(outboundSendFingerprints.createdAt, new Date(now.getTime() - SEND_FINGERPRINT_RETENTION_MS)),
    sql`not exists (select 1 from ${outboundSends} where ${outboundSends.id} = ${outboundSendFingerprints.sendId}
      and ${outboundSends.accountId} = ${outboundSendFingerprints.accountId}
      and ${outboundSends.status} = 'unverified' and ${outboundSends.resolvedBy} is null)`,
  );
  const ids = tx.select({ id: outboundSendFingerprints.id }).from(outboundSendFingerprints)
    .where(eligible).orderBy(asc(outboundSendFingerprints.createdAt), asc(outboundSendFingerprints.id)).limit(batch)
    .for("update", { skipLocked: true });
  return rowsAffected(await tx.execute(sql`
    with due as materialized (${ids})
    delete from ${outboundSendFingerprints} using due
    where ${outboundSendFingerprints.id} = due.id and ${eligible}
  `));
}
