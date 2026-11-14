/**
 * THE OPEN SENDER'S SENTENCE: who, and where their mail goes, the place a word you press. A real suggestion is the
 * slot's proposal; with none the slot says nobody has chosen. Under it, the address (the way to the sender's card)
 * and how wide a decision reaches, then the lines: what ohmail measured, the advice or why there is none, what a
 * whole-domain press also files, and what Screen out and Spam also send. Every line is said before the press.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import type { RefObject } from "react";
import {
  PILE_KEY,
  PILE_VERB_KEY,
  suggestionWords,
  type DecisionScope,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { Button, Dot, Menu, MenuItem, Sentence as KitSentence, Slot, Tag } from "@ohmail/ui/base";
import { useText } from "../../text/index.js";
import { useNoAdvice, useScreener } from "../contract.js";
import { unsubscribeDisclosure } from "./unsubscribe-disclosure.js";

const chunkText = (chunks: unknown): string =>
  (Array.isArray(chunks) ? chunks : [chunks]).filter((c) => typeof c === "string").join("");

export function whoOf(sender: ScreenerSenderDTO): string {
  return sender.from.name?.trim() || displayAddress(sender.from.address);
}

export function Sentence({
  view,
  sender,
  choosing,
  shared,
  scope,
  slotAt,
  cardAt,
  scopeAt,
  onCard,
}: {
  view: ScreenerView;
  sender: ScreenerSenderDTO;
  choosing: boolean;
  shared: boolean;
  scope: DecisionScope;
  slotAt: RefObject<HTMLButtonElement | null>;
  cardAt: RefObject<HTMLButtonElement | null>;
  scopeAt: RefObject<HTMLButtonElement | null>;
  onCard: () => void;
}) {
  const t = useText("screener");
  const words = suggestionWords(sender, useNoAdvice());
  const place =
    view.segment !== "waiting"
      ? t(view.segment === "screened" ? "pileScreened" : "pileSpam")
      : words.dest === null
        ? t("place.nowhere")
        : t(PILE_KEY[words.dest]);
  /* What ohmail measured, said as facts beside the sentence: a claimed company, how sure the advice is. */
  const facts = [
    ...(sender.checked?.reason === "impersonation"
      ? [t("senderCheck.chip", { brand: sender.checked.brand })]
      : []),
    ...(view.segment === "waiting" && words.sure !== null ? [t("place.sure", { sure: words.sure })] : []),
  ];
  const lead = t.rich("place.goes", {
    who: whoOf(sender),
    place,
    slot: (chunks: unknown) =>
      choosing ? (
        <Slot
          ref={slotAt}
          kind={words.dest === null ? "none" : "fill"}
          label={t("rowMoreAria")}
          expanded={view.shown === "place"}
          onPress={() => view.show(view.shown === "place" ? null : "place")}
        >
          {chunkText(chunks)}
        </Slot>
      ) : (
        <b>{chunkText(chunks)}</b>
      ),
  });
  return (
    <div>
      <KitSentence level={2}>
        {lead}
        <Dot kind="ink" />
      </KitSentence>
      <p className="oh-text sc-sentence-tools">
        <Button kind="quiet" size="s" opens="dialog" ref={cardAt} onPress={onCard}>
          {displayAddress(sender.from.address)}
        </Button>
        {choosing && !shared ? (
          <Slot
            ref={scopeAt}
            label={t("barScopeAria")}
            expanded={view.shown === "scope"}
            onPress={() => view.show(view.shown === "scope" ? null : "scope")}
          >
            {t(scope === "domain" ? "barScopeDomain" : "barScopeSender")}
          </Slot>
        ) : null}
        {facts.map((fact) => (
          <Tag key={fact}>{fact}</Tag>
        ))}
      </p>
      <ScopeMenu view={view} sender={sender} scope={scope} anchor={scopeAt} />
    </div>
  );
}

/** The lines under the sentence, each said before the press. */
export function DecisionLines({
  view,
  sender,
  choosing,
  scope,
  shared,
}: {
  view: ScreenerView;
  sender: ScreenerSenderDTO;
  choosing: boolean;
  scope: DecisionScope;
  shared: boolean;
}) {
  const t = useText("screener");
  const rules = useText("rules");
  const model = useScreener();
  const words = suggestionWords(sender, useNoAdvice());
  const reach = choosing && scope === "domain" ? model.reachOf(sender, scope) : null;
  const unsubscribe = choosing
    ? unsubscribeDisclosure(t, sender.from.address, scope, model.unsubClaimOf(sender, scope))
    : null;
  return (
    <>
      {(view.segment === "waiting" ? words.lines : []).map((line) => (
        <p key={line.key} className="oh-text">
          {line.key === "aiActRefused"
            ? t("aiActRefused", { accept: t(words.dest === null ? "rowAccept" : PILE_VERB_KEY[words.dest]) })
            : t(line.key, line.values as Record<string, string | number> | undefined)}
        </p>
      ))}
      {view.segment === "waiting" && sender.inertRule ? (
        <p className="oh-text">{rules("sharedProviderInert", { domain: sender.inertRule.domain })}</p>
      ) : null}
      {reach !== null && reach.others.length > 0 ? (
        <p className="oh-text">
          {t("domainAlsoFiles", {
            count: reach.others.reduce((n, o) => n + o.count, 0),
            senders: reach.others.map((o) => `${displayAddress(o.address)} (${o.count})`).join(", "),
          })}
        </p>
      ) : null}
      {choosing && sender.checked?.claimsOnly && (shared || scope === "sender") ? (
        <>
          <p className="oh-text">{t("listClaimDecision", { brand: sender.checked.brand })}</p>
          <p className="oh-text">{t("barRuleListClaim", { target: displayAddress(sender.from.address) })}</p>
        </>
      ) : null}
      {unsubscribe ? <p className="oh-text">{unsubscribe}</p> : null}
    </>
  );
}

/** How wide a decision reaches: this sender, or everyone at the domain. */
function ScopeMenu({
  view,
  sender,
  scope,
  anchor,
}: {
  view: ScreenerView;
  sender: ScreenerSenderDTO;
  scope: DecisionScope;
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const t = useText("screener");
  return (
    <Menu
      open={view.shown === "scope"}
      onClose={() => view.show(null)}
      anchor={anchor}
      label={t("barScopeAria")}
    >
      {(["sender", "domain"] as const).map((s) => (
        <MenuItem
          key={s}
          checked={scope === s}
          onPress={() => {
            view.setScope(sender, s);
            view.show(null);
          }}
        >
          {t(s === "domain" ? "barScopeDomain" : "barScopeSender")}
        </MenuItem>
      ))}
    </Menu>
  );
}
