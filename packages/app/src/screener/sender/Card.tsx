/**
 * THE SENDER'S CARD: who it is, how wide a decision reaches, and where their mail goes. Taking a place is the
 * decision itself, through the view's `decide`, with the reach the card shows; it moves no mail before that press.
 * An install that may not decide shows who it is and nothing to choose.
 */
import type { RefObject } from "react";
import type { ScreenerSenderDTO } from "@ohmail/client-engine";
import {
  DECISION_ORDER,
  isSharedDomain,
  PILE_KEY,
  refused,
  suggestionWords,
  type DecisionDestination,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { ContactCard } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { useScreener } from "../contract.js";
import { whoOf } from "./Sentence.js";

export function Card({
  view,
  sender,
  anchor,
  choosing,
}: {
  view: ScreenerView;
  sender: ScreenerSenderDTO;
  anchor: RefObject<Element | null>;
  /** A waiting sender this install may decide. */
  choosing: boolean;
}) {
  const t = useText("screener");
  const { role } = useScreener();
  const may = choosing && !refused(role);
  const shared = isSharedDomain(sender.from.address);
  const scope = shared ? "sender" : view.scopeOf(sender);
  const proposed = suggestionWords(sender).dest;
  return (
    <ContactCard
      open={view.shown === "card"}
      onClose={() => view.show(null)}
      anchor={anchor}
      label={t("place.keyCard")}
      person={{ name: whoOf(sender), address: displayAddress(sender.from.address) }}
      scope={
        may && !shared
          ? {
              label: t("barScopeAria"),
              value: scope,
              options: [
                { value: "sender", label: t("barScopeSender") },
                {
                  value: "domain",
                  label: t("wholeDomain", { domain: displayDomainLabel(sender.from.address) }),
                },
              ],
              onChange: (value) => view.setScope(sender, value === "domain" ? "domain" : "sender"),
            }
          : undefined
      }
      goes={
        may
          ? {
              label: t("place.goesLabel"),
              value: proposed ?? undefined,
              places: DECISION_ORDER.map((dest) => ({ value: dest, label: t(PILE_KEY[dest]) })),
              onChange: (value) => view.decide(value as DecisionDestination, false),
            }
          : undefined
      }
    />
  );
}
