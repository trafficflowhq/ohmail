/**
 * THE ENTITLEMENTS PORT — the one question the open server asks about an account's standing,
 * and nothing that answers it.
 *
 * Limits, access and AI metering belong to whoever operates the service. A managed deployment
 * points `ENTITLEMENTS_URL` at a program that holds that state; a self-hosted or desktop install
 * has no such program and is unmetered. Both run the same route table, so the callers must be
 * able to name the answer they may be handed without depending on the thing that answers.
 *
 * This file is the question; `entitlements-local.ts` and `entitlements-client.ts` are the two
 * answers. It stays on the MAIL barrel — pure types and one literal, no database — for the reason
 * `ai-gate-port.ts` does: every host compiles the route table, and the engine artifact may not
 * carry the hosted half.
 */

/** Why access was refused. Two states, because a refusal has two remedies: pay, or ask us. */
export type AccessRefusal = "payment_required" | "suspended";

/**
 * May this account use the service, and within what limits.
 *
 * `null` limits mean UNBOUNDED, never unknown — a fault answers with the last known verdict and
 * defaults to allow (see {@link EntitlementsPort.access}), so there is no third state to carry.
 */
export type AccessVerdict =
  | { ok: true; limits: AccessLimits }
  | { ok: false; reason: AccessRefusal; manageUrl?: string };

export interface AccessLimits {
  /** Mailboxes this account may have connected; `null` ⇒ unbounded. */
  mailboxes: number | null;
  /** Stored bytes this account may hold; `null` ⇒ unbounded. */
  storageBytes: number | null;
  /** Whether metered AI may run at all. A port-less install answers `true` and meters nothing. */
  aiEnabled: boolean;
}

/**
 * The money verdict for one AI action, in the AI gate's own vocabulary
 * (`packages/db/src/ai-gate-port.ts`): `ok` proceed and charged, `duplicate` proceed and already
 * paid for, `insufficient` degrade to rules, `fault` degrade because we do not know. The gate's
 * never-throw contract is why `fault` exists rather than a rejection — a billing fault must cost
 * the AI suggestion and never the mail.
 */
export type SpendVerdict = "ok" | "duplicate" | "insufficient" | "fault";

/**
 * What erasure learned when it stopped the money. Three values because the customer's screen
 * shows three: there was nothing to stop, it stopped, or it could not be stopped and nobody can
 * try again from that account. Art. 17 proceeds in all three.
 */
export type ReleaseOutcome = "none" | "released" | "failed";

export interface EntitlementsPort {
  /**
   * May this account use the service, and within what limits.
   *
   * NEVER THROWS, and a transport fault answers with the last verdict this process saw for the
   * account — or, with none, `ok: true` and unbounded limits. That direction is the ai-gate law
   * one layer up: an entitlements outage must not lock a paying customer out of their mail. It is
   * also why implementations cache: a per-request dial on the mail path is refused by review.
   */
  access(accountId: string): Promise<AccessVerdict>;
  /**
   * Charge one AI action against `attemptKey`, or say why not. Never throws — see
   * {@link SpendVerdict}. `attemptKey` names the unit of WORK, so a retry of it is free.
   */
  spend(accountId: string, action: string, attemptKey: string): Promise<SpendVerdict>;
  /** Reverse a charge for work that was never delivered. Never throws; replay-safe. */
  release(accountId: string, attemptKey: string): Promise<void>;
  /**
   * Where this account manages its subscription, or `null` when there is nowhere to send them.
   * `null` is the answer on every install that operates no such surface, and the settings row
   * renders only when a URL comes back.
   */
  manageLink(accountId: string): Promise<{ url: string } | null>;
  /**
   * The person is being erased: stop the money. Bounded in time and never throwing, because
   * Art. 17 may not be withheld because a payment processor is unreachable.
   */
  releaseAccount(accountId: string): Promise<ReleaseOutcome>;
}

/**
 * WHAT A HOST WITH NO ENTITLEMENTS PROGRAM SAYS — a named state, never an absent field.
 *
 * Absent and unmetered are two different facts: absent is a composition nobody finished, and a
 * host that means to be unmetered has to say so. Every composition therefore fills the member,
 * with a port or with this literal, and a bag holding neither is a configuration error rather
 * than a silently free tier.
 */
export const UNMETERED = "unmetered" as const;

/** A composition either reaches an entitlements program or declares itself unmetered. */
export type EntitlementsComposition = EntitlementsPort | typeof UNMETERED;

/** The unmetered verdict, as a value — unbounded limits, AI gated only by a provider key. */
export const UNMETERED_ACCESS: AccessVerdict = {
  ok: true,
  limits: { mailboxes: null, storageBytes: null, aiEnabled: true },
};

/**
 * Read access through whatever this host declared. The unmetered arm dials nothing and allocates
 * nothing, which is what makes an unmetered install unable to depend on a network answer.
 */
export async function accessOf(
  entitlements: EntitlementsComposition, accountId: string,
): Promise<AccessVerdict> {
  if (entitlements === UNMETERED) return UNMETERED_ACCESS;
  return entitlements.access(accountId);
}

/** True iff this host reaches an entitlements program at all. */
export function isMetered(e: EntitlementsComposition): e is EntitlementsPort {
  return e !== UNMETERED;
}
