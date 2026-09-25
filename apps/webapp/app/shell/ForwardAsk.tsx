"use client";

/**
 * THE FORWARD ASK — what the dock shows in place of the editor when a `no_forward` message is
 * forwarded (`forwardPress`): one sentence saying why ohmail flagged it, then the question once.
 * Confirm opens the editor and the send carries `forwardConfirmed`; Cancel closes the dock. Focus
 * starts on Cancel, the answer that sends nothing.
 */
import { useEffect, useId, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import type { ForwardAsk } from "@ohmail/client-engine";

export function ForwardAskStrip({ ask, onConfirm, onCancel }: {
  ask: ForwardAsk;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("reply.forwardAsk");
  const whyId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLButtonElement>("[data-ask-cancel]")?.focus(); }, []);
  return (
    <div ref={box} className="reply reply-ask" role="alertdialog" aria-label={t("question")} aria-describedby={whyId}>
      <p className="reply-forwarding" id={whyId}>{t(ask)}</p>
      <div className="reply-actions">
        <Button variant="primary" onClick={onConfirm}>{t("confirm")}</Button>
        <Button variant="ghost" data-ask-cancel="" onClick={onCancel}>{t("cancel")}</Button>
        <span className="reply-hint">{t("question")}</span>
      </div>
    </div>
  );
}
