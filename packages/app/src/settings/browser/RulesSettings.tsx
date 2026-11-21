"use client";

import { usePlaceLiveArgs } from "../../frame/index.js";
import { browserClipboard } from "../../host/browser/index.js";
import { ContactDetails, useOpenCard } from "../../reader/contact/Contact.js";
import type { PaneBodyProps } from "../index.js";
import { RulesPane, type RuleItem, type RulesModel } from "../rules/index.js";
import { useText } from "../../text/index.js";
import { useEngine } from "@ohmail/app-logic/engine/context";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { rosterStateOf } from "@ohmail/app-logic/mail-state/mail-state";
import { rulesPostureOf } from "@ohmail/app-logic/press/rules-posture";
import { RETRO_DEFAULT_ON } from "@ohmail/app-logic/press/sender-screening";
import { useNowAt } from "@ohmail/app-logic/session/day-clock";
import { displayRuleMatch } from "@ohmail/app-logic/text/idn";
import {
  canonicalDestination,
  PROFILE_RULES_SENT_MAX,
  ruleDestinationPile,
  useRuleSettings,
  walkOwed,
} from "@ohmail/app-logic/press/rule-settings";
import type { EngineMessage, Folder, RuleEntity } from "@ohmail/wire";
import { PILE_KEY } from "@ohmail/app-logic/screener";
import { placeLabel } from "@ohmail/app-logic/text/format";
import {
  useRuleActions,
  pileOf,
  rulePastMail,
  walkedMailboxes,
} from "@ohmail/app-logic/press/rule-management";
import { useRuleDescriptions } from "@ohmail/app-logic/press/rule-descriptions";
import {
  bodyTermOf,
  changePlaces,
  groupByDestination,
  subjectTermOf,
} from "@ohmail/app-logic/press/rule-list";

export function BrowserRulesPane({ scroller }: PaneBodyProps) {
  const engine = useEngine();
  const { report } = usePlaceLiveArgs();
  const { mailboxes, rosterProbed } = useMailState();
  const posture = rulesPostureOf(mailboxes);
  const nowAt = useNowAt();
  const t = useText("rules");
  const why = useText("ohbox");
  const screener = useText("screener");
  const [card, openCard, closeCard] = useOpenCard();
  const { data, planAtPress, retarget } = useRuleSettings(posture, nowAt);
  const published = data.source === "published";
  const { rules, apart, apartLine, factsOf } = useRuleDescriptions(
    data.rules,
    data.waiting,
    data.queued,
    published,
    t,
    (id) => mailboxes?.find((box) => box.id === id)?.address ?? null,
  );
  const placeName = (folder: Folder) => {
    const dest = ruleDestinationPile(folder);
    return dest ? screener(PILE_KEY[dest]) : placeLabel(folder);
  };
  const pastMail = (rule: RuleEntity, destination: Folder | null) =>
    rulePastMail(
      rule,
      planAtPress(),
      engine.read().list<EngineMessage>("message"),
      destination,
      walkedMailboxes(rosterStateOf(rosterProbed, mailboxes)),
    );
  const actions = useRuleActions({
    t,
    tWhy: why,
    toast: report,
    placeName,
    pastMail,
    posture,
    onRevoke: (ruleId) => engine.mutate({ kind: "rule_delete", ruleId }),
    onRetarget: retarget,
  });
  const items = rules.map((rule) => ruleItem(rule, factsOf(rule), t, placeName, pastMail));
  const holder = data.holder ?? t("theOrganizer");
  const max = PROFILE_RULES_SENT_MAX;
  const bound = published
    ? data.rules.length >= max
      ? t("profileBoundHeld", { max, holder })
      : null
    : data.rules.length > max
      ? t("profileBound", { max, count: data.rules.length - max })
      : null;
  const model: RulesModel = {
    rules: items,
    waiting: apart.map((row, i) => ({ key: row.requestId ?? String(i), ...apartLine(row) })),
    intro: published ? t(posture.mode === "pending" ? "introHeld" : "introCopy", { holder }) : t("intro"),
    locked: actions.lockedWhy,
    refusal: actions.refusal,
    bound,
    facets: groupByDestination(rules).map(({ destination }) => ({
      folder: destination,
      name: placeName(destination),
    })),
    refileFirst: RETRO_DEFAULT_ON,
    revoke: actions.revoke,
    revokeAll: actions.runBulk,
    retarget(id, folder, refile) {
      const rule = rules.find((r) => r.id === id);
      const allowed = rule && changePlaces(rule).find((p) => p.folder === folder && !p.current);
      if (rule && allowed) actions.retarget(rule, allowed.folder, refile);
    },
    lift(id) {
      const rule = rules.find((r) => r.id === id);
      if (rule) actions.lift(rule);
    },
    contact(address, anchor) {
      openCard({ name: displayRuleMatch(address), address, anchor, slot: address });
    },
  };
  return (
    <>
      <RulesPane model={model} scroller={scroller} />
      <ContactDetails
        person={card}
        onClose={closeCard}
        clipboard={(text) => {
          const owner = card?.anchor.ownerDocument.defaultView;
          return owner ? browserClipboard(owner)(text) : Promise.resolve(false);
        }}
      />
    </>
  );
}

function ruleItem(
  rule: RuleEntity,
  facts: ReturnType<ReturnType<typeof useRuleDescriptions>["factsOf"]>,
  t: ReturnType<typeof useText>,
  placeName: (folder: Folder) => string,
  pastMail: (rule: RuleEntity, destination: Folder | null) => number | null,
): RuleItem {
  const { what, meta, waits, q, queuedLine, rank, inert, twinNote } = facts;
  const who = displayRuleMatch(rule.match);
  const folder = canonicalDestination(rule.destination) as Folder;
  const narrow = subjectTermOf(rule) !== "" || bodyTermOf(rule) !== "";
  const notes = [
    narrow ? what : null,
    rank && t(rank.kind, { domain: displayRuleMatch(rank.domain), place: placeLabel(rank.place) }),
    inert && t("sharedProviderInert", { domain: displayRuleMatch(inert) }),
    twinNote,
    waits,
    queuedLine,
  ].filter((note): note is string => !!note);
  return {
    id: rule.id,
    who,
    person: rule.kind === "sender" ? { name: who, address: rule.match } : null,
    what,
    folder,
    place: placeName(folder),
    origin: meta,
    byOhmail: rule.byOhmail === true,
    notes,
    outranked: rank?.kind === "outranked",
    queued: !!q,
    places: changePlaces(rule).map((p) => ({ ...p, name: placeName(p.folder) })),
    finds: [rule.match, who, subjectTermOf(rule), bodyTermOf(rule)].join(" ").toLowerCase(),
    get refile() {
      const from = placeName(pileOf(rule));
      const walk = walkOwed(rule);
      const count = pastMail(rule, null);
      return {
        label: t(walk ? "retroToggleWalk" : "retroToggle", { from }),
        note:
          count === null
            ? t("retroToggleUncounted")
            : t(walk ? "retroToggleNoteWalk" : "retroToggleNote", { count, from }),
        on: t(walk ? "retargetExplainWalk" : "retargetExplainRetro", { from }),
      };
    },
  };
}
