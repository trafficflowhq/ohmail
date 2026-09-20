import { randomUUID } from "node:crypto";
import { and, asc, eq, exists, gt, isNull, sql } from "drizzle-orm";
import { accounts, users, accountSettings } from "@trafficflow/db";
import { accountLifecycleNotices } from "@trafficflow/db/cloud";
import type { AccessLifecycle, AccessVerdict, ReleaseOutcome } from "@trafficflow/db";
import { bridgeTx, type Db } from "./context.js";
import { silentLogger, type Logger } from "@trafficflow/core";
import { deleteAccount } from "./account-deletion-service.js";
import type { MailContext } from "./mail/index.js";

/**
 * THE NIGHTLY ACCOUNT-LIFECYCLE PASS (cloud 0040, the wall) — the reminder mails and the erasure.
 * It iterates `accounts WHERE erased_at IS NULL` having at least one user, reads the plane's
 * verdict once per account, and owes at most one mail per FACT: idempotency is DERIVED from the
 * `account_lifecycle_notices` PRIMARY KEY (account, kind, anchor), where `anchor` is the plane's
 * own ISO instant — never a clock read here. No state machine, no closure table: a re-run
 * inserts nothing, a NEW closure is a new anchor. The ERASURE runs here and in `DELETE /account`
 * and NOWHERE ELSE: when `erasureAt + 24 h <= now` (a day of slack against plane↔API clock skew)
 * it stops the money and calls `deleteAccount` as the route does; `erased_at` is the skip.
 */

/** How far ahead the trial reminder looks — "two days left", the flow's own words. */
export const TRIAL_REMINDER_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
/** How far ahead the erasure reminder looks. */
export const ERASURE_REMINDER_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** The slack past `erasureAt` before anything is erased. */
export const ERASURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * The one method this pass needs of `MailService` — structural, so the API's dependency bag
 * (compiled by every host) can declare it without naming the hosted mail barrel.
 */
export interface LifecycleNoticeMailer {
  sendLifecycleNotice(
    ctx: MailContext,
    input: {
      to: string;
      kind: "trial_two_days" | "closed" | "erasure_week";
      locale: "en" | "de";
      anchor: Date;
      erasureAt: Date | null;
    },
    // The WEAKEST shape the pass reads — `status` alone — so the API's structural declaration of
    // this method (which cannot name `MailSendResult`) satisfies it; `MailService`'s own richer
    // result remains assignable.
  ): Promise<{ status: "sent" | "skipped" | "failed" }>;
}

export interface AccountLifecyclePassDeps {
  /** The entitlements program, or what a route composes from it. Never throws (the port's rule). */
  port: {
    access(accountId: string): Promise<AccessVerdict>;
    releaseAccount(accountId: string): Promise<ReleaseOutcome>;
  };
  /**
   * Customer mail, or `null` on a deployment with none — an owed notice is then REPORTED and not
   * claimed, so the row cannot say "sent" about a mail that never existed and the mails go out
   * once a mailer is configured.
   */
  mail: LifecycleNoticeMailer | null;
  now: () => Date;
  log?: Logger;
  /** Accounts read from the plane at once. The plane's own budget bounds each call. */
  concurrency?: number;
}

export interface AccountLifecyclePassResult {
  /** Accounts iterated (erased ones never enter). */
  accounts: number;
  /** Verdicts that carried a lifecycle block. Old plane ⇒ 0, and nothing else happens. */
  withLifecycle: number;
  /** Notices newly claimed AND sent, by kind. */
  sent: { trial_two_days: number; closed: number; erasure_week: number };
  /** Owed notices left unclaimed because no mailer is configured. */
  unmailable: number;
  /** Accounts erased this run (`erasureAt` + slack passed). */
  erased: number;
  /** Per-account faults absorbed (send failures, erase failures) — the run keeps going. */
  faults: number;
}

interface DueNotice {
  kind: "trial_two_days" | "closed" | "erasure_week";
  anchor: Date;
  erasureAt: Date | null;
}

