/**
 * WHY A WAITING ROW HAS NO SUGGESTION — the three answers, named.
 *
 * Every sender with no advice rendered "No suggestion yet for this sender", and "yet" is a promise.
 * It is not kept on an account whose spend is refused — a STANDING condition rather than a moment —
 * and nothing came by itself for mail the sensitivity pass keeps out of the automatic
 * classification. The word is true for one of the three states, so the state is named and the
 * sentence follows from it. Pure, so the reason and its key are assertable without a render.
 */

/** The reason this row shows no advice. */
export type NoSuggestionReason =
  /** Nobody has asked about this sender yet, and asking would work. The only "yet". */
  | "pending"
  /**
   * The account OPTED IN to automatic suggestions and nothing stands in their way, so one is on
   * its way without anybody pressing anything — the worker buys on ingest and its cycle, and the
   * open Screener re-reads what was bought. Its own state rather than a reworded `pending`,
   * because the two make different promises: `pending` offers a press, this names a cadence.
   */
  | "coming"
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
  coming: "noSuggestionComing",
  unavailable: "noSuggestionUnavailable",
  no_auto_ai: "noSuggestionNoAutoAi",
};

/**
 * Which of the four this row is. Read only where the row carries no `ai` at all — a `noAnswer`
 * is a nearer, more specific fact. `noAi` is read FIRST: it says why nothing arrived
 * automatically, the question a row never in a run is asking. The standing spend refusal
 * OUTRANKS the opt-in — an account that opted in and then ran out is not owed a "coming" the
 * next run cannot keep. `autoSuggest` is the opt-in fact, absent on every surface with no
 * server behind it, and absent must read as NO.
 */
export function noSuggestionReason(
  sender: { noAi?: true },
  standing: SuggestStanding | null,
  autoSuggest?: boolean,
): NoSuggestionReason {
  if (sender.noAi) return "no_auto_ai";
  if (standing !== null) return "unavailable";
  if (autoSuggest === true) return "coming";
  return "pending";
}
