/**
 * THE QUEUE PAST THE PAGE THE DEVICE HOLDS: Show more senders loads the next page on a press and never on a scroll;
 * while it loads the line says so, and a page that did not arrive offers Try again.
 */
import { ListLine, ListTail } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { useScreener } from "../contract.js";

export function Tail() {
  const t = useText("screener");
  const { waitingMore: more, waitingCount } = useScreener();
  if (more.failed)
    return (
      <ListLine warn act={{ label: t("waitingMoreRetry"), onPress: more.load }}>
        {t("waitingMoreFailed")}
      </ListLine>
    );
  if (more.loading) return <ListLine busy>{t("waitingMoreLoading")}</ListLine>;
  if (!more.available) return null;
  return (
    <ListTail way={{ label: t("waitingMoreAction"), onPress: more.load }}>
      {t("metaWaiting", { count: waitingCount })}
    </ListTail>
  );
}
