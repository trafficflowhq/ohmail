import type { SpendAction } from "./ledger-source.js";
import type { AiRefusalReason } from "./ai-gate-port.js";

/**
 * The entitlements port — the one question the open server asks about an account's standing, and
 * nothing that answers it. Metering belongs to whoever operates the service: a managed deployment
 * points `ENTITLEMENTS_URL` at a program holding that state; a self-hosted or desktop install has
 * none and is unmetered. Both run the same route table, so callers must name the answer without
 * depending on what answers. On the MAIL barrel — pure types, no database — because every host
 * compiles the route table and the engine artifact may not carry the hosted half; the two answers
 * live on the hosted barrel. The shapes follow wire contract v1 and only ever REDUCE it: the
 * program answers ten `reason` values, this port carries two.
 */

/** Why access was refused. Two states, because a refusal has two remedies: pay, or ask us. */
export type AccessRefusal = "payment_required" | "suspended";

/** The lifecycle's closed state set — wire contract v1's `lifecycle.state` (2026-09-20). */
export type AccessLifecycleState =
  | "trialing" | "grace" | "past_due" | "active" | "closed" | "erased";

/** Why a closed account closed. `null` on a closed state means "nothing to depart from". */
export type AccessClosedReason = "trial_ended" | "canceled" | "unpaid" | "suspended";

/**
 * The program's `lifecycle` block, carried VERBATIM (ISO strings, not Dates): every consumer is a
 * renderer or a comparator, and parsing dates here would put a timezone decision in a port.
 * Absent on the wire = an old program = today's behaviour, so the field below is optional on both
 * verdict arms — `grace`/`past_due` ride `ok: true`, `closed`/`erased` ride the refusal.
 */
export interface AccessLifecycle {
  state: AccessLifecycleState;
  closedReason: AccessClosedReason | null;
  /** The trial period's end, while `trialing` only — the day-12 mail and the banner's date. */
  trialEndsAt: string | null;
  /** The open-until deadline: dunning's 7 d, or cancel + 24 h for a never-paid cancel. */
  graceUntil: string | null;
  closedAt: string | null;
  /** `max(closedAt, lifecycleEpoch)` + retention (30 d never-paid / 90 d paid); null if held. */
  erasureAt: string | null;
  erasedAt: string | null;
  formerlyPaid: boolean;
  /**
   * The instant the program's own lifecycle went live, which `erasureAt` is floored on there.
   * ABSENT (or null) means the program states none — an older program, and the erasure pass then
   * erases nothing. Present, it is what that pass belts an irreversible act against.
   */
  lifecycleEpoch?: string | null;
}

/** May this account use the service, and within what limits. */
export type AccessVerdict =
  | { ok: true; limits: AccessLimits; lifecycle?: AccessLifecycle }
  | { ok: false; reason: AccessRefusal; manageUrl?: string; lifecycle?: AccessLifecycle };

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
 * The money answer for one AI action — five verdicts the program states, plus the one the CALLER
 * synthesizes. Each of the two extras is a defect if folded: `refused` folded into `insufficient`
 * answers "out of credits" to a funded account whose owner switched AI off — a payment demand for
 * the product working as asked (409, never 402); `inflight` folded into `duplicate` tells the
 * loser of a race to PROCEED, buying a second paid model call for one credit — it is the
 * exclusive claim's whole purpose, per-SOURCE so a batch moves on. `fault` is never a 200 body:
 * it is what a caller says when the program could not answer, which keeps a fault impossible to
 * mistake for a refusal.
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
 * How a spend ended — `refund: false` gives the claim back, `true` also reverses the charge. A
 * UNION, and the asymmetry is deliberate: a reversal must NAME the attempt it reverses, and a
 * release that reverses nothing has nothing to name. As one shape with an optional `attempt`,
 * "refund this, I forget which attempt" is representable — and that shape reverses a NEIGHBOUR'S
 * charge, because the gate falls back to the bare source, which is attempt 1 and may belong to
 * work delivered months ago. Pass `refund: true` only with an `attempt` THIS caller was told was
 * `charged: true`, once per abandonment. A `duplicate` charged nothing; its caller releases and
 * does not refund.
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
 * DID THE PROGRAM TAKE THIS RELEASE — the answer that makes a lost refund writable.
 *
 * `release` answered `void`, so a reversal the program never received and one it applied were the
 * same value at every call site. A spend that bought nothing then had no way to become an
 * obligation and no way to tell the person which of the two happened to their credits. Two
 * members, never an optional field: "we do not know" is `unreachable` here, because a refund we
 * cannot confirm is a debt until something confirms it.
 */
export type ReleaseReceipt =
  /** The program answered 200. The claim is back, and a refund named here is reversed. */
  | "settled"
  /** Nothing answered, or the answer was not a 200. Whatever this release owed is still owed. */
  | "unreachable";

