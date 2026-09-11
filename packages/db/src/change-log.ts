import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
/* THE MAIL HALF DIRECTLY, never `./schema.js`. `schema.ts` re-exports both halves, so naming it
 * here would put every Cloud table into the root barrel's closure — and the root barrel is what
 * the desktop engine's bundle follows. Both tables below are mail-domain. */
import { accountSyncState, changeLog } from "./schema-mail.js";
import { dialect } from "./dialect/index.js";

/**
 * A Drizzle query runner: either a top-level db handle (postgres-js in prod, PGlite in tests) or
 * an ambient transaction handle. Both expose the same query-builder surface, so change-log
 * writers are driver-agnostic and always operate on the AMBIENT `tx`, never a captured `this.db`.
 * This type does NOT mean "a transaction": it is right for a READ, and for a write whose
 * correctness does not depend on other statements committing with it. Anything that takes a row
 * lock or must commit two writes together wants {@link LedgerTx} — a lock taken on a top-level
 * handle is released at the end of its own statement and serializes nothing.
 */
export type Tx = PgDatabase<any, any, any>;

/**
 * A REAL transaction handle — the value `db.transaction((tx) => …)` hands its callback.
 *
 * Distinct from {@link Tx} on purpose: a top-level `PgDatabase` is not assignable here, so
 * `debitCredits(db, …)` does not compile. Use it for every primitive whose guarantees rest on
 * a row lock outliving the statement that took it, or on several writes becoming durable
 * together. (`liveSubscriptionOf(…, { forUpdate: true })` has the same requirement; it keeps
 * `Tx` because the same function serves the ordinary read path.)
 */
export type LedgerTx = PgTransaction<any, any, any>;

/** Thrown when a change-log writer is handed an autocommit handle. See {@link assertLedgerTx}. */
export class NotInTransactionError extends Error {
  constructor(fn: string) {
    super(
      `${fn} must be called inside db.transaction(...): a top-level handle auto-commits the seq ` +
      "allocation before the change_log row is inserted, so a polling client can advance past a " +
      "seq that is not there yet and never see it",
    );
    this.name = "NotInTransactionError";
  }
}

/**
 * The RUNTIME half of the transaction requirement, for the seam the type cannot reach. {@link
 * LedgerTx} makes `recordChange(db, …)` uncompilable, which covers every direct caller. It cannot
 * cover `DrizzleRepo`, whose one `db` field is legitimately either a top-level handle (reads) or
 * a transaction handle (inside `repo.transaction(...)`), so its `recordChange` has to cast — this
 * refuses the cast, the `as any`, and the JavaScript caller with it; `credits.ts` layers its own
 * transaction requirement the same way. Checked here, in the function that takes the row LOCK: a
 * lock on an autocommit handle is released at the end of its own statement and serializes
 * nothing.
 */
export function assertLedgerTx(tx: LedgerTx, fn: string): void {
  if (typeof (tx as unknown as { rollback?: unknown }).rollback !== "function") {
    throw new NotInTransactionError(fn);
  }
}

// The client-visible entity kinds that flow through `/sync`. Growing this union is not free: a
// type here without a matching case in `materialize` is worse than none — the materializer falls
// through to `null`, `SyncService` reads a null entity as a TOMBSTONE, and every row of the new
// kind drains to the client as a `delete`. Add a kind together with its materializer
// (`packages/services/src/dto/materialize.ts`) in the same change. Tag ASSIGNMENTS are not a type
// here: they ride the existing `message` entity — one change per toggle; a separate `message_tag`
// entity would mean two changes at two seqs, with a window where the client has the assignment
// but not the tag it names.
export type EntityType =
  | "message" | "thread" | "routing_decision" | "approval"
  | "draft" | "rule" | "message_state" | "folder"
  // Tag identity (name + hue). The assignment rides `message`; see above.
  | "tag"
  /**
   * The account's own settings row — added together with `materializeSettings`
   * (`packages/services/src/dto/materialize.ts`), the condition the rule above imposes. One row
   * per account, so `entity_id` is the ACCOUNT id and the op is always `"update"` (created lazily
   * by whichever knob writes first, never deleted). The change exists so a settings write rings
   * the wake channel and travels the delta feed: without it, a consent flip made on one surface
   * reached other signed-in surfaces only at their next full boot. The entity carries the row's
   * scalars, but the AUTHORITY stays `GET /consent` — clients treat the change as "re-ask now",
   * not a second consent read, so the two doors cannot drift.
   */
  | "settings";

export type ChangeOp = "create" | "update" | "move" | "delete";

export interface ChangeInput {
  accountId: string;
  entityType: EntityType;
  entityId: string;
  op: ChangeOp;
  meta?: { from: string | null; to: string } | null;
}

