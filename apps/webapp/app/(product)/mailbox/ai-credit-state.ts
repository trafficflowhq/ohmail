import type { SubscriptionStatus } from "../../api-client";

/**
 * WHAT TO SAY ABOUT AI CREDITS — one derivation, read by every surface that says anything.
 *
 * The trial grants a fixed bounty now, which turned "is AI on?" from a question with one visible
 * answer into a question with several, all of which a person can act on differently:
 *
 *  · on a trial with credits left — the interesting one, and the one nothing said before. The
 *    Screener's suggestions and the drafts work, out of a pot that does not refill;
 *  · on a trial with none left — the trial's demonstration is over and the honest next step is a
 *    plan;
 *  · on a plan with none left — the same words would be WRONG: the allowance returns at the next
 *    renewal and there is nothing to buy;
 *  · not paying, or not paying yet — AI is off for a reason that names itself, and a plan fixes it;
 *  · suspended — AI is off and no purchase changes that.
 *
 * Every one of those was previously one silent `aiEnabled: false`, so the Screener's control
 * quoted a price and the purchase was refused with a sentence written by the server for the
 * refusal, after the press. This decides it before the press, from the read the settings pane
 * already makes.
 *
 * ── WHY THIS IS A PURE FUNCTION OVER THE DTO ────────────────────────────────────────────────
 *
 * Two surfaces show this — the Screener's suggestion area and Settings → Subscription — and they
 * must not be able to disagree, because the second one is where a person goes to check what the
 * first one told them. A pure function over `GET /billing/subscription` is also the whole of what
 * a test needs to walk every state, which a component that fetches is not.
 *
 * ── AND WHY IT COMPOSES `entitlements` INSTEAD OF RE-DECIDING ───────────────────────────────
 *
 * `entitlements.aiEnabled` and `entitlements.reason` are the SERVER's answer, computed by the one
 * function that owns the truth table. Nothing here re-derives them from `subscription.status` —
 * an `if (status === "past_due")` on this side would be a second copy of a policy that already
 * has an owner, and the two would part company the first time grace, the export window or
 * suspension moved. What this function decides is only which SENTENCE fits an answer it is given.
 */
export type AiCreditState =
  /** On a trial with a balance. `remaining` is the number to show. */
  | { kind: "trial_credits"; remaining: number }
  /** On a trial with nothing left. A plan is the way forward. */
  | { kind: "trial_spent" }
  /** Paying, allowed to spend, and out. The allowance returns; there is nothing to buy. */
  | { kind: "period_spent" }
  /** AI is off because of the subscription's state. `reason` is the server's own word. */
  | { kind: "unavailable"; reason: string }
  /** Nothing worth saying: AI works and there is nothing unusual about it. */
  | null;

/**
 * `null` in, `null` out — a failed or absent read is not a claim about an account.
 *
 * That is the same distinction `BillingSection` draws between `sub === null` (no subscription) and
 * a refused fetch, and it matters more here: this surface's job is to explain why AI is off, and
 * explaining it on the strength of a read that never arrived would put "AI actions come with a
 * plan" in front of a paying subscriber whose only problem was a dropped request.
 */
