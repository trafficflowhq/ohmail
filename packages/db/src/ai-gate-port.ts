/**
 * THE AI SPEND GATE, AS A PORT — the shapes a caller needs to ask permission, and nothing that
 * decides.
 *
 * Metered AI is a hosted concern: it needs a subscription, a credit ledger and the tables behind
 * both. A local install has none of those and asks no one's permission — it runs against its
 * owner's own model key or no model at all. But the code that CALLS the gate is the same code in
 * both deployments: the ingest pipeline, the Screener, the drafting path. Those modules must be
 * able to say "I may be handed a gate, and here is what I will ask it" without depending on the
 * implementation that answers.
 *
 * So this file is the question and `ai-gate.ts` is the answer. Everything that constructs a gate,
 * reads entitlements, writes a ledger row or knows what an action costs stays there. Nothing here
 * has a default: a deployment that supplies no gate supplies no gate, and every caller already
 * treats that as "skip the AI" rather than as "proceed unmetered".
 *
 * `ai-gate.ts` re-exports these names, so no existing import moves.
 */

/**
 * Why an entitlement decision came out the way it did.
 *
 * It lives here rather than with the subscription logic because {@link AiRefusalReason} is built
 * from it and a caller must be able to name a refusal without reaching for the billing module.
 * One definition, imported back by that module — the alternative is two unions that agree until
 * somebody adds a state to one of them.
 *
 * These strings are already visible to any client that receives a refusal, so naming them here
 * discloses nothing that a refused request does not.
 */
export type EntitlementReason =
  | "suspended" | "no_subscription" | "trialing" | "active"
  | "past_due_grace" | "past_due" | "unpaid" | "canceled" | "paused"
  /*
   * The account owner's own AI switch, off. Unlike every other member, it is not a subscription
   * state at all — which is exactly why it is here rather than only in {@link AiRefusalReason}.
   *
   * `entitlementsFor` may be handed the switch, and when it is, its `aiEnabled` is the FULL
   * spendability predicate rather than the subscription's half of it. Without a word for this
   * case that boolean could only go false with a reason describing a perfectly healthy
   * subscription, and a surface reading it would explain a refusal by offering a plan the
   * customer already has. The gate keeps answering it from its own short-circuit read, which is
   * why the two do not disagree: same string, same meaning, one produced before the subscription
   * read and one after.
   */
  | "ai_disabled";

/**
 * Why a spend was refused.
 *
 * `ai_disabled` is the account owner's own choice, and is therefore unlike every other member of
 * this union: the others describe something wrong with a subscription that support or a payment
 * would fix, this one describes the product working exactly as asked. That difference is why it
 * is quiet in the default refusal reporter, and why the drafting path answers `409` for it rather
 * than the `402` that means "pay us".
 */
export type AiRefusalReason = "out_of_credits" | "ai_disabled" | EntitlementReason;

/**
 * The FULL answer to "may this account spend?", for callers that can act on the difference.
 *
 * {@link AiCreditGate.tryDebit}'s boolean is this type with the detail thrown away, and that loss
 * is fine where there is exactly one thing to do with a no (skip the AI). It is NOT fine on a
 * request path, where collapsing a database FAULT into the same `false` as an empty balance makes
 * the server answer "insufficient credits" — a demand for money — to a fully funded customer
 * whose only problem is that a ledger connection dropped.
 *
 *  · `permitted: true` — proceed. `charged` says whether THIS attempt moved money (`false` ⇒ a
 *    free retry of an attempt already open), and `attempt` is the ledger source actually used,
 *    which is what a refund must name.
 *  · `refusal: "state"` — the subscription may not spend at all; `reason` says which state.
 *  · `refusal: "quantity"` — the plan could spend, but the balance is empty.
 *  · `refusal: "fault"` — we do not know, because something broke. Never a payment demand.
 */
export type AiSpendOutcome =
  | { permitted: true; charged: boolean; attempt: string }
  | { permitted: false; refusal: "state" | "quantity"; reason: AiRefusalReason }
  | { permitted: false; refusal: "fault"; error: unknown };

/**
 * The AI spend gate, as the narrow port every call site sees.
 *
 * `tryDebit` is deliberately shaped so that a test double as small as
 * `{ tryDebit: async () => false }` satisfies the narrower gate a pipeline asks for — which is
 * what the proof that the product degrades to rules-only is written against.
 */
