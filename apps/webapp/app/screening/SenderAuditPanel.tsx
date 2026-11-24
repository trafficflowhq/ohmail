"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { useFocusFollows } from "@ohmail/app-logic/keys/focus-follows";
import { Button } from "@ohmail/ui/base";
import { ContactCardHeader } from "@ohmail/ui/mail";
import type { EngineMessage } from "@ohmail/wire";
import { placeLabel } from "../shell/format";
import "../shell/sender-sheet.css";

export interface SenderAuditState {
  title: string;
  name?: string;
  domain: boolean;
  rows: readonly EngineMessage[];
}

export function SenderAuditPanel({ state, onClose, onBack }: {
  state: SenderAuditState;
  onClose: () => void;
  onBack?: () => void;
}) {
  const t = useTranslations("screening");
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);
  useFocusFollows(panelRef, { onEscape: onClose });

  return (
    <>
      <div className="sa-bg" onClick={onClose} />
      <div className="sa" ref={panelRef} role="dialog" aria-modal="true" aria-label={t("auditAria", { subject: state.title })}>
        <ContactCardHeader
          heading
          title={state.domain ? t("auditTitleDomain", { domain: state.title }) : (state.name || state.title)}
          note={t("scopeCountOne", { count: state.rows.length })}
          lead={
            <Button ref={closeRef} icon="back" kind="quiet" size="s"
              label={t(onBack ? "cardBack" : "auditClose")} onPress={onBack ?? onClose} />
          }
        />

        {state.rows.length === 0 ? (
          <p className="sa-empty">{t("auditEmpty")}</p>
        ) : (
          <ul className="sa-list">
            {state.rows.map((message) => (
              <li key={message.id}>
                <div className="sa-line"><b>{message.subject || t("auditNoSubject")}</b></div>
                <div className="sa-meta">
                  {message.date
                    ? t("auditPlaceWhen", { place: placeLabel(message.folder), when: message.date.slice(0, 10) })
                    : placeLabel(message.folder)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