export function aiCreditState(status: SubscriptionStatus | null): AiCreditState {
  if (!status) return null;

  const { balance, entitlements } = status;
  // The mirror saying `trialing` is NECESSARY but not SUFFICIENT for "this balance is the
  // trial's pot". In the trial→paid window, `invoice.paid` grants the plan's allowance before
  // `customer.subscription.updated` — its own delivery — moves the row off `trialing`, so for
  // that window the status reads "trial" about PAID credits that refill at every renewal.
  // `invoiceGranted` is the server's word that revenue has landed; once it has, the balance is
  // never a trial pot and a spent balance is a plan's period, not a spent trial (R6-1-13 — the
  // old label's provenance was false while its number was real). `undefined` — an older server
  // — keeps the prior reading: the brief window is accepted rather than suppressing every true
  // trial label a stale API would otherwise lose.
  const trialing = status.subscription?.status === "trialing" && status.invoiceGranted !== true;

  if (entitlements.aiEnabled) {
    // Spending is allowed. The only thing left worth saying is how much of a TRIAL's fixed pot is
    // left, because that pot does not refill and the number is the whole of what a person is
    // deciding with. A plan's balance is not reported here: it is large, it refills monthly, and
    // a running total in the corner of the Screener would be a meter nobody asked for. Settings →
    // Subscription shows it for anyone who wants it.
    return trialing ? { kind: "trial_credits", remaining: balance } : null;
  }

  // Suspension outranks everything, exactly as it does in the entitlement decision, and it is the
  // one refusal a purchase cannot fix — so it must not be reached by the balance branch below and
  // be offered a plan.
  if (entitlements.reason === "suspended") return { kind: "unavailable", reason: "suspended" };

  // An empty balance on a state that WOULD be allowed to spend. The distinction between a trial
  // and a plan is the whole reason this function exists: the same fact ("no credits") has two
  // different truthful next steps.
  const spendableState =
    entitlements.reason === "trialing" ||
    entitlements.reason === "active" ||
    entitlements.reason === "past_due_grace";
  if (spendableState && balance <= 0) {
    return trialing ? { kind: "trial_spent" } : { kind: "period_spent" };
  }

  return { kind: "unavailable", reason: entitlements.reason };
}

/**
 * The message key for a state, in the `aiCredits` namespace.
 *
 * A table rather than a switch inside the component, because BOTH surfaces render these and a
 * second mapping is a second place for a reason to fall through to the wrong sentence. An
 * entitlement reason this table does not know resolves to `noPlan` — the mildest true thing that
 * can be said about "AI is off and a plan is how it comes on", and never an invented cause.
 */
export function aiCreditMessageKey(state: NonNullable<AiCreditState>): string {
  switch (state.kind) {
    case "trial_credits": return "trialLeft";
    case "trial_spent": return "trialSpent";
    case "period_spent": return "spent";
    case "unavailable":
      switch (state.reason) {
        case "past_due": return "pastDue";
        case "unpaid": return "unpaid";
        case "canceled": return "canceled";
        case "paused": return "paused";
        case "suspended": return "suspended";
        // The account's own switch, off. It is NOT a subscription problem, so it must not fall
        // through to `noPlan` — "AI actions come with a plan" to somebody who has a plan and
        // turned the feature off is both false and unhelpful. The sentence names the switch.
        case "ai_disabled": return "aiOff";
        default: return "noPlan";
      }
  }
}

/**
 * Which action, if any, belongs beside the sentence. Both actions lead to the SAME place —
 * Settings → Subscription, which holds the plan cards, the balance and the billing portal — and
 * differ only in what they promise, which is the part that has to be true.
 *
 *  · `start` — no paid plan is in force, so beginning one is the honest next step. **A spent
 *    TRIAL is on this arm**, and that is the one worth stating: a trial IS a subscription row, so
 *    a rule phrased as "do you have a subscription?" would label it "See your plan" and send
 *    somebody to look at a plan they have not bought. `canceled` is here for the same reason —
 *    there is nothing live to look at, and resubscribing is what the person came for.
 *  · `see` — there is a live paid subscription and something about it explains the refusal: a
 *    payment that has not gone through, a pause, or an allowance that will return by itself.
 *    Offering to "start a plan" to any of those is offering somebody a second subscription.
 *  · `null` — nothing on this screen would help, and a button would imply otherwise. A trial with
 *    credits (nothing is wrong) and a suspended account (no purchase lifts it).
 */
export function aiCreditAction(state: NonNullable<AiCreditState>): "start" | "see" | null {
  switch (state.kind) {
    case "trial_credits": return null;
    case "trial_spent": return "start";
    case "period_spent": return "see";
    case "unavailable":
      switch (state.reason) {
        case "suspended": return null;
        // No BUTTON for the off switch, and that is the honest shape rather than a missing
        // feature: the remedy is the AI row in Settings, not a plan, and neither label this
        // component has ("Start a plan", "See your plan") describes it. The sentence carries the
        // remedy instead, which is what a one-line surface can do truthfully.
        case "ai_disabled": return null;
        case "past_due": case "unpaid": case "paused": return "see";
        // `no_subscription`, `canceled`, and anything a future entitlement adds: there is no live
        // paid plan to look at, so the mild, true offer is to start one.
        default: return "start";
      }
  }
}
