"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useConsent, usePartition } from "@ohmail/app-logic/consent";
import { useEngine } from "@ohmail/app-logic/engine/context";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { otherOrganizerOf } from "@ohmail/app-logic/mail-state/mail-state";
import { shellConsentOptions } from "@ohmail/app-logic/press/consent-options";
import { browserOffline, queuedWaitOf } from "@ohmail/app-logic/press/queued-sentence";
import { moveInBatches, retroOf, screeningReadBack, screeningShown, verdictAction, verdictArgs, verdictKeyOf, writtenRuleIds } from "@ohmail/app-logic/press/press-verdict";
import {
  autoUnsubscribeDoor, dispatchScreeningChange, domainOf, isOwnSubject, movesAtLanding, planScreeningChange,
  resolutionExtras, ruleMatchOf, screeningPath, screeningToast, senderScreening, withResolution,
  type ScreeningDest, type ScreeningScope, type ScreeningPress,
} from "@ohmail/app-logic/press/sender-screening";
import { useNowAt } from "@ohmail/app-logic/session/day-clock";
import { confirmedSyncEngine, mirrorOwnerOf } from "@ohmail/app-logic/session/sync-scheduler";
import { placeLabel } from "@ohmail/app-logic/text/format";
import { displayAddress, displayDomain } from "@ohmail/app-logic/text/idn";
import { useMailboxWord, usePress, useReport, useScopeHere } from "@ohmail/app/frame";
import type { ContactScreeningProps } from "@ohmail/app/reader";
import { useScreener } from "@ohmail/app/screener";
import {
  FOLDER_OF_VIEW, PRESS_VISIBLE_ROWS, autoUnsubscribeConfirms, consentPartition, inverseMutations, outrankCoveringDomains,
  pressForecast, pressGained, pressRuleId, ruleFingerprint, rulesInPlay, rulesList, senderKey, unsubscribeClaim, unsubscribeLetterOf, type PressForecast,
} from "@ohmail/client-engine";
import { cssRect } from "@ohmail/ui/base";
import type { EngineMessage } from "@ohmail/wire";
import { usePileNames } from "../../shell/decision-copy";
import { SenderAuditPanel } from "../../screening/SenderAuditPanel";
import { SenderMenu, type SenderMenuState } from "../../components/sender-menu/SenderMenu";
import { useWebSubjectRule } from "./WebScreenerSubjectRule";

function positionOf(person: ContactScreeningProps["person"]): Omit<SenderMenuState, "messageId" | "address"> {
  const rect = cssRect(person.anchor);
  return { x: rect.left, y: rect.bottom, anchorTop: rect.top, anchorBottom: rect.bottom };
}

const successful = new Set(["toastRuled", "toastRetargeted", "toastRuledMoved", "toastRuledFuture", "toastMoved"]);
const termOf = (rule: ScreeningPress["shown"][number] | undefined): string =>
  (rule?.subjectContains ?? rule?.bodyContains ?? "").trim();

const forecastKey = (forecast: PressForecast): string =>
  JSON.stringify(forecast, (_key, value: unknown) => value instanceof Map ? [...value] : value);

