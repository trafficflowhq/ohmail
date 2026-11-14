import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { accounts, mailboxes, passProgress } from "./schema-mail.js";
import { dialect } from "./dialect/index.js";
import type { Tx } from "./change-log.js";

/**
 * THE ONE DOOR TO `pass_progress` (mail 0203): where each one-time pass stands, per subject.
 *
 * A pass that runs once per mailbox or once per account has to remember that it ran, and a pass
 * bounded per run has to remember where it stopped. Until 0203 that was fourteen columns on
 * `mailboxes` and `account_settings`; it is one table now, keyed by `(account, job, subject)`:
 *
 *   requested_at  somebody asked for the pass (only a pass that is armed carries it)
 *   started_at    when the walk the cursor belongs to began; NULL exactly when the cursor is
 *   done_at       the pass finished; written LAST, because claiming it first makes a crash permanent
 *   cursor        the id of the last row of the last COMMITTED page, as text; NULL = from the start
 *
 * NO ROW MEANS EVERY MARK IS EMPTY: the pass never ran for that subject. A reader treats an absent
 * row, a NULL mark and a failed read alike as "not done", the only default that can still repair.
 *
 * `job` is the pass's name in the worker's registry. The list is closed and grows; no store holds
 * it in a CHECK, so THIS module is where a foreign name is refused, for a write and for a read
 * alike. Nothing else inserts into, updates or deletes from the table but the two erasures, which
 * delete an account's or a mailbox's rows.
 */
export const PASS_NAMES = [
  /** Per mailbox: the once-per-mailbox inbox-shaping pass at connect ran. */
  "kickstart",
  /** Per mailbox: the one-time re-evaluation of mail the sensitivity override misrouted. */
  "sensitive_rescreen",
  /** Per mailbox: the one-time repair of bodies a classifier false positive stored redacted. */
  "sensitive_fp_backfill",
  /** Per mailbox: a full read found no letter spelled the pre-0.22 way (`ohmail/Reads`). */
  "news_repair",
  /** Per account: the Ohbox backlog tidy, re-armed on each transition into `people_only`. */
  "ohbox_tidy",
  /** Per account: the one-time release of mail a pre-0.19 seed left at the screening gate. */
  "gate_release",
  /** Per account: every living letter has its search document. */
  "search_index_backfill",
  /** Per account: every stored letter's `List-Post` was read. */
  "list_address_backfill",
  /** Per account: every html-only letter stored before 0172 has its html's words as text. */
  "html_words_backfill",
] as const;

export type PassName = (typeof PASS_NAMES)[number];

/** A name the door does not know: a pass that is not registered here writes and reads nothing. */
export class UnknownPassName extends Error {
  readonly code = "unknown_pass_name";
  constructor(readonly job: unknown) {
    super(`${JSON.stringify(job)} is not a pass this store keeps progress for`);
    this.name = "UnknownPassName";
  }
}

export function isPassName(v: unknown): v is PassName {
  return typeof v === "string" && (PASS_NAMES as readonly string[]).includes(v);
}

function known(job: PassName): PassName {
  if (!isPassName(job)) throw new UnknownPassName(job);
  return job;
}

/** One pass for one subject. `subjectId` is the mailbox for a mailbox's pass, the account otherwise. */
export interface PassKey {
  readonly accountId: string;
  readonly job: PassName;
  readonly subjectId: string;
}

/** The key of an account's pass. */
export function accountPass(job: PassName, accountId: string): PassKey {
  return { accountId, job: known(job), subjectId: accountId };
}

/** The key of one mailbox's pass. */
export function mailboxPass(job: PassName, accountId: string, mailboxId: string): PassKey {
  return { accountId, job: known(job), subjectId: mailboxId };
}

/** The four marks, as a reader gets them. */
export interface PassMarks {
  requestedAt: Date | null;
  startedAt: Date | null;
  doneAt: Date | null;
  cursor: string | null;
}

export const NO_MARKS: PassMarks = Object.freeze({ requestedAt: null, startedAt: null, doneAt: null, cursor: null });

