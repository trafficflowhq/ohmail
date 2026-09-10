import { balanceOf } from "./credits.js";
import { effectiveSubscriptionOf, entitlementsFor } from "./billing.js";
import { isSuspended } from "./suspension.js";
import { makeAiCreditGate } from "./ai-gate.js";
import { withSetupPool } from "./setup-grant.js";
import { SPEND_ACTIONS, sourceFor } from "./ledger-source.js";
import { UNMETERED_ACCESS } from "./entitlements-port.js";
import type { AiCreditGate, AiRefusalReason } from "./ai-gate-port.js";
import type { Tx } from "./change-log.js";
import type {
  AccessVerdict, EntitlementsPort, ReleaseOutcome, SpendAction, SpendMeta, SpendOutcome,
  SpendRelease,
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
  /**
   * Where a swallowed spend FAULT goes. Absent ⇒ the gate's own default (`console.error`).
   *
   * On the port because the gate is this module's private detail now: a host or a suite that
   * needs a fault counted rather than printed has nowhere else to ask. It is per-HOST and never
   * per-action — a fault is a fault whichever call site met it.
   */
  onError?: (err: unknown, ctx: { phase: "debit" | "refund"; accountId: string; source: string }) => void;
  /** Where a REFUSAL goes. Absent ⇒ the gate's default, which reports state and stays quiet
   *  about an empty balance. Here for `onError`'s reason. */
  onRefusal?: (ctx: {
    kind: "state" | "quantity"; reason: AiRefusalReason; accountId: string; source: string;
  }) => void;
}

export function makeLocalEntitlements(cfg: LocalEntitlementsConfig): EntitlementsPort {
  const now = cfg.now ?? (() => new Date());

  /**
   * THE GATE FOR ONE CALL SITE — composed from {@link SPEND_ACTIONS} and from nothing else.
   *
   * Every term the call sites used to choose for themselves is read off the table here: the
   * ledger reason, the exclusive claim, the draft path's retry window, and the Screener's setup
   * pool. That is what makes the two implementations of this port interchangeable — the
   * entitlements program composes its gate from the same table, so a host cannot hand one call
   * site another's terms, and the terms cannot differ between a local and a remote answer.
   *
   * The wrapper ORDER is load-bearing and is the program's: `withSetupPool` OUTSIDE the
   * exclusive gate, so the pool draw extends the claim rather than answering around it.
   */
  const gateFor = (action: SpendAction, accountId: string): AiCreditGate => {
    const spec = SPEND_ACTIONS[action];
    const inner = makeAiCreditGate(cfg.db, accountId, {
      reason: spec.reason,
      now,
      ...(cfg.onError ? { onError: cfg.onError } : {}),
      ...(cfg.onRefusal ? { onRefusal: cfg.onRefusal } : {}),
      ...(spec.exclusive ? { exclusive: true as const } : {}),
      ...("retryWindowMs" in spec ? { retryWindowMs: spec.retryWindowMs } : {}),
    });
    return spec.setupPool ? withSetupPool(cfg.db, accountId, inner, { now }) : inner;
  };

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
      try {
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
      } catch (err) {
        // FAIL OPEN, and never throw: `access` is consulted in front of mail reads, and the port
        // states that a fault answers with the last verdict this process saw or, with none,
        // unbounded. These three reads had no catch at all, so a dropped ledger connection came
        // out of the port as a 500 on every mail read — the one direction the contract forbids,
        // because it turns a billing blip into every customer's inbox going dark.
        //
        // There is no last-known verdict to fall back to here by design: this adapter reads the
        // same database the request itself is using, so a fault means the whole request is
        // already failing on its own terms and a cache would only hide which one. The operator is
        // told by name instead.
        cfg.onError?.(err, { phase: "debit", accountId, source: "access" });
        return UNMETERED_ACCESS;
      }
    },

    /**
     * The AI gate's own decision, one-to-one. Every one of `AiSpendOutcome`'s five shapes has a
     * word here, which is the reason the port carries five: folding `inflight` into `duplicate`
     * tells the loser of a race to proceed, and folding a state refusal into `insufficient`
     * demands payment from a funded account whose owner switched AI off.
     */
    async spend(
      accountId: string, action: SpendAction, attemptKey: string, meta?: SpendMeta,
    ): Promise<SpendOutcome> {
      // THE SOURCE IS COMPOSED, NEVER PASSED IN — and this line is the whole of the money fix.
      //
      // `attemptKey` used to reach the gate as the source itself, so this adapter meant a FULL
      // source by it while the program means a BARE key. Swapping the two implementations under
      // one caller would then have double-prefixed one direction and stripped the other: a
      // double-prefixed source passes the ledger's namespace CHECK and its UNIQUE, so work that
      // was already paid for answers `ok` instead of `duplicate` and is charged a second time.
      // `sourceFor` is the one composer both sides use, and it refuses a key that is already a
      // source rather than composing one nobody can read.
      const source = sourceFor(action, attemptKey);
      const outcome = await gateFor(action, accountId).spend(source, { ...meta, action });
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
    /**
     * The reversal names the ATTEMPT the caller was told it charged, and the claim is given back
     * by SOURCE.
     *
     * `refundAttempt` rather than `refund`: `refund`'s guard is an in-process marker on the gate
     * instance that charged, and there is no such instance across a network hop — nor across two
     * cycles of a retrying worker, whose second `duplicate` clears the marker while the first
     * cycle's charge is the one that has to come back. The exactly-once layers that do not care
     * who asks are the two in the database: the refund's own source is unique per account, and a
     * trigger refuses a refund naming no debit. So the caller's obligation is the one the port
     * states — pass an `attempt` this account was told was `charged: true`, once per abandonment.
     *
     * The claim is released only for an action that takes one, exactly as the program does it;
     * `release` on a gate with no claim is a no-op either way, and reading the term off the table
     * is what keeps the two answers the same.
     */
    async release(accountId: string, r: SpendRelease): Promise<void> {
      const source = sourceFor(r.action, r.attemptKey);
      const gate = gateFor(r.action, accountId);
      if (r.refund) await gate.refundAttempt(r.attempt, { ...r.meta, action: r.action });
      if (SPEND_ACTIONS[r.action].exclusive) await gate.release?.(source);
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
