/**
 * WHAT THE OPEN SENDER'S SENTENCE SAYS, as keys of the `screener` namespace and their values: where a real
 * suggestion files them (the slot's proposal, with how sure it is), and the lines under it. What ohmail measured
 * comes first and stands whether or not a suggestion was bought; then the model's advice, or why there is none:
 * nobody asked yet, a run is buying one now, the account's spend is refused, or the sender's mail is kept out of
 * automatic AI. Where a run met a refusal, "yet" is not said; where no run stands (`NO_RUN`: no control or no wire)
 * the sentence is today's "No suggestion yet", as the released Screener says it there. The words are read where
 * they are drawn: no reader crosses into this package.
 */
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
  /** The lines under the sentence, in the order they are read. */
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
function adviceLines(sender: ScreenerSenderDTO, why: NoAdvice): WordsLine[] {
  const ai = sender.ai;
  if (!ai) {
    const reason = noSuggestionReason(sender, why.standing, why.inFlight.has(senderKey(sender.from.address)));
    return [{ key: noSuggestionKey(reason, why.standing, why.subscriptionPane) }];
  }
  const lines: WordsLine[] = [];
  if (ai.reasonCode) lines.push({ key: `aiReason.${ai.reasonCode}`, values: reasonValues(ai) });
  if (ai.noAnswer) lines.push({ key: `aiSkip.${ai.noAnswer}` });
  else if (ai.dest === "screener") lines.push({ key: "aiHolds" });
  if (!ai.noAnswer && ai.rationale) lines.push({ key: "aiWhy", values: { why: ai.rationale } });
  if (ai.actRefused) lines.push({ key: "aiActRefused" });
  return lines;
}

export function suggestionWords(sender: ScreenerSenderDTO, why: NoAdvice): SuggestionWords {
  const dest = acceptDestOf(sender);
  return {
    dest,
    sure: dest !== null && sender.ai ? sender.ai.confidence : null,
    lines: [...checkedLines(sender), ...adviceLines(sender, why)],
  };
}