/** The notices a verdict owes RIGHT NOW — pure, so the truth table is a unit test. */
export function noticesDue(lc: AccessLifecycle, now: Date): DueNotice[] {
  const out: DueNotice[] = [];
  const at = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));
  const trialEndsAt = at(lc.trialEndsAt);
  const closedAt = at(lc.closedAt);
  const erasureAt = at(lc.erasureAt);
  if (lc.state === "trialing" && trialEndsAt !== null) {
    const ahead = trialEndsAt.getTime() - now.getTime();
    if (ahead > 0 && ahead <= TRIAL_REMINDER_AHEAD_MS) {
      out.push({ kind: "trial_two_days", anchor: trialEndsAt, erasureAt: null });
    }
  }
  // An operator HOLD is not a departure. The closed notice sells re-subscription, which reopens
  // nothing while staff hold the account, so a suspended closure owes no mail and claims no row —
  // the hold is communicated by the operator. `erasureAt` is null while suspended (the port's own
  // contract), so the erasure notice below and the erasure itself cannot fire for one either.
  if (lc.state === "closed" && closedAt !== null && lc.closedReason !== "suspended") {
    out.push({ kind: "closed", anchor: closedAt, erasureAt });
    if (erasureAt !== null) {
      const ahead = erasureAt.getTime() - now.getTime();
      if (ahead > 0 && ahead <= ERASURE_REMINDER_AHEAD_MS) {
        out.push({ kind: "erasure_week", anchor: erasureAt, erasureAt });
      }
    }
  }
  return out;
}

/**
 * Whether the verdict's erasure is DUE — `erasureAt` + a day of slack has passed. THE ONE POINT
 * that decides an erasure, so the suspended refusal lives here and nowhere else.
 *
 * An operator hold is never erased by this pass, whatever `erasureAt` says. The plane's contract
 * already keeps that field null while suspended, but erasure is irreversible and so does not rest
 * on the other program keeping its word: a suspended account carrying one is a drift between the
 * two, refused here and reported by the caller.
 */
export function erasureDue(lc: AccessLifecycle, now: Date): boolean {
  if (lc.state !== "closed" || lc.erasureAt === null) return false;
  if (lc.closedReason === "suspended") return false;
  return new Date(lc.erasureAt).getTime() + ERASURE_SLACK_MS <= now.getTime();
}

