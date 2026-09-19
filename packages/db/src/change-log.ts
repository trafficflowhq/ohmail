import { eq, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
/* THE MAIL HALF DIRECTLY, never `./schema.js`. `schema.ts` re-exports both halves, so naming it
 * here would put every Cloud table into the root barrel's closure — and the root barrel is what
 * the desktop engine's bundle follows. Both tables below are mail-domain. */
import { accountSyncState, changeLog, mailboxes } from "./schema-mail.js";
import { dialect } from "./dialect/index.js";
/* The seam owns the erasure class, and its own import of this file is TYPE-ONLY, so this edge
 * is one-way at runtime. */
import { MailboxErasedError } from "./erasure-fence.js";

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
  | "settings"
  /**
   * A MAILBOX THIS ACCOUNT NO LONGER HOLDS — emitted with op `"delete"` and nothing else, so it
   * needs no materializer (`getChanges` short-circuits a delete into the tombstone bucket). The
   * entity id is the MAILBOX's id and the row is the whole receipt; a client cascades its own
   * dependents from it. ONE ROW FOR A WHOLE MAILBOX: a mirror learns only from this log, so a
   * removal that appends nothing here leaves every client rendering the mailbox it removed. NOT
   * written by an ordinary disconnect — a soft `MailboxService.delete` keeps the mail; only the
   * two acts that take a mailbox's mail off the store emit it (`wipeLocalMirror`,
   * `sweepMailboxData`).
   */
  | "mailbox"
  /**
   * A BOUGHT SCREENER SUGGESTION — the narrow verdict entity (owner decision 2026-09-18,
   * reversing "no model output in /sync": the entity carries the chip's fields, never the
   * model's text — see `storeScreenerSuggestion`). The entity id is the `routing_decisions`
   * ROW id; a re-buy emits a delete for the replaced row and a create for the new one in the
   * same transaction, so a mirror never holds two live rows for one purchase. Materialized by
   * `materializeScreenerSuggestion` (`packages/services/src/dto/materialize.ts`), which is
   * provenance-scoped: a pipeline decision's id materializes null under this type.
   */
  | "screener_suggestion";

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
 * THE MAILBOX A WRITER IS COMMITTING INTO, asked BY the allocating statement — ONE READ, TWO
 * STAMPS, and no statement of its own: the allocation already runs in the commit's transaction
 * and already takes the row lock. `status` is the REMOVAL question and {@link answer} is the
 * caller's decider for it (`null` ⇔ no such mailbox row). `erased_at` is the ERASURE question,
 * and the seam decides that one here because it owns the class — a stamped row throws
 * {@link MailboxErasedError} before the caller is told anything, and the transaction this
 * statement ran in commits nothing. A door that hands this carrier over has asked BOTH.
 */
export interface MailboxMustBeLive {
  readonly mailboxId: string;
  answer(status: string | null): void;
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
 * Allocate `count` CONSECUTIVE sequence numbers in one statement, oldest first. One round trip and
 * one row-lock acquisition instead of `count`: a caller writing hundreds of change-log rows in one
 * transaction otherwise pays three statements per row — on a serverless host the difference between
 * answering and being killed at the deadline. Reserved by the same UPDATE {@link allocateSeq} uses,
 * so the guarantees are identical: strictly monotonic, gap-free, serialized by the row lock.
 * `count` must be positive; a caller with nothing to record must not take the lock at all.
 * `mustBeLive` is the ingest's removal fence riding along for free — see {@link MailboxMustBeLive};
 * absent, this sends the statement it has always sent.
 */
export async function allocateSeqRange(
  tx: LedgerTx, accountId: string, count: number, mustBeLive?: MailboxMustBeLive,
): Promise<bigint[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`allocateSeqRange: count must be a positive integer, got ${String(count)}`);
  }
  assertLedgerTx(tx, "allocateSeqRange");
  await tx.insert(accountSyncState).values({ accountId }).onConflictDoNothing();
  const d = dialect(tx);
  const bump = sql`${d.greatest(
    accountSyncState.nextSeq,
    sql`coalesce((select max(${changeLog.seq}) from ${changeLog} where ${changeLog.accountId} = ${accountId}), 0)`,
  )} + ${count}`;
  // THE FOLDED FORM, and only for a writer that asked: a data-modifying CTE is a PostgreSQL
  // shape, so the device store answers the same question from its own read below. A writer that
  // passes nothing reaches the ordinary UPDATE with the statement it has always sent.
  if (mustBeLive && d.name !== "sqlite") {
    return blockEndingAt(await allocateBesideTheFence(tx, d, accountId, bump, mustBeLive), count);
  }
  if (mustBeLive) {
    const read = await d.exec(tx, sql`select ${mailboxes.status} as status,
        ${mailboxes.erasedAt} as erased_at from ${mailboxes}
      where ${mailboxes.id} = ${mustBeLive.mailboxId} ${d.lockClause({ mode: "share" })}`);
    answerBothStamps(mustBeLive, read[0]?.[0], read[0]?.[1]);
  }
  const rows = await tx
    .update(accountSyncState)
    .set({ nextSeq: bump })
    .where(eq(accountSyncState.accountId, accountId))
    .returning({ nextSeq: accountSyncState.nextSeq });
  return blockEndingAt(rows[0]!.nextSeq, count);
}

