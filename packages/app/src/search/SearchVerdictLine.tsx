/** THE LINES UNDER THE RESULTS: what was searched, each with its one press. */
import type { SearchListModel } from "@ohmail/app-logic/search";
import { ListLine } from "@ohmail/ui/mail";
import { useText, type Text } from "../text/index.js";
import type { SaidLine } from "./verdict-words.js";

function withWait(line: SaidLine, t: Text) {
  if (line.waitedMs === undefined) return line.say;
  const cut = /.*(?: — |: )/.exec(line.say)?.[0].length ?? 0;
  return (
    <>
      {line.say.slice(0, cut)}
      <span className="oh-nowrap">
        {line.say.slice(cut)}
        {t("resultsMeta", { ms: line.waitedMs })}
      </span>
    </>
  );
}

export function SearchVerdictLine({ model, lines }: { model: SearchListModel; lines: readonly SaidLine[] }) {
  const t = useText("search");
  return (
    <>
      {lines.map((line) => (
        <ListLine
          key={line.say}
          warn={line.warn}
          busy={line.busy}
          said={line.said}
          act={line.again ? { label: t("saidAgain"), quiet: !line.warn, onPress: model.retry } : undefined}
        >
          {withWait(line, t)}
        </ListLine>
      ))}
    </>
  );
}
