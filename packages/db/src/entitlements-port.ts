/**
 * THE ENTITLEMENTS PORT — the one question the open server asks about an account's standing, and
 * nothing that answers it.
 *
 * Limits, access and AI metering belong to whoever operates the service: a managed deployment
 * points `ENTITLEMENTS_URL` at a program that holds that state, and a self-hosted or desktop
 * install has none and is unmetered. Both run the same route table, so callers must be able to
 * name the answer they may be handed without depending on what answers.
 *
 * On the MAIL barrel — pure types and two literals, no database — for the reason `ai-gate-port.ts`
 * is: every host compiles the route table, and the engine artifact may not carry the hosted half.
 * `entitlements-local.ts` and `entitlements-client.ts` are the two answers, on the hosted barrel.
 */

/** Why access was refused. Two states, because a refusal has two remedies: pay, or ask us. */
export type AccessRefusal = "payment_required" | "suspended";

/** May this account use the service, and within what limits. */
export type AccessVerdict =
  | { ok: true; limits: AccessLimits }
  | { ok: false; reason: AccessRefusal; manageUrl?: string };

/**
 * `null` means UNBOUNDED, never unknown: a fault answers with the last known verdict and defaults
 * to allow, so there is no third state to carry. `aiEnabled` is whether METERED AI may run at all;
 * a port-less install answers `true` and meters nothing.
 */
export interface AccessLimits {
  mailboxes: number | null;
  storageBytes: number | null;
  aiEnabled: boolean;
}

/**
 * The money verdict for one AI action, in the gate's own vocabulary (`ai-gate-port.ts`): proceed
 * and charged, proceed and already paid for, degrade to rules, degrade because we do not know.
 * `fault` exists rather than a rejection because a billing fault must cost the AI suggestion and
 * never the mail.
 */
export type SpendVerdict = "ok" | "duplicate" | "insufficient" | "fault";

/**
 * What erasure learned when it stopped the money. Three values because the customer's screen shows
 * three — nothing to stop, stopped, could not be stopped — and Article 17 proceeds in all three.
 */
export type ReleaseOutcome = "none" | "released" | "failed";

export interface EntitlementsPort {
  /**
   * NEVER THROWS, and a transport fault answers with the last verdict this process saw for the
   * account — or, with none, `ok: true` and unbounded limits. An entitlements outage must not lock
   * a paying customer out of their mail. It is also why implementations cache: a per-request dial
   * on the mail path is refused at review.
   */
  access(accountId: string): Promise<AccessVerdict>;
  /** Charge one AI action against `attemptKey`, which names the unit of WORK so retries are free.
   *  Never throws — see {@link SpendVerdict}. */
  spend(accountId: string, action: string, attemptKey: string): Promise<SpendVerdict>;
  /** Reverse a charge for work never delivered. Never throws; replay-safe. */
  release(accountId: string, attemptKey: string): Promise<void>;
  /** Where this account manages its subscription, or `null` when there is nowhere to send them.
   *  The settings row renders only when a URL comes back. */
  manageLink(accountId: string): Promise<{ url: string } | null>;
  /** The person is being erased: stop the money. Bounded and never throwing, because Article 17
   *  may not be withheld because a payment processor is unreachable. */
  releaseAccount(accountId: string): Promise<ReleaseOutcome>;
}

/**
 * WHAT A HOST WITH NO ENTITLEMENTS PROGRAM SAYS — a named state, never an absent field.
 *
 * Absent is a composition nobody finished; this literal is a deployment that means it. Every
 * composition fills the member, with a port or with this, so a bag holding neither is a
 * configuration error rather than a silently free tier.
 */
export const UNMETERED = "unmetered" as const;

/** A composition either reaches an entitlements program or declares itself unmetered. */
export type EntitlementsComposition = EntitlementsPort | typeof UNMETERED;

/** The unmetered verdict as a value — unbounded limits, AI gated only by a provider key. */
export const UNMETERED_ACCESS: AccessVerdict = {
  ok: true,
  limits: { mailboxes: null, storageBytes: null, aiEnabled: true },
};

/** Read access through whatever this host declared. The unmetered arm dials nothing, which is what
 *  makes an unmetered install unable to depend on a network answer. */
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
