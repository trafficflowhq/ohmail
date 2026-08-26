import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
/* THE MAIL HALF DIRECTLY, never `./schema.js`. `schema.ts` re-exports both halves, so naming it
 * here would put every Cloud table into the root barrel's closure — and the root barrel is what
 * the desktop engine's bundle follows. Both tables below are mail-domain. */
import { accountSyncState, changeLog } from "./schema-mail.js";

/**
 * A Drizzle query runner: either a top-level db handle (postgres-js in prod,
 * PGlite in tests) or an ambient transaction handle. Both expose the same
 * query-builder surface, so change-log writers are driver-agnostic and
 * always operate on the AMBIENT `tx`, never a captured `this.db`.
 *
 * **This type does NOT mean "a transaction".** It is the right type for a READ, and for a
 * write whose correctness does not depend on other statements committing with it. Anything
 * that takes a row lock, or that must commit two writes together, wants {@link LedgerTx} —
 * a lock taken on a top-level handle is released at the end of its own statement and
 * serializes nothing.
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
 * The RUNTIME half of the transaction requirement, for the seam the type cannot reach.
 *
 * {@link LedgerTx} makes `recordChange(db, …)` uncompilable, which covers every direct caller —
 * and there are around twenty. It cannot cover `DrizzleRepo`, whose ONE `db` field is
 * legitimately either a top-level handle (for the reads) or a transaction handle (inside
 * `repo.transaction(...)`), so its `recordChange` has to cast. This is what refuses the cast, and
 * the `as any` and the JavaScript caller with it. `credits.ts` layers its own transaction
 * requirement exactly this way and for the same reason.
 *
 * Checked here, in the function that takes the row LOCK, rather than in each entry point: a lock
 * on an autocommit handle is released at the end of its own statement and serializes nothing, so
 * this is the statement whose correctness the transaction actually buys.
 */
export function assertLedgerTx(tx: LedgerTx, fn: string): void {
  if (typeof (tx as unknown as { rollback?: unknown }).rollback !== "function") {
    throw new NotInTransactionError(fn);
  }
}

