/**
 * ACCOUNT SUSPENSION — the reader seam the entitlement gates share, and the transactional write
 * the admin console performs (cloud migration 0008).
 *
 * ## One reader, not four joins
 *
 * `entitlementsFor` (`billing.ts`) already collapses a suspension into "no entitlements"; the only
 * thing missing was the input. Four call sites answer the SAME question — is this account
 * suspended — and they must answer it identically or the console, the worker roster and the AI
 * gate disagree about who is live. So the read is ONE function (`suspendedAccountIds` for the
 * batch caller, `isSuspended` for the singletons), here beside the table, rather than a
 * `LEFT JOIN account_suspensions` copied into each. Presence is the state (see `schema-cloud.ts`):
 * a row means suspended, and there is no `resumed_at` predicate for a reader to forget.
 *
 * ## The write is one transaction, and it lives here
 *
 * Suspend writes the cloud suspension row AND the mail `audit_log` row together, so a suspension
 * can never exist without the record of who caused it, and a replay produces neither a second row
 * nor a second audit entry. It runs on the RUNTIME connection (`deps.db`) — never the content-blind
 * console role, which holds no write grant by construction — and the `account_suspensions` PRIMARY
 * KEY is the concurrency guard: `ON CONFLICT (account_id) DO NOTHING` admits exactly one of two
 * racing suspends.
 *
 * ## BOTH SUSPEND WRITERS TAKE THE SPEND MUTEX FIRST, AND THAT IS NOT A LOCAL DECISION
 *
 * `lockAccountBalance` — the account's `credit_balances` row lock — is taken before either INSERT.
 * The PRIMARY KEY orders the two suspend writers against EACH OTHER; it says nothing about the AI
 * spend gate, which is the writer that matters here. That gate used to read this table and only
 * then take the balance lock, so a spend could read "not suspended", queue behind the balance lock
 * with other spends, and commit a debit — and a paid model call — after a Stripe reversal had
 * already taken the revenue back (the suspension-race finding, extending the reversal ruling). The gate now RE-READS this table
 * with that lock held; this side taking the same lock is what makes the re-read decisive rather
 * than merely narrower, because it means no suspension can become durable between the gate's
 * re-read and the gate's commit.
 *
 * The invariant the pair buys: **no debit and no model call commits after a suspension row is
 * committed for that account.** A spend that committed BEFORE the suspension stands — the recorded
 * ruling is suspend-not-clawback, and this changes nothing about that.
 *
 * `resumeAccount` deliberately does NOT take it. It removes a suspension, so a spend racing it can
 * only ever be refused a spend it was about to be allowed — fail-closed, and no money moves the
 * wrong way. It also takes a strict SUBSET of the locks the writers above take, which is what keeps
 * it out of the deadlock argument. The full lock order, and why it is deadlock-free, is in
 * `spend-lock.ts`; `test/spend-suspension-race.pg.test.ts` is the proof.
 *
 * The actor is written into `audit_log.payload.actor` as the `staff_users` id. The content-blind
 * console cannot read `payload` (privacy — the bag could carry mail content, so `admin-service.ts`
 * never grants it), so the actor is a durable forensic fact read directly from the table, not a
 * console field. The audit ROW (action, account, time) is what the console renders.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { lockAccountBalance } from "./spend-lock.js";
import { accountSuspensions, auditLog, mailboxes } from "./schema.js";
import type { LedgerTx, Tx } from "./change-log.js";

/** Which of `accountIds` are currently suspended. The batch reader — one query, no per-id round trip. */
export async function suspendedAccountIds(
  tx: Tx,
  accountIds: readonly string[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await tx
    .select({ accountId: accountSuspensions.accountId })
    .from(accountSuspensions)
    .where(inArray(accountSuspensions.accountId, [...accountIds]));
  return new Set(rows.map((r) => r.accountId));
}

/** Is this one account suspended right now? The singleton reader for the per-account gates. */
export async function isSuspended(tx: Tx, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ accountId: accountSuspensions.accountId })
    .from(accountSuspensions)
    .where(eq(accountSuspensions.accountId, accountId))
    .limit(1);
  return row != null;
}

export interface SuspensionWrite {
  accountId: string;
  /** The `staff_users` id from the resolved session — the actor an audit row blames. */
  staffId: string;
  /** The operator's stated reason, recorded in the audit payload. */
  note: string;
  now: Date;
}

