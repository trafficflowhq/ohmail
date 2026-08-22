import { sql, eq, inArray } from "drizzle-orm";
import { accountStorage, messageBodies } from "./schema-mail.js";
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
 * RECOMPUTE the account's counter from `message_bodies`, race-safely, in the caller's
 * transaction. Returns the value written.
 *
 * ── WHY THIS EXISTS, AND WHY THE MIGRATION'S OWN STATEMENT IS NOT IT ────────────────────────
 *
 * `0062_storage_accounting.sql`'s backfill is `INSERT … SELECT SUM(…) … ON CONFLICT DO UPDATE
 * SET bytes = excluded.bytes`. As a ONE-TIME migration on a quiesced schema that is correct, and
 * it is the historical record of what ran. As the REPEATABLE operation the runbook used to
 * describe ("re-run exactly this statement once after the worker deploy") it has a lost-update
 * hole, and the hole is open precisely when the re-run is prescribed — while mail is arriving:
 *
 *   1. the statement's `SELECT SUM(…)` fixes `excluded.bytes` from ITS OWN snapshot;
 *   2. a worker transaction then commits a body AND its `bytes = bytes + n` reservation;
 *   3. the backfill's conflict arm now waits for that row lock, gets it, and writes the STALE
 *      sum — silently erasing the reservation from step 2.
 *
 * The body stays stored and uncounted, so the account's effective allowance grows for ever, or
 * until some later full recomputation. Ordinary inbound mail during the prescribed re-run is
 * enough; nothing errors, and the counter looks plausible.
 *
 * ── THE FIX IS THE LOCK ORDER, NOT A BIGGER LOCK ────────────────────────────────────────────
 *
 * Take the counter row's lock FIRST, then compute. Under READ COMMITTED every statement takes a
 * fresh snapshot, so the aggregate below runs on a snapshot taken AFTER the lock was granted —
 * which means every reservation that committed before us is visible, and every reservation still
 * in flight is blocked on the row we hold and applies its delta after we commit. Both orderings
 * are then correct, which is the property the single-statement form cannot have: there, the
 * snapshot is taken before the lock is even requested.
 *
 * `SELECT … FOR UPDATE` and the aggregate are deliberately SEPARATE statements for that reason —
 * folding them into one would restore the very snapshot-before-lock shape this removes. Same
 * per-account row lock as {@link reserveBodyBytes}, so this introduces no new lock and no new
 * ordering: call it before the transaction's first `recordChange`, like every other writer here.
 */
export async function recomputeAccountStorage(tx: Tx, accountId: string): Promise<number> {
  // The row must EXIST before it can be locked — an account whose bodies all predate 0062 has no
  // row, and `FOR UPDATE` locks nothing rather than waiting for one to appear.
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  await tx.execute(sql`
    select 1 from ${accountStorage} where ${accountStorage.accountId} = ${accountId} for update`);
  const rows = await tx.execute<{ bytes: string }>(sql`
    update ${accountStorage}
       set bytes = coalesce((select sum(octet_length(b."text") + coalesce(octet_length(b."html"), 0))
                               from message_bodies b
                               join messages m on m."id" = b."message_id"
                              where m."account_id" = ${accountId}), 0),
           updated_at = now()
     where ${accountStorage.accountId} = ${accountId}
    returning bytes`);
  // Driver split, the credits precedent: postgres-js answers the array, PGlite `{ rows }`.
  const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Array<{ bytes: string }> }).rows;
  return Number((list as Array<{ bytes: string }>)[0]?.bytes ?? 0);
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

/**
 * ROLLING-WINDOW EVICTION (ratified 2026-08-21; replaces decline-new as the at-cap behaviour).
 *
 * At the storage cap the OLDEST stored bodies become husks — headers kept, content emptied,
 * `withheld_reason = 'storage_cap'` — so the hosted store holds a rolling window of the newest
 * mail and NEW bodies keep landing. The IMAP originals are never touched: eviction rewrites the
 * hosted COPY only, which is the same sentence the husk's `withheld_reason` already tells the
 * client ("not stored here; the original is in your mailbox"). The marker value is deliberately
 * the existing `'storage_cap'` — the REASON is the cap in both the declined-new and the evicted
 * case, only the mechanism differs — so every consumer of the marker (the client's withheld
 * sentence, the repair passes' skip rule, the 0062 CHECK) is already correct.
 *
 * Two layers share these primitives, and the split is the hysteresis:
 *
 *  · the WORKER's background pass (`apps/worker/src/storage-evict.ts`) trims accounts from
 *    {@link EVICT_HIGH_WATER_RATIO} of cap down to {@link EVICT_LOW_WATER_RATIO}, in bounded
 *    batches — so ingest almost always finds headroom and the band between the two marks is
 *    what stops trim/refill thrash;
 *  · the INGEST fallback ({@link reserveBodyBytesEvicting}) evicts just enough for the one
 *    body in front of it when a burst outruns the background pass, bounded by
 *    {@link EVICT_INLINE_MAX_BODIES}; past that bound the body is withheld exactly as the old
 *    decline-new behaviour withheld it — the pathological ceiling, not the ordinary path.
 *
 * LOCK ORDER: the counter row FIRST (`FOR UPDATE`), then the body rows — the same
 * counter-before-everything order every writer in this module keeps. The repair passes order
 * the other way around (body row, then delta), which is safe only because all per-account
 * worker passes run serially inside one cycle; the eviction pass is registered in that same
 * serial section, never as a global concurrent sweep.
 */

/** Trim starts once counted bytes reach this fraction of the cap… */
export const EVICT_HIGH_WATER_RATIO = 0.95;
/** …and stops at this one. The band between the two is the hysteresis. */
export const EVICT_LOW_WATER_RATIO = 0.90;
/** Most bodies one background eviction TRANSACTION husks — the bounded batch. */
export const EVICT_BATCH_BODIES = 500;
/** Most bodies the inline (ingest-path) fallback will husk to fit ONE new body. */
export const EVICT_INLINE_MAX_BODIES = 64;

export interface EvictionResult {
  /** Bodies husked by this call. */
  evicted: number;
  /** Counted bytes released. */
  freedBytes: number;
  /** The counter after the decrement. */
  bytesAfter: number;
  /** `true` ⇒ still above `targetBytes` AND stored bodies remain — call again. */
  more: boolean;
}

/**
 * Husk the account's OLDEST stored bodies until its counter is at or under `targetBytes`,
 * bounded by `maxBodies`, in the caller's transaction.
 *
 * "Oldest" is the message's own date (`coalesce(messages.date, messages.created_at)`) — the
 * order a person would recognise as their mail's age — with the id as the total-order
 * tiebreak. Victims are rows that actually hold content (`withheld_reason IS NULL` and a
 * non-empty text or a non-null html); husks and already-withheld rows are never re-processed.
 *
 * The counter row is locked FIRST and the aggregate of what was freed is decremented under
 * that same lock, clamped like every compensation here — so the counter can never describe a
 * state `message_bodies` is not in, and concurrent reserves serialize behind the trim exactly
 * as they serialize behind each other.
 */
export async function evictOldestBodies(
  tx: Tx, accountId: string, opts: { targetBytes: number; maxBodies: number },
): Promise<EvictionResult> {
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  const lockRows = await tx.execute<{ bytes: string }>(sql`
    select bytes from ${accountStorage} where ${accountStorage.accountId} = ${accountId} for update`);
  const lockList = Array.isArray(lockRows)
    ? lockRows : (lockRows as unknown as { rows: Array<{ bytes: string }> }).rows;
  const bytes = Number((lockList as Array<{ bytes: string }>)[0]?.bytes ?? 0);
  if (bytes <= opts.targetBytes) {
    return { evicted: 0, freedBytes: 0, bytesAfter: bytes, more: false };
  }

  // The victims, oldest first, with the exact octets each will free — the same
  // `octet_length(text) + octet_length(html)` sum every other counter movement uses.
  const victimRows = await tx.execute<{ id: string; freed: string }>(sql`
    select b."id" as id,
           (octet_length(b."text") + coalesce(octet_length(b."html"), 0)) as freed
      from message_bodies b
      join messages m on m."id" = b."message_id"
     where m."account_id" = ${accountId}
       and b."withheld_reason" is null
       and (octet_length(b."text") > 0 or b."html" is not null)
     order by coalesce(m."date", m."created_at") asc, m."id" asc
     limit ${opts.maxBodies}`);
  const victims = (Array.isArray(victimRows)
    ? victimRows : (victimRows as unknown as { rows: Array<{ id: string; freed: string }> }).rows
  ) as Array<{ id: string; freed: string }>;

  const need = bytes - opts.targetBytes;
  const chosen: string[] = [];
  let freed = 0;
  for (const v of victims) {
    if (freed >= need) break;
    chosen.push(v.id);
    freed += Number(v.freed);
  }
  if (chosen.length === 0) {
    return { evicted: 0, freedBytes: 0, bytesAfter: bytes, more: false };
  }

  await tx.update(messageBodies)
    .set({ text: "", html: null, withheldReason: "storage_cap" })
    .where(inArray(messageBodies.id, chosen));
  await releaseBodyBytes(tx, accountId, freed);
  const bytesAfter = Math.max(0, bytes - freed);
  return {
    evicted: chosen.length,
    freedBytes: freed,
    bytesAfter,
    // More work remains if the target is still ahead AND the victim page was full — a short
    // page means the account has no further stored bodies to give.
    more: bytesAfter > opts.targetBytes && victims.length === opts.maxBodies,
  };
}

/**
 * {@link reserveBodyBytes}, with the ROLLING WINDOW as its at-cap behaviour: when the reserve
 * refuses, husk just enough of the account's oldest stored bodies for THIS body to fit — never
 * more than {@link EVICT_INLINE_MAX_BODIES} — and try once more. Still `false` (the body is
 * withheld, the pre-ruling behaviour) only when even that bound cannot make room, which takes a
 * single body larger than everything {@link EVICT_INLINE_MAX_BODIES} messages hold: the
 * pathological ceiling, kept so one giant message cannot turn ingest into an unbounded sweep.
 *
 * The target leaves the incoming body's own bytes free UNDER the cap (`cap − bytes`), because
 * the reserve's predicate is `bytes < cap` before adding — freeing exactly to the cap would
 * still refuse.
 */
export async function reserveBodyBytesEvicting(
  tx: Tx, accountId: string, bytes: number, capBytes: number | null,
): Promise<boolean> {
  if (await reserveBodyBytes(tx, accountId, bytes, capBytes)) return true;
  if (capBytes === null) return false;   // unreachable: a null cap never refuses
  const target = Math.max(0, capBytes - bytes);
  await evictOldestBodies(tx, accountId, { targetBytes: target, maxBodies: EVICT_INLINE_MAX_BODIES });
  return reserveBodyBytes(tx, accountId, bytes, capBytes);
}
