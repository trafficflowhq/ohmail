/**
 * The AI spend gate, as a port — the shapes a caller needs to ask permission, nothing that
 * decides. Metered AI is a hosted concern; a local install asks no one. But the code that calls
 * the gate is the same in both deployments — ingest, the Screener, drafting — and must say "I may
 * be handed a gate, and here is what I will ask it" without depending on the implementation. This
 * file is the question; `ai-gate.ts` is the answer — construction, entitlements, ledger writes
 * and pricing stay there. Nothing here has a default: no gate means "skip the AI", never "proceed
 * unmetered". `ai-gate.ts` re-exports these names, so no import moves.
 */

/**
 * Why an entitlement decision came out the way it did. It lives here rather than with the
 * subscription logic because {@link AiRefusalReason} is built from it and a caller must be able
 * to name a refusal without reaching for the billing module — one definition, imported back by
 * that module; the alternative is two unions that agree until somebody adds a state to one. These
 * strings are already visible to any client that receives a refusal, so naming them here
 * discloses nothing a refused request does not.
 */
export const ENTITLEMENT_REASONS = [
  "suspended", "no_subscription", "trialing", "active",
  "past_due_grace", "past_due", "unpaid", "canceled", "paused",
  // The account owner's own AI switch, off. Unlike every other member it is not a subscription
  // state at all — which is why it is here rather than only in {@link AiRefusalReason}.
  // `entitlementsFor` may be handed the switch, and then its `aiEnabled` is the full spendability
  // predicate rather than the subscription's half; without a word for this case that boolean
  // could only go false with a reason describing a healthy subscription, and a surface would
  // explain a refusal by offering a plan the customer already has. The gate keeps answering it
  // from its own short-circuit read — same string, same meaning, one produced before the
  // subscription read and one after.
  "ai_disabled",
] as const;

/** The members as a TYPE — derived, so the list and the union cannot come apart. */
export type EntitlementReason = (typeof ENTITLEMENT_REASONS)[number];

/**
 * Why a spend was refused.
 *
 * `ai_disabled` is the account owner's own choice, and is therefore unlike every other member of
 * this union: the others describe something wrong with a subscription that support or a payment
 * would fix, this one describes the product working exactly as asked. That difference is why it
 * is quiet in the default refusal reporter, and why the drafting path answers `409` for it rather
 * than the `402` that means "pay us".
 */
export const AI_REFUSAL_REASONS = ["out_of_credits", ...ENTITLEMENT_REASONS] as const;

export type AiRefusalReason = (typeof AI_REFUSAL_REASONS)[number];

/**
 * IS THIS ONE OF OUR REASONS — the predicate the entitlements client narrows on.
 *
 * A refusal crosses the wire as a bare string, and the open app's sentences are written against
 * these words. An unrecognised one is a DRIFT between the two programs, not a new refusal: read
 * as one it would be rendered as a payment demand or a silent skip on a state nobody here can
 * explain. The client reports it by name and takes the fault path instead.
 */