export async function runAccountLifecyclePass(
  db: Db, deps: AccountLifecyclePassDeps,
): Promise<AccountLifecyclePassResult> {
  const log = deps.log ?? silentLogger;
  const now = deps.now;
  const concurrency = deps.concurrency ?? 4;
  const result: AccountLifecyclePassResult = {
    accounts: 0, withLifecycle: 0,
    sent: { trial_two_days: 0, closed: 0, erasure_week: 0 },
    unmailable: 0, erased: 0, faults: 0,
  };

  // Keyset pages over the live accounts — the erased are out by the WHERE, and an account this
  // very run erases sets `erased_at` so no later page or run meets it again.
  let after: string | null = null;
  for (;;) {
    const page: Array<{ id: string }> = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(
        isNull(accounts.erasedAt),
        exists(db.select({ one: sql`1` }).from(users).where(eq(users.accountId, accounts.id))),
        ...(after !== null ? [gt(accounts.id, after)] : []),
      ))
      .orderBy(asc(accounts.id))
      .limit(200);
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;

    for (let i = 0; i < page.length; i += concurrency) {
      const chunk = page.slice(i, i + concurrency);
      await Promise.all(chunk.map(async ({ id }) => {
        result.accounts += 1;
        try {
          const verdict = await deps.port.access(id);
          const lc = verdict.lifecycle;
          if (!lc) return; // an old plane, or no block — today's behaviour, nothing owed
          result.withLifecycle += 1;

          for (const due of noticesDue(lc, now())) {
            await claimAndSend(db, deps, id, due, result, log);
          }

          // The refusal above is silent by itself, and a drift nobody sees is a drift nobody
          // fixes. Reported once per pass, never acted on — the hold stays a staff act.
          if (lc.closedReason === "suspended" && lc.erasureAt !== null) {
            log.warn("account_erasure_refused_suspended", {
              accountId: id,
              reason: "the plane sent an erasure date for an account it holds suspended, which " +
                "its own contract keeps null; the pass refuses the erasure and changes nothing",
            });
          }

          if (erasureDue(lc, now())) {
            // THE VERDICT IS RE-READ AT THE ERASURE DOOR. The page's read can be minutes old on a
            // long run, and somebody who subscribed again in between must keep their data. The
            // re-read sits AHEAD of the money stop so a skip touches nothing at all — a released
            // subscription is not recoverable by returning early.
            const fresh = (await deps.port.access(id)).lifecycle;
            if (!fresh || !erasureDue(fresh, now())) {
              log.info("account_erasure_skipped_reactivated", {
                accountId: id,
                reason: "the verdict read at the erasure door no longer asks for erasure — the " +
                  "account was reactivated or its retention moved; nothing was released or erased",
              });
              return;
            }
            // STOP THE MONEY first, exactly as `DELETE /account` does; a cancel failure does not
            // block erasure — the port answers rather than throwing, and the outcome is logged.
            const outcome = await deps.port.releaseAccount(id);
            await deleteAccount({
              db, accountId: id, userId: null, now, requestId: randomUUID(),
            });
            result.erased += 1;
            log.info("account_lifecycle_erased", {
              accountId: id, subscription: outcome,
              reason: "the retention period ended a day ago or more; the account's data is " +
                "erased through the same path DELETE /account runs, and the mailbox is untouched",
            });
          }
        } catch (err) {
          result.faults += 1;
          log.error("account_lifecycle_account_failed", {
            accountId: id, err,
            reason: "this account's lifecycle step failed and is retried on the next run; " +
              "the pass continues with the remaining accounts",
          });
        }
      }));
    }
  }
  return result;
}

/** Claim one notice by its PK, send it, and un-claim on a FAILED send so the next run retries. */
async function claimAndSend(
  db: Db, deps: AccountLifecyclePassDeps, accountId: string, due: DueNotice,
  result: AccountLifecyclePassResult, log: Logger,
): Promise<void> {
  if (deps.mail === null) {
    result.unmailable += 1;
    return;
  }
  const claimed = await bridgeTx(db).insert(accountLifecycleNotices)
    .values({ accountId, kind: due.kind, anchor: due.anchor })
    .onConflictDoNothing()
    .returning({ accountId: accountLifecycleNotices.accountId });
  if (claimed.length === 0) return; // already sent for this fact — the PK is the idempotency

  const recipients = await db.select({ email: users.email }).from(users)
    .where(eq(users.accountId, accountId));
  const [settings] = await db.select({ locale: accountSettings.locale }).from(accountSettings)
    .where(eq(accountSettings.accountId, accountId)).limit(1);
  const locale: "en" | "de" = settings?.locale === "de" ? "de" : "en";

  let anyFailed = false;
  for (const r of recipients) {
    const sent = await deps.mail.sendLifecycleNotice(
      { db, now: deps.now },
      { to: r.email, kind: due.kind, locale, anchor: due.anchor, erasureAt: due.erasureAt },
    );
    if (sent.status === "failed") anyFailed = true;
  }
  if (anyFailed) {
    // The claim is handed back so the next nightly run retries; the mailer's own idempotency
    // key (recipient, kind, anchor) keeps a half-delivered account from double-mailing.
    await bridgeTx(db).delete(accountLifecycleNotices).where(and(
      eq(accountLifecycleNotices.accountId, accountId),
      eq(accountLifecycleNotices.kind, due.kind),
      eq(accountLifecycleNotices.anchor, due.anchor),
    ));
    result.faults += 1;
    log.error("account_lifecycle_notice_send_failed", {
      accountId, kind: due.kind,
      reason: "the notice's claim was handed back; the next nightly run sends it again",
    });
    return;
  }
  result.sent[due.kind] += 1;
}