/**
 * PROVENANCE FOR THE LEDGER ROW, and the reason it is not free-form in practice.
 *
 * It is a `jsonb` column and indexes nothing, which is why identifiers too long or too variable
 * for a source belong here — the mailbox, the message, the run and its step. It is also the
 * column a privacy review found carrying a raw `Message-ID`, so what goes in are ids WE minted
 * and counts, and nothing a sender chose.
 */
export type SpendMeta = Record<string, unknown>;

/** Why a spend bought nothing. The `credit_refund_obligations_reason_check` set, as words. */
export type RefundObligationReason =
  /** The model call this spend paid for threw. Nothing was produced and nothing was stored. */
  | "drafter_failed"
  /** Advice was bought for a mailbox no organizer can apply it to — bought, then unusable. */
  | "no_organizer"
  /** The sender was advised between the candidate query and the claim: the spend bought a second
   *  copy of an answer that already exists. */
  | "already_advised";

/** One debt: everything the reversal needs, and nothing about what a credit is worth. */
export interface RefundObligation {
  accountId: string;
  action: SpendAction;
  /** The BARE attempt key. The port composes the ledger source; storing a composed one
   *  double-prefixes it on the drain's release. */
  attemptKey: string;
  /** What {@link SpendOutcome} answered as `attempt` for a `charged: true` verdict. */
  attempt: string;
  reason: RefundObligationReason;
  meta?: SpendMeta;
}

/**
 * WHERE A SPEND THAT BOUGHT NOTHING IS REMEMBERED — a port, for the reason `ApiFaultLogPort` is
 * one: the table is Cloud's and this file is on the mail barrel, which the desktop engine
 * compiles. A local install composes none of this and has nothing to owe.
 *
 * `owe` runs BEFORE the reversal is attempted, so a crash between the two leaves the debt
 * standing; it is idempotent per (account, attempt), so observing one failure twice is one debt.
 * `settle` is what a receipt of `settled` earns. Neither may throw for anything but a real write
 * failure: a lost obligation is the defect this port exists to close, so it is never swallowed.
 */
export interface RefundObligationPort {
  owe(o: RefundObligation): Promise<void>;
  settle(accountId: string, attempt: string): Promise<void>;
}

/**
 * What erasure learned when it stopped the money — the erasure response's own three values, so
 * nothing translates between them and none of them can be reported as another.
 */
export type ReleaseOutcome = "none" | "cancelled" | "cancel_failed";

export interface EntitlementsPort {
  /**
   * NEVER THROWS: a transport fault answers with the last verdict this process saw for the
   * account, or with none `ok: true` and unbounded limits. An entitlements outage must not lock
   * a paying customer out of their mail, which is also why implementations cache.
   *
   * `fresh: true` skips the held verdict and asks again — for the ONE caller that must not read
   * a cached refusal, the cross-check deciding whether an AI spend refusal may become a payment
   * demand, because a held refusal outlives the condition that produced it. Never on the mail
   * path: a per-request dial there is the thing the cache exists to prevent.
   */
  access(accountId: string, opts?: { fresh?: boolean }): Promise<AccessVerdict>;
  /**
   * Charge one AI action against `attemptKey`, which names the unit of WORK so retries are free.
   * `attemptKey` is the BARE key — the message, `<messageId>:<hashed client key>`, the run id —
   * never a composed ledger source. Both implementations compose the source through the one
   * composer (`sourceFor`), which refuses a key that is already a source: a double-prefixed one
   * passes the ledger's namespace CHECK and its UNIQUE, so already-paid work would answer `ok`
   * and be charged twice. Build keys with `ledger-source.ts`. Never answers a money verdict by
   * throwing — see {@link SpendOutcome}; a malformed key is the caller-bug class and raises.
   */
  spend(
    accountId: string, action: SpendAction, attemptKey: string, meta?: SpendMeta,
  ): Promise<SpendOutcome>;
  /**
   * The work is over, whichever way it ended. Never throws; replay-safe, and it ANSWERS — see
   * {@link ReleaseReceipt}. A caller reversing a charge reads the receipt and records what the
   * program did not take; a caller merely handing a claim back may ignore it, because a lost
   * release costs the customer nothing (the attempt stays open, so the retry is free).
   */
  release(accountId: string, r: SpendRelease): Promise<ReleaseReceipt>;
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

/**
 * THE ACCESS HALF ALONE — what a call site is handed when it must ask "may this account use AI
 * at all", and nothing else.
 *
 * Narrow for {@link SpendPort}'s reason and one of its own: the sites that read it are refusal
 * paths, and a refusal path holding `spend` could charge while explaining why it will not.
 */
export type AccessPort = Pick<EntitlementsPort, "access">;

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
  entitlements: EntitlementsComposition, accountId: string, opts?: { fresh?: boolean },
): Promise<AccessVerdict> {
  if (entitlements === UNMETERED) return UNMETERED_ACCESS;
  return entitlements.access(accountId, opts);
}

/** True iff this host reaches an entitlements program at all. */
export function isMetered(e: EntitlementsComposition): e is EntitlementsPort {
  return e !== UNMETERED;
}
