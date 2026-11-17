/** THE LINES UNDER THE RESULTS: what was searched where it was not the whole mailbox counted, each with its one press. */
import type { SearchListModel } from "@ohmail/app-logic/search";
import { ListLine } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { SaidLine } from "./verdict-words.js";

export function SearchVerdictLine({ model, lines }: { model: SearchListModel; lines: readonly SaidLine[] }) {
  const t = useText("search");
  return (
    <>
      {lines.map((line) => (
        <ListLine
          key={line.say}
          warn={line.warn}
          busy={line.busy}
          act={line.again ? { label: t("saidAgain"), quiet: !line.warn, onPress: model.retry } : undefined}
        >
          {line.say}
        </ListLine>
      ))}
    </>
  );
}
