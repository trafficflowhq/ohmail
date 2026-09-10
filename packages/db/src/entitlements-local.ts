import { balanceOf } from "./credits.js";
import { effectiveSubscriptionOf, entitlementsFor } from "./billing.js";
import { isSuspended } from "./suspension.js";
import { makeAiCreditGate } from "./ai-gate.js";
import type { WeightedDebitReason } from "./ledger-source.js";
import type { Tx } from "./change-log.js";
import type {
  AccessVerdict, EntitlementsPort, ReleaseOutcome, SpendAction, SpendOutcome, SpendRelease,
} from "./entitlements-port.js";

/**
 * THE LOCAL ADAPTER — {@link EntitlementsPort} answered from the tables in this database.
 *
 * It exists so the seam can be introduced without moving any state: every consumer starts
 * speaking the port while the answers still come from `billing_subscriptions`, `credit_ledger`
 * and `account_suspensions` exactly as they did before. When the state moves to a program of its
 * own, the composition swaps this for `entitlements-client.ts` and no caller changes.
 *
 * It is on the HOSTED barrel, so the engine census refuses it in the desktop artifact — which is
 * the point: the port TYPE is engine-safe and this answer is not.
 */

/** Where the two answers this database cannot give come from. Both are optional and both fail
 *  closed to "there is none", which is the honest answer on a deployment that wired neither. */
export interface LocalEntitlementsConfig {
  /** The account's own handle. Never a caller's transaction — see {@link makeLocalEntitlements}. */
  db: Tx;
  /** The clock; entitlement states are time-dependent (grace, trial end). */
  now?: () => Date;
  /**
   * Where a customer manages their subscription. Composed by the host, because the answer is a
   * network hop through a service this package may not import. Absent ⇒ `null`, and the
   * settings row does not render.
   */
  manageLink?: (accountId: string) => Promise<{ url: string } | null>;
  /** Erasure's "stop the money", composed by the host for the same reason. Absent ⇒ `"none"`. */
  releaseAccount?: (accountId: string) => Promise<ReleaseOutcome>;
}

/**
 * The program prices per CALL SITE; this database's gate books per ledger REASON. One mapping,
 * here, so the two can never disagree — the same table the program's contract states.
 */
const REASON_OF: Record<SpendAction, WeightedDebitReason> = {
  classify_ingest: "debit_classify",
  screener: "debit_classify",
  draft: "debit_draft",
  propose: "debit_propose",
  workflow: "debit_workflow",
};

export function makeLocalEntitlements(cfg: LocalEntitlementsConfig): EntitlementsPort {
  const now = cfg.now ?? (() => new Date());
  /** The Screener is the one call site that serializes its spenders — the gate's `exclusive`. */
  const gateFor = (action: SpendAction, accountId: string): ReturnType<typeof makeAiCreditGate> =>
    makeAiCreditGate(cfg.db, accountId, {
      reason: REASON_OF[action], now, ...(action === "screener" ? { exclusive: true } : {}),
    });

  return {
    /**
     * TODAY'S LIMITS, AND NO REFUSAL — deliberately, because today's product locks nobody out of
     * their own mail. A suspension stops sync and scheduled sends and turns AI off, all of which
     * ride `limits`/`aiEnabled` below; it has never refused a mail read, and introducing that
     * here would ship a lock-out under a seam whose job is to change nothing. The refusing arm
     * belongs to whoever holds the access policy.
     *
     * Reads on `cfg.db`, never on a caller's transaction: a port answer taken inside somebody
     * else's transaction holds their row locks across a decision that will one day be a network
     * hop.
     */
    async access(accountId: string): Promise<AccessVerdict> {
      const at = now();
      const sub = await effectiveSubscriptionOf(cfg.db, accountId);
      const balance = await balanceOf(cfg.db, accountId);
      const suspended = await isSuspended(cfg.db, accountId);
      const ent = entitlementsFor({ sub, balance, suspended, now: at });
      return {
        ok: true,
        limits: {
          mailboxes: ent.mailboxLimit,
          storageBytes: ent.storageBytesLimit,
          canAddMailbox: ent.canAddMailbox,
          aiEnabled: ent.aiEnabled,
        },
      };
    },

    /**
     * The AI gate's own decision, one-to-one. Every one of `AiSpendOutcome`'s five shapes has a
     * word here, which is the reason the port carries five: folding `inflight` into `duplicate`
     * tells the loser of a race to proceed, and folding a state refusal into `insufficient`
     * demands payment from a funded account whose owner switched AI off.
     */
    async spend(accountId: string, action: SpendAction, attemptKey: string): Promise<SpendOutcome> {
      const outcome = await gateFor(action, accountId).spend(attemptKey, { action });
      if (outcome.permitted) {
        return outcome.charged
          ? { verdict: "ok", charged: true, attempt: outcome.attempt }
          : { verdict: "duplicate", charged: false, attempt: outcome.attempt };
      }
      if (outcome.refusal === "quantity") return { verdict: "insufficient", reason: outcome.reason };
      if (outcome.refusal === "state") return { verdict: "refused", reason: outcome.reason };
      if (outcome.refusal === "inflight") return { verdict: "inflight", source: outcome.source };
      return { verdict: "fault" };
    },

    /**
     * `refund: false` gives the exclusive claim back and leaves the charge standing — the work was
     * delivered, and an open attempt is what makes its retries free. `true` also reverses the
     * named attempt, which is the abandoned case.
     */
    async release(accountId: string, r: SpendRelease): Promise<void> {
      const gate = gateFor(r.action, accountId);
      if (r.refund) await gate.refundAttempt(r.attempt);
      await gate.release?.(r.attemptKey);
    },

    async manageLink(accountId: string): Promise<{ url: string } | null> {
      if (!cfg.manageLink) return null;
      try {
        return await cfg.manageLink(accountId);
      } catch {
        // A settings row that cannot be built is a row that does not render. Never a 500 on a
        // page whose other half is the customer's own account.
        return null;
      }
    },

    async releaseAccount(accountId: string): Promise<ReleaseOutcome> {
      if (!cfg.releaseAccount) return "none";
      try {
        return await cfg.releaseAccount(accountId);
      } catch {
        // Never "none": the customer's screen must not read "nothing to cancel" when the truth
        // is "we could not cancel it" — that is a deleted account still being charged.
        return "cancel_failed";
      }
    },
  };
}
