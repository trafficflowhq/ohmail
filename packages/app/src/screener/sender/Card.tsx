/**
 * THE SENDER'S CARD: who it is, how wide a decision reaches, and where their mail goes. Taking a place is the
 * decision itself, through the view's `decide`, with the reach the card shows; it moves no mail before that press.
 * An install that may not decide shows who it is and nothing to choose.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import { useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { RETRO_DEFAULT_ON } from "@ohmail/app-logic/press/sender-screening";
import {
  DECISION_KEY,
  DECISION_ORDER,
  isSharedDomain,
  PILE_VERB_KEY,
  refused,
  senderCheckSentence,
  suggestionWords,
  type DecisionDestination,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { MenuItem, Tag } from "@ohmail/ui/base";
import { formatRecipientLine } from "@ohmail/app-logic/writing/compose-from";
import { ContactCard } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { useNoAdvice, useScreener } from "../contract.js";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import { IdentityNotice } from "./IdentityNotice.js";
import { lookalikeBrand, whoOf } from "./Sentence.js";

export interface CardActions {
  subject?: ReactNode;
  seeAll?: () => void;
}

interface CardProps {
  view: ScreenerView;
  sender: ScreenerSenderDTO;
  anchor: RefObject<Element | null>;
  /** A waiting sender this install may decide. */
  choosing: boolean;
  actions?: CardActions;
}

export function Card(props: CardProps) {
  return props.view.shown === "card" ? <OpenCard key={props.sender.id} {...props} /> : null;
}

function OpenCard({ view, sender, anchor, choosing, actions }: CardProps) {
  const t = useText("screener");
  const screening = useText("screening");
  const message = useText("message");
  const { host } = useFrame();
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
  const place =
    view.segment === "waiting"
      ? screening("placeScreener")
      : t(view.segment === "screened" ? "pileScreened" : "pileSpam");
  const clipboard = host.features.reader === NONE ? NONE : (host.features.reader.copy ?? NONE);
  const close = () => view.show(null);
  const address = sender.from.address;
  const claim = lookalikeBrand(sender);
  return (
    <ContactCard
      open
      onClose={close}
      anchor={anchor}
      label={t("place.keyCard")}
      closeWhenFull={screening("auditClose")}
      onKey={may ? (event) => spamKey(event, () => view.decide("spam", false, applyRetro)) : undefined}
      person={{ name: whoOf(sender), address: displayAddress(sender.from.address) }}
      copy={
        clipboard === NONE
          ? undefined
          : {
              label: message("copyAddress"),
              onPress: () => {
                void clipboard(address).catch(() => false);
                close();
              },
            }
      }
      notice={<SenderNotice sender={sender} claim={claim} shared={shared} />}
      scope={
        may && !shared
          ? {
              label: screening("scopeAria"),
              value: scope,
              options: [
                {
                  value: "sender",
                  label: screening("scopeAddress"),
                  note: screening("scopeCountOne", { count: sender.held.length }),
                },
                {
                  value: "domain",
                  label: screening("scopeDomain", { domain: displayDomainLabel(address) }),
                  note: domainCount,
                },
              ],
              onChange: (value) => view.setScope(sender, value === "domain" ? "domain" : "sender"),
            }
          : undefined
      }
      now={{
        line: screening("cardNowIn", { place }),
        place,
        all: { label: screening("cardSeeAll"), onPress: actions?.seeAll ?? close },
      }}
      switches={
        may
          ? [
              {
                label: screening("cardExisting"),
                ariaLabel: screening("retroToggleAria"),
                on: applyRetro,
                onChange: setApplyRetro,
              },
            ]
          : undefined
      }
      goes={
        may
          ? {
              label: t("place.goesLabel"),
              value: proposed ?? undefined,
              places: DECISION_ORDER.map((dest) => ({ value: dest, label: t(PILE_VERB_KEY[dest]) })),
              onChange: (value) => view.decide(value as DecisionDestination, false, applyRetro),
            }
          : undefined
      }
    >
      {host.features.places.write !== NONE || host.features.places.address !== NONE || actions?.subject ? (
        <CardWays sender={sender} close={close}>
          {actions?.subject}
        </CardWays>
      ) : null}
    </ContactCard>
  );
}

function spamKey(event: KeyboardEvent, decide: () => void): boolean {
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
  decide();
  return true;
}

function CardWays({
  sender,
  close,
  children,
}: {
  sender: ScreenerSenderDTO;
  close: () => void;
  children: ReactNode;
}) {
  const { host, commands } = useFrame();
  const message = useText("message");
  const address = sender.from.address;
  return (
    <>
      {host.features.places.write !== NONE ? (
        <MenuItem
          icon="write"
          onPress={() => {
            const recipient = formatRecipientLine([{ name: sender.from.name, address }]);
            close();
            commands.write({ to: [recipient], cc: [], bcc: [], subject: "", body: "" });
          }}
        >
          {message("write")}
        </MenuItem>
      ) : null}
      {host.features.places.address !== NONE ? (
        <MenuItem
          icon="go"
          onPress={() => {
            close();
            commands.go({ place: "address", sub: address });
          }}
        >
          {message("contactAllMail")}
        </MenuItem>
      ) : null}
      {children}
    </>
  );
}

function SenderNotice({
  sender,
  claim,
  shared,
}: {
  sender: ScreenerSenderDTO;
  claim: string | undefined;
  shared: boolean;
}) {
  const t = useText("screener");
  return (
    <>
      {sender.checked ? <IdentityNotice>{senderCheckSentence(t, sender.checked)}</IdentityNotice> : null}
      {claim || shared ? (
        <div className="sc-sentence-tools">
          {claim ? <Tag>{t("senderCheck.chip", { brand: claim })}</Tag> : null}
          {shared ? (
            <>
              <Tag>{t("place.sharedProvider")}</Tag>
              <Tag>{t("place.perAddress")}</Tag>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
