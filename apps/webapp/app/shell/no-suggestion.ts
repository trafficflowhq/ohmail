/**
 * WHY A WAITING ROW HAS NO SUGGESTION — the three answers, named.
 *
 * Every sender with no advice on record rendered one sentence: "No suggestion yet for this
 * sender." On a measured queue that was 3 609 of 3 979 rows, and "yet" is a promise — it says one
 * is coming. It is not coming on an account whose spend is refused, which is a STANDING condition
 * rather than a moment, and it did not come by itself for mail the sensitivity pass keeps out of
 * the automatic classification. The word is true for exactly one of the three states, so the state
 * is named and the sentence follows from it.
 *
 * Pure and dependency-free so both the reason and its catalogue key can be asserted without a
 * render; `ScreenerView` is the only caller.
 */

/** The reason this row shows no advice. */
export type NoSuggestionReason =
  /** Nobody has asked about this sender yet, and asking would work. The only "yet". */
  | "pending"
  /**
   * The account may not spend on suggestions — the allowance is exhausted or the entitlement
   * refuses. One state and one sentence for both: from a row's point of view the fact is the
   * same, and naming a price or a plan is the managed service's business, not this server's.
   */
  | "unavailable"
  /**
   * This sender's representative is `no_ai` — mail the sensitivity pass keeps out of the AUTOMATIC
   * classification, on every door (`core/src/pipeline.ts`). That is why the row was never filled
   * in by itself.
   *
   * Deliberately NOT "AI is off for this sender": under the AI-OPEN ruling an explicit purchase
   * asks about every held sender, this one included, so a sentence saying the model will never see
   * it would be contradicted by the next press of "Suggest…".
   */
  | "no_auto_ai";

/** The stop a run reported, remembered until a later run contradicts it. */
export type SuggestStanding = "out_of_credits" | "spend_unavailable";

/** The catalogue key each reason renders, under the `screener` namespace. */
export const NO_SUGGESTION_KEY: Record<NoSuggestionReason, string> = {
  pending: "noSuggestion",
  unavailable: "noSuggestionUnavailable",
  no_auto_ai: "noSuggestionNoAutoAi",
};

/**
 * Which of the three this row is. Read only where there is no `ai` on the row at all — a row that
 * carries a `noAnswer` already says why the run it was part of could not answer, and that is a
 * nearer and more specific fact than either state below.
 *
 * `noAi` is read FIRST: it says why nothing arrived automatically, which is the question a row
 * that has never been in a run is asking. The standing spend refusal is the account-wide answer
 * for every other such row.
 */
export function noSuggestionReason(
  sender: { noAi?: true },
  standing: SuggestStanding | null,
): NoSuggestionReason {
  if (sender.noAi) return "no_auto_ai";
  if (standing !== null) return "unavailable";
  return "pending";
}
