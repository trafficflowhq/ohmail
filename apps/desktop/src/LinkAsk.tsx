/**
 * THE ASK BEFORE A MARKED LINK OPENS, ON THE DESKTOP. A message link whose label names another site
 * (`markElsewhere` in `MessageBody.tsx`) reaches the shell's new-window door like any other; the
 * shell holds the person's press and hands this window a token and the address (`link:ask`). The
 * window names where the link goes, outside the letter, where its styles cannot reach. Open sends
 * the token back (`link_ask_open`) and the shell opens what it holds; Cancel and Escape send nothing.
 * The window never names an address to the shell.
 */
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Button, useOptionalToast } from "@ohmail/ui";
import { COPY } from "../../webapp/app/components/MessageBody";
import { useModalGate } from "../../webapp/app/shell/modal-gate";
import { linkAskOpen, type LinkAsk as HeldPress } from "./native.js";

const TITLE_ID = "link-ask-title";
const BODY_ID = "link-ask-body";

/** The ask over whichever screen the gate shows. The layer claims the window while it is up. */
export function LinkAsk({ ask, onClose }: { ask: HeldPress; onClose: () => void }) {
  const toast = useOptionalToast();
  const layer = useRef<HTMLDivElement | null>(null);
  useModalGate(true);
  /* Everything beside the layer, up to the body, is inert while it is up, and the focus goes back
     where it stood when it closes; it starts on Cancel, the answer that does nothing. */
  useLayoutEffect(() => {
    const stood = document.activeElement;
    const held: Array<[Element, boolean]> = [];
    for (let at: HTMLElement | null = layer.current; at && at !== document.body; at = at.parentElement) {
      for (const sib of Array.from(at.parentElement?.children ?? [])) {
        if (sib === at) continue;
        held.push([sib, sib.hasAttribute("inert")]);
        sib.setAttribute("inert", "");
      }
    }
    layer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      for (const [el, was] of held) if (!was) el.removeAttribute("inert");
      if (stood instanceof HTMLElement && stood !== document.body && stood.isConnected) stood.focus();
    };
  }, []);
  const host = new URL(ask.url).hostname;
  const open = (): void => {
    onClose();
    linkAskOpen(ask.token).catch(() => toast?.(COPY.linkAskGone));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  return (
    <div
      ref={layer}
      className="session-end link-ask"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={BODY_ID}
      onKeyDown={onKeyDown}
    >
      <div className="gate-card">
        <h1 id={TITLE_ID}>{COPY.linkAskTitle}</h1>
        <p id={BODY_ID}>{COPY.linkAskElsewhere} {COPY.linkAskGoes(host)}</p>
        <p className="link-ask-url">{ask.url}</p>
        <div className="gate-actions">
          <Button onClick={onClose}>{COPY.linkAskCancel}</Button>
          <Button variant="primary" onClick={open}>{COPY.linkAskOpen(host)}</Button>
        </div>
      </div>
    </div>
  );
}
