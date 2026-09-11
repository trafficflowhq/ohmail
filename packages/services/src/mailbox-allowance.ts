import { and, eq, ne, sql } from "drizzle-orm";
import {
  accounts, mailboxes, NotInTransactionError,
  type AccessRefusal, type AccessVerdict, type LedgerTx,
} from "@trafficflow/db";
import { ServiceError } from "./errors.js";

/**
 * Plan-limit enforcement. "Read the count, refuse at limit" is wrong in production: two `POST
 * /mailboxes` at limit−1 both read `limit − 1` and both insert — the check is correct and the
 * outcome is still wrong. The serialization is the account's OWN row: {@link
 * readMailboxAllowance} takes `FOR UPDATE` on `accounts` BEFORE the count, so the loser counts a
 * world containing the winner's mailbox; the pg twin fires the race across two pools. The account
 * row, not the mailboxes: the contended resource is the COUNT, and row locks do not lock gaps.
 * The LIMIT is a snapshot read before the transaction (no network hop under a row lock); the
 * count is read under the lock. Unmetered is a DECLARATION, refused when absent.
 */

/**
 * Why a create was refused. Four answers, because the UI must say something TRUE and each has a
 * different remedy — and every one is REACHABLE, which the previous set was not once the reason
 * came from the port. `payment_required` — refused for payment. `suspended` — the account is
 * suspended. `not_permitted` — the port ADMITS the account and still forbids another mailbox:
 * retention and creation are different rights, and an account can hold what it has without being
 * allowed one more. `at_limit` — permitted, and every slot the limit allows is occupied: raise
 * the limit, or disconnect a mailbox.
 */
export type MailboxRefusal = "payment_required" | "suspended" | "not_permitted" | "at_limit";

/** Everything the decision was made from — carried into the error so the UI need not re-query. */
export interface MailboxAllowance {
  /**
   * How many mailboxes this account may have connected, FROM THE ENTITLEMENTS PORT, and the one
   * number both the decision and the message read. `null` ⇒ unbounded (an unmetered install).
   *
   * It is a field of its own rather than `entitlements.mailboxLimit` because the limit and the
   * REASON now come from different places: the limit from whoever operates the service, the reason
   * how a refusal ends up quoting a number the gate did not use: the limit and the REASON come
   * from the same verdict, and reading either one twice is what gets them out of step.
   */
  mailboxLimit: number | null;
  /**
   * MAY this account connect another at all, FROM THE PORT — a separate question from the count,
   * and not derivable from it: an account may retain the mailboxes it has and be forbidden
   * another. Collapsing the two is how a refusal ends up offering a plan the customer holds.
   */
  canAddMailbox: boolean;
  /**
   * WHY the port refused, or `null` when it did not. Two words, because the port carries two —
   * whoever operates the service knows ten states and the app has two sentences to say.
   */
  accessRefusal: AccessRefusal | null;
  /**
   * Mailboxes that currently OCCUPY a slot: every row whose `status` is not `'disabled'`.
   * `mailboxes` has no `deleted_at` (the original sketch assumed one) — disconnect is a soft delete to
   * `status='disabled'` because `messages.mailbox_id` FK-references the row. `'error'` still
   * occupies a slot: a mailbox that is failing to sync is still connected.
   */
  enabledCount: number;
}

/** Refusal → the wire code and status. 402 where the remedy is elsewhere, 409 where it is here. */
const HTTP: Record<MailboxRefusal, { code: string; status: number }> = {
  // 402: the remedy is not on this server — it is with whoever operates the service.
  payment_required: { code: "payment_required", status: 402 },
  suspended: { code: "account_suspended", status: 402 },
  not_permitted: { code: "mailbox_not_permitted", status: 402 },
  // 409: nothing is wrong with the account; the request conflicts with what it already holds.
  at_limit: { code: "mailbox_limit_reached", status: 409 },
};

/**
 * Factual microcopy — no slogans, and never a lie about what was kept.
 *
 * Three sentences where there were eight: the eight came from a per-state reason this server
 * kept, and the port answers two words. Every sentence still says what happens to what is
 * already connected, which is the half a refusal must not omit.
 */
function messageFor(refusal: MailboxRefusal, a: MailboxAllowance): string {
  if (refusal === "at_limit") {
    return `This account may have ${a.mailboxLimit} mailbox${a.mailboxLimit === 1 ? "" : "es"} and ` +
      `${a.enabledCount} are connected. Raise the limit or disconnect a mailbox to add another.`;
  }
  if (refusal === "suspended") {
    return "This account is suspended. No mailbox can be connected while it is; " +
      "nothing already connected is deleted.";
  }
  if (refusal === "payment_required") {
    return "This account is not currently entitled to connect a mailbox. " +
      "The mailboxes already connected are kept, and nothing is deleted.";
  }
  return "This account may not connect another mailbox. " +
    "The mailboxes already connected are kept, and nothing is deleted.";
}

/**
 * The refusal, as a typed {@link ServiceError} subclass — so `withErrorEnvelope` maps it to the
 * `{ error: { code, message, details } }` envelope with no route change, and so a caller can
 * `instanceof` it without string-matching a code.
 *
 * `details` carries the whole decision (`reason`, the entitlement state it came from, the limit
 * and the current count). That is what lets the UI say "2 of 2 connected on Solo" instead of
 * "something went wrong", which is the entire point of distinguishing the reasons.
 */
export class MailboxAllowanceError extends ServiceError {
  constructor(readonly refusal: MailboxRefusal, readonly allowance: MailboxAllowance) {
    const { code, status } = HTTP[refusal];
    super(code, status, messageFor(refusal, allowance), {
      reason: refusal,
      accessReason: allowance.accessRefusal,
      mailboxLimit: allowance.mailboxLimit,
      mailboxCount: allowance.enabledCount,
    });
    this.name = "MailboxAllowanceError";
  }
}