// The client-visible entity kinds that flow through `/sync`.
//
// GROWING THIS UNION IS NOT FREE, AND HERE IS WHY. The rule is not "never add a type" — it is
// that a type here without a matching case in `materialize` is worse than no type at all: the
// materializer falls through to `null`, and `SyncService` reads a null entity as a TOMBSTONE, so
// every row of the new kind would drain to the client as a `delete`. `"tag"` is added together
// with `materializeTag` (`packages/services/src/dto/materialize.ts`) in the same change, which is
// the condition this rule actually imposes.
//
// TAG ASSIGNMENTS ARE NOT A TYPE HERE. They ride the existing `"message"` entity: an assign or
// unassign emits one `message` change and the client re-reads that message's `labels`. A
// separate `message_tag` entity would have meant two changes per toggle at two seqs, with a
// window in which the client had the assignment but not the tag it names.
export type EntityType =
  | "message" | "thread" | "routing_decision" | "approval"
  | "draft" | "rule" | "message_state" | "folder"
  // Tag identity (name + hue). The assignment rides `message`; see above.
  | "tag"
  /**
   * THE ACCOUNT'S OWN SETTINGS ROW — added together with `materializeSettings`
   * (`packages/services/src/dto/materialize.ts`), which is the condition the rule above imposes.
   *
   * One row per account, so `entity_id` is the ACCOUNT id and the op is always `"update"` (the
   * row is created lazily by whichever knob writes first, and it is never deleted). The change
   * exists so that a settings write RINGS THE WAKE CHANNEL and travels the delta feed like any
   * other state: without it, a consent/settings flip made on one surface reached every other
   * signed-in surface only at its next full boot — the desktop showed a folders group the
   * account had just switched off until the app was restarted. The entity carries the row's own
   * scalars (a stamp plus the flags surfaces gate on), but the AUTHORITY for what a client shows
   * stays `GET /consent` — clients treat the change as "re-ask now", not as a second consent
   * read, so the two doors cannot drift.
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
 * THE WAKE CHANNEL — one `NOTIFY` per {@link recordChanges} call, on ONE shared channel.
 *
 * Emitted from the append chokepoint so that EVERY writer signals: the worker's ingest, the
 * API's record-at-send, the screener, triage, the sidecar's local mirror — they all funnel
 * through `recordChanges`, and `change-notify-chokepoint.test.ts` proves nothing else inserts
 * into `change_log`. A NOTIFY issued inside the transaction is queued by Postgres and delivered
 * AT COMMIT — after the row is durable, never for a rollback — which is exactly the contract a
 * "drain now" hint needs.
 *
 * ── ONE CHANNEL + PAYLOAD FILTERING, NOT A CHANNEL PER ACCOUNT ─────────────────────────────
 *
 * A listener holds ONE session-mode connection per serving instance and fans out in process.
 * With per-account channels that connection would have to `LISTEN`/`UNLISTEN` on every stream
 * open/close — each a round trip serialized on the one connection, with a race window between
 * subscribing and the first delivery, and `pg_listening_channels()` churn for nothing: Postgres
 * delivers a notification to every listening BACKEND anyway, so account channels save no server
 * work, they only move the filter from a Map lookup into connection state. One static channel is
 * one `LISTEN` at connect (trivially re-issued on reconnect) and a pure in-process dispatch. The
 * payload volume argument is also nothing: one `uuid:seq` line per committed mutation batch.
 *
 * The name is namespaced by prefix rather than by schema because NOTIFY channels live in a flat
 * per-database namespace — there is no schema qualification to have — and it is identifier-safe
 * (no dots, no quoting) so every client (`LISTEN`, postgres-js `sql.listen`, psql) spells it the
 * same way.
 *
 * ── THE PAYLOAD CARRIES NO CONTENT, EVER ───────────────────────────────────────────────────
 *
 * `<account uuid>:<max seq of the batch>` and nothing else. NOTIFY payloads can surface in
 * `pg_stat_activity` and server logs, so a subject line or an address here would be mail
 * content in the log stream — which no log may ever carry. The seq lets a listener drop stale wakes
 * without a read; the client's answer to a wake is `GET /sync?since=cursor`, so the frame never
 * needs to carry an entity.
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
 * Allocate the next per-account, gap-free, strictly-monotonic sequence number.
 *
 *   UPDATE account_sync_state
 *   SET next_seq = greatest(next_seq, coalesce((SELECT max(seq) FROM change_log
 *                                               WHERE account_id = $1), 0)) + 1
 *   WHERE account_id = $1 RETURNING next_seq;
 *
 * The implicit ROW LOCK taken by the UPDATE is the serialization mechanism — a
 * concurrent allocator blocks on the same row until this transaction commits, so
 * seq N is durable before N+1 is ever handed out. This is NOT a pg advisory lock
 * and NOT a bare bigserial (both of which leak gaps under concurrency).
 *
 * A guard INSERT ensures the counter row exists on first use for an account; it
 * is a no-op once the row is present (the common, hot path), leaving the UPDATE
 * as the sole serializing step.
 *
 * ── WHY THE COUNTER IS RECONCILED AGAINST THE LOG ON EVERY ALLOCATION ─────────────────────
 *
 * `change_log`'s primary key is `(account_id, seq)`, so a counter that sits BELOW the log's
 * own maximum does not degrade — it hard-fails, permanently. Every allocation hands back a
 * seq that is already taken, the insert raises `23505`, and because the change-log write is
 * inside the caller's transaction the whole mutation rolls back. An account in that state
 * cannot ingest a message, write a rule or record a screening decision: every write path in
 * the product returns 500 and nothing self-corrects, because the counter is only ever moved
 * by the statement that is failing.
 *
 * The way it happens is not exotic. Any copy of the database that reads these two tables at
 * different instants while the account is in use — a restore, a move between providers — lands
 * a counter that is behind the log it was copied beside, and from then on every mutation on
 * that account fails. The breakage is silent in the sense that matters: nothing about it is
 * visible until somebody presses a button.
 *
 * `greatest(next_seq, max(seq))` closes it by construction, for any cause, at the cost of one
 * index probe: `max(seq) WHERE account_id = $1` is a single descending walk of the primary
 * key. Monotonicity is unaffected — the first arm alone already guarantees it, so the
 * reconciliation can only ever move the counter FORWARD, never re-issue, and never leave a
 * gap that was not already in the log.
 *
 * ── THE TRANSACTION IS NOT ADVICE, AND THE SIGNATURE NOW SAYS SO ──────────────────────────
 *
 * This used to read "MUST be called with the ambient transaction handle" and take `Tx`, which
 * accepts a top-level `PgDatabase`. On an autocommit handle the UPDATE above is its own
 * transaction: it commits, and RELEASES THE COUNTER ROW LOCK, before its caller inserts the
 * `change_log` row. So `recordChange(db, …)` for entity A can allocate 5, let a concurrent call
 * allocate 6 and commit `(acct, 6)`, and only then insert `(acct, 5)`. A client polling
 * `after=4` in that window sees 6, advances its cursor to 6, and asks `after=6` for ever — seq 5
 * exists and is unreachable, so that mirror is permanently missing entity A. A statement failure
 * between the two also leaves a permanent hole.
 *
 * {@link LedgerTx} is `PgTransaction`, so a top-level handle no longer compiles;
 * {@link assertLedgerTx} covers the one seam a type cannot. No production call site was passing
 * a bare handle — this closes the door rather than fixing a live defect, which is the cheapest
 * moment to do it.
 */
