import { sql, eq, inArray } from "drizzle-orm";
import { accountStorage, messageBodies, messages } from "./schema-mail.js";
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
 * write; LOCK ORDER: the `account_storage` row before the first `recordChange`, everywhere. A mailbox
 * erase step takes it after the mailbox row and before its receipts ({@link lockAccountStorage}).
 * The same writers keep the counter's facts on that row (mail 0166): the trim, a letter withheld
 * for space on arrival and the erase move the count of letters emptied for space. Only the trim
 * moves the month text is kept from; a letter withheld on arrival past it is counted apart. The
 * recount rewrites the counts from the bodies, never moves the month later (it may pull it back to
 * the newest emptied letter before it), and says how far the counter had drifted.
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
 * already held from the reserve, so this is the same lock, not a second ordering. `emptied` is how
 * many deleted letters had been emptied for space (the erase), taken off their count, clamped too;
 * the letters withheld on arrival are never more than that count (the erase cannot tell which it took).
 */
export async function releaseBodyBytes(
  tx: Tx, d: Dialect, accountId: string, bytes: number, emptied = 0,
): Promise<void> {
  const left = d.greatest(sql`0`, sql`${accountStorage.huskedForSpace} - ${emptied}`);
  await tx.update(accountStorage)
    .set({
      bytes: d.greatest(sql`0`, sql`${accountStorage.bytes} - ${bytes}`),
      ...(emptied > 0
        ? {
          huskedForSpace: left,
          withheldOnArrival: sql`case when ${accountStorage.withheldOnArrival} < ${left} then ${accountStorage.withheldOnArrival} else ${left} end`,
        }
        : {}),
      updatedAt: d.now(),
    })
    .where(eq(accountStorage.accountId, accountId));
}

/**
 * A letter that ARRIVED at the cap and was stored withheld for space (`insertMessageBody`, after
 * its row was inserted): one more letter whose text is not held. It never moves `kept_from`: only
 * the trim does, past letters it emptied. Dated on or after it (or with none recorded), it is counted
 * apart as withheld on arrival, the letters the month's sentence must except.
 */
export async function recordWithheldForSpace(tx: Tx, d: Dialect, accountId: string, messageId: string): Promise<void> {
  const [counter] = await d.forUpdate(tx.select({ keptFrom: accountStorage.keptFrom }).from(accountStorage)
    .where(eq(accountStorage.accountId, accountId)));
  const [letter] = await tx.select({ at: sql<Date>`coalesce(${messages.date}, ${messages.createdAt})`.mapWith(messages.createdAt) })
    .from(messages).where(eq(messages.id, messageId));
  const past = onOrAfterKeptFrom(counter?.keptFrom ?? null, letter?.at ?? null);
  await tx.update(accountStorage)
    .set({
      huskedForSpace: sql`${accountStorage.huskedForSpace} + 1`,
      ...(past ? { withheldOnArrival: sql`${accountStorage.withheldOnArrival} + 1` } : {}),
    })
    .where(eq(accountStorage.accountId, accountId));
}

