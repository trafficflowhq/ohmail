import { and, asc, eq, gt } from "drizzle-orm";
import { AccountErasedError, fencedAccountWrite } from "./erasure-fence.js";
import { accountLifecycleNotices, staffAuditEvents } from "./schema-cloud.js";
import { accounts, accountSettings, users } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * THE STAFF BILLING LINK'S CLAIM (cloud 0050): at most {@link BILLING_LINK_CAP} per account in any
 * {@link BILLING_LINK_WINDOW_MS}, each one an `account_lifecycle_notices` row of kind
 * `billing_link`. The account row is taken FOR NO KEY UPDATE first, so the count and the claim of
 * concurrent presses run one after another, and an erasure orders against it. The claim and its
 * `ok` audit row commit together, before any mail leaves: no row, no mail.
 */

export const BILLING_LINK_CAP = 3;
export const BILLING_LINK_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BillingLinkClaimInput {
  accountId: string;
  now: Date;
  /** The `ok` staff audit row, built and checked by the API's one writer, inserted inside the claim. */
  staffEvent: (o: { userId: string; sendsToday: number }) => typeof staffAuditEvents.$inferInsert;
}

export type BillingLinkClaim =
  | {
    kind: "claimed"; to: string; userId: string; locale: "en" | "de"; anchor: Date;
    sendsToday: number; auditId: string; auditAt: Date;
  }
  | { kind: "refused"; code: "account_not_found" | "account_erased" | "no_login"; retryAt: null }
  | { kind: "refused"; code: "rate_limited"; retryAt: Date };

/** Thrown when the claim's audit row could not be built or written; the claim rolled back with it. */
export class BillingLinkAuditError extends Error {
  constructor(readonly cause: unknown) {
    super("billing link audit row could not be written");
    this.name = "BillingLinkAuditError";
  }
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export async function claimBillingLink(db: Tx, input: BillingLinkClaimInput): Promise<BillingLinkClaim> {
  const { accountId, now } = input;
  try {
    return await fencedAccountWrite(db, { accountId, lock: "no key update" }, async (tx): Promise<BillingLinkClaim> => {
      const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!account) return { kind: "refused", code: "account_not_found", retryAt: null };
      // The account's owner is its oldest login, as the staff roster reads it.
      const [owner] = await tx.select({ id: users.id, email: users.email }).from(users)
        .where(eq(users.accountId, accountId)).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
      if (!owner) return { kind: "refused", code: "no_login", retryAt: null };

      const recent = (await tx.select({ anchor: accountLifecycleNotices.anchor }).from(accountLifecycleNotices)
        .where(and(
          eq(accountLifecycleNotices.accountId, accountId),
          eq(accountLifecycleNotices.kind, "billing_link"),
          gt(accountLifecycleNotices.anchor, new Date(now.getTime() - BILLING_LINK_WINDOW_MS)),
        ))
        .orderBy(asc(accountLifecycleNotices.anchor))).map((r) => asDate(r.anchor).getTime());
      if (recent.length >= BILLING_LINK_CAP) {
        return { kind: "refused", code: "rate_limited", retryAt: new Date(recent[0]! + BILLING_LINK_WINDOW_MS) };
      }
      // One instant per claim even on a coarse or frozen clock: the row is keyed on its anchor.
      const anchor = new Date(Math.max(now.getTime(), (recent.at(-1) ?? -1) + 1));
      const [settings] = await tx.select({ locale: accountSettings.locale }).from(accountSettings)
        .where(eq(accountSettings.accountId, accountId)).limit(1);
      await tx.insert(accountLifecycleNotices).values({ accountId, kind: "billing_link", anchor });

      const sendsToday = recent.length + 1;
      let audit: { id: string; at: Date | string } | undefined;
      try {
        [audit] = await tx.insert(staffAuditEvents)
          .values(input.staffEvent({ userId: owner.id, sendsToday }))
          .returning({ id: staffAuditEvents.id, at: staffAuditEvents.at });
      } catch (err) {
        throw new BillingLinkAuditError(err);
      }
      if (!audit) throw new BillingLinkAuditError(new Error("no row returned"));
      return {
        kind: "claimed", to: owner.email, userId: owner.id, locale: settings?.locale === "de" ? "de" : "en",
        anchor, sendsToday, auditId: audit.id, auditAt: asDate(audit.at),
      };
    });
  } catch (err) {
    if (err instanceof AccountErasedError) return { kind: "refused", code: "account_erased", retryAt: null };
    throw err;
  }
}

/**
 * A send the mailer DECLINED (it never reached a transport) hands its claim back, with the
 * failure's audit row in the same transaction, so it does not spend the day's three. A transport
 * FAILURE keeps its claim: a mail may have left, and the cap bounds mails, not confirmations.
 */
export async function handBackBillingLink(
  db: Tx, input: { accountId: string; anchor: Date; staffEvent: typeof staffAuditEvents.$inferInsert },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(accountLifecycleNotices).where(and(
      eq(accountLifecycleNotices.accountId, input.accountId),
      eq(accountLifecycleNotices.kind, "billing_link"),
      eq(accountLifecycleNotices.anchor, input.anchor),
    ));
    await tx.insert(staffAuditEvents).values(input.staffEvent);
  });
}