export interface SuspensionOutcome {
  /** `true` when this call changed state; `false` on a replay (already suspended / not suspended). */
  changed: boolean;
  /** When the account's current suspension began; `null` after a resume. */
  suspendedAt: Date | null;
}

/**
 * Suspend an account, idempotently. `INSERT … ON CONFLICT (account_id) DO NOTHING` is the guard:
 * a second concurrent suspend, or a replay of the same request, returns `changed: false` and
 * writes NO second audit row. The audit row is written in the SAME transaction as the suspension,
 * and only when a row was actually inserted.
 */
export async function suspendAccount(db: Tx, input: SuspensionWrite): Promise<SuspensionOutcome> {
  const { accountId, staffId, note, now } = input;
  return db.transaction(async (tx) => {
    // THE SPEND MUTEX, BEFORE THE SUSPENSION ROW. See the module doc: it is what
    // makes the AI gate's in-region re-read decisive. An operator's suspension is as much a "no
    // more spending" instruction as a revenue reversal is, so it participates in the same order.
    await lockAccountBalance(tx as unknown as LedgerTx, accountId);

    const inserted = await tx
      .insert(accountSuspensions)
      .values({ accountId, suspendedAt: now, suspendedBy: staffId, note })
      .onConflictDoNothing({ target: accountSuspensions.accountId })
      .returning({ suspendedAt: accountSuspensions.suspendedAt });

    if (inserted.length === 0) {
      // Already suspended — a replay. Report the existing timestamp; no new audit row.
      const [existing] = await tx
        .select({ suspendedAt: accountSuspensions.suspendedAt })
        .from(accountSuspensions)
        .where(eq(accountSuspensions.accountId, accountId))
        .limit(1);
      return { changed: false, suspendedAt: existing?.suspendedAt ?? null };
    }

    await tx.insert(auditLog).values({
      accountId,
      action: "admin.account.suspend",
      payload: { account_id: accountId, note, actor: staffId },
      inverse: { action: "admin.account.resume", account_id: accountId },
      createdAt: now,
    });
    return { changed: true, suspendedAt: inserted[0]!.suspendedAt };
  });
}

export interface RevenueReversalSuspension {
  accountId: string;
  /**
   * What reversed the revenue — `stripe:<event type>:<object id>`. Written into the row's `note`
   * and the audit payload; ids only, never payload text (the standing scrubbing rule).
   */
  source: string;
  now: Date;
}

/**
 * Suspend an account because its revenue was REVERSED — a Stripe refund or a lost dispute
 * (the recorded policy: suspend on confirmed fraud). The billing webhook is the caller.
 *
 * The same `INSERT … ON CONFLICT (account_id) DO NOTHING` idempotency as {@link suspendAccount},
 * with two deliberate differences:
 *
 *  · **`suspended_by` is NULL** (cloud 0012). There is no staff actor; the provenance is the
 *    `note` and the audit payload's `actor: "stripe-webhook"`. A sentinel staff row was the
 *    alternative and it would surface a fake operator in every roster read.
 *  · **No inner transaction.** The caller is the webhook's apply transaction, and the suspension
 *    must become durable WITH the event's claim row or not at all — a self-owned transaction here
 *    would be a savepoint pretending to be a boundary. The admin write above keeps its own
 *    because its caller is a bare route handler.
 *
 * Already-spent credits are NOT clawed back and the remaining balance is NOT expired — accepted:
 * the spent portion is unrecoverable regardless, and `entitlementsFor` maps the suspension to
 * `aiEnabled: false` / `syncEnabled: false`, which is what stops further use. The escape hatch
 * for a goodwill Dashboard refund that lands here is the console's existing resume (a DELETE).
 */