/** `kept_from` ('YYYY-MM-DD', a UTC day) as the instant it starts; null for none. */
function keptFromInstant(keptFrom: string | null): Date | null {
  if (keptFrom === null) return null;
  const [y, m, d] = keptFrom.slice(0, 10).split("-").map(Number);
  // setUTCFullYear, not Date.UTC: a two-digit year stays that year.
  const at = new Date(0);
  at.setUTCFullYear(y!, m! - 1, d!);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** Is a letter dated `at` on or after `kept_from`? Every letter is while none is recorded; an unreadable date counts too. */
function onOrAfterKeptFrom(keptFrom: string | null, at: Date | null): boolean {
  const from = keptFromInstant(keptFrom);
  if (from === null || at === null || !Number.isFinite(at.getTime())) return true;
  return at.getTime() >= from.getTime();
}

/**
 * The first day of the calendar month (UTC) AFTER an instant: `kept_from` for a newest emptied letter
 * dated then, so every letter dated on or after it still holds its text. Null for none.
 */
export function monthAfterOf(at: Date | null): string | null {
  if (at === null || !Number.isFinite(at.getTime())) return null;
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const year = next.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** `kept_from` once a letter dated `emptied` is emptied: never earlier than it was ('YYYY-MM-DD' sorts). */
function keptFromPast(current: string | null, emptied: Date | null): string | null {
  const after = monthAfterOf(emptied);
  if (after === null) return current;
  return current !== null && current > after ? current : after;
}

/** What the person's own client is told about their stored letters (`GET /account/access`). */
export interface StorageFacts {
  usedBytes: number;
  emptiedForSpace: number;
  /** ISO instant of the first trim that emptied a letter; null when none is recorded. */
  firstEmptiedAt: string | null;
  /** "YYYY-MM": text is kept for letters from this month on, but the `withheldOnArrival` ones; null for none. */
  keptFrom: string | null;
  /** Of `emptiedForSpace`, the letters stored without their text because they arrived while the storage was full. */
  withheldOnArrival: number;
}

/** One primary-key read of the account's counter row; no row reads as nothing stored. */
export async function storageFactsOf(tx: Tx, accountId: string): Promise<StorageFacts> {
  const [row] = await tx.select({
    bytes: accountStorage.bytes, husked: accountStorage.huskedForSpace, first: accountStorage.firstHuskedAt,
    keptFrom: accountStorage.keptFrom, onArrival: accountStorage.withheldOnArrival,
  }).from(accountStorage).where(eq(accountStorage.accountId, accountId)).limit(1);
  const first = row?.first == null ? null : new Date(row.first as Date | string);
  return {
    usedBytes: Number(row?.bytes ?? 0),
    emptiedForSpace: Number(row?.husked ?? 0),
    firstEmptiedAt: first === null || !Number.isFinite(first.getTime()) ? null : first.toISOString(),
    keptFrom: row?.keptFrom == null ? null : String(row.keptFrom).slice(0, 7),
    withheldOnArrival: Number(row?.onArrival ?? 0),
  };
}

/** Make the account's counter row exist and lock it; returns the bytes read under the lock. */
export async function lockAccountStorage(tx: Tx, d: Dialect, accountId: string): Promise<number> {
  await tx.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
  const rows = await d.forUpdate(tx.select({ bytes: accountStorage.bytes }).from(accountStorage)
    .where(eq(accountStorage.accountId, accountId)));
  return Number(rows[0]?.bytes ?? 0);
}

/** What one recount found and wrote ({@link recomputeAccountStorage}). */
export interface AccountRecount {
  /** The stored letters' real bytes, now the counter. */
  bytes: number;
  /** The counter as it stood under the lock, minus `bytes`: what had drifted. */
  drift: number;
  /** Letters whose text is not held for space. */
  huskedForSpace: number;
  /**
   * The first day of the month after the newest emptied letter dated before the month the trim
   * recorded: never later than that month, null when none is recorded or no emptied letter precedes it.
   */
  keptFrom: string | null;
  /**
   * Of those letters, the ones dated on or after the month the trim recorded: withheld on arrival,
   * never trimmed. While no month is recorded, the count kept on arrival, clamped to `huskedForSpace`.
   */
  withheldOnArrival: number;
}

/**
 * Recompute the account's counter from `message_bodies`, race-safely, and write what it found: the
 * bytes, the letters emptied for space, the month text is kept from, when (`now`), and the drift.
 * The migration's backfill statement is NOT it: repeated while mail is arriving it has a
 * lost-update hole — its `SELECT SUM` fixes the value from its own snapshot, a worker then commits
 * a body AND its reservation, and the conflict arm writes the STALE sum, erasing the reservation.
 * The fix is the LOCK ORDER: take the counter row's lock FIRST, then compute — under READ
 * COMMITTED the aggregate runs on a snapshot taken AFTER the lock, so every committed reservation
 * is visible and every in-flight one is blocked behind us. The lock and the aggregate are separate
 * statements deliberately: folding them into one restores the snapshot-before-lock shape this
 * removes. The write is a third, still under the lock, so nothing can land between.
 */
export async function recomputeAccountStorage(
  tx: Tx, d: Dialect, accountId: string, now: Date,
): Promise<AccountRecount> {
  // The row must EXIST before it can be locked — an account whose bodies all predate 0062 has no
  // row, and a row lock locks nothing rather than waiting for one to appear.
  const locked = await lockAccountStorage(tx, d, accountId);
  // The month the trim recorded, read under that lock. The bodies cannot tell a trimmed letter from
  // one withheld on arrival, so the recount never moves the month later; it pulls it back to the
  // newest emptied letter before it, and counts the emptied letters from it on as withheld on arrival.
  const [row] = await tx.select({ keptFrom: accountStorage.keptFrom, onArrival: accountStorage.withheldOnArrival })
    .from(accountStorage).where(eq(accountStorage.accountId, accountId));
  const from = keptFromInstant(row?.keptFrom ?? null);
  const at = sql`coalesce(${messages.date}, ${messages.createdAt})`;
  const capped = sql`${messageBodies.withheldReason} = 'storage_cap'`;
  // One aggregate through the builder, which decodes the instant with the column's own mapper on
  // either store.
  const [real] = await tx.select({
    bytes: sql<number>`coalesce(sum(octet_length(${messageBodies.text}) + coalesce(octet_length(${messageBodies.html}), 0)), 0)`
      .mapWith(Number),
    husked: sql<number>`coalesce(sum(case when ${capped} then 1 else 0 end), 0)`.mapWith(Number),
    newestBefore: (from === null ? sql<Date | null>`null`
      : sql<Date | null>`max(case when ${capped} and ${at} < ${d.ts(from)} then ${at} end)`).mapWith(messages.createdAt),
    fromOn: (from === null ? sql<number>`0`
      : sql<number>`coalesce(sum(case when ${capped} and ${at} >= ${d.ts(from)} then 1 else 0 end), 0)`).mapWith(Number),
  }).from(messageBodies)
    .innerJoin(messages, eq(messages.id, messageBodies.messageId))
    .where(eq(messages.accountId, accountId));
  const husked = real?.husked ?? 0;
  const found: AccountRecount = {
    bytes: real?.bytes ?? 0,
    drift: locked - (real?.bytes ?? 0),
    huskedForSpace: husked,
    keptFrom: from === null ? null : monthAfterOf(real?.newestBefore ?? null),
    // With no month recorded the arrivals cannot be told apart: the count stands, clamped.
    withheldOnArrival: from === null ? Math.min(Number(row?.onArrival ?? 0), husked) : real?.fromOn ?? 0,
  };
  await tx.update(accountStorage).set({
    bytes: found.bytes, huskedForSpace: found.huskedForSpace, keptFrom: found.keptFrom,
    withheldOnArrival: found.withheldOnArrival,
    recountedAt: now, recountDrift: found.drift, updatedAt: d.now(),
  }).where(eq(accountStorage.accountId, accountId));
  return found;
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
  const locked = await d.forUpdate(tx.select({
    bytes: accountStorage.bytes, husked: accountStorage.huskedForSpace,
    first: accountStorage.firstHuskedAt, keptFrom: accountStorage.keptFrom,
  }).from(accountStorage).where(eq(accountStorage.accountId, accountId)));
  const bytes = Number(locked[0]?.bytes ?? 0);
  if (bytes <= opts.targetBytes) {
    return { evicted: 0, freedBytes: 0, bytesAfter: bytes, more: false };
  }

  // The victims, oldest first, with the exact octets each will free — the same
  // `octet_length(text) + octet_length(html)` sum every other counter movement uses — and each
  // one's date. Through the seam's `exec`, whose rows are POSITIONAL, in the order selected.
  const victimRows = await d.exec(tx, sql`
    select b."id" as id,
           (octet_length(b."text") + coalesce(octet_length(b."html"), 0)) as freed,
           coalesce(m."date", m."created_at") as at
      from message_bodies b
      join messages m on m."id" = b."message_id"
     where m."account_id" = ${accountId}
       and b."withheld_reason" is null
       and (octet_length(b."text") > 0 or b."html" is not null)
     order by coalesce(m."date", m."created_at") asc, m."id" asc
     limit ${opts.maxBodies}`);
  const victims = victimRows.map((r) => ({ id: String(r[0]), freed: Number(r[1]), at: r[2] }));

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
  // The counter and its facts in one update, on the lock taken above: the bytes freed (clamped
  // like every release), the letters emptied, the latest time, the first only when nothing was
  // counted before (a count the release filled has no first time to make up), and kept_from past
  // the newest letter chosen (the page is oldest first).
  const prior = locked[0];
  const newest = victims[chosen.length - 1]!;
  await tx.update(accountStorage)
    .set({
      bytes: d.greatest(sql`0`, sql`${accountStorage.bytes} - ${freed}`),
      huskedForSpace: sql`${accountStorage.huskedForSpace} + ${chosen.length}`,
      ...(prior?.first == null && Number(prior?.husked ?? 0) === 0 ? { firstHuskedAt: d.now() } : {}),
      lastHuskedAt: d.now(),
      // Decoded by the column's own mapper: an ISO text on the server, epoch milliseconds on a device.
      keptFrom: keptFromPast(prior?.keptFrom ?? null, messages.createdAt.mapFromDriverValue(newest.at as never) as Date),
      updatedAt: d.now(),
    })
    .where(eq(accountStorage.accountId, accountId));
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