/** `next_seq` names the LAST seq of the block; the block is the `count` values ending there. */
function blockEndingAt(last: bigint, count: number): bigint[] {
  const out: bigint[] = [];
  for (let i = BigInt(count) - 1n; i >= 0n; i--) out.push(last - i);
  return out;
}

/** The status column as the driver handed it back — no row, or no status, is `null`. */
function statusOf(value: unknown): string | null {
  return value == null ? null : String(value);
}

/**
 * The erasure first, then the caller's decider. In that order because the two stamps are not the
 * same kind of answer: an erased mailbox is refused HERE with the seam's own class, whatever the
 * caller would have made of the status beside it, and a caller that admits `disabled` (the
 * recovering cycle does) must not be handed a row whose mail has just been swept.
 */
function answerBothStamps(
  mustBeLive: MailboxMustBeLive, status: unknown, erasedAt: unknown,
): void {
  if (erasedAt != null) throw new MailboxErasedError(mustBeLive.mailboxId);
  mustBeLive.answer(statusOf(status));
}

/**
 * THE ALLOCATION AND THE FENCE IN ONE STATEMENT.
 *
 * `fence` takes the mailbox row at `share` — the same strength and the same lock the standing
 * read takes — and the UPDATE names it, so the row is held before the counter moves and no seq
 * is spent on a mailbox that is already gone. Both stamps come back beside `next_seq`, which is
 * what makes the fence free: one round trip for two questions that cost one each of their own.
 */
