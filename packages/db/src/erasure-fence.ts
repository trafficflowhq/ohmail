import { eq } from "drizzle-orm";
import { carryDialect, dialect, type Dialect, type LockMode } from "./dialect/index.js";
import { accounts, mailboxes } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * THE ERASURE FENCE, AND THE SEAM EVERY ACCOUNT-SCOPED WRITER GOES THROUGH.
 *
 * `accounts` SURVIVES Art. 17 erasure and a removed mailbox SURVIVES its own sweep as a tombstone,
 * so nothing structural refuses a late writer: a read begun before the erasure can commit after it
 * and put the person's data back. That was found at twelve call sites, which is what
 * {@link fencedAccountWrite} exists to stop being possible — one door, asked FOR SHARE, with the
 * write in the same transaction. `services/src/erasure-fence.ts` is the HTTP half: it calls this
 * file's read and puts a `ServiceError` on the answer.
 */

/** Thrown when the account was erased before the write could land. */
export class AccountErasedError extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} has been deleted; its settings cannot be changed`);
    this.name = "AccountErasedError";
  }
}

/** Thrown when the MAILBOX was erased before the write could land. */
export class MailboxErasedError extends Error {
  constructor(readonly mailboxId: string) {
    super(`mailbox ${mailboxId} has been erased; nothing may be written against it`);
    this.name = "MailboxErasedError";
  }
}

/**
 * `accounts.erased_at`, read `FOR SHARE` — the interlock's own half. `undefined` when no row
 * exists at all (not erased; `accounts` survives erasure by design, so an absent row means the id
 * was never real), `null` when the row exists and is not erased, a `Date` when it is.
 *
 * MUST be the FIRST statement in the caller's transaction — see the module header for the lock
 * order this holds against `deleteAccount`'s own first statement.
 */
export async function readAccountErasedAt(
  tx: Tx, d: Dialect, accountId: string, mode: LockMode = "share",
): Promise<Date | null | undefined> {
  // SHARE by default, and the strength travels: fences read this row concurrently and must keep
  // doing so — only the erasure itself takes the exclusive lock they are ordered against. A
  // caller whose transaction will LATER take `accounts FOR UPDATE` (the mailbox allowance gate is
  // the one) passes `"update"` instead: a share taken first and upgraded later is a deadlock
  // between two such callers, and taking the strong lock at the head has the same effect as the
  // share against the sweep.
  const [row] = await d.forUpdate(
    tx.select({ erasedAt: accounts.erasedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
    { mode });
  if (row === undefined) return undefined;
  return row.erasedAt;
}

/**
 * `mailboxes.erased_at`, read `FOR SHARE` — the same read one scope down, and the reason the
 * fence needed a second one: a mailbox erasure leaves its row standing, so the account's stamp
 * says nothing about it. `undefined` when no row exists (the sweep never deletes one, so an
 * absent row means the id was never real), `null` when live, a `Date` when erased.
 *
 * Taken AFTER the account's read and never before it: `sweepMailboxData`'s caller takes the
 * account row first too, and crossing the two orders is the deadlock this ordering closes.
 */
export async function readMailboxErasedAt(
  tx: Tx, d: Dialect, mailboxId: string, mode: LockMode = "share",
): Promise<Date | null | undefined> {
  const [row] = await d.forUpdate(
    tx.select({ erasedAt: mailboxes.erasedAt })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1),
    { mode });
  if (row === undefined) return undefined;
  return row.erasedAt;
}

/** What a fenced write is scoped to. `mailboxId` is supplied when the write is mailbox-keyed. */
export interface FenceScope {
  readonly accountId: string;
  /** Present when the row being written belongs to ONE mailbox — then the mailbox is fenced too. */
  readonly mailboxId?: string | undefined;
  /** `"update"` for a caller whose transaction will later take `accounts FOR UPDATE`. */
  readonly lock?: LockMode | undefined;
}

/**
 * THE FENCE, for a writer already inside the caller's transaction — the first statement it runs.
 *
 * Account first, then the mailbox: one lock order, held by every caller, which is what keeps this
 * off `deleteAccount`'s and `sweepMailboxData`'s deadlock diagonal. An absent row is not a
 * refusal — neither sweep deletes one, so an id with no row was never real and belongs to
 * whatever existence check the caller already ran.
 */
export async function fenceErased(tx: Tx, d: Dialect, scope: FenceScope): Promise<void> {
  const erasedAt = await readAccountErasedAt(tx, d, scope.accountId, scope.lock);
  if (erasedAt != null) throw new AccountErasedError(scope.accountId);
  if (scope.mailboxId === undefined) return;
  const mailboxErasedAt = await readMailboxErasedAt(tx, d, scope.mailboxId, scope.lock);
  if (mailboxErasedAt != null) throw new MailboxErasedError(scope.mailboxId);
}

/**
 * THE MAILBOX ARM, ASKED ALONE — for a write whose ACCOUNT arm is already structural.
 *
 * A row with a NOT NULL key to `mailboxes` cannot outlive the ACCOUNT sweep, which deletes that
 * parent; the MAILBOX sweep leaves it standing as the tombstone, so the stamp is the only thing
 * left that can refuse such a write. Asking the account again would read a row the caller holds
 * and, after the mailbox row is taken, cross {@link fenceErased}'s order — this reads one row, so
 * a caller already holding it adds no lock. ONLY where the account arm is structural:
 * `erasure-fence-census.test.ts` derives that from the schema and refuses a door without it.
 */
export async function fenceErasedMailbox(
  tx: Tx, d: Dialect, mailboxId: string, mode: LockMode = "share",
): Promise<void> {
  const erasedAt = await readMailboxErasedAt(tx, d, mailboxId, mode);
  if (erasedAt != null) throw new MailboxErasedError(mailboxId);
}

/**
 * THE SEAM. Opens a transaction, fences it, and runs the write inside it — the one door every
 * account-scoped writer in the open server goes through, so that remembering the call is not what
 * the person's erasure rests on.
 *
 * The write MUST happen on the `tx` handed in: a write on the outer handle commits on its own
 * connection and the fence's share lock protects nothing. The dialect brand does not travel to a
 * transaction object, so it is carried from the handle this was opened on.
 */
export async function fencedAccountWrite<T>(
  db: Tx, scope: FenceScope, fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const d = dialect(db);
  const handle = db as unknown as {
    transaction: <R>(f: (t: unknown) => Promise<R>) => Promise<R>;
  };
  return handle.transaction(async (raw) => {
    const tx = carryDialect(db, raw as object) as unknown as Tx;
    await fenceErased(tx, d, scope);
    return fn(tx);
  });
}
