/**
 * THE UNSUBSCRIBE QUESTION: Screen out or Spam on a sender whose letters offer a one-click unsubscribe asks before
 * anything leaves. The first confirmation on an account also explains who sends the request and what it affects.
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
  const spam = ask?.dest === "spam";
  const title =
    ask?.scope === "domain" && !ask.explain
      ? t(spam ? "place.unsub.spamDomain" : "place.unsub.screenedDomain", {
          domain: displayDomainLabel(ask.sender.from.address),
        })
      : t(spam ? "place.unsub.spam" : "place.unsub.screened");
  const how = !ask?.explain
    ? null
    : from === "service"
      ? t("place.unsub.service")
      : from === "computer"
        ? t("place.unsub.computer")
        : null;
  const claim = ask?.claim ?? "none";
  const confirm = !ask?.explain
    ? t("place.unsub.continue")
    : claim === "may_send"
      ? screening("unsubCommitMaybe")
      : title;
  let explanation: string | null = null;
  if (ask?.explain && ask.scope === "domain") {
    explanation = screening(claim === "sends" ? "unsubDomain" : "unsubDomainMaybe", {
      domain: displayDomainLabel(ask.sender.from.address),
      senders: ask.senders,
      place: title,
    });
  } else if (ask?.explain) {
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
      hot
      line={t("place.unsub.final")}
      keysOn="cancel"
      confirm={{ label: confirm, onPress: () => view.answerUnsub(true) }}
      cancel={{ label: t("cancel") }}
    >
      {explanation !== null || how !== null ? (
        <>
          {explanation === null ? null : <p className="oh-text">{explanation}</p>}
          {how === null ? null : <p className="oh-text">{how}</p>}
        </>
      ) : null}
    </Dialog>
  );
}