/**
 * The DECISION, as a pure function of an already-read allowance: `null` when the create may
 * proceed, otherwise the reason. Pure and total on purpose — the half of this gate that is
 * table-testable without a database; the unit table pins the decision independently of how the
 * verdict was read. Order matters: `canAddMailbox` is consulted BEFORE the count. An account the
 * port refuses while under the limit must be refused for the reason that is TRUE — its standing —
 * not told it is full, and an account whose limit is 0 must read the port's word rather than
 * `at_limit`.
 */
export function decideMailboxAllowance(a: MailboxAllowance): MailboxRefusal | null {
  // The port's own word where it gave one; `not_permitted` where it ADMITTED the account and
  // still said no. All three are reachable, which is what makes each one worth a sentence.
  if (!a.canAddMailbox) return a.accessRefusal ?? "not_permitted";
  // `null` is UNBOUNDED, not zero: an unmetered install has no count to exceed.
  if (a.mailboxLimit !== null && a.enabledCount >= a.mailboxLimit) return "at_limit";
  return null;
}


/** What {@link readMailboxAllowance} needs beyond the transaction it runs in. */
export interface MailboxAllowanceInput {
  /**
   * The account's access verdict, read BEFORE this transaction opened — REQUIRED. A parameter and
   * not a read because answering it may be a network hop to whoever operates the service, and a
   * remote call inside this transaction would hold the account's row lock across it. The caller
   * reads it first and hands the snapshot down; `null` is not accepted, because an absent verdict
   * and an unmetered one are different facts and only one means "no limit". The limit may be
   * microseconds staler than the count — the right way round: the count is the contended
   * resource, read under the lock; a limit that changed in that window is re-read on the next
   * request.
   */
  access: AccessVerdict;
  /**
   * The RE-ENABLE path (a mailbox moving out of `'disabled'` occupies a slot it does not yet hold):
   * the row must not count itself.
   */
  excludeMailboxId?: string;
}

/**
 * Read the account's allowance UNDER A ROW LOCK. The two statements are ordered, and the order is
 * the mechanism: (1) `SELECT … FROM accounts WHERE id = $1 FOR UPDATE` — the serializer; (2)
 * `SELECT count(*) FROM mailboxes WHERE account_id = $1 AND status <> 'disabled'`. A concurrent
 * creator blocks at (1) and reads (2) only after the winner's INSERT is durable; reversing them,
 * or dropping the `FOR UPDATE`, restores the double-admit race. MUST be called with the ambient
 * transaction handle: a lock taken on a top-level db handle is released at the end of its own
 * statement and serializes nothing — the `LedgerTx` type refuses a `PgDatabase` at compile time,
 * and the runtime guard catches the `as any`.
 */
export async function readMailboxAllowance(
  tx: LedgerTx,
  accountId: string,
  now: Date,
  input: MailboxAllowanceInput,
): Promise<MailboxAllowance> {
  if (typeof (tx as unknown as { rollback?: unknown }).rollback !== "function") {
    throw new NotInTransactionError("readMailboxAllowance");
  }
  const opts = input;

  // (1) The lock. Everything after this statement is serialized per account. `accounts` always has
  // this row — the session was resolved through it — so the lock is never silently absent.
  await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for("update");

  // (2) The count, read under that lock.
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      ne(mailboxes.status, "disabled"),
      opts.excludeMailboxId ? ne(mailboxes.id, opts.excludeMailboxId) : undefined,
    ));

  return {
    // The port decides all three, and a refused account may add none at all.
    mailboxLimit: input.access.ok ? input.access.limits.mailboxes : 0,
    canAddMailbox: input.access.ok ? input.access.limits.canAddMailbox : false,
    accessRefusal: input.access.ok ? null : input.access.reason,
    enabledCount: row?.n ?? 0,
  };
}

/**
 * {@link readMailboxAllowance} + {@link decideMailboxAllowance}, throwing
 * {@link MailboxAllowanceError} on refusal. Returns the allowance on success so a caller can
 * log or echo it.
 *
 * Throwing (rather than returning an outcome) is deliberate here, unlike the spend port:
 * the caller's transaction has done nothing yet at this point, so the rollback the throw causes
 * is free, and a refusal that must be remembered to be checked is a refusal that will one day
 * not be.
 */
export async function assertMayAddMailbox(
  tx: LedgerTx,
  accountId: string,
  now: Date,
  input: { access: AccessVerdict | null; excludeMailboxId?: string },
): Promise<MailboxAllowance> {
  /**
   * NO VERDICT AT ALL is a misconfigured host, not a free one — the same refusal
   * `defaultMailboxAllowance()` makes one seam over, for the same reason. Defaulting an absent
   * reader to "unmetered" would silently remove the plan limit from any host that wired THIS gate
   * and forgot the reader, and a paid gate that quietly stopped applying is not a failure anyone
   * notices from the outside. An unmetered host supplies a reader that says so.
   */
  if (input.access === null) {
    throw new ServiceError(
      "server_error", 500,
      "no entitlements reader is configured for this host, so the mailbox limit cannot be read",
    );
  }
  const allowance = await readMailboxAllowance(tx, accountId, now, {
    access: input.access, ...(input.excludeMailboxId ? { excludeMailboxId: input.excludeMailboxId } : {}),
  });
  const refusal = decideMailboxAllowance(allowance);
  if (refusal) throw new MailboxAllowanceError(refusal, allowance);
  return allowance;
}