export function isAiRefusalReason(value: unknown): value is AiRefusalReason {
  return typeof value === "string" && (AI_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The full answer to "may this account spend?", for callers that can act on the difference.
 * `tryDebit`'s boolean is this type with the detail thrown away — fine with exactly one thing to
 * do with a no, not fine on a request path, where collapsing a database fault into the same
 * `false` as an empty balance answers "insufficient credits" to a fully funded customer whose
 * ledger connection dropped. `permitted: true` — proceed (`charged`: did this attempt move money;
 * `attempt`: the ledger source a refund must name). `"state"` — the subscription may not spend.
 * `"quantity"` — the balance is empty. `"fault"` — we do not know; never a payment demand.
 * `"inflight"` — another caller holds the exclusive claim.
 */
export type AiSpendOutcome =
  | { permitted: true; charged: boolean; attempt: string }
  | { permitted: false; refusal: "state" | "quantity"; reason: AiRefusalReason }
  | { permitted: false; refusal: "fault"; error: unknown }
  // Not a refusal of the account — a refusal of the duplicate, the whole of the exclusive-claim
  // fix. The gate used to answer a second concurrent caller `permitted: true, charged: false` —
  // the right answer to "is this work paid for?" and the wrong one to "should I call the model?":
  // the first caller is still inside its own call, so proceeding buys a second paid call for one
  // credit. Three obligations, each got wrong once: never charge for it, never demand payment
  // because of it (not `quantity`, not `state`); it is per-source, not per-account — a batch loop
  // moves to its next item rather than stopping; it is transient by construction — the holder
  // finishes or its claim expires (`AI_CLAIM_TTL_MS`), so retrying is the correct instruction and
  // the retry is free. `source` is echoed back so a caller can wait on the work it names.
  | { permitted: false; refusal: "inflight"; source: string };

/**
 * The AI spend gate, as the narrow port every call site sees.
 *
 * `tryDebit` is deliberately shaped so that a test double as small as
 * `{ tryDebit: async () => false }` satisfies the narrower gate a pipeline asks for — which is
 * what the proof that the product degrades to rules-only is written against.
 */
export interface AiCreditGate {
  /**
   * Does this gate serialize callers with an exclusive claim, or only price them? On the port
   * because a wrapper has to know: a decorator that can answer `permitted` on its own
   * (`withSetupPool` is the one that exists) must extend the claim rather than answer around it,
   * and reading the property off the wrapped gate makes that impossible to get wrong. The
   * alternative — a second `exclusive` flag passed beside the gate — is a flag two call sites can
   * disagree with; that disagreement was a real defect, in which setup-funded Screener spends
   * skipped the claim and one credit bought as many provider calls as a caller could overlap.
   * Absent or `false` ⇒ no claim is taken and {@link AiCreditGate.release} is a no-op.
   */
  readonly exclusive?: boolean;
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
   * The same decision, undiminished — {@link AiSpendOutcome} instead of a boolean. One
   * implementation backs both: `tryDebit` is `(await spend(…)).permitted`, deliberately, because
   * two methods that each decided for themselves is how a request path and a background worker
   * end up disagreeing about a customer's money. Use this wherever the difference between "you
   * are out of credits", "your subscription cannot spend" and "our database is unwell" changes
   * what the caller should do — in practice every request path. Never throws.
   */
  spend(source: string, meta?: Record<string, unknown>): Promise<AiSpendOutcome>;
  /**
   * Reverse a charge THIS gate made, because the model call it paid for threw. A no-op unless
   * this instance charged an attempt for `source` in its most recent decision: a duplicate
   * outcome charged nothing, so refunding it would reverse an earlier attempt whose work may have
   * been delivered (the marker clears on every non-charging decision); a gate rebuilt after a
   * restart never charged, so it refunds nothing — safe: an un-refunded charge leaves its attempt
   * open, and retries of an open attempt are free. Exactly-once by construction, and never
   * throws: it runs in a catch block whose job is to rethrow the original error; a failed refund
   * keeps its marker for a later reissue.
   */
  refund(source: string, meta?: Record<string, unknown>): Promise<void>;
  /**
   * Reverse a charge THIS gate made, because the model call it paid for threw. A no-op unless
   * this instance charged an attempt for `source` in its most recent decision: a duplicate
   * outcome charged nothing, so refunding it would reverse an earlier attempt whose work may have
   * been delivered; a gate rebuilt after a restart never charged, so it refunds nothing — safe:
   * an un-refunded charge leaves its attempt open, and retries of an open attempt are free.
   * Exactly-once by construction, and never throws: it runs in a catch block whose job is to
   * rethrow the original error; a failed refund keeps its marker for reissue.
   */
  refundAttempt(attempt: string, meta?: Record<string, unknown>): Promise<void>;
  /**
   * The work is over — give up the exclusive claim {@link spend} took for `source`. Call it when
   * the model call ends, whichever way it ended: releasing after a failure matters as much as
   * after a success — the charge stays (an open attempt is what makes the retry free), and a
   * claim left behind would make that free retry wait out the TTL for nothing. Optional on the
   * port, deliberately: a gate with no exclusivity has nothing to release, and the narrow test
   * doubles this port admits (`{ tryDebit: async () => false }`) must stay valid. Call as `await
   * gate.release?.(source)`. Forgetting it is bounded: the claim expires on its own — at most one
   * TTL of exclusivity, never any money. Never throws: it runs in `finally` blocks.
   */
  release?(source: string): Promise<void>;
}
