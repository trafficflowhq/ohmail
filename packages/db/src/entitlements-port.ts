import type { SpendAction } from "./ledger-source.js";
import type { AiRefusalReason } from "./ai-gate-port.js";

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
 *
 * The shapes below follow the entitlements program's own wire contract v1, which is the authority
 * for both sides. Where they differ from it they REDUCE: the program answers ten `reason` values
 * and this port carries two, because the open app has two sentences to say.
 */

/** Why access was refused. Two states, because a refusal has two remedies: pay, or ask us. */
export type AccessRefusal = "payment_required" | "suspended";

/** May this account use the service, and within what limits. */
export type AccessVerdict =
  | { ok: true; limits: AccessLimits }
  | { ok: false; reason: AccessRefusal; manageUrl?: string };

/**
 * `null` means UNBOUNDED, never unknown: a fault answers with the last known verdict and defaults
 * to allow, so there is no third state to carry.
 *
 * `canAddMailbox` and `aiEnabled` are separate questions and not derivable from the numbers —
 * an account may retain the mailboxes it has and be forbidden another, and one that has switched
 * AI off is healthy. Collapsing them is how a refusal ends up offering a plan the customer holds.
 */
export interface AccessLimits {
  mailboxes: number | null;
  storageBytes: number | null;
  canAddMailbox: boolean;
  aiEnabled: boolean;
}

/**
 * THE MONEY ANSWER FOR ONE AI ACTION — five verdicts the program states, plus the one the CALLER
 * synthesizes. Four would not carry it, and each of the two extras is a defect if folded:
 *
 *  · `refused` folded into `insufficient` answers "out of credits" to a funded account whose owner
 *    switched AI off — a payment demand for the product working as asked (409, never 402);
 *  · `inflight` folded into `duplicate` tells the loser of a race to PROCEED, buying a second paid
 *    model call for one credit. It is the exclusive claim's whole purpose. The caller does not
 *    proceed on it and does not treat it as a duplicate; it is per-SOURCE, so a batch moves on.
 *
 * `fault` is never a 200 body. It is what a caller says when the program could not answer, which
 * is what keeps a fault impossible to mistake for a refusal.
 */
export type SpendOutcome =
  /** Proceed; this attempt moved money. KEEP `attempt` — it is what a reversal names. */
  | { verdict: "ok"; charged: true; attempt: string }
  /** Proceed, free: an attempt for this work is already open and paid for. */
  | { verdict: "duplicate"; charged: false; attempt: string }
  /** The plan could spend and the balance is empty. A payment demand. */
  | { verdict: "insufficient"; reason: AiRefusalReason }
  /** The subscription or the account's own switch may not spend. NOT a payment demand. */
  | { verdict: "refused"; reason: AiRefusalReason }
  /** Another caller holds the claim on this exact work. Transient, never charged, do not proceed. */
  | { verdict: "inflight"; source: string }
  /** We do not know. Degrade — never a charge and never a demand. */
  | { verdict: "fault" };

/**
 * WHICH CALL SITE IS SPENDING — the terms table's own keys, and not a second list of them.
 *
 * It was a hand-written union of the same five words. One definition, because the terms
 * (`SPEND_ACTIONS`: reason, namespace, exclusivity, pool, retry window) and the names have to
 * move together — a sixth action added to the table with no word here, or a word here with no
 * terms, is what a port cannot express.
 */
export type { SpendAction } from "./ledger-source.js";

/**
 * HOW A SPEND ENDED — `refund: false` gives the claim back, `true` also reverses the charge.
 *
 * A UNION, and the asymmetry is deliberate: a reversal must NAME the attempt it reverses, and a
 * release that reverses nothing has nothing to name. Written as one shape with an optional
 * `attempt`, "refund this, I forget which attempt" is representable — and it is the shape that
 * reverses a neighbour's charge, because the gate falls back to the bare source, which is
 * attempt 1 and may belong to work that was delivered months ago.
 *
 * Pass `refund: true` only with an `attempt` THIS caller was told was `charged: true`, once per
 * abandonment. A `duplicate` charged nothing, so its caller releases and does not refund.
 */
