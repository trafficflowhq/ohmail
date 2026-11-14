/**
 * THE CALENDAR WRITER'S FENCE: no `cal_*` row is written outside a transaction that first holds, in
 * this order, the account's row (the erasure fence), the mailbox the row or its connection names,
 * and, for anything under a connection, that connection's row: each FOR SHARE, each refused when
 * erased, absent or not this account's, the connection also when it is being removed.
 *
 * It is the product's one fence, not a second: inside `withAccountTx` or `fencedAccountWrite` the
 * account's row is already held and is not read again. The order is the erasures' own: the account
 * sweep takes the account's row first, a mailbox's erasure stamps the mailbox and its calendar step
 * takes the riding connections FOR UPDATE, so a page in flight commits before either reads it and a
 * later one finds the stamp or the row gone. A provider is never read inside this transaction: the
 * read ends, then the page opens its own transaction here.
 *
 * Reached on a server and a desktop's store; a phone's store holds no calendar.
 */
import { and, eq } from "drizzle-orm";
import { dialect, type Dialect } from "../dialect/index.js";
import { MailboxErasedError, fenceErased, fencedAccountWrite } from "../erasure-fence.js";
import type { Tx } from "../change-log.js";
import { calConnections, mailboxes } from "../schema-mail.js";

/** Refused at its connection: not this account's, gone, or being removed. Nothing was written. */
export class CalendarConnectionGone extends Error {
  constructor(readonly connectionId: string, readonly reason: "absent" | "removing") {
    super(reason === "absent"
      ? `calendar connection ${connectionId} is not this account's or is gone; nothing may be written under it`
      : `calendar connection ${connectionId} is being removed; nothing may be written under it`);
    this.name = "CalendarConnectionGone";
  }
}

/** What the fence found of the connection it holds. */
export interface HeldCalendarConnection {
  readonly mailboxId: string | null;
  readonly status: string;
}

/** The mailbox, this account's and live, FOR SHARE. Another account's is refused as an erased one. */
async function shareMailbox(tx: Tx, d: Dialect, accountId: string, mailboxId: string): Promise<void> {
  const [row] = await d.forUpdate(
    tx.select({ erasedAt: mailboxes.erasedAt }).from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId))).limit(1),
    { mode: "share" },
  );
  if (row === undefined || row.erasedAt != null) throw new MailboxErasedError(mailboxId);
}

/**
 * For a row that names a mailbox and hangs on no connection (a link, a suggestion): the account's
 * fence, then the mailbox. Refuses with `AccountErasedError` or `MailboxErasedError`.
 */
export async function holdCalendarMailbox(
  tx: Tx, d: Dialect, scope: { accountId: string; mailboxId: string },
): Promise<void> {
  await fenceErased(tx, d, { accountId: scope.accountId });
  await shareMailbox(tx, d, scope.accountId, scope.mailboxId);
}

/**
 * For anything under a connection: the account's fence, the mailbox the connection rides (its id is
 * set when the connection is made and never changed, so an unlocked read names it and the mailbox
 * is held before the connection, as every fence orders them), then the connection by both ids.
 * Refuses with `AccountErasedError`, `MailboxErasedError` or {@link CalendarConnectionGone}.
 */
export async function holdCalendarConnection(
  tx: Tx, d: Dialect, scope: { accountId: string; connectionId: string },
): Promise<HeldCalendarConnection> {
  await fenceErased(tx, d, { accountId: scope.accountId });
  const where = and(eq(calConnections.id, scope.connectionId), eq(calConnections.accountId, scope.accountId));
  const [riding] = await tx.select({ mailboxId: calConnections.mailboxId }).from(calConnections).where(where).limit(1);
  if (riding === undefined) throw new CalendarConnectionGone(scope.connectionId, "absent");
  if (riding.mailboxId !== null) await shareMailbox(tx, d, scope.accountId, riding.mailboxId);
  const [row] = await d.forUpdate(
    tx.select({ mailboxId: calConnections.mailboxId, status: calConnections.status }).from(calConnections).where(where).limit(1),
    { mode: "share" },
  );
  if (row === undefined) throw new CalendarConnectionGone(scope.connectionId, "absent");
  if (row.status === "removing") throw new CalendarConnectionGone(scope.connectionId, "removing");
  return { mailboxId: row.mailboxId, status: row.status };
}

/** One transaction for a write under a connection: the account's fence, then the hold, then `fn`. */
export async function fencedConnectionWrite<T>(
  db: Tx, scope: { accountId: string; connectionId: string }, fn: (tx: Tx, held: HeldCalendarConnection) => Promise<T>,
): Promise<T> {
  const d = dialect(db);
  return fencedAccountWrite(db, { accountId: scope.accountId }, async (tx) => fn(tx, await holdCalendarConnection(tx, d, scope)));
}
