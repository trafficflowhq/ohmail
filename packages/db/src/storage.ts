import { sql, eq, inArray } from "drizzle-orm";
import { accountStorage, messageBodies } from "./schema-mail.js";
import type { Dialect } from "./dialect/index.js";
import type { Tx } from "./change-log.js";

/**
 * Per-account stored-body accounting — the mail-schema half of the storage cap. The CLOUD half
 * lives in `storage-cloud.ts` (it reads `billing_subscriptions`); THIS module touches only
 * `account_storage` (mail 0062) and sits inside the desktop engine's closure. {@link bodyBytesOf}
 * is the ONE definition of what counts: `octet_length(text) + octet_length(html)`. Headers never
 * count (still written at cap); neither do snippets, attachment metadata or staging.
 * `Buffer.byteLength` is UTF-8 octets — the number the 0062 backfill aggregates in SQL; a pg test
 * holds the two together. Every writer moves the counter IN THE SAME TRANSACTION as the body
 * write; LOCK ORDER: the `account_storage` row before the first `recordChange`, everywhere.
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
 * Reserve `bytes` against the account's cap, atomically, in the caller's transaction. `true`:
 * store the body; `false`: at cap — write the withheld row. No advisory lock: an `INSERT … ON
 * CONFLICT DO NOTHING` makes the row exist, then ONE conditional `UPDATE … SET bytes = bytes + $n
 * WHERE bytes < $cap RETURNING` — the UPDATE takes the row lock, and a racer that finds `bytes >=
 * cap` matches no row, which IS the decline. The predicate tests BEFORE adding, so the message
 * that CROSSES the cap stores in full; the pg test mutates the WHERE arm and watches the decline
 * go red. `capBytes: null` is UNMETERED — declared by the caller, never inferred — and the
 * counter still moves: a number only right where a cap is wired is a number nobody may trust.
 */
export async function reserveBodyBytes(
  tx: Tx, d: Dialect, accountId: string, bytes: number, capBytes: number | null,
): Promise<boolean> {
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  if (capBytes === null) {
    await tx.update(accountStorage)
      .set({ bytes: sql`${accountStorage.bytes} + ${bytes}`, updatedAt: d.now() })
      .where(eq(accountStorage.accountId, accountId));
    return true;
  }
  const rows = await tx.update(accountStorage)
    .set({ bytes: sql`${accountStorage.bytes} + ${bytes}`, updatedAt: d.now() })
    .where(sql`${accountStorage.accountId} = ${accountId} and ${accountStorage.bytes} < ${capBytes}`)
    .returning({ bytes: accountStorage.bytes });
  return rows.length > 0;
}

/**
 * COMPENSATE a reservation whose body insert turned out to be a duplicate (`ON CONFLICT DO
 * NOTHING` inserted no row): the loser reserved bytes it will not store. Clamped at zero through
 * the seam's largest-of member so a compensation can never trip the `>= 0` CHECK — the row lock is
 * already held from the reserve, so this is the same lock, not a second ordering.
 */
export async function releaseBodyBytes(
  tx: Tx, d: Dialect, accountId: string, bytes: number,
): Promise<void> {
  await tx.update(accountStorage)
    .set({
      bytes: d.greatest(sql`0`, sql`${accountStorage.bytes} - ${bytes}`),
      updatedAt: d.now(),
    })
    .where(eq(accountStorage.accountId, accountId));
}

/**
 * Recompute the account's counter from `message_bodies`, race-safely. The migration's backfill
 * statement is NOT it: repeated while mail is arriving it has a lost-update hole — its `SELECT
 * SUM` fixes the value from its own snapshot, a worker then commits a body AND its reservation,
 * and the conflict arm writes the STALE sum, erasing the reservation. The fix is the LOCK ORDER:
 * take the counter row's lock FIRST, then compute — under READ COMMITTED the aggregate runs on a
 * snapshot taken AFTER the lock, so every committed reservation is visible and every in-flight
 * one is blocked behind us. The lock and the aggregate are separate statements deliberately:
 * folding them into one restores the snapshot-before-lock shape this removes.
 */
export async function recomputeAccountStorage(tx: Tx, d: Dialect, accountId: string): Promise<number> {
  // The row must EXIST before it can be locked — an account whose bodies all predate 0062 has no
  // row, and a row lock locks nothing rather than waiting for one to appear.
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  // THROUGH THE QUERY BUILDER, not as lock syntax inside the statement's text. The seam's member
  // takes a QUERY, so a raw fragment could not go through it — and a fragment member would be the
  // more dangerous shape, because it can be attached to a statement the server refuses to lock
  // while `forUpdate(q, { of })` can only be attached to a query and can name the table.
  await d.forUpdate(tx.select({ locked: accountStorage.accountId }).from(accountStorage)
    .where(eq(accountStorage.accountId, accountId)));
  // THROUGH THE SEAM'S `exec`, which is also what removed the driver split this used to carry.
  // Its rows are POSITIONAL — the narrower of the two shapes on purpose, because the server's
  // driver answers named objects and the device's answers arrays, and a helper passing each
  // through would compile everywhere and read correctly on exactly one store.
  const rows = await d.exec(tx, sql`
    update ${accountStorage}
       set bytes = coalesce((select sum(octet_length(b."text") + coalesce(octet_length(b."html"), 0))
                               from message_bodies b
                               join messages m on m."id" = b."message_id"
                              where m."account_id" = ${accountId}), 0),
           updated_at = ${d.now()}
     where ${accountStorage.accountId} = ${accountId}
    returning bytes`);
  return Number(rows[0]?.[0] ?? 0);
}

