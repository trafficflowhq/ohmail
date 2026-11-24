/** The reason this row shows no advice. */
export type NoSuggestionReason =
  /** Nobody has asked about this sender yet, and asking would work. The only "yet". */
  | "pending"
  /**
   * A RUN IS BUYING A SUGGESTION FOR THIS SENDER RIGHT NOW, so one is on its way. Only that licenses
   * the promise: an opt-in alone said it on an account whose every run is
   * refused, and on a surface whose own run had not been made. `pending` offers a press instead.
   */
  | "coming"
  /**
   * The account may not spend on suggestions — the allowance is exhausted or the entitlement
   * refuses. One state and one sentence for both: from a row's point of view the fact is the
   * same, and naming a price or a plan is the managed service's business, not this server's.
   */
  | "unavailable";

/**
 * WHY THE SUGGEST ROUTE REFUSED THIS ACCOUNT, remembered until a later run contradicts it. Every
 * refusal writes it — a run the gate STOPPED (an answer) and a request REFUSED OUTRIGHT (a 402,
 * 409 or 503, thrown) alike — because both leave the account in the same place: the next run is
 * refused too, so no row may say a suggestion is coming. `refused` is any other refusal a server
 * stated. The quote's own stop (`over_quote`) is not here: it is the number a person pressed.
 */
export type SuggestStanding =
  | "no_budget" | "spend_unavailable" | "ai_disabled" | "ai_unavailable" | "refused";

/** The catalogue key each reason renders, under the `screener` namespace. */
export const NO_SUGGESTION_KEY: Record<NoSuggestionReason, string | null> = {
  pending: null,
  coming: null,
  unavailable: "noSuggestionUnavailable",
};

/** The `unavailable` sentence per standing — each names the reason, never only the fact. */
export const UNAVAILABLE_KEY: Record<SuggestStanding, string> = {
  no_budget: "noSuggestionNoBudget",
  spend_unavailable: "noSuggestionUnavailable",
  ai_disabled: "noSuggestionAiOff",
  ai_unavailable: "noSuggestionAiDown",
  refused: "noSuggestionRefused",
};

/**
 * The sentence a standing says on a row. The no-credits one names where credits come from,
 * Settings → Subscription, so that clause is said only where Settings lists that pane
 * (`subscriptionPane`).
 */
export function standingKey(standing: SuggestStanding, subscriptionPane = false): string {
  return standing === "no_budget" && subscriptionPane ? "noSuggestionNoBudgetWhere" : UNAVAILABLE_KEY[standing];
}

/**
 * The Suggest menu's line for a standing, or `null`. Only the empty balance: it waits on the
 * person, where the others are their own switch or a fault. Same pane rule as {@link standingKey}.
 */
export function suggestMenuStandingKey(standing: SuggestStanding | null | undefined, subscriptionPane = false): string | null {
  if (standing !== "no_budget") return null;
  return subscriptionPane ? "suggest.noCreditsWhere" : "suggest.noCredits";
}

/** The key a row with no advice renders: {@link noSuggestionReason}, with the standing's reason. */
export function noSuggestionKey(
  reason: NoSuggestionReason, standing: SuggestStanding | null, subscriptionPane = false,
): string | null {
  return reason === "unavailable" && standing !== null
    ? standingKey(standing, subscriptionPane)
    : NO_SUGGESTION_KEY[reason];
}

export function noSuggestionReason(
  standing: SuggestStanding | null,
  inFlight?: boolean,
): NoSuggestionReason {
  if (standing !== null) return "unavailable";
  if (inFlight === true) return "coming";
  return "pending";
}
