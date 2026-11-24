"use client";

import { useLayoutEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { usePartition } from "@ohmail/app-logic/consent";
import { useEngine } from "@ohmail/app-logic/engine/context";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { otherOrganizerOf } from "@ohmail/app-logic/mail-state/mail-state";
import { browserOffline, queuedWaitOf } from "@ohmail/app-logic/press/queued-sentence";
import { rulesPostureOf } from "@ohmail/app-logic/press/rules-posture";
import { isOwnSubject, senderScreening, worstStatus, type ScreeningDest } from "@ohmail/app-logic/press/sender-screening";
import {
  MAX_SUBJECT_TERM_CHARS,
  planSubjectRule,
  subjectRuleContext,
  subjectOrganizerMissing,
  subjectRuleToast,
  type SubjectRuleContext,
  type TermField,
} from "@ohmail/app-logic/press/subject-rule";
import { confirmedSyncEngine, mirrorOwnerOf } from "@ohmail/app-logic/session/sync-scheduler";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { usePress, useReport, useScopeHere } from "@ohmail/app/frame";
import type { SubjectRulePartProps } from "@ohmail/app/screener";
import { ruleKeyOf } from "@ohmail/client-engine";
import { MenuItem, cssRect } from "@ohmail/ui/base";
import type { EngineMessage } from "@ohmail/wire";
import { SenderAuditPanel } from "../../screening/SenderAuditPanel";
import { usePileNames } from "../../shell/decision-copy";
import { SubjectRuleSheet, type SubjectRuleState } from "../../screening/SubjectRuleSheet";

interface SubjectInvocation {
  readonly state: SubjectRuleState;
  readonly mailboxId: string;
  readonly authority: string;
  readonly nobody: boolean;
  readonly context: SubjectRuleContext;
  readonly owner: ReturnType<typeof useEngine>;
}

type SubjectEntry = Pick<SubjectRulePartProps,
  "messageId" | "senderAddress" | "eligible" | "open" | "onOpen" | "onClose" | "onBack"
>;

export function useWebSubjectRule(
  { messageId, senderAddress, eligible, open, onOpen, onClose, onBack }: SubjectEntry,
  from: "held" | "letter",
) {
  const engine = useEngine();
  const scope = useScopeHere();
  const report = useReport();
  const { mutateSetAndReport } = usePress();
  const { ownAddresses } = usePartition();
  const { mailboxes, rosterProbed } = useMailState();
  const t = useTranslations("screening");
  const refused = useTranslations("ohbox.whyRefused");
  const piles = usePileNames();
  const invocation = useRef<SubjectInvocation | null>(null);
  const receipt = useRef<SubjectInvocation | null>(null);

  useLayoutEffect(() => () => {
    invocation.current = null;
    receipt.current = null;
  }, [engine, scope]);

  const ownsEngine = () => scope !== null && mirrorOwnerOf(engine) === scope && confirmedSyncEngine(engine) === engine;
  const liveSeed = () => {
    if (!eligible || !rosterProbed || !ownsEngine()) return null;
    const read = engine.read();
    const message = read.get<EngineMessage>("message", messageId);
    if (!message || message.accountId !== scope
      || (from === "held" && message.folder !== "ohmail/Screener")
      || message.from.address.trim().toLowerCase() !== senderAddress.trim().toLowerCase()
      || isOwnSubject(read, messageId, undefined, ownAddresses)) return null;
    const mailbox = mailboxes?.find((box) => box.id === message.mailboxId);
    // The browser maps an absent role to organizer for old servers. The roster must
    // also say that this mailbox's role has actually been checked.
    if (mailbox?.organizerChecked !== true || mailbox.status === "disabled") return null;
    const posture = rulesPostureOf([mailbox]);
    const { mode } = posture;
    const writable = mode === "organizer" || mode === "pending";
    if (!writable && from === "held") return null;
    const holder = mailbox.organizedBy;
    const authority = JSON.stringify([mode, holder?.kind, holder?.name, holder?.since]);
    return { message, authority, writable, posture };
  };
  const nobody = (context: SubjectRuleContext) => otherOrganizerOf(
    mailboxes, new Set(context.messages.map((message) => message.mailboxId)),
  )?.nobody === true;

  const close = () => {
    invocation.current = null;
    onClose();
  };
  const back = onBack ? () => {
    invocation.current = null;
    onBack();
  } : close;
  const begin = (anchor: Element | null) => {
    const seed = liveSeed();
    const context = seed && subjectRuleContext(engine.read(), messageId, engine.store);
    const rect = anchor ? cssRect(anchor) : null;
    if (!seed || !context || !rect) return;
    receipt.current = null;
    invocation.current = {
      state: { messageId, x: rect.left, y: rect.bottom, anchorTop: rect.top, anchorBottom: rect.bottom },
      mailboxId: seed.message.mailboxId,
      authority: seed.authority,
      nobody: nobody(context),
      context,
      owner: engine,
    };
    onOpen();
  };

  const confirm = async (term: string, destination: ScreeningDest, field: TermField, applyRetro: boolean) => {
    const pressed = invocation.current;
    const seed = liveSeed();
    const current = seed && subjectRuleContext(engine.read(), messageId, engine.store);
    const length = term.trim().length;
    if (!open || !pressed || pressed.owner !== engine || !seed || !current
      || pressed.mailboxId !== seed.message.mailboxId || pressed.authority !== seed.authority
      || pressed.context.subject !== current.subject || pressed.nobody !== nobody(current)
      || length === 0 || length > MAX_SUBJECT_TERM_CHARS) {
      close();
      return;
    }

    if (!seed.writable) {
      report(seed.posture.mode === "blocked" && seed.posture.reason === "organizer_outdated"
        ? seed.posture.name ? refused("outdated", { name: seed.posture.name }) : refused("outdatedUnknown")
        : t(subjectOrganizerMissing));
      return;
    }

    const plan = planSubjectRule(current, term, destination, field, applyRetro);
    const shown = planSubjectRule(pressed.context, term, destination, field, applyRetro);
    // A changed match count, standing rule or set of visible moves needs a new confirmation.
    if (JSON.stringify(plan) !== JSON.stringify(shown)) {
      close();
      return;
    }
    // The standing rules above come from the mirror. A queued or in-flight press
    // for this key still owns the request, even if its optimistic row is visible elsewhere.
    if (engine.unsettledRulePresses().some(({ key }) => ruleKeyOf(key) === plan.ruleKey)) return;

    close();
    receipt.current = pressed;
    if (plan.already && plan.mutations.length > 0) {
      await mutateSetAndReport(plan.mutations, (count) =>
        t("subjectAlreadyFiled", { count, place: piles[destination] }),
      );
      return;
    }
    const results = await Promise.all(plan.ruleMutations.map((mutation) => engine.mutate(mutation)));
    if (receipt.current !== pressed || !ownsEngine()) return;

    const key = subjectRuleToast(plan, worstStatus(results), queuedWaitOf(results, browserOffline()));
    if (key === null) return;
    const values = { sender: displayAddress(current.address), place: piles[destination], count: plan.matched, term: plan.term };
    report(t(key === "subjectRuled" && field === "body" ? "subjectRuledBody" : key, values));
  };

  const seed = liveSeed();
  const pressed = invocation.current;
  const sheet = open && pressed && seed && pressed.owner === engine && pressed.mailboxId === seed.message.mailboxId ? (
    <SubjectRuleSheet
      state={pressed.state}
      ctx={pressed.context}
      nobody={pressed.nobody}
      onClose={close}
      onBack={back}
      onConfirm={confirm}
    />
  ) : null;
  return { available: seed !== null, begin, sheet, ownsEngine };
}

export function WebScreenerSubjectRule({
  messageId, senderAddress, anchor, eligible, cardOpen, domainScope, auditOpen, onAudit, open, onOpen, onClose, onBack, children,
}: SubjectRulePartProps) {
  const engine = useEngine();
  const scope = useScopeHere();
  const t = useTranslations("screening");
  const { available, begin, sheet, ownsEngine } = useWebSubjectRule(
    { messageId, senderAddress, eligible, open, onOpen, onClose, onBack }, "held",
  );
  const screening = (cardOpen || auditOpen) && ownsEngine()
    ? senderScreening(engine.read(), messageId)
    : null;
  const audited = screening?.scopes[domainScope ? "domain" : "sender"].messages
    .filter((message) => message.accountId === scope);
  return (
    <>
      {children({
        subject: available ? <MenuItem icon="plus" onPress={() => begin(anchor.current)}>{t("cardSubject")}</MenuItem> : undefined,
        seeAll: audited?.length ? onAudit : undefined,
      })}
      {auditOpen && audited ? (
        <SenderAuditPanel
          onClose={onClose}
          onBack={onBack}
          state={{
            title: domainScope ? displayDomainLabel(senderAddress) : displayAddress(senderAddress),
            domain: domainScope,
            name: screening?.name ?? undefined,
            rows: audited,
          }}
        />
      ) : null}
      {sheet}
    </>
  );
}
