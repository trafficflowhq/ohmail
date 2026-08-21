import { sql, eq } from "drizzle-orm";
import { accountStorage } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * PER-ACCOUNT STORED-BODY ACCOUNTING — the mail-schema half of the managed storage cap.
 * The CLOUD half — what the cap IS for an account, and who is at it — lives in
 * `storage-cloud.ts` on the `/cloud` entry point, because it reads `billing_subscriptions`;
 * THIS module touches only `account_storage` (mail 0062) and is inside the desktop engine's
 * import closure, where `DrizzleRepo` calls it.
 *
 * ## What one byte is
 *
 * {@link bodyBytesOf} is the ONE definition of what counts: `octet_length(text) +
 * octet_length(html)` — UTF-8 octets of exactly the two columns a body row stores content in.
 * Headers never count (they are still written at cap — the organizing passes read stored
 * headers, so a count of undeclinable bytes would grow with no user remedy), and neither do
 * snippets, attachment metadata (attachment BYTES are never stored server-side), the transient
 * outbound staging (its own quota), or the derived `body_tsv`. `Buffer.byteLength` is UTF-8
 * byte length, which is `octet_length` for a UTF-8 database — the 0062 backfill computes the
 * same sum in SQL, and `storage-reserve.pg.test.ts` holds the two definitions together.
 *
 * ## The transaction discipline
 *
 * Every writer moves the counter IN THE SAME TRANSACTION as the body write it accounts for —
 * the reserve inside `DrizzleRepo.insertMessageBody`, the clamped deltas inside the repair
 * passes' per-message transactions — so the number can never describe a state `message_bodies`
 * is not in. LOCK ORDER: the `account_storage` row is written BEFORE the first
 * `recordChange`/`allocateSeq` of its transaction, everywhere, so two writers can never hold
 * the two locks in opposite orders.
 */

/**
 * The one definition of how many bytes a stored body costs the account.
 * `Buffer.byteLength` measures UTF-8 octets — the same number Postgres's `octet_length`
 * answers for these columns, which is what the 0062 backfill aggregates.
 */
export function bodyBytesOf(body: { text: string; html: string | null }): number {
  return Buffer.byteLength(body.text, "utf8") + (body.html === null ? 0 : Buffer.byteLength(body.html, "utf8"));
}

/** The account's counted stored-body bytes. A missing row is 0 — nothing stored, nothing owed. */
export async function storageUsageOf(tx: Tx, accountId: string): Promise<number> {
  const rows = await tx.select({ bytes: accountStorage.bytes }).from(accountStorage)
    .where(eq(accountStorage.accountId, accountId)).limit(1);
  return rows[0]?.bytes ?? 0;
}

/**
 * RESERVE `bytes` against the account's cap, atomically, in the caller's transaction.
 *
 * `true` ⇒ the counter moved and the caller stores the body. `false` ⇒ the account is AT CAP
 * (counted bytes already ≥ `capBytes`) and the caller writes the withheld row instead.
 *
 * ── The mechanism, and why it needs no advisory lock ─────────────────────────────────────────
 *
 * Two statements: an `INSERT … ON CONFLICT DO NOTHING` that makes the row exist, then ONE
 * conditional `UPDATE … SET bytes = bytes + $n WHERE account_id = $1 AND bytes < $cap
 * RETURNING`. The UPDATE takes the row lock, so concurrent ingests for one account serialize
 * on it exactly as credit debits serialize on `credit_balances`; a racer that finds
 * `bytes >= cap` matches no row and is the decline. There is no read-then-write to race.
 *
 * ── At-cap means "decline once ≥ cap", NOT a hard byte ceiling ───────────────────────────────
 *
 * The predicate is `bytes < cap` BEFORE adding `n`, so the message that CROSSES the cap stores
 * in full — conservative toward the user, bounded by one message (64 MiB raw ceiling upstream,
 * 256 KiB stored html) — and the first message after that is the first decline. Deleting the
 * WHERE arm makes over-cap ingest store forever; the pg test mutates exactly that and watches
 * the decline assertion go red.
 *
 * `capBytes: null` is UNMETERED — the caller has already declared it (the required
 * `storageCap` on `CommitDeps`; never inferred from absent config) — and the counter still
 * moves, unconditionally: accounting is not billing, and a number that is only right where a
 * cap is wired is a number nobody may trust.
 */
export async function reserveBodyBytes(
  tx: Tx, accountId: string, bytes: number, capBytes: number | null,
): Promise<boolean> {
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  if (capBytes === null) {
    await tx.update(accountStorage)
      .set({ bytes: sql`${accountStorage.bytes} + ${bytes}`, updatedAt: sql`now()` })
      .where(eq(accountStorage.accountId, accountId));
    return true;
  }
  const rows = await tx.update(accountStorage)
    .set({ bytes: sql`${accountStorage.bytes} + ${bytes}`, updatedAt: sql`now()` })
    .where(sql`${accountStorage.accountId} = ${accountId} and ${accountStorage.bytes} < ${capBytes}`)
    .returning({ bytes: accountStorage.bytes });
  return rows.length > 0;
}

/**
 * COMPENSATE a reservation whose body insert turned out to be a duplicate (`ON CONFLICT DO
 * NOTHING` inserted no row): the loser reserved bytes it will not store. Clamped with
 * `GREATEST(0, …)` so a compensation can never trip the `>= 0` CHECK — the row lock is already
 * held from the reserve, so this is the same lock, not a second ordering.
 */
export async function releaseBodyBytes(tx: Tx, accountId: string, bytes: number): Promise<void> {
  await tx.update(accountStorage)
    .set({ bytes: sql`greatest(0, ${accountStorage.bytes} - ${bytes})`, updatedAt: sql`now()` })
    .where(eq(accountStorage.accountId, accountId));
}

/**
 * Apply a byte DELTA for a body a repair pass rewrote in place (`sensitive-backfill`,
 * `redacted-restore`: old body out, fresh body in — delta = fresh − old). Ensures the row (an
 * account whose bodies all predate 0062's backfill still gets a row), clamps at zero so a
 * negative drift computed against a pre-backfill row can never abort the REPAIR the pass
 * exists to make — the counter self-corrects upward from the floor, and the backfill re-run
 * recomputes it exactly. Call it BEFORE the transaction's `recordChange` (the lock order).
 */
export async function applyBodyBytesDelta(tx: Tx, accountId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  await tx.update(accountStorage)
    .set({ bytes: sql`greatest(0, ${accountStorage.bytes} + ${delta})`, updatedAt: sql`now()` })
    .where(eq(accountStorage.accountId, accountId));
}