/**
 * THE WAKE CHANNEL — one `NOTIFY` per {@link recordChanges} call, on ONE shared channel, emitted
 * from the append chokepoint so every writer signals (`change-notify-chokepoint.test.ts` proves
 * nothing else inserts into `change_log`). A NOTIFY inside the transaction is delivered AT COMMIT
 * — after the row is durable, never for a rollback. One channel plus payload filtering, not a
 * channel per account: a listener holds ONE session-mode connection per instance and fans out in
 * process. The payload is `<account uuid>:<max seq>` and NEVER content: NOTIFY payloads surface
 * in `pg_stat_activity` and server logs, and no log may carry mail content. A wake's answer is
 * `GET /sync?since=cursor`.
 */
export const CHANGE_LOG_CHANNEL = "ohmail_change_log";

/** The NOTIFY payload for one appended batch. Account id and seq — never content. */
export function changeWakePayload(accountId: string, seq: bigint): string {
  return `${accountId}:${seq}`;
}

/** A parsed wake, or `null` for anything malformed (a foreign writer on the channel). */
export function parseChangeWake(payload: string): { accountId: string; seq: bigint } | null {
  const at = payload.lastIndexOf(":");
  if (at <= 0 || at === payload.length - 1) return null;
  const accountId = payload.slice(0, at);
  const raw = payload.slice(at + 1);
  if (!/^\d+$/.test(raw)) return null;
  return { accountId, seq: BigInt(raw) };
}

/**
 * Allocate the next per-account, gap-free, strictly-monotonic sequence number. The UPDATE's
 * implicit ROW LOCK is the serialization: a concurrent allocator blocks on the row until this
 * transaction commits — not an advisory lock, not a bigserial (both leak gaps). A guard INSERT
 * creates the counter row on first use. `greatest(next_seq, max(seq))` reconciles the counter
 * against the log: a counter below the log's maximum hard-fails permanently (23505 on every
 * write, nothing self-corrects); a restore lands exactly that state. On an autocommit handle the
 * UPDATE releases the lock before the caller's insert: seq 6 can commit before 5 exists, and a
 * client past 5 misses that entity forever — hence {@link LedgerTx} and {@link assertLedgerTx}.
 */
export async function allocateSeq(tx: LedgerTx, accountId: string): Promise<bigint> {
  const [first] = await allocateSeqRange(tx, accountId, 1);
  return first!;
}

/**
 * Allocate `count` CONSECUTIVE sequence numbers in one statement, oldest first. One round trip
 * instead of `count`, and one row-lock acquisition instead of `count`: a caller writing hundreds
 * of change-log rows in one transaction (the sent-mail seed confirms one rule per correspondent,
 * and real mailboxes carry thousands) otherwise pays three statements per row — on a serverless
 * host the difference between answering and being killed at the deadline. Reserved by the same
 * UPDATE {@link allocateSeq} uses, so the guarantees are identical: strictly monotonic, gap-free,
 * serialized by the row lock. `count` must be positive; a caller with nothing to record must not
 * take the lock at all.
 */
export async function allocateSeqRange(tx: LedgerTx, accountId: string, count: number): Promise<bigint[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`allocateSeqRange: count must be a positive integer, got ${String(count)}`);
  }
  assertLedgerTx(tx, "allocateSeqRange");
  await tx.insert(accountSyncState).values({ accountId }).onConflictDoNothing();
  const rows = await tx
    .update(accountSyncState)
    .set({
      nextSeq: sql`${dialect(tx).greatest(
        accountSyncState.nextSeq,
        sql`coalesce((select max(${changeLog.seq}) from ${changeLog} where ${changeLog.accountId} = ${accountId}), 0)`,
      )} + ${count}`,
    })
    .where(eq(accountSyncState.accountId, accountId))
    .returning({ nextSeq: accountSyncState.nextSeq });
  // `next_seq` now names the LAST seq of the block; the block is the `count` values ending there.
  const last = rows[0]!.nextSeq;
  const out: bigint[] = [];
  for (let i = BigInt(count) - 1n; i >= 0n; i--) out.push(last - i);
  return out;
}

/**
 * Allocate a seq and append the corresponding `change_log` row in the SAME
 * transaction (allocateSeq + change_log insert + entity write commit as one).
 * Returns the assigned seq (→ the `X-Sync-Seq` response header).
 *
 * MUST be called with the ambient transaction handle.
 */
export async function recordChange(tx: LedgerTx, c: ChangeInput): Promise<bigint> {
  const [seq] = await recordChanges(tx, [c]);
  return seq!;
}