export async function suspendAccountForRevenueReversal(
  tx: LedgerTx, input: RevenueReversalSuspension,
): Promise<SuspensionOutcome> {
  const { accountId, source, now } = input;
  // THE SPEND MUTEX, BEFORE THE SUSPENSION ROW. This is THE case the ordering was
  // written for: without it a spend that had already read "not suspended" and was queued on the
  // balance row committed its debit — and made its paid model call — after this row was durable.
  // The `LedgerTx` in the signature is load-bearing rather than cosmetic: on an autocommit handle
  // the lock would be released by the statement that took it and the ordering would be a no-op.
  await lockAccountBalance(tx, accountId);

  const inserted = await tx
    .insert(accountSuspensions)
    .values({ accountId, suspendedAt: now, suspendedBy: null, note: source })
    .onConflictDoNothing({ target: accountSuspensions.accountId })
    .returning({ suspendedAt: accountSuspensions.suspendedAt });

  if (inserted.length === 0) {
    // Already suspended — a redelivery, a second reversal on the same account, or an operator
    // got there first. Report the standing timestamp; no second audit row.
    const [existing] = await tx
      .select({ suspendedAt: accountSuspensions.suspendedAt })
      .from(accountSuspensions)
      .where(eq(accountSuspensions.accountId, accountId))
      .limit(1);
    return { changed: false, suspendedAt: existing?.suspendedAt ?? null };
  }

  await tx.insert(auditLog).values({
    accountId,
    action: "billing.account.suspend",
    payload: { account_id: accountId, note: source, actor: "stripe-webhook" },
    // The inverse is the ADMIN resume: freeing a suspended account is an operator's decision,
    // whatever wrote the suspension.
    inverse: { action: "admin.account.resume", account_id: accountId },
    createdAt: now,
  });
  return { changed: true, suspendedAt: inserted[0]!.suspendedAt };
}

/**
 * Resume (unsuspend) an account, idempotently. `DELETE … RETURNING` is the guard: resuming an
 * account that is not suspended returns `changed: false` and writes no audit row. The resume audit
 * row is written in the same transaction as the delete, and only when a row was actually removed.
 */
export async function resumeAccount(db: Tx, input: SuspensionWrite): Promise<SuspensionOutcome> {
  const { accountId, staffId, note, now } = input;
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(accountSuspensions)
      .where(eq(accountSuspensions.accountId, accountId))
      .returning({ accountId: accountSuspensions.accountId });

    if (deleted.length === 0) return { changed: false, suspendedAt: null };

    await tx.insert(auditLog).values({
      accountId,
      action: "admin.account.resume",
      payload: { account_id: accountId, note, actor: staffId },
      inverse: { action: "admin.account.suspend", account_id: accountId },
      createdAt: now,
    });
    return { changed: true, suspendedAt: null };
  });
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SECOND ADMIN WRITE — RELEASING A QUARANTINED MAILBOX (mail 0039)
   ══════════════════════════════════════════════════════════════════════════════════════════

   It lives in this file rather than beside the worker's mailbox writes because of WHO performs
   it. Everything in `apps/worker/src/mailboxes.ts` is fenced on the leader lock — those writes
   are the leader's claims about a mailbox it is serving. This one is an OPERATOR's, from the API
   host, with no lock and no shard; the thing it has in common with the two above is the shape
   that makes an admin write safe here (runtime connection, staff-attributed, one transaction,
   audit row or nothing), and that shape is what this module is for.

   ── WHAT IT DOES, AND EXACTLY WHAT IT DOES NOT ──────────────────────────────────────────────

   It clears `mailboxes.retry_after`, and that is all. On the next roster pass — at most
   `TF_ROSTER_INTERVAL_MS`, 30 s in production — the leader finds no backoff in force and dials
   the mailbox again.

   It does NOT touch `retry_count`, and that is a decision rather than an oversight. That column
   is the SIZE of the current outage; an operator releasing a mailbox is not asserting the outage
   never happened, and zeroing it would erase the one durable record of how long a customer's
   mailbox has been broken. The worker's in-memory attempt count is likewise untouched (it cannot
   be reached from here anyway), so a release buys ONE immediate attempt rather than a reset
   ladder — a mailbox that fails again resumes the backoff where it was, and a support engineer
   clicking the button repeatedly cannot turn it into a retry loop against a customer's provider.

   It does NOT clear `status`, `error_code` or `failed_at`. Those are the record of the failure
   and only a verified recovery may clear them (`markMailboxConnected`); writing `connected` from
   here would be this console claiming a sync it has not observed.

   ── WHY IT REFUSES A MAILBOX WITH NOTHING TO RELEASE ────────────────────────────────────────

   `changed: false` when no row matched, so the route can answer "nothing to release" instead of
   a 200 that reads as "done". The predicate is `retry_after IS NOT NULL`: a mailbox that is not
   parked cannot be un-parked, and a success message about it is the kind of small lie that makes
   an operator trust the console less the next time it matters. No audit row is written for a
   no-op, matching `resumeAccount` exactly. */

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
