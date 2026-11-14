/**
 * THE UNSUBSCRIBE QUESTION: Screen out or Spam on a sender whose letters offer a one-click unsubscribe asks before
 * anything leaves, since a sent request cannot be taken back. It names the sender it asks about (a row's press asks
 * about a sender that is not the open one) and says whose machine sends it (the host's own answer: ohmail's servers,
 * or this computer); the yes makes the decision it held, Cancel makes none.
 */
import type { ScreenerView } from "@ohmail/app-logic/screener";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { Dialog } from "@ohmail/ui/base";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/index.js";

export function Unsubscribe({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const screening = useText("screening");
  const { host } = useFrame();
  const ask = view.ask?.kind === "unsub" ? view.ask : null;
  const from = host.capabilities.unsubscribeFrom;
  const title = ask?.dest === "spam" ? t("place.unsub.spam") : t("place.unsub.screened");
  const how =
    from === "service" ? t("place.unsub.service") : from === "computer" ? t("place.unsub.computer") : null;
  const claim = ask?.claim ?? "none";
  const confirm = claim === "may_send" ? screening("unsubCommitMaybe") : title;
  let explanation: string | null = null;
  if (ask?.scope === "domain") {
    explanation = screening(claim === "sends" ? "unsubDomain" : "unsubDomainMaybe", {
      domain: displayDomainLabel(ask.sender.from.address),
      senders: ask.senders,
      place: title,
    });
  } else if (ask) {
    explanation = screening(claim === "sends" ? "unsubSender" : "unsubSenderMaybe", {
      sender: displayAddress(ask.sender.from.address),
      place: title,
    });
  }
  return (
    <Dialog
      open={ask !== null}
      onClose={() => view.answerUnsub(false)}
      title={title}
      line={t("place.unsub.final")}
      keysOn="cancel"
      confirm={{ label: confirm, onPress: () => view.answerUnsub(true) }}
      cancel={{ label: t("cancel") }}
    >
      {explanation === null ? null : <p className="oh-text">{explanation}</p>}
      {how === null ? null : <p className="oh-text">{how}</p>}
    </Dialog>
  );
}
