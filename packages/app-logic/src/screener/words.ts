/**
 * WHAT THE OPEN SENDER'S SENTENCE SAYS, as keys of the `screener` namespace and their values: where a real
 * suggestion files them (the slot's proposal, with how sure it is), and the lines under it. What ohmail measured
 * comes first and stands whether or not a suggestion was bought; then the model's advice, or why there is none.
 * The words are read where they are drawn: no reader crosses into this package.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import type { DecisionDestination } from "./decision.js";
import { acceptDestOf } from "./filter.js";

export interface WordsLine {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface SuggestionWords {
  /** Where a real suggestion files this sender: the slot's proposal. Null: nobody has chosen. */
  readonly dest: DecisionDestination | null;
  /** How sure the advice is, 0 to 1, where it is a real suggestion. */
  readonly sure: number | null;
  /** The lines under the sentence, in the order they are read. */
  readonly lines: readonly WordsLine[];
}

type Ai = NonNullable<ScreenerSenderDTO["ai"]>;

const reasonValues = (ai: Ai): Record<string, string | number> => ({
  brand: ai.reasonBrand ?? "",
  count: ai.reasonCount ?? 0,
});

/** What ohmail measured about the sender: the claim, or the brand's own address its provider did not confirm. */
function checkedLines(sender: ScreenerSenderDTO): WordsLine[] {
  const c = sender.checked;
  if (!c) return [];
  const values = { brand: c.brand, domain: c.domain };
  const first: WordsLine =
    c.reason === "unverified"
      ? { key: "senderCheck.unverified", values }
      : { key: c.domainShared ? "senderCheck.impersonationShared" : "senderCheck.impersonation", values };
  return c.list ? [first, { key: "senderCheck.list" }] : [first];
}

/** The model's advice, said as 1.0.11 says it; a sender with none says why. */
function adviceLines(sender: ScreenerSenderDTO): WordsLine[] {
  const ai = sender.ai;
  if (!ai) return [{ key: sender.noAi ? "noSuggestionNoAutoAi" : "noSuggestion" }];
  const lines: WordsLine[] = [];
  if (ai.reasonCode) lines.push({ key: `aiReason.${ai.reasonCode}`, values: reasonValues(ai) });
  if (ai.noAnswer) lines.push({ key: `aiSkip.${ai.noAnswer}` });
  else if (ai.dest === "screener") lines.push({ key: "aiHolds" });
  if (!ai.noAnswer && ai.rationale) lines.push({ key: "aiWhy", values: { why: ai.rationale } });
  if (ai.actRefused) lines.push({ key: "aiActRefused" });
  return lines;
}

export function suggestionWords(sender: ScreenerSenderDTO): SuggestionWords {
  const dest = acceptDestOf(sender);
  return {
    dest,
    sure: dest !== null && sender.ai ? sender.ai.confidence : null,
    lines: [...checkedLines(sender), ...adviceLines(sender)],
  };
}