/**
 * Append MANY change-log rows in one allocation and one insert, in the order given. The same
 * contract as {@link recordChange} — every seq allocated from the account's counter inside the
 * ambient transaction — with the per-row round trips collapsed. A loop over `recordChange` spent
 * three statements per entity, and the cost is not merely latency: the counter row stays locked
 * from the first allocation to commit, so a long loop blocks every other writer on the account.
 * Returns the assigned seqs, positionally. An empty list writes nothing and takes no lock.
 */
/**
 * How many change rows one INSERT carries. Six bind parameters per row against PostgreSQL's
 * 65 535-parameter ceiling puts the hard wall at 10 923; this leaves room for a column to be
 * added without moving the wall onto a caller. See the loop in {@link recordChanges}.
 */
const CHANGE_INSERT_CHUNK = 5_000;

export async function recordChanges(tx: LedgerTx, changes: readonly ChangeInput[]): Promise<bigint[]> {
  if (changes.length === 0) return [];
  const accountId = changes[0]!.accountId;
  // One account per call: the seqs come from ONE counter, so a mixed list would silently
  // stamp another account's rows with this account's sequence.
  for (const c of changes) {
    if (c.accountId !== accountId) throw new Error("recordChanges: every change must name the same account");
  }
  const seqs = await allocateSeqRange(tx, accountId, changes.length);
  const rows = changes.map((c, i) => ({
    accountId,
    seq: seqs[i]!,
    entityType: c.entityType,
    entityId: c.entityId,
    op: c.op,
    meta: c.meta ?? null,
  }));
  // One statement per chunk, because a bind list has a ceiling: each row binds SIX parameters and
  // PostgreSQL allows 65 535 per statement, so 10 923 rows is the wall — past it the INSERT
  // errors outright. It became reachable when a mailbox removal started closing every pending
  // appointment in one transaction; there the failure rolls back the tombstone AND the credential
  // delete identically on every retry, so the mailbox becomes impossible to remove, and the batch
  // size is a property of the account's data. The chunk sits well under the ceiling so a future
  // column does not silently move the wall. Seqs are allocated ONCE above and sliced here, so
  // rows keep their reserved numbers whatever the chunking does, and the single NOTIFY below
  // still names the highest.
  for (let i = 0; i < rows.length; i += CHANGE_INSERT_CHUNK) {
    await tx.insert(changeLog).values(rows.slice(i, i + CHANGE_INSERT_CHUNK));
  }
  // The wake, INSIDE the transaction — Postgres queues it and delivers at COMMIT, so a listener
  // is never woken for a row that rolled back, and never before the row it names is readable.
  // One notification per batch (the highest seq), account id + seq only: see
  // {@link CHANGE_LOG_CHANNEL} for the channel design and why no content may ever ride here.
  await dialect(tx).notify(
    tx, CHANGE_LOG_CHANNEL, changeWakePayload(accountId, seqs[seqs.length - 1]!),
  );
  return seqs;
}

/** Both ends of an account's retained change log. Both `null` ⇔ the log is empty. */
export interface SeqBounds {
  /** The lowest retained seq — the floor a resuming cursor must not have fallen below. */
  min: bigint | null;
  /** The highest committed seq — the ceiling no legitimate cursor can be above. */
  max: bigint | null;
}

/**
 * The two horizons of an account's change log, from ONE statement. `SyncService.getChanges` needs
 * both on every resuming request: a cursor below `min` names changes that no longer exist, above
 * `max` changes that never existed — both unrecoverable, both 410, the client re-snapshots. One
 * aggregate rather than two round trips is a correctness property: floor and ceiling come from
 * the same read, so they cannot disagree about which side of the window a cursor sits on. No
 * transaction, no lock: `change_log` is append-only (the sole delete is account erasure), so
 * `max` never falls and `min` only rises — a concurrent writer can only WIDEN the window, turning
 * a would-be 410 into a plain empty 200, never the reverse.
 */
export async function seqBounds(tx: Tx, accountId: string): Promise<SeqBounds> {
  const rows = await tx
    .select({
      min: sql<string | null>`min(${changeLog.seq})`,
      max: sql<string | null>`max(${changeLog.seq})`,
    })
    .from(changeLog)
    .where(eq(changeLog.accountId, accountId));
  const row = rows[0];
  return {
    min: row?.min == null ? null : BigInt(row.min),
    max: row?.max == null ? null : BigInt(row.max),
  };
}

/**
 * The lowest `seq` still retained in the change log for an account, or `null`
 * when the log is empty. SyncService uses this to detect a cursor that has
 * fallen behind the retention horizon (→ 410 cursor_expired).
 *
 * Delegates to {@link seqBounds} so there is ONE query behind both horizons; a second copy of
 * the aggregate is a second place for the account predicate to be got wrong.
 */
export async function minRetainedSeq(tx: Tx, accountId: string): Promise<bigint | null> {
  return (await seqBounds(tx, accountId)).min;
}