export interface AiCreditGate {
  /**
   * May this account spend one AI action on `source`, and charge it if so.
   *
   * @param source Build it with the ledger-source vocabulary, never by hand: a database
   *   constraint pins the namespace to the reason, so a hand-written source is a write error.
   * @param meta Provenance for the ledger row. It is a JSON column and NOT an index key, which
   *   is why identifiers too long or too variable for `source` belong here instead.
   * @returns `true` ⇒ the AI branch may run; `false` ⇒ skip it. **Never throws.**
   */
  tryDebit(source: string, meta?: Record<string, unknown>): Promise<boolean>;
  /**
   * The same decision, undiminished — {@link AiSpendOutcome} instead of a boolean.
   *
   * ONE implementation backs both: `tryDebit` is `(await spend(…)).permitted`. That is
   * deliberate, because two methods that each decided for themselves is precisely how a request
   * path and a background worker end up disagreeing about a customer's money.
   *
   * Use this wherever the difference between "you are out of credits", "your subscription cannot
   * spend" and "our database is unwell" changes what the caller should do — which in practice
   * means every request path. **Never throws.**
   */
  spend(source: string, meta?: Record<string, unknown>): Promise<AiSpendOutcome>;
  /**
   * Reverse a charge THIS gate made, because the model call it paid for threw.
   *
   * A no-op unless this gate instance actually charged an attempt for `source` in its most recent
   * decision about it. Two different things are being excluded, and both matter:
   *
   *  · a duplicate outcome charged nothing, so refunding it would reverse an EARLIER attempt
   *    whose work may well have been delivered — a charge taken for one run being handed back
   *    because a later reprocessing of the same message failed. The in-process marker is cleared
   *    on every non-charging decision, so it cannot outlive the attempt that set it;
   *  · a gate rebuilt after a process restart never charged anything, so it refunds nothing. That
   *    is safe rather than lossy: an un-refunded charge leaves its attempt OPEN, and the retries
   *    of an open attempt are free.
   *
   * Replay-safe and exactly-once by construction, and — like `tryDebit` — **never throws**: it is
   * called from a catch block whose job is to rethrow the original error, and a failed refund
   * must not replace the diagnosis with itself. A refund that fails keeps its marker, so a later
   * call can reissue it.
   */
  refund(source: string, meta?: Record<string, unknown>): Promise<void>;
  /**
   * Reverse a NAMED ATTEMPT, for a caller that holds its identity from its own {@link spend}.
   *
   * ## Why {@link AiCreditGate.refund} cannot serve this caller
   *
   * `refund` is guarded by an in-process marker, and that marker CLEARS on every non-charging
   * decision, including a duplicate. That is correct for the call sites it was built for, and it
   * makes `refund` useless for a retrying background caller, whose sequence is exactly:
   *
   *   cycle 1: `spend` ⇒ permitted, charged (marker set) → the model faults → rethrow
   *   cycle 2: `spend` ⇒ duplicate, NOT charged (**marker cleared**) → the model faults again →
   *            the caller gives up, and the message is filed on rules alone, for good
   *
   * At that last moment the charge from cycle 1 has bought nothing and never will, so it must
   * come back — but `refund(source)` finds no marker and silently does nothing. The customer
   * keeps a charge for work that was abandoned. This method exists so that caller can name the
   * attempt it was told it charged, rather than asking a guard that has already been consumed.
   *
   * ## Why bypassing the marker is still safe
   *
   * The marker was only ever the FIRST of three exactly-once layers, and the other two are in the
   * database and do not care who asks: a uniqueness constraint on the refund's own ledger source
   * makes a repeat a duplicate rather than a second payout, and a trigger refuses any refund that
   * does not name a real debit on this account — so a refund of nothing, and a refund of a
   * refund, are both database errors. The caller's obligation is the one the name states: pass an
   * `attempt` that {@link spend} returned to THIS process with `charged: true`, and pass it once
   * per abandonment.
   *
   * Like `refund`, it **never throws** — it is called from failure handling, and a failed reversal
   * must not replace the diagnosis with itself.
   */
  refundAttempt(attempt: string, meta?: Record<string, unknown>): Promise<void>;
}
