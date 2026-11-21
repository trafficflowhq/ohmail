"use client";

/**
 * What a send that has not arrived says. One line, one component, both surfaces — a component
 * because the thing it gets right is not layout: `queued` and `unverified` are the two states a
 * hurried reader is most likely to take for a delivery, and the copy is written against that (one
 * says it has not gone yet, the other says we cannot tell); a second copy of that decision is a
 * second place to get it wrong. `role="status"` with `aria-live` because a send resolves out of
 * band — sometimes minutes later on a retry — and the outcome must reach a screen reader with
 * focus nowhere near it. `scope` picks the wording (a reply and a message are different nouns) and
 * nothing else.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatFileSize } from "@ohmail/ui/file-size";
import { SENDING_LONG_MS, type SendState, type ShowSend } from "@ohmail/app-logic/writing/mail-send";
import { sendLine, sendLineValuesOver, type SendTone } from "@ohmail/app-logic/writing/send-line";
import { activeFormatLocale } from "./locale";
import { readColumnHidden } from "@ohmail/app-logic/layout/narrow";

/** The reading column the layout hides below its breakpoint (app.css and zero-layout.css). */
const HIDABLE_COLUMN = ".view.split > .read-col";

/**
 * Can anyone see this line? The reading column renders at every width and is hidden by CSS alone,
 * so a line there counts only while the column stands. No element yet (an idle line) answers yes.
 */
export function lineSeen(el: Element | null): boolean {
  return el === null || !(readColumnHidden() && el.closest(HIDABLE_COLUMN) !== null);
}

/* The line a send state says is app-logic's (`writing/send-line.ts`); handed on under the names it always had here. */
export { sendLine, type SendTone };

/** A file's size in the person's language, as every line of the letter names one (the new screen's `size`). */
export function fileSize(bytes: number): string {
  return formatFileSize(bytes, activeFormatLocale());
}

/** The ceiling as the sentences name it, `{size}` in every line that takes one. */
export function sendLineValues(): { size: string } {
  return sendLineValuesOver(fileSize);
}

export function SendStatus({
  send,
  scope,
  lane,
  showing,
}: {
  send: SendState;
  scope: "reply" | "compose";
  /** The lane this line shows, registered while mounted (`MailSendApi.showing`); `null` with no shell. */
  lane: string | null;
  showing: ShowSend | null;
}) {
  const t = useTranslations(scope);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(
    () => (lane !== null && showing !== null ? showing(lane, () => lineSeen(line.current)) : undefined),
    [lane, showing],
  );

  /**
   * Has this send been going long enough to say so? — see {@link SENDING_LONG_MS}. After four
   * seconds "Sending your message" reads as a broken button; the line changes to say the product
   * still knows about it. Armed from `send.since`, the stamp the phase carries, rather than from a
   * mount: the same instance sits through a whole compose session, and a timer keyed on its
   * lifetime would fire once and never again for the next send. Re-armed on every change of that
   * stamp and cleared on every other phase, so a 200 ms send leaves no timer and a second send
   * starts its own clock.
   */
  const since = send.phase === "sending" ? send.since : undefined;
  const [longAt, setLongAt] = useState(false);
  useEffect(() => {
    if (since === undefined) {
      setLongAt(false);
      return;
    }
    const elapsed = Date.now() - since;
    if (elapsed >= SENDING_LONG_MS) {
      setLongAt(true);
      return;
    }
    setLongAt(false);
    const timer = setTimeout(() => setLongAt(true), SENDING_LONG_MS - elapsed);
    return () => clearTimeout(timer);
  }, [since]);

  const said = sendLine(send, longAt);
  if (!said) return null;
  return (
    <p ref={line} className={`send-status ${said.tone}`} role="status" aria-live="polite">
      {t(said.key, sendLineValues())}
    </p>
  );
}