type Mark = keyof PassMarks;
/** A mark's new value: a value, or an expression over the stored row ({@link passProgress}) and {@link proposed}. */
type MarkValue = Date | string | null | SQL;
export type PassWrite = Partial<Record<Mark, MarkValue>>;

const COLUMN: Record<Mark, string> = { requestedAt: "requested_at", startedAt: "started_at", doneAt: "done_at", cursor: "cursor" };

/** The value this write proposes for a mark, inside an `onExisting` expression or a `when` guard. */
export function proposed(mark: Mark): SQL {
  return sql.raw(`excluded."${COLUMN[mark]}"`);
}

/**
 * `stored cursor < proposed cursor`, in the walk's own order. A cursor is a row id as text; ids are
 * uuids in lower case, whose text order under byte comparison is the uuid's order, so the
 * comparison is pinned to bytes on a server and is bytes already on a device.
 */
export function cursorBehind(db: unknown, than: SQL | string = proposed("cursor")): SQL {
  const other = typeof than === "string" ? sql`${than}` : than;
  return dialect(db).name === "pg"
    ? sql`(${passProgress.cursor} is null or ${passProgress.cursor} collate "C" < ${other} collate "C")`
    : sql`(${passProgress.cursor} is null or ${passProgress.cursor} < ${other})`;
}

/** The row of `job` for a subject, as a join's ON or a filter: every reader names the pass through this. */
export function onPass(job: PassName, accountId: SQLWrapper | string, subjectId: SQLWrapper | string = accountId): SQL {
  return and(
    eq(passProgress.accountId, accountId as never),
    eq(passProgress.job, known(job)),
    eq(passProgress.subjectId, subjectId as never),
  )!;
}

/**
 * One mark of `job` for a subject, as a scalar subquery a larger statement folds in. It decodes
 * as the column does on each store. NULL for no row.
 */
export function passMark<M extends Mark>(
  job: PassName, mark: M, accountId: SQLWrapper | string, subjectId: SQLWrapper | string = accountId,
): SQL<PassMarks[M]> {
  const column = passProgress[mark];
  return sql`(select ${column} from ${passProgress} where ${onPass(job, accountId, subjectId)})`
    .mapWith(column) as unknown as SQL<PassMarks[M]>;
}

/** Is the pass done for the subject? The predicate a statement asks instead of reading the mark. */
export function passDone(job: PassName, accountId: SQLWrapper | string, subjectId: SQLWrapper | string = accountId): SQL {
  return sql`exists (select 1 from ${passProgress} where ${onPass(job, accountId, subjectId)} and ${passProgress.doneAt} is not null)`;
}

/** The marks of one pass for one subject; {@link NO_MARKS} for no row. */
export async function readPassProgress(db: Tx, key: PassKey, opts: { lock?: boolean } = {}): Promise<PassMarks> {
  const q = db.select({
    requestedAt: passProgress.requestedAt, startedAt: passProgress.startedAt,
    doneAt: passProgress.doneAt, cursor: passProgress.cursor,
  }).from(passProgress).where(onPass(known(key.job), key.accountId, key.subjectId)).limit(1);
  const [row] = opts.lock ? await dialect(db).forUpdate(q) : await q;
  return row ?? NO_MARKS;
}

/**
 * WRITE A PASS'S MARKS: insert the row, or change the one that stands.
 *
 * `marks` is what a new row carries. On a row that stands, `onExisting` says what each mark
 * becomes (default: the same marks), and `when` guards the change: an expression over the stored
 * row, false meaning "leave it". Both may name {@link proposed}. A pass keeps its own rule in
 * those two: a mark claimed once (`when: done_at is null`), a cursor that only moves forward
 * ({@link cursorBehind}), a stamp another run's stamp survives (`coalesce(done_at, proposed)`).
 *
 * `onlyIf` guards the INSERT as `when` guards the change: a condition asked in the same statement,
 * false meaning "make no row" (a pass's mark for a subject whose data is gone must not grow back).
 *
 * THE SUBJECT IS ASKED FOR IN THE SAME STATEMENT, because the table has no key into any other:
 *
 *  - an account's mark is written unless the account's row says it is erased (no row reads as
 *    not erased, as the erasure fence reads it). A plain read: a lock on the account's row
 *    belongs at the head of a transaction (`erasure-fence.ts`), and a pass whose stamp may
 *    trail its work by minutes takes that fence itself, as the gate release does;
 *  - a mailbox's mark is written only for a mailbox the account holds and has not erased, and
 *    the mailbox's row is read FOR SHARE: a removal waits for this write and then deletes its
 *    row, or this write waits for the removal and writes nothing. Both erasures delete the
 *    table after they have written the mailbox's row, which is what makes that order hold. A
 *    pair handed in from outside cannot mark another account's mailbox.
 *
 * Returns whether a row was written. One statement; it runs in the caller's transaction.
 */
