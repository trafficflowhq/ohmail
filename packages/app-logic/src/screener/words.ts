/** The place, confidence and advice the Screener can show for one sender. */
import { senderKey } from "@ohmail/client-engine";
import type { ScreenerSenderDTO } from "@ohmail/wire";
import type { DecisionDestination } from "./decision.js";
import { acceptDestOf } from "./filter.js";
import { noSuggestionKey, noSuggestionReason, type SuggestStanding } from "./no-suggestion.js";

export interface WordsLine {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface SuggestionWords {
  /** Where a real suggestion files this sender: the slot's proposal. Null: nobody has chosen. */
  readonly dest: DecisionDestination | null;
  /** How sure the advice is, 0 to 1, where it is a real suggestion. */
  readonly sure: number | null;
  readonly badge: "aiHoldChip" | "aiNoAnswerChip" | null;
  readonly reason: WordsLine | null;
  /** A standing refusal or a failed automatic decision. */
  readonly lines: readonly WordsLine[];
}

/** What the suggestion run knows about senders it has no advice for. */
export interface NoAdvice {
  /** The refusal a run last met, standing until a later run contradicts it; null: none. */
  readonly standing: SuggestStanding | null;
  /** The senders a run is buying now, by sender key: the only licence for "a suggestion is coming". */
  readonly inFlight: ReadonlySet<string>;
  /** Settings lists the pane credits come from: the no-credits sentence names it only then. */
  readonly subscriptionPane: boolean;
}

/** Where no run stands (no control, no wire): nothing refuses and nothing is coming. */
export const NO_RUN: NoAdvice = { standing: null, inFlight: new Set<string>(), subscriptionPane: false };

type Ai = NonNullable<ScreenerSenderDTO["ai"]>;

const reasonValues = (ai: Ai): Record<string, string | number> => ({
  brand: ai.reasonBrand ?? "",
  count: ai.reasonCount ?? 0,
});

function reasonOf(ai: Ai): WordsLine | null {
  if (ai.reasonCode === "impersonation") return null;
  if (ai.reasonCode) return { key: `aiReasonChip.${ai.reasonCode}`, values: reasonValues(ai) };
  return ai.rationale.trim() ? { key: "aiWhy", values: { why: ai.rationale } } : null;
}

export function suggestionWords(sender: ScreenerSenderDTO, why: NoAdvice): SuggestionWords {
  const ai = sender.ai;
  const dest = acceptDestOf(sender);
  const badge = ai?.noAnswer ? "aiNoAnswerChip" : ai?.dest === "screener" ? "aiHoldChip" : null;
  const lines: WordsLine[] = [];
  if (!ai) {
    const reason = noSuggestionReason(sender, why.standing, why.inFlight.has(senderKey(sender.from.address)));
    const key = noSuggestionKey(reason, why.standing, why.subscriptionPane);
    if (key !== null) lines.push({ key });
  }
  if (ai?.actRefused) lines.push({ key: "aiActRefused" });
  return {
    dest,
    sure: dest !== null && ai ? ai.confidence : null,
    badge,
    reason: ai && badge === null && sender.checked?.reason !== "impersonation" ? reasonOf(ai) : null,
    lines,
  };
}