/**
 * Apply a byte DELTA for a body a repair pass rewrote in place (`sensitive-backfill`,
 * `redacted-restore`: old body out, fresh body in — delta = fresh − old). Ensures the row (an
 * account whose bodies all predate 0062's backfill still gets a row), clamps at zero so a
 * negative drift computed against a pre-backfill row can never abort the REPAIR the pass
 * exists to make — the counter self-corrects upward from the floor, and the backfill re-run
 * recomputes it exactly. Call it BEFORE the transaction's `recordChange` (the lock order).
 */
export async function applyBodyBytesDelta(
  tx: Tx, d: Dialect, accountId: string, delta: number,
): Promise<void> {
  if (delta === 0) return;
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  await tx.update(accountStorage)
    .set({
      bytes: d.greatest(sql`0`, sql`${accountStorage.bytes} + ${delta}`),
      updatedAt: d.now(),
    })
    .where(eq(accountStorage.accountId, accountId));
}

/**
 * Rolling-window eviction — the at-cap behaviour (2026-08-21), replacing decline-new. At the cap
 * the OLDEST stored bodies become husks — headers kept, content emptied, `withheld_reason =
 * 'storage_cap'` — so the hosted store holds a rolling window of the newest mail. The IMAP
 * originals are never touched: eviction rewrites the hosted COPY only. The marker is the existing
 * `'storage_cap'`, so every consumer is already correct. Two layers, split by hysteresis: the
 * background pass trims from the high-water ratio to the low; the ingest fallback evicts just
 * enough for the one body in front of it. LOCK ORDER: the counter row FIRST — the repair passes
 * order the other way, safe only because per-account passes run serially.
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
 * Husk the account's OLDEST stored bodies until its counter is at or under `targetBytes`, bounded
 * by `maxBodies`, in the caller's transaction. "Oldest" is the message's own date
 * (`coalesce(messages.date, messages.created_at)`) — the order a person recognises as their
 * mail's age — with the id as the total-order tiebreak. Victims are rows that actually hold
 * content; husks and already-withheld rows are never re-processed. The counter row is locked
 * FIRST and the freed aggregate is decremented under that same lock, clamped like every
 * compensation here — so the counter can never describe a state `message_bodies` is not in, and
 * concurrent reserves serialize behind the trim exactly as they serialize behind each other.
 */
export async function evictOldestBodies(
  tx: Tx, d: Dialect, accountId: string, opts: { targetBytes: number; maxBodies: number },
): Promise<EvictionResult> {
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  // The counter row's lock and its value in one query through the builder — see the note in
  // `recomputeAccountStorage`. It also drops the driver split this used to carry: the builder
  // returns rows, so there is no longer an array-or-`{rows}` shape to decide between.
  const locked = await d.forUpdate(tx.select({ bytes: accountStorage.bytes }).from(accountStorage)
    .where(eq(accountStorage.accountId, accountId)));
  const bytes = Number(locked[0]?.bytes ?? 0);
  if (bytes <= opts.targetBytes) {
    return { evicted: 0, freedBytes: 0, bytesAfter: bytes, more: false };
  }

  // The victims, oldest first, with the exact octets each will free — the same
  // `octet_length(text) + octet_length(html)` sum every other counter movement uses.
  // Through the seam's `exec`, whose rows are POSITIONAL — two columns, in the order selected.
  const victimRows = await d.exec(tx, sql`
    select b."id" as id,
           (octet_length(b."text") + coalesce(octet_length(b."html"), 0)) as freed
      from message_bodies b
      join messages m on m."id" = b."message_id"
     where m."account_id" = ${accountId}
       and b."withheld_reason" is null
       and (octet_length(b."text") > 0 or b."html" is not null)
     order by coalesce(m."date", m."created_at") asc, m."id" asc
     limit ${opts.maxBodies}`);
  const victims = victimRows.map((r) => ({ id: String(r[0]), freed: Number(r[1]) }));

  const need = bytes - opts.targetBytes;
  const chosen: string[] = [];
  let freed = 0;
  for (const v of victims) {
    if (freed >= need) break;
    chosen.push(v.id);
    freed += v.freed;
  }
  if (chosen.length === 0) {
    return { evicted: 0, freedBytes: 0, bytesAfter: bytes, more: false };
  }

  await tx.update(messageBodies)
    .set({ text: "", html: null, withheldReason: "storage_cap" })
    .where(inArray(messageBodies.id, chosen));
  await releaseBodyBytes(tx, d, accountId, freed);
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
 * pathological ceiling, kept so one giant message cannot turn ingest into an unbounded sweep. The
 * target leaves the incoming body's own bytes free UNDER the cap (`cap − bytes`): the reserve's
 * predicate is `bytes < cap` before adding, so freeing exactly to the cap would still refuse.
 */
export async function reserveBodyBytesEvicting(
  tx: Tx, d: Dialect, accountId: string, bytes: number, capBytes: number | null,
): Promise<boolean> {
  if (await reserveBodyBytes(tx, d, accountId, bytes, capBytes)) return true;
  if (capBytes === null) return false;   // unreachable: a null cap never refuses
  const target = Math.max(0, capBytes - bytes);
  await evictOldestBodies(tx, d, accountId, { targetBytes: target, maxBodies: EVICT_INLINE_MAX_BODIES });
  return reserveBodyBytes(tx, d, accountId, bytes, capBytes);
}
