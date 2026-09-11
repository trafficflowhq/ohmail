/**
 * The FAQ's item list, and the one answer another section links into. A plain module rather than
 * three lines inside `components/Faq.tsx` for one reason: the plan card links to the answer stating
 * the credit price schedule, and a link whose target is derived in a component can only be checked
 * by rendering one. Here the id, the message key and the list are values a test imports —
 * `pricing-structure.test.ts` asserts the anchor exists and is the price answer, red if either
 * moves. The card links because it sells an allowance in a unit needing one sentence of explanation
 * that already exists (`faq.a4`) — a link, not a second copy of the schedule, and not a hover,
 * which a phone cannot reach.
 */

/** The question keys, in the order the section renders them. */
export const FAQ_QUESTIONS = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"] as const;

/**
 * The answer key for the nth question. The FAQ's two catalogues are keyed `q1…qN` / `a1…aN`
 * in parallel, which is the whole reason an id can be derived rather than written down.
 */
export const FAQ_ANSWERS = FAQ_QUESTIONS.map((_, i) => `a${i + 1}`);

/** The DOM id of an answer, so a fragment link can land on it. */
export function faqAnswerAnchor(answerKey: string): string {
  return `faq-${answerKey}`;
}

/**
 * The answer that states what an AI action costs in credits — the plan card's link target.
 * Named here rather than at the link so exactly one place has to change if the FAQ is reordered,
 * and so a test can ask whether it is still one of the answers the section renders.
 */
export const CREDIT_PRICES_ANSWER = "a4";

/** The fragment the plan card's credits line points at. */
export const CREDIT_PRICES_ANCHOR = faqAnswerAnchor(CREDIT_PRICES_ANSWER);
