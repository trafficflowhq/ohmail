import { and, eq, isNotNull } from "drizzle-orm";
import { auditLog, mailboxes } from "./schema.js";
import type { Tx } from "./change-log.js";

/**
 * THE OPERATOR'S MAILBOX WRITE — releasing a quarantined mailbox (mail 0039).
 *
 * A module of its own because of WHO performs it: everything in `apps/worker/src/mailboxes.ts`
 * is fenced on the leader lock — those writes are the leader's claims about a mailbox it is
 * serving — while this one is an operator's, from the API host, with no lock and no shard. The
 * shape that makes such a write safe is the whole of this file: runtime connection,
 * staff-attributed, one transaction, an audit row or nothing.
 */

export interface MailboxResyncWrite {
  mailboxId: string;
  /** The `staff_users` id from the resolved session — the actor an audit row blames. */
  staffId: string;
  /** The operator's stated reason, recorded in the audit payload. */
  note: string;
  now: Date;
}

export interface MailboxResyncOutcome {
  /** `true` when a backoff was actually cleared; `false` when the mailbox was not parked. */
  changed: boolean;
  /** The account the mailbox belongs to, or `null` when no such mailbox exists. */
  accountId: string | null;
  /** The backoff that was in force, for the operator's record. */
  clearedRetryAfter: Date | null;
}

/**
 * Release a quarantined mailbox: clear its durable retry backoff so the leader re-dials on its
 * next roster pass. Idempotent — a second call, or a call against a mailbox with no backoff,
 * returns `changed: false` and writes no audit row.
 *
 * `SELECT … FOR UPDATE` is the concurrency guard, and it is a row lock rather than a bare
 * `UPDATE … WHERE retry_after IS NOT NULL RETURNING` for one reason: the outcome has to carry the
 * backoff that WAS in force, and Postgres `RETURNING` gives the NEW value of an updated column,
 * so a guard-in-the-statement would have reported `null` for the value it just cleared. With the
 * lock, two operators clicking at once serialize: one releases and writes one audit row, the
 * other reads NULL and gets `changed: false`.
 */
export async function resyncMailbox(db: Tx, input: MailboxResyncWrite): Promise<MailboxResyncOutcome> {
  const { mailboxId, staffId, note, now } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ accountId: mailboxes.accountId, retryAfter: mailboxes.retryAfter })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1)
      .for("update");

    // Nothing to release. `accountId: null` distinguishes "no such mailbox" from "this one is not
    // in a backoff", because they are different answers to the operator: the first is a wrong id,
    // the second is "there was nothing to do".
    if (!row) return { changed: false, accountId: null, clearedRetryAfter: null };
    if (row.retryAfter == null) {
      return { changed: false, accountId: row.accountId, clearedRetryAfter: null };
    }

    // The `IS NOT NULL` predicate is kept on the UPDATE as well, so the statement is still
    // correct on its own if the lock above is ever removed by someone reading only this line.
    await tx
      .update(mailboxes)
      .set({ retryAfter: null })
      .where(and(eq(mailboxes.id, mailboxId), isNotNull(mailboxes.retryAfter)));

    await tx.insert(auditLog).values({
      accountId: row.accountId,
      action: "admin.mailbox.resync",
      payload: { mailbox_id: mailboxId, account_id: row.accountId, note, actor: staffId },
      // No inverse. Re-parking a mailbox is not an operator action — the backoff is the worker's
      // to set, from an observed failure, and a console that could impose one would be inventing
      // a failure that did not happen.
      inverse: null,
      createdAt: now,
    });
    return { changed: true, accountId: row.accountId, clearedRetryAfter: row.retryAfter };
  });
}