export function WebContactScreening({ person, onClose, children }: ContactScreeningProps) {
  const t = useTranslations("screening");
  const readerText = useTranslations("reader");
  const sessionText = useTranslations("session");
  const ohbox = useTranslations("ohbox");
  const session = useScopeHere();
  const engine = useEngine();
  const press = usePress();
  const mailboxWord = useMailboxWord();
  const stayedFor = useCallback((ids: readonly string[]) => engine.whyStayed(ids), [engine]);
  const screener = useScreener();
  const { ownAddresses, firstImportDoneAt, consentView } = usePartition();
  const consent = useConsent();
  const { mailboxes, rosterProbed } = useMailState();
  const now = useNowAt();
  const report = useReport();
  const piles = usePileNames();
  const [audit, setAudit] = useState<ScreeningScope | null>(null);
  const [subjectOpen, setSubjectOpen] = useState(false);
  const subjectRule = useWebSubjectRule({
    messageId: person.messageId ?? "",
    senderAddress: person.address,
    eligible: person.onSender === true || person.direct === true || person.slot === `${person.messageId} from`,
    open: subjectOpen,
    onOpen: () => setSubjectOpen(true),
    onClose: () => setSubjectOpen(false),
  }, "letter");

  const ownsEngine = () => session !== null && mirrorOwnerOf(engine) === session && confirmedSyncEngine(engine) === engine;
  const readContact = () => {
    if (!person.messageId || !rosterProbed || !consentView || !ownsEngine()) return null;
    const read = engine.verbRead();
    const message = read.get<EngineMessage>("message", person.messageId);
    if (!message || message.accountId !== session || !mailboxes?.some((box) =>
      box.id === message.mailboxId && box.organizerChecked === true && box.status !== "disabled")) return null;
    const address = person.slot === `${message.id} from` ? undefined : person.address;
    const rules = press.routing.planOver.current?.(read);
    const sender = senderScreening(read, message.id, address, consentView.placeOf, rules, { mailbox: "seed" });
    return sender ? { read, message, address, sender, rules, placeOf: consentView.placeOf } : null;
  };
  const contact = readContact();
  if (!contact) return children();
  const { read, message, address, sender, rules } = contact;
  const options = () => shellConsentOptions(consent, now(), ownAddresses, firstImportDoneAt);
  const forecast = (current: NonNullable<ReturnType<typeof readContact>>, dest: ScreeningDest,
    scope: ScreeningScope, makeRule: boolean, applyRetro: boolean) => {
    const plan = planScreeningChange(current.sender, dest, scope, makeRule, applyRetro);
    const decide = plan.mutations.find((mutation) => mutation.kind === "screener_decide");
    return pressForecast({
      reader: current.read,
      ...(current.rules ? { rules: current.rules } : {}),
      options: options(), subject: current.sender.scopes[scope].messages, scope,
      match: ruleMatchOf(current.sender, scope), wanted: FOLDER_OF_VIEW[dest],
      makeRule, applyRetro, now: now(), seedId: current.message.id,
      ...(decide?.kind === "screener_decide" ? { decide } : {}),
    });
  };

  const disclosesUnsubscribe = autoUnsubscribeDoor({
    demo: false, known: consent.known, on: consent.autoUnsubscribe, standalone: consent.standalone,
    confirms: autoUnsubscribeConfirms(mailboxes),
  }).discloses;
  const heldFor = (current: NonNullable<ReturnType<typeof readContact>>, scope: ScreeningScope) =>
    current.sender.scopes[scope].messages.filter((letter) =>
      letter.accountId === session && letter.folder === FOLDER_OF_VIEW.screener
      && (scope === "domain" || letter.id === current.message.id));
  const lettersFor = (current: NonNullable<ReturnType<typeof readContact>>, scope: ScreeningScope) =>
    heldFor(current, scope).map((letter) => unsubscribeLetterOf(current.read, letter.id));
  const recipientsFor = (current: NonNullable<ReturnType<typeof readContact>>, scope: ScreeningScope) => {
    const letters = heldFor(current, scope).filter(({ id }) => {
      const { posture, authVerdict } = unsubscribeLetterOf(current.read, id);
      return (posture === null || posture === "one_click") && (authVerdict == null || authVerdict === "pass");
    });
    return {
      ids: letters.map(({ id }) => id).sort(),
      senders: new Set(letters.map(({ from }) => from.address.trim().toLowerCase())).size,
    };
  };

  const choose = (
    dest: ScreeningDest, scope: ScreeningScope, makeRule: boolean, applyRetro: boolean,
    answer?: ScreeningPress, grantedIds?: readonly string[],
  ) => {
    const current = readContact();
    if (!current || isOwnSubject(current.read, current.message.id, current.address, ownAddresses)) return false;
    const over = current.rules;
    const subject = current.sender.scopes[scope];
    if (subject.messages.some((letter) => letter.accountId !== session || !mailboxes?.some((box) =>
      box.id === letter.mailboxId && box.organizerChecked === true && box.status !== "disabled"))) return false;
    const path = screeningPath(current.sender, scope, makeRule);
    const resolution = answer?.resolution ?? "keep";
    const latest = forecast(current, dest, scope, makeRule, applyRetro);
    if (answer && forecastKey(answer.forecast) !== forecastKey(latest)) return false;
    const base = planScreeningChange(current.sender, dest, scope, makeRule, applyRetro);
    const widened = answer?.widenedFrom;
    const armed = disclosesUnsubscribe && base.unsubscribes;
    const currentIds = armed && (widened || grantedIds) ? recipientsFor(current, scope).ids : [];
    const grantedLetters = grantedIds?.filter((id) => currentIds.includes(id));
    const unsubscribeIds = grantedLetters?.length ? grantedLetters : undefined;
    if (widened) {
      if (forecastKey(widened.forecast) !== forecastKey(forecast(current, dest, "sender", makeRule, applyRetro))) return false;
      const claim = currentIds.length === 0 ? "none" : unsubscribeClaim({ armed, letters: lettersFor(current, scope) });
      if (widened.unsubscribe !== claim || (grantedIds?.length ?? 0) !== currentIds.length
        || (unsubscribeIds?.length ?? 0) !== currentIds.length) return false;
    }
    onClose();
    const extras = resolutionExtras(answer);
    const plan = path === "window" ? base : withResolution(base, extras);
    const moves = movesAtLanding(plan, latest, resolution);
    const who = scope === "domain" ? displayDomain(current.sender.domain) : displayAddress(current.sender.address);
    const place = piles[dest];
    const facts = () => ({
      consent, now: now(), ownAddresses, ...(firstImportDoneAt ? { firstImportDoneAt } : {}),
    });
    const shownNow = () => screeningShown(engine.verbRead(), subject.messages, dest, facts());
    const before = shownNow();
    const args = { sender: who, place };
    const readBack = (retro = applyRetro) =>
      screeningReadBack(engine.verbRead(), current.message.id, current.address, dest, scope, { ...facts(), retro }, { mailbox: "seed" });
    const sayVerdict = (back: ReturnType<typeof readBack>, applying?: string) => {
      if (back && back.verdict.key !== "none") {
        const action = verdictAction(back.verdict, { scope, address: current.sender.address });
        const keptRule = back.verdict.key === "kept" ? back.verdict.rule : null;
        const line = t(verdictKeyOf(back.verdict), verdictArgs(back.verdict, {
          ...args, history: t("placeHistory"), label: placeLabel, domain: displayDomain,
        }));
        report(applying ? `${line} ${applying}` : line, action?.kind === "move" ? {
          action: t("verdictMoveThem", { still: action.ids.length }),
          duration: 8000,
          onAction: () => {
            if (!ownsEngine()) return;
            const originalMissing = engine.verbRead().get<EngineMessage>("message", current.message.id) === undefined;
            moveStayed(action.ids, dest, scope, current.sender.address, current.message.mailboxId, originalMissing);
          },
        } : action?.kind === "remove" && keptRule ? {
          action: t("verdictRemoveRule"), duration: 8000,
          onAction: () => {
            const live = readContact();
            if (!live || live.sender.address !== current.sender.address) return;
            const rows = live.rules ?? rulesList(live.read);
            const ruleId = live.rules ? pressRuleId(keptRule, rows) : action.ruleId;
            const rule = rows.find((rule) => rule.id === ruleId);
            if (!rule || ruleFingerprint(rule) !== ruleFingerprint(keptRule)) return;
            void press.mutateAndReport({ kind: "rule_delete", ruleId }, null, engine).then((ok) => {
              if (ok && ownsEngine()) choose(dest, scope, makeRule, applyRetro);
            });
          },
        } : undefined);
      }
    };
    const send: Parameters<typeof dispatchScreeningChange>[2] = (mutation) => {
      const scoped = mutation.kind === "screener_decide" && unsubscribeIds !== undefined
        ? { ...mutation, unsubscribeIds } : mutation;
      return press.fileAndRefresh(engine.mutate(over ? outrankCoveringDomains(over, scoped) : scoped));
    };
    const seedMove = latest[resolution].seedMove;
    const waiting = path === "decide" && extras.length === 0
      ? screener.waiting.find((row) => row.id === subject.representativeId)
      : undefined;
    if (waiting) {
      screener.decide(waiting, dest, {
        read: false, scope, applyRetro, unsubscribeIds, ...(seedMove ? { seedMove } : {}),
      });
      return;
    }
    if (plan.mutations.length === 0 && moves.length === 0 && extras.length === 0) {
      report(t("toastAlready", { sender: who, place }));
      return;
    }
    if (path !== "window") {
      void dispatchScreeningChange(plan, moves, send, moves.length, plan.ruleState === "promoted")
        .then((key) => {
          if (!key || !ownsEngine()) return;
          const back = successful.has(key) ? readBack() : null;
          sayVerdict(back);
          if (back?.verdict.key === "none" || !back) report(t(key, {
            ...args, count: pressGained(before, back?.shown ?? shownNow()),
          }));
        });
      return;
    }

    const moving = new Set(moves.map((move) => move.messageId));
    const inverses = moves.flatMap((move) => inverseMutations(current.read, move));
    const opened = press.routing.holdScreen({
      id: crypto.randomUUID(), seedId: current.message.id, address: current.sender.address, dest,
      messageIds: latest[resolution].landing.filter((id) => !moving.has(id)).slice(0, PRESS_VISIBLE_ROWS),
      note: { sender: who, place, count: moves.length }, makeRule, applyRetro, resolution,
      shown: (answer?.shown ?? []).map((rule) => ({ id: rule.id, fp: ruleFingerprint(rule) })),
      moves: moves.map(send),
      after: ({ worst, results, mutations, changed }) => {
        if (!ownsEngine() || worst === "superseded") return;
        if (worst === "rolled_back" || worst === "awaiting_organizer" || worst === "queued") {
          const key = screeningToast(plan, worst, moves.length, queuedWaitOf(results, browserOffline()));
          report(t(key, { ...args, count: pressGained(before, shownNow()) }));
          return;
        }
        for (const rule of answer?.shown ?? []) {
          const term = termOf(rule);
          if (term && changed.includes(rule.id)) report(t("verdictChanged", { term }));
        }
        const back = readBack();
        if (!back) return;
        const ids = writtenRuleIds(mutations, results);
        const retro = !applyRetro || !makeRule ? "done" : ids ? retroOf(engine.verbRead(), ids) : "unknown";
        const rearming = retro === "applying" && plan.ruleState === "already";
        const applying = rearming
          ? t("toastAlreadyRuledRetro", args)
          : t("verdictApplying", { ...args, count: back.at });
        if (back.verdict.key === "none") {
          report(retro === "done" ? t("verdictAll", { ...args, count: back.at }) : applying);
        } else {
          const explainsBacklog = retro === "applying" && (rearming || back.verdict.key !== "applying");
          sayVerdict(back, explainsBacklog ? rearming ? applying : t("verdictApplyingRest") : undefined);
        }
        if (retro === "applying" && ids) {
          press.pressWatch.watch({
            ruleIds: ids,
            done: (state) => {
              if (state !== "done" || !ownsEngine()) return;
              const after = readBack(false);
              if (!after) return;
              const verdict = after.verdict.key;
              if (verdict === "none") report(t("verdictAll", { ...args, count: after.at }));
              else if (verdict === "still" || verdict === "stillLegacy" || verdict === "undecided") sayVerdict(after);
            },
          });
        }
      },
    });
    const terms = latest.groups
      .filter((group) => group.cause === "term-subject" || group.cause === "term-body")
      .map((group) => group.rule);
    const removed = terms.filter((rule) => answer?.shown.some((shown) => shown.id === rule.id));
    const ready = !applyRetro
      ? t(screeningToast(plan, null, moves.length), { ...args, count: pressGained(before, latest[resolution].landing) })
      : resolution === "remove" && removed.length
        ? t("toastPressRemoved", { ...args, rules: removed.length, term: termOf(removed[0]) })
        : resolution === "keep" && terms.length === 1
          ? t("toastPressKeptOne", { ...args, term: termOf(terms[0]), keptPlace: placeLabel(terms[0]!.destination) })
          : resolution === "keep" && terms.length > 1
            ? t("toastPressKeptMany", { ...args, rules: terms.length })
            : latest.exception
              ? t("toastPressException", { ...args, domain: displayDomain(latest.exception.rule.match),
                  domainPlace: placeLabel(latest.exception.rule.destination) })
              : t("toastPressRuled", args);
    if (!opened.held) {
      report(`${ready} ${sessionText("noUndoHere")}`);
      return;
    }
    press.toastWithUndo(ready, inverses, {
      cancel: () => press.routing.undo(press.routing.subjectOf(current.sender.address)), undone: t("toastRoutingUndoneRules"),
    });
  };

  const moveStayed = (
    ids: readonly string[], dest: ScreeningDest, scope: ScreeningScope, address: string,
    seedMailboxId: string, originalMissing = false,
  ) => {
    if (!ownsEngine()) return;
    const latest = engine.verbRead();
    const domain = scope === "domain" ? domainOf(address) : "";
    const key = senderKey(address);
    const eligible = ids.filter((id) => {
      const letter = latest.get<EngineMessage>("message", id);
      return letter && letter.accountId === session && letter.mailboxId === seedMailboxId
        && (domain ? domainOf(letter.from.address) === domain : senderKey(letter.from.address) === key)
        && mailboxes?.some((box) => box.id === letter.mailboxId && box.organizerChecked === true && box.status !== "disabled");
    });
    const wanted = FOLDER_OF_VIEW[dest];
    const { placeOf } = consentPartition(latest, options());
    const moving = eligible.filter((id) => placeOf.get(id) !== wanted);
    void moveInBatches(moving, wanted, (mutation) =>
      press.fileAndRefresh(engine.mutate(mutation)),
    ).then(({ moved, refused, waiting }) => {
      if (!ownsEngine()) return;
      const movedNotice = moved ? t("verdictMoved", { place: piles[dest], count: moved }) : null;
      const incompleteNotice = refused ? ohbox("pressPartlyRefused", { count: refused })
        : waiting ? ohbox("pressPartlyQueued", { count: waiting }) : null;
      if (originalMissing) {
        const outcome = incompleteNotice ?? movedNotice;
        report(outcome ? `${readerText("gone")} ${outcome}` : readerText("gone"));
        return;
      }
      if (movedNotice) report(movedNotice);
      if (incompleteNotice) report(incompleteNotice);
    });
  };

  if (audit) {
    const rows = sender.scopes[audit].messages.filter((letter) => letter.accountId === session);
    return <SenderAuditPanel state={{
      title: audit === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address),
      domain: audit === "domain",
      name: sender.name ?? undefined,
      rows,
    }} onClose={onClose} />;
  }
  if (subjectRule.sheet) return subjectRule.sheet;
  return <SenderMenu
    id={person.cardId}
    state={{ ...positionOf(person), messageId: message.id, address }}
    renderCard={(card, subjectRule, showAddress) => children(subjectRule, card, showAddress)}
    sender={sender}
    own={isOwnSubject(read, message.id, address, ownAddresses)}
    onClose={onClose}
    onChoose={choose}
    forecastFor={(dest, scope, makeRule, applyRetro) => {
      const current = readContact();
      return current ? forecast(current, dest, scope, makeRule, applyRetro) : null;
    }}
    rulesFor={(scope) => rulesInPlay({
      reader: read, placeOf: contact.placeOf, subject: sender.scopes[scope].messages,
      scope, match: ruleMatchOf(sender, scope),
    })}
    organizer={otherOrganizerOf(mailboxes, new Set(sender.messages.map((letter) => letter.mailboxId)))}
    autoUnsubscribe={disclosesUnsubscribe}
    lettersFor={(scope) => {
      const current = readContact();
      return current ? lettersFor(current, scope) : [];
    }}
    unsubscribeRecipientsFor={(scope) => {
      const current = readContact();
      return current ? recipientsFor(current, scope) : { ids: [], senders: 0 };
    }}
    mailboxNameOf={(id) => mailboxWord(id, "label")}
    stayedFor={stayedFor}
    onMoveToo={(ids, dest) => {
      moveStayed(ids, dest, "domain", sender.address, message.mailboxId);
      onClose();
    }}
    onOpenDetail={setAudit}
    onSubjectRule={subjectRule.available ? () => subjectRule.begin(person.anchor) : undefined}
  />;
}