async function allocateBesideTheFence(
  tx: LedgerTx, d: ReturnType<typeof dialect>, accountId: string,
  bump: SQL, mustBeLive: MailboxMustBeLive,
): Promise<bigint> {
  const [row] = await d.exec(tx, sql`
    with fence as (
      select ${mailboxes.status} as status, ${mailboxes.erasedAt} as erased_at from ${mailboxes}
       where ${mailboxes.id} = ${mustBeLive.mailboxId} ${d.lockClause({ mode: "share" })}
    ), allocated as (
      update ${accountSyncState} set ${sql.identifier(accountSyncState.nextSeq.name)} = ${bump}
       where ${accountSyncState.accountId} = ${accountId} and exists (select 1 from fence)
      returning ${accountSyncState.nextSeq} as next_seq
    )
    select (select next_seq from allocated) as next_seq, (select status from fence) as status,
           (select erased_at from fence) as erased_at`);
  // Both stamps, BEFORE the seqs are believed: on either refusal it throws out of here and the
  // transaction this statement ran in commits nothing.
  answerBothStamps(mustBeLive, row?.[1], row?.[2]);
  const last = row?.[0];
  if (last == null) {
    throw new Error(
      "allocateSeqRange: the account's counter row disappeared between the guard insert and the "
      + "allocation — no sequence was reserved",
    );
  }
  return BigInt(String(last));
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

export async function recordChanges(
  tx: LedgerTx, changes: readonly ChangeInput[], mustBeLive?: MailboxMustBeLive,
): Promise<bigint[]> {
  if (changes.length === 0) return [];
  const accountId = changes[0]!.accountId;
  // One account per call: the seqs come from ONE counter, so a mixed list would silently
  // stamp another account's rows with this account's sequence.
  for (const c of changes) {
    if (c.accountId !== accountId) throw new Error("recordChanges: every change must name the same account");
  }
  const seqs = await allocateSeqRange(tx, accountId, changes.length, mustBeLive);
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

/**
 * THE ONE DOOR FOR A RULE WHOSE STATE MOVED.
 *
 * `rule` is a synced entity, so a client shows the rule it was last told about; a writer that
 * moves the state without appending here leaves it showing the old one for ever, with nothing
 * wrong at the write and nothing later to correct it. Four writers were in that state, which is
 * why this is a door — `rule-state-delta-census` refuses a write site that does not call it.
 * `ruleIds` are the rows a `.returning()` says ACTUALLY changed, never the rows asked about.
 * {@link LedgerTx} is the requirement: the delta and the row commit together or neither does.
 */
/**
 * The same delta as a ROW, for the one writer that cannot append on the spot: the profile import
 * builds ONE ordered batch across every entity kind it restores, and splitting the rule rows out
 * of it would give the client the rules at seqs interleaved with nothing else — a half-applied
 * import between two polls. Same door, same shape; only the append is the caller's.
 */
export function ruleDelta(accountId: string, ruleId: string, op: ChangeOp): ChangeInput {
  return { accountId, entityType: "rule", entityId: ruleId, op, meta: null };
}

export async function recordRuleDelta(
  tx: LedgerTx, accountId: string, ruleIds: readonly string[], op: ChangeOp,
): Promise<bigint[]> {
  return recordChanges(tx, ruleIds.map((entityId) => ({
    accountId, entityType: "rule" as const, entityId, op, meta: null,
  })));
}

/**
 * THE ONE DOOR FOR A MAILBOX WHOSE MAIL IS GONE — see the `"mailbox"` member of {@link
 * EntityType} for what the row means and which two acts may write it.
 *
 * A door rather than an inline `recordChange`, for the reason `recordRuleDelta` is one: the two
 * writers are in different packages (the standalone install's wipe and the hosted erasure's
 * sweep) and a second spelling is a second place to get the op or the entity id wrong — and the
 * op is the whole contract here, since only `"delete"` short-circuits before materialization.
 */
export async function recordMailboxRemoved(
  tx: LedgerTx, accountId: string, mailboxId: string,
): Promise<bigint> {
  return recordChange(tx, {
    accountId, entityType: "mailbox", entityId: mailboxId, op: "delete", meta: null,
  });
}

/** Both ends of an account's retained change log. Both `null` ⇔ the log is empty. */
export interface SeqBounds {
  /** The lowest retained seq — the floor a resuming cursor must not have fallen below. */
  min: bigint | null;
  /** The highest committed seq — the ceiling no legitimate cursor can be above. */
  max: bigint | null;
  /**
   * The explicit retention floor (`account_sync_state.pruned_through_seq`, mail 0120): every seq
   * at or below it may have been COMPACTED by the retention pass (`retention.ts`), so a cursor
   * BELOW it cannot replay exactly — the deleted rows include tombstones — and is 410'd. NOT
   * derivable from `min`: compaction retains each live entity's first row below the floor, so
   * `min` stays low while the gap above it is real. 0 ⇔ nothing pruned (or no counter row).
   */
  prunedThrough: bigint;
}

/**
 * The horizons of an account's change log, from ONE statement. `SyncService.getChanges` needs
 * them on every resuming request: a cursor below `prunedThrough` (or below `min`) names changes
 * that no longer exist, above `max` changes that never existed — both unrecoverable, both 410,
 * the client re-snapshots. One statement rather than round trips is a correctness property: the
 * floors and the ceiling come from the same read, so they cannot disagree about which side of
 * the window a cursor sits on. No transaction, no lock: deletes here are the retention pass and
 * account erasure only, and the pass raises `prunedThrough` BEFORE deleting and never touches a
 * row above it — so `max` never falls, both floors only rise, and a concurrent writer or pruner
 * can only turn a would-be empty 200 into a 410 read a moment earlier, never serve a gap.
 */
export async function seqBounds(tx: Tx, accountId: string): Promise<SeqBounds> {
  const rows = await tx
    .select({
      min: sql<string | null>`min(${changeLog.seq})`,
      max: sql<string | null>`max(${changeLog.seq})`,
      // A scalar subquery on the counter row's PK — the same read, one round trip. NULL when the
      // account has no counter row, which also means it has no log.
      prunedThrough: sql<string | null>`(select ${accountSyncState.prunedThroughSeq} from ${accountSyncState} where ${accountSyncState.accountId} = ${accountId})`,
    })
    .from(changeLog)
    .where(eq(changeLog.accountId, accountId));
  const row = rows[0];
  return {
    min: row?.min == null ? null : BigInt(row.min),
    max: row?.max == null ? null : BigInt(row.max),
    prunedThrough: row?.prunedThrough == null ? 0n : BigInt(row.prunedThrough),
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
