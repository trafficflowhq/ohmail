/**
 * WHAT AN ADMIN WRITE ANSWERS, as one shape.
 *
 * Two fields here are the ones a console may not invent. `changed` says whether the write
 * applied to anything, so a write that applied to nothing can render "nothing to do" instead of
 * "done". `audit` names the `audit_log` row that was appended, so the surface displays the entry
 * it RECEIVED rather than one composed from the request it sent. `null` means no row was
 * written, which is a fact about the database and not a gap in the response.
 *
 * This type, {@link mailboxResyncAnswer} and the admin console's own parser are the same wire
 * in three places; they move together.
 */

/** The identity of one `audit_log` row, as the wire carries it. */
export interface AdminWriteAudit {
  /** `audit_log.id`. */
  id: string;
  /** `audit_log.created_at`, ISO-8601. */
  at: string;
}

/** `POST /admin/mailboxes/resync`, 200. */
export interface MailboxResyncAnswer {
  ok: true;
  action: "admin.mailbox.resync";
  mailboxId: string;
  accountId: string;
  /** `false` ⇒ the mailbox was not parked: nothing was cleared and `audit` is `null`. */
  changed: boolean;
  /** The backoff that was in force, for the operator's record. */
  clearedRetryAfter: string | null;
  /** The row this write appended, or `null` when it appended none. */
  audit: AdminWriteAudit | null;
  /** The staff address the row is attributed to. */
  actor: string;
  at: string;
}

export function mailboxResyncAnswer(input: {
  mailboxId: string;
  accountId: string;
  changed: boolean;
  clearedRetryAfter: Date | null;
  auditId: string | null;
  auditAt: Date | null;
  actor: string;
  at: Date;
}): MailboxResyncAnswer {
  return {
    ok: true,
    action: "admin.mailbox.resync",
    mailboxId: input.mailboxId,
    accountId: input.accountId,
    changed: input.changed,
    clearedRetryAfter: input.clearedRetryAfter?.toISOString() ?? null,
    // BOTH halves or nothing: an id with no timestamp is half a row, and half a row displayed as
    // a whole one is the invention this field exists to stop.
    audit: input.auditId !== null && input.auditAt !== null
      ? { id: input.auditId, at: input.auditAt.toISOString() }
      : null,
    actor: input.actor,
    at: input.at.toISOString(),
  };
}
