/**
 * THE UNSUBSCRIBE QUESTION: Screen out or Spam on a sender whose letters offer a one-click unsubscribe asks before
 * anything leaves, since a sent request cannot be taken back. It names the sender it asks about (a row's press asks
 * about a sender that is not the open one) and says whose machine sends it (the host's own answer: ohmail's servers,
 * or this computer); the yes makes the decision it held, Cancel makes none.
 */
import type { ScreenerView } from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Dialog } from "@ohmail/ui/base";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/index.js";
import { useScreener } from "../contract.js";

export function Unsubscribe({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const screening = useText("screening");
  const model = useScreener();
  const { host } = useFrame();
  const ask = view.ask?.kind === "unsub" ? view.ask : null;
  const from = host.capabilities.unsubscribeFrom;
  const title = ask?.dest === "spam" ? t("place.unsub.spam") : t("place.unsub.screened");
  const how =
    from === "service" ? t("place.unsub.service") : from === "computer" ? t("place.unsub.computer") : null;
  const claim = ask === null ? "none" : model.unsubClaimOf(ask.sender, view.scopeOf(ask.sender));
  return (
    <Dialog
      open={ask !== null}
      onClose={() => view.answerUnsub(false)}
      title={title}
      line={t("place.unsub.final")}
      keysOn="cancel"
      confirm={{ label: title, onPress: () => view.answerUnsub(true) }}
      cancel={{ label: t("cancel") }}
    >
      {ask === null ? null : (
        <p className="oh-text">
          {screening(claim === "sends" ? "unsubSender" : "unsubSenderMaybe", {
            sender: displayAddress(ask.sender.from.address),
            place: title,
          })}
        </p>
      )}
      {how === null ? null : <p className="oh-text">{how}</p>}
    </Dialog>
  );
}
