"use client";

/**
 * WHAT A SEND THAT HAS NOT ARRIVED SAYS.
 *
 * One line, one component, both surfaces. It exists as a component rather than as two blocks
 * of JSX because the thing it gets right is not layout — it is that `queued` and `unverified`
 * are the two states a hurried reader is most likely to take for a delivery, and the copy is
 * written against that: one says it has not gone yet, the other says we cannot tell. A second
 * copy of that decision, in Compose, is a second place for it to be got wrong.
 *
 * `role="status"` with `aria-live` because a send resolves out of band — sometimes minutes
 * later on a retry — so the outcome has to reach a screen reader without the focus being
 * anywhere near it.
 *
 * The `scope` picks the wording (a reply and a message are different nouns) and nothing else;
 * the tones, the element and the announcement are the same for both.
 */
import { useTranslations } from "next-intl";
import type { SendState } from "./mail-send";

type Tone = "pending" | "warn" | "error";

export function SendStatus({
  send,
  scope,
}: {
  send: SendState;
  scope: "reply" | "compose";
}) {
  const t = useTranslations(scope);
  const line: { tone: Tone; text: string } | null =
    send.phase === "sending"
      ? { tone: "pending", text: t("statusSending") }
      : send.phase === "queued"
        ? { tone: "pending", text: t("statusQueued") }
        : send.phase === "unverified"
          ? { tone: "warn", text: t("statusUnverified") }
          : send.phase === "failed"
            /**
             * EVERY REFUSAL GETS THE PRODUCT'S OWN WORDS — the wire never renders.
             *
             * `statusFailed` used to quote the server ("Not sent: {reason}"), on the theory that
             * the long tail of SMTP refusals is best relayed verbatim. What that shipped, to a
             * real subscriber, was "Nicht gesendet: authentication required" — the API
             * middleware's own 401 envelope text, in English, inside a German UI, during a
             * deploy blip (owner report 2026-08-21). A protocol sentence names the machine's
             * state, not the reader's next move. So the failed line now says the one thing that
             * is true of every refusal this component cannot name — the draft is kept
             * (`mail-send.ts`: "Text kept, Send live again") and the Send control beside this
             * line is the retry — and the server's text stays in `send.reason` for diagnostics.
             *
             * `mailbox_disabled` keeps its own sentence: a state with a control on the same
             * screen. The branch is on the CODE, not on the text, so a reworded server message
             * cannot silently change which sentence renders. And "sign in" is deliberately NOT
             * said here: a single send's 401 cannot tell a deploy blip from a revocation —
             * the SyncBar owns that claim, after `REFUSAL_SUSTAIN_MS` of re-made refusals.
             */
            ? send.code === "mailbox_disabled"
              ? { tone: "error", text: t("statusMailboxDisabled") }
              : { tone: "error", text: t("statusFailed") }
            : null;

  if (!line) return null;
  return (
    <p className={`send-status ${line.tone}`} role="status" aria-live="polite">
      {line.text}
    </p>
  );
}
