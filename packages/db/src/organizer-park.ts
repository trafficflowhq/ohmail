import { and, eq, isNotNull, isNull, ne, type SQL } from "drizzle-orm";
import { mailboxes } from "./schema-mail.js";

/**
 * THE RESUME OF A MAILBOX THE WALL RELEASED (mail 0135), stated once for its two callers: the
 * worker's roster pass and the API's `GET /account/access` when it reads open. It writes what a
 * person's "Organize here" writes — a `join` stamp — so the gate still decides, and a `join` yields
 * to any live foreign claim. The marker stays until the promotion or stand-down that spends the
 * stamp; `takeover_authorized_at IS NULL` makes the write a no-op while one is unspent. A mailbox the
 * person released carries no marker and is never touched.
 */
export function parkedResumeWhere(): SQL {
  return and(
    isNotNull(mailboxes.organizerParkedAt),
    eq(mailboxes.organizerRole, "reader"),
    isNotNull(mailboxes.organizeConsentedAt),
    isNull(mailboxes.releaseRequestedAt),
    isNull(mailboxes.takeoverAuthorizedAt),
    ne(mailboxes.status, "disabled"),
  )!;
}

/** The stamp itself, and the doorbell that asks the worker to serve it now rather than next tick. */
export function parkedResumeSet(now: Date): {
  takeoverAuthorizedAt: Date; takeoverIntent: "join"; syncRequestedAt: Date;
} {
  return { takeoverAuthorizedAt: now, takeoverIntent: "join", syncRequestedAt: now };
}
