/** A sender’s place, identity, scope and advice. */
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
import {
  Button,
  Dot,
  EndDot,
  Icon,
  Menu,
  MenuItem,
  Sentence as KitSentence,
  Slot,
  Tag,
} from "@ohmail/ui/base";
import { useText } from "../../text/index.js";
import { useNoAdvice, useScreener } from "../contract.js";
import "./sentence.css";

const chunkText = (chunks: unknown): string =>
  (Array.isArray(chunks) ? chunks : [chunks]).filter((c) => typeof c === "string").join("");

export function whoOf(sender: ScreenerSenderDTO): string {
  return sender.from.name?.trim() || displayAddress(sender.from.address);
}

export function lookalikeBrand(sender: ScreenerSenderDTO): string | undefined {
  if (sender.checked?.reason === "impersonation") return sender.checked.brand;
  if (sender.checked?.reason === "unverified") return undefined;
  return sender.ai?.reasonCode === "impersonation" ? sender.ai.reasonBrand : undefined;
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
  unsubscribed,
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
  unsubscribed: boolean;
}) {
  const t = useText("screener");
  const screening = useText("screening");
  const words = suggestionWords(sender, useNoAdvice());
  const model = useScreener();
  const waiting = view.segment === "waiting";
  const place =
    view.segment !== "waiting"
      ? t(view.segment === "screened" ? "pileScreened" : "pileSpam")
      : words.dest === null
        ? t("place.nowhere")
        : t(PILE_KEY[words.dest]);
  const checked = sender.checked;
  const brand = lookalikeBrand(sender);
  const identity = brand
    ? { icon: "warn" as const, label: t("senderCheck.chip", { brand }) }
    : checked?.reason === "unverified"
      ? { icon: "ask" as const, label: t("place.notConfirmed") }
      : null;
  const detection =
    view.segment === "spam" && view.open && "pinned" in view.open && !view.open.pinned
      ? sender.detection
      : undefined;
  const offered = waiting && model.unsubClaimOf(sender, scope) !== "none";
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
        <Dot kind={waiting ? "hot" : "ink"} />
      </KitSentence>
      <p className="oh-text sc-sentence-tools">
        <span className="sc-identity">
          {identity ? (
            <Icon name={identity.icon} size={18} />
          ) : model.senderConfirmed?.(sender) ? (
            <Icon name="check" size={18} label={t("place.confirmed")} />
          ) : null}
          <Button kind="quiet" size="s" opens="dialog" ref={cardAt} onPress={onCard}>
            {displayAddress(sender.from.address)}
          </Button>
        </span>
        {identity ? <b>{identity.label}</b> : null}
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
        {shared && waiting ? <Tag>{t("place.perAddress")}</Tag> : null}
        {offered ? <Tag>{t("unsubOffered")}</Tag> : null}
        {view.segment === "screened" ? (
          <>
            {sender.scope === "domain" ? <Tag>{t("barScopeDomain")}</Tag> : null}
            <Tag>{t("place.heldLabel", { count: sender.held.length })}</Tag>
            <Tag>{t("place.screenedOn", { date: sender.screenedOn ?? sender.time })}</Tag>
          </>
        ) : null}
        {unsubscribed ? <Tag>{t("place.unsubscribed")}</Tag> : null}
        {detection ? (
          <span className="sc-shelf-advice">
            {t("place.sure", { sure: detection.confidence })} · {detection.reason}
          </span>
        ) : null}
      </p>
      {choosing && scope === "sender" && sender.checked?.claimsOnly ? (
        <p className="oh-text">{screening("footListClaim", { brand: sender.checked.brand })}</p>
      ) : null}
      <ScopeMenu view={view} sender={sender} scope={scope} anchor={scopeAt} />
    </div>
  );
}

/** Show the current advice and any actionable refusal. */
export function DecisionLines({ sender }: { sender: ScreenerSenderDTO }) {
  const t = useText("screener");
  const rules = useText("rules");
  const words = suggestionWords(sender, useNoAdvice());
  const learned = sender.ai?.learnedReason === "webinar" && sender.ai.reasonCode === undefined;
  const advice = learned || words.badge !== null || words.sure !== null || words.reason !== null;
  return (
    <>
      {advice ? (
        <p className="oh-text sc-advice">
          <Icon name="spark" size={18} />
          {words.badge !== null ? <Tag>{t(words.badge)}</Tag> : null}
          {words.sure !== null ? (
            <b title={t("place.confidence")}>{t("place.sure", { sure: words.sure })}</b>
          ) : null}
          {learned ? (
            <span>
              <EndDot kind="hot">{t("learnedWebinar")}</EndDot>
            </span>
          ) : words.reason ? (
            <span>{t(words.reason.key, words.reason.values)}</span>
          ) : null}
        </p>
      ) : null}
      {words.lines.map((line) => (
        <p key={line.key} className="oh-text">
          {line.key === "aiActRefused"
            ? t("aiActRefused", { accept: t(words.dest === null ? "rowAccept" : PILE_VERB_KEY[words.dest]) })
            : t(line.key, line.values)}
        </p>
      ))}
      {sender.inertRule ? (
        <p className="oh-text">{rules("sharedProviderInert", { domain: sender.inertRule.domain })}</p>
      ) : null}
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
      title={t("place.ruleFor")}
    >
      {(["sender", "domain"] as const).map((s) => (
        <MenuItem
          key={s}
          checked={scope === s}
          note={
            s === "domain" ? displayDomainLabel(sender.from.address) : displayAddress(sender.from.address)
          }
          onPress={() => {
            view.setScope(sender, s);
            view.show(null);
          }}
        >
          {t(s === "domain" ? "place.scopeDomain" : "place.scopeSender")}
        </MenuItem>
      ))}
    </Menu>
  );
}