export type SpendRelease = {
  action: SpendAction;
  attemptKey: string;
  /** Provenance for the reversal's own ledger row. Ids and counts, never a message's content. */
  meta?: SpendMeta;
} & (
  | { refund: false }
  | {
      refund: true;
      /** What {@link SpendOutcome} returned as `attempt` for a `charged: true` answer. */
      attempt: string;
    }
);

/**
 * PROVENANCE FOR THE LEDGER ROW, and the reason it is not free-form in practice.
 *
 * It is a `jsonb` column and indexes nothing, which is why identifiers too long or too variable
 * for a source belong here — the mailbox, the message, the run and its step. It is also the
 * column a privacy review found carrying a raw `Message-ID`, so what goes in are ids WE minted
 * and counts, and nothing a sender chose.
 */
export type SpendMeta = Record<string, unknown>;

/**
 * What erasure learned when it stopped the money — the erasure response's own three values, so
 * nothing translates between them and none of them can be reported as another.
 */
export type ReleaseOutcome = "none" | "cancelled" | "cancel_failed";

export interface EntitlementsPort {
  /**
   * NEVER THROWS, and a transport fault answers with the last verdict this process saw for the
   * account — or, with none, `ok: true` and unbounded limits. An entitlements outage must not lock
   * a paying customer out of their mail. It is also why implementations cache: a per-request dial
   * on the mail path is refused at review.
   */
  access(accountId: string): Promise<AccessVerdict>;
  /**
   * Charge one AI action against `attemptKey`, which names the unit of WORK so retries are free.
   *
   * `attemptKey` is the BARE key — the message, `<messageId>:<hashed client key>`, the run id,
   * `<runId>:<stepIndex>` — never a composed ledger source. Both implementations compose the
   * source through the one composer (`sourceFor`), which refuses a key that is already a source:
   * a double-prefixed one passes the ledger's namespace CHECK and its UNIQUE, so already-paid
   * work would answer `ok` and be charged twice. Build keys with `ledger-source.ts`.
   *
   * Never answers a money verdict by throwing — see {@link SpendOutcome}. A malformed key is not
   * a money verdict: it is the caller-bug class, and it raises.
   */
  spend(
    accountId: string, action: SpendAction, attemptKey: string, meta?: SpendMeta,
  ): Promise<SpendOutcome>;
  /** The work is over, whichever way it ended. Never throws; replay-safe. */
  release(accountId: string, r: SpendRelease): Promise<void>;
  /**
   * The one customer-facing door the managed service has: plan choice for an account with no
   * subscription, and plan status for one that has. A KNOWN account always gets a URL, so this is
   * also the only route to a FIRST subscription — which is why `null` means one thing, that the
   * program does not know this account, and not "nothing to manage".
   *
   * Render the row, or the onboarding link, only when a URL comes back; never store one.
   */
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

/**
 * THE SPEND HALF ALONE — what an AI call site is handed.
 *
 * A call site asks about money and says when the work ended; it has no business reading limits,
 * minting a manage link or cancelling a subscription. Narrowing it here rather than at each site
 * means the ten of them name one type, and a test double is two methods rather than five.
 */
export type SpendPort = Pick<EntitlementsPort, "spend" | "release">;

/** A call site either reaches an entitlements program or is told this host meters nothing. */
export type SpendComposition = SpendPort | typeof UNMETERED;

/** True iff this host meters spend at all. The unmetered arm charges nothing and asks nobody. */
export function isSpendMetered(e: SpendComposition): e is SpendPort {
  return e !== UNMETERED;
}

/** The unmetered verdict as a value — unbounded limits, AI gated only by a provider key. */
export const UNMETERED_ACCESS: AccessVerdict = {
  ok: true,
  limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true },
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
