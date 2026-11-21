import type { ScreenerView } from "@ohmail/app-logic/screener";
import { Dialog } from "@ohmail/ui/base";
import { useText } from "../../text/index.js";

/** The warning on the two bulk actions that can send a one-click request. */
export function BulkDecision({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const ask = view.ask && view.ask.kind !== "unsub" ? view.ask : null;
  const applying = ask?.kind === "applySuggestions";
  const screened = ask?.kind === "picked";
  const count = ask?.senders.length ?? 0;
  const requests = ask?.unsubscribeCount ?? 0;
  return (
    <Dialog
      open={ask !== null}
      onClose={() => view.answerBulk(false)}
      title={t(screened ? "askScreenPicked" : applying ? "askApplySuggestions" : "askAllSpam", { count })}
      line={
        requests > 0
          ? t("bulkUnsubscribeConfirm", { count: requests })
          : t(screened ? "askScreenPickedNote" : "askAllSpamNote")
      }
      keysOn="cancel"
      confirm={{
        label: t(screened ? "pileScreenOut" : applying ? "askApplySuggestionsYes" : "askAllSpamYes", {
          count,
        }),
        onPress: () => view.answerBulk(true),
      }}
      cancel={{ label: t("cancel") }}
    />
  );
}
