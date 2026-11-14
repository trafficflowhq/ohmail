/**
 * THE SENDER'S CARD: who it is, how wide a decision reaches, and where their mail goes. Taking a place is the
 * decision itself, through the view's `decide`, with the reach the card shows; it moves no mail before that press.
 * An install that may not decide shows who it is and nothing to choose.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import { useState, type ReactNode, type RefObject } from "react";
import { RETRO_DEFAULT_ON } from "@ohmail/app-logic/press/sender-screening";
import {
  DECISION_KEY,
  DECISION_ORDER,
  isSharedDomain,
  PILE_KEY,
  refused,
  senderCheckSentence,
  suggestionWords,
  type DecisionDestination,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { ContactCard } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { useNoAdvice, useScreener } from "../contract.js";
import { IdentityNotice } from "./IdentityNotice.js";
import { whoOf } from "./Sentence.js";

interface CardProps {
  view: ScreenerView;
  sender: ScreenerSenderDTO;
  anchor: RefObject<Element | null>;
  /** A waiting sender this install may decide. */
  choosing: boolean;
  subjectAction?: ReactNode;
}

export function Card(props: CardProps) {
  return props.view.shown === "card" ? <OpenCard key={props.sender.id} {...props} /> : null;
}

function OpenCard({ view, sender, anchor, choosing, subjectAction }: CardProps) {
  const t = useText("screener");
  const screening = useText("screening");
  const [applyRetro, setApplyRetro] = useState(RETRO_DEFAULT_ON);
  const model = useScreener();
  const { role } = model;
  const may = choosing && !refused(role);
  const shared = isSharedDomain(sender.from.address);
  const scope = shared ? "sender" : view.scopeOf(sender);
  const proposed = suggestionWords(sender, useNoAdvice()).dest;
  const domainSenders = may && !shared ? (model.domainWaitingCount?.(sender) ?? null) : null;
  const others = domainSenders === null ? null : model.reachOf(sender, "domain").others;
  const domainCount =
    others !== null && domainSenders === others.length + 1
      ? screening("scopeCount", {
          count: sender.held.length + others.reduce((sum, other) => sum + other.count, 0),
          senders: domainSenders,
        })
      : undefined;
  return (
    <ContactCard
      open
      onClose={() => view.show(null)}
      anchor={anchor}
      label={t("place.keyCard")}
      closeWhenFull={screening("close")}
      onKey={
        may
          ? (event) => {
              if (
                event.key !== DECISION_KEY.spam ||
                event.repeat ||
                event.nativeEvent.isComposing ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.shiftKey
              )
                return false;
              event.preventDefault();
              view.decide("spam", false, applyRetro);
              return true;
            }
          : undefined
      }
      person={{ name: whoOf(sender), address: displayAddress(sender.from.address) }}
      notice={
        sender.checked ? <IdentityNotice>{senderCheckSentence(t, sender.checked)}</IdentityNotice> : undefined
      }
      scope={
        may && !shared
          ? {
              label: t("barScopeAria"),
              value: scope,
              options: [
                {
                  value: "sender",
                  label: t("barScopeSender"),
                  note: screening("scopeCountOne", { count: sender.held.length }),
                },
                {
                  value: "domain",
                  label: t("wholeDomain", { domain: displayDomainLabel(sender.from.address) }),
                  note: domainCount,
                },
              ],
              onChange: (value) => view.setScope(sender, value === "domain" ? "domain" : "sender"),
            }
          : undefined
      }
      more={subjectAction}
      switches={
        may ? [{ label: screening("retroToggleAria"), on: applyRetro, onChange: setApplyRetro }] : undefined
      }
      goes={
        may
          ? {
              label: t("place.goesLabel"),
              value: proposed ?? undefined,
              places: DECISION_ORDER.map((dest) => ({ value: dest, label: t(PILE_KEY[dest]) })),
              onChange: (value) => view.decide(value as DecisionDestination, false, applyRetro),
            }
          : undefined
      }
    />
  );
}
