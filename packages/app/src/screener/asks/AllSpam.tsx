/**
 * MARK ALL SPAM ASKS FIRST: the question names how many it moves and that their later mail goes to Spam too. Nothing
 * moves and no unsubscribe is asked before the yes; the keys start on Cancel, and the yes moves the senders the
 * question named, never one who arrived while it stood.
 */
import type { ScreenerView } from "@ohmail/app-logic/screener";
import { Dialog } from "@ohmail/ui/base";
import { useText } from "../../text/index.js";
import { useScreener } from "../contract.js";

export function AllSpam({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const model = useScreener();
  const ask = view.ask?.kind === "allSpam" ? view.ask : null;
  const count = ask?.senders.length ?? 0;
  return (
    <Dialog
      open={ask !== null}
      onClose={() => view.answerAllSpam(false)}
      title={t("askAllSpam", { count })}
      line={t("askAllSpamNote")}
      keysOn="cancel"
      confirm={{ label: t("askAllSpamYes", { count }), onPress: () => view.answerAllSpam(true) }}
      cancel={{ label: t("cancel") }}
    >
      {ask !== null && ask.senders.some((s) => model.unsubClaimOf(s, view.scopeOf(s)) !== "none") ? (
        <p className="oh-text">{t("bulkUnsub")}</p>
      ) : null}
    </Dialog>
  );
}