export async function writePassProgress(
  db: Tx, key: PassKey, marks: PassWrite,
  opts: { onExisting?: PassWrite; when?: SQL; onlyIf?: SQL; now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const job = known(key.job);
  const d = dialect(db);
  const set: Record<string, unknown> = { ...((opts.onExisting ?? marks) as Record<string, unknown>), updatedAt: now };
  const lit = (v: MarkValue | undefined): SQL =>
    v === undefined || v === null ? sql`null` : v instanceof Date ? d.ts(v) : typeof v === "string" ? sql`${v}` : v;
  const forMailbox = key.subjectId !== key.accountId;
  const and_ = opts.onlyIf === undefined ? sql`` : sql` and (${opts.onlyIf})`;
  // The row's values as a SELECT the subject's own row answers, every column in the table's order.
  const source = forMailbox
    ? sql`from ${mailboxes} where ${mailboxes.id} = ${key.subjectId} and ${mailboxes.accountId} = ${key.accountId}
        and ${mailboxes.erasedAt} is null${and_} ${d.lockClause({ mode: "share" })}`
    : sql`where not exists (select 1 from ${accounts} where ${accounts.id} = ${key.accountId} and ${accounts.erasedAt} is not null)${and_}`;
  const written = await db.insert(passProgress).select(sql`select ${key.accountId}, ${job}, ${key.subjectId},
      ${lit(marks.requestedAt)}, ${lit(marks.startedAt)}, ${lit(marks.doneAt)}, ${lit(marks.cursor)}, ${d.ts(now)}
    ${source}`)
    .onConflictDoUpdate({
      target: [passProgress.accountId, passProgress.job, passProgress.subjectId],
      set: set as never,
      ...(opts.when === undefined ? {} : { setWhere: opts.when }),
    }).returning({ job: passProgress.job });
  return written.length > 0;
}

/**
 * Change a row that stands, and only one that stands: a mark cleared, a walk reset. No row is
 * made (no row and every mark empty mean the same). Returns whether a row changed.
 */
export async function updatePassProgress(
  db: Tx, key: PassKey, marks: PassWrite, opts: { when?: SQL; now?: Date } = {},
): Promise<boolean> {
  const set = { ...(marks as Record<string, unknown>), updatedAt: opts.now ?? new Date() };
  // RETURNING, not a driver's count of affected rows: the count reads differently on each store.
  const changed = await db.update(passProgress).set(set as never)
    .where(and(onPass(known(key.job), key.accountId, key.subjectId), opts.when))
    .returning({ job: passProgress.job });
  return changed.length > 0;
}

/**
 * Arm a pass from the top: asked for at `at`, and an earlier run's cursor gone in the same write
 * (a re-arm that left the cursor at a previous run's end would resume there and do nothing).
 */
export async function requestPass(db: Tx, key: PassKey, at: Date): Promise<void> {
  await writePassProgress(db, key, { requestedAt: at, cursor: null }, { now: at });
}

/**
 * Stamp the pass done, once: the first caller's instant stands and it alone is told `true`. The
 * claim a pass makes AFTER its work, so a crash before it runs the pass again.
 */
export async function markPassDone(db: Tx, key: PassKey, at: Date): Promise<boolean> {
  return writePassProgress(db, key, { doneAt: at }, { when: sql`${passProgress.doneAt} is null`, now: at });
}