export async function allocateSeq(tx: LedgerTx, accountId: string): Promise<bigint> {
  const [first] = await allocateSeqRange(tx, accountId, 1);
  return first!;
}

/**
 * Allocate `count` CONSECUTIVE sequence numbers in one statement, oldest first.
 *
 * One round trip instead of `count` of them, and — more importantly — one row-lock
 * acquisition instead of `count`. A caller writing hundreds of change-log rows in a single
 * transaction (the sent-mail seed confirms one rule per correspondent, and real mailboxes
 * carry thousands) otherwise pays three statements per row, which on a serverless host is
 * the difference between a request that answers and one the platform kills at its deadline.
 *
 * The block is contiguous and reserved by the same UPDATE that {@link allocateSeq} uses, so
 * the guarantees are identical: strictly monotonic, gap-free, serialized against every
 * concurrent allocator on the account by the row lock this statement takes.
 *
 * `count` must be positive; a caller with nothing to record must not take the lock at all.
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
      nextSeq: sql`greatest(${accountSyncState.nextSeq}, coalesce((select max(${changeLog.seq}) from ${changeLog} where ${changeLog.accountId} = ${accountId}), 0)) + ${count}`,
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
 * Append MANY change-log rows in one allocation and one insert, in the order given.
 *
 * The same contract as {@link recordChange} — every row's seq is allocated from the account's
 * counter inside the ambient transaction — with the per-row round trips collapsed. A bulk
 * mutation that called `recordChange` in a loop spent three statements per entity, and the
 * cost is not merely latency: the account's counter row stays locked from the first
 * allocation to commit, so a long loop blocks every other writer on the account for its whole
 * duration. One allocation shortens that window to a single statement.
 *
 * Returns the assigned seqs, positionally. An empty list writes nothing and takes no lock.
 */
export async function recordChanges(tx: LedgerTx, changes: readonly ChangeInput[]): Promise<bigint[]> {
  if (changes.length === 0) return [];
  const accountId = changes[0]!.accountId;
  // One account per call: the seqs come from ONE counter, so a mixed list would silently
  // stamp another account's rows with this account's sequence.
  for (const c of changes) {
    if (c.accountId !== accountId) throw new Error("recordChanges: every change must name the same account");
  }
  const seqs = await allocateSeqRange(tx, accountId, changes.length);
  await tx.insert(changeLog).values(changes.map((c, i) => ({
    accountId,
    seq: seqs[i]!,
    entityType: c.entityType,
    entityId: c.entityId,
    op: c.op,
    meta: c.meta ?? null,
  })));
  // The wake, INSIDE the transaction — Postgres queues it and delivers at COMMIT, so a listener
  // is never woken for a row that rolled back, and never before the row it names is readable.
  // One notification per batch (the highest seq), account id + seq only: see
  // {@link CHANGE_LOG_CHANNEL} for the channel design and why no content may ever ride here.
  await tx.execute(
    sql`select pg_notify(${CHANGE_LOG_CHANNEL}, ${changeWakePayload(accountId, seqs[seqs.length - 1]!)})`,
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
 * THE TWO HORIZONS OF AN ACCOUNT'S CHANGE LOG, FROM ONE STATEMENT.
 *
 * `SyncService.getChanges` needs both on every resuming request: a cursor below `min` names
 * changes that no longer exist, and a cursor above `max` names changes that never existed. Both
 * are unrecoverable and both answer 410, so the client re-snapshots.
 *
 * ONE aggregate rather than two round trips, and that is a correctness property as well as a
 * cost one: the floor and the ceiling come from the same read of the same table, so they cannot
 * be evaluated against two different states of the log and disagree about which side of the
 * window a cursor sits on.
 *
 * No transaction and no lock. `change_log` is append-only in the product — the sole statement
 * that ever removes a row is the account erasure in `account-deletion-service.ts`, which takes
 * the account with it — so `max` is monotonically non-decreasing for any account that still has
 * a client, and `min` only ever rises. A concurrent writer between this read and the caller's
 * page read can therefore only widen the window, never narrow it, which is the direction that
 * turns a would-be 410 into a plain empty 200. The reverse — a false 410 on a healthy cursor —
 * would need `max` to go BACKWARDS, which no code path does.
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
