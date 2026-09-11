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
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SENDING_LONG_MS, type SendState } from "./mail-send";

type Tone = "pending" | "warn" | "error";

export function SendStatus({
  send,
  scope,
}: {
  send: SendState;
  scope: "reply" | "compose";
}) {
  const t = useTranslations(scope);

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

  const line: { tone: Tone; text: string } | null =
    send.phase === "sending"
      ? { tone: "pending", text: t(longAt ? "statusSendingLong" : "statusSending") }
      : send.phase === "queued"
        /**
         * Two queued states, two sentences — the difference is who has the message. `accepted` is the
         * send route's own answer: reserved under this key, submission still in flight, the retry driver
         * will report the outcome — from the reader's side the same condition as a long send, and it says
         * so. Without the flag the request may never have arrived (a transport rejection, an offline
         * press) and the only honest line is that it has not gone yet. Not `statusAccepted`: that string
         * says "ohmail sends it on its next pass", and for an interactive send there is no such pass —
         * both of `claimDue`'s arms require a non-null `drafts.send_key`, which a manual send has never
         * had. The key stays in the catalogue for the surface that can honestly use it.
         */
        ? { tone: "pending", text: t(send.accepted === true ? "statusSendingLong" : "statusQueued") }
        : send.phase === "unverified"
          ? { tone: "warn", text: t("statusUnverified") }
          : send.phase === "failed"
            /**
             * Every refusal gets the product's own words — the wire never renders. `statusFailed` used to quote the
             * server, which shipped "Nicht gesendet: authentication required" — the API middleware's English 401 text
             * inside a German UI (owner report 2026-08-21). A protocol sentence names the machine's state, not the
             * reader's next move; the failed line now says the one thing true of every refusal — the draft is kept
             * and Send is the retry — with the server's text kept in `send.reason` for diagnostics.
             * `mailbox_disabled` keeps its own sentence (a state with a control on the same screen), branched on the
             * CODE so a reworded server message cannot change which sentence renders. "Sign in" is deliberately not
             * said: one send's 401 cannot tell a deploy blip from a revocation — the SyncBar owns that claim.
             */
            ? send.code === "mailbox_disabled"
              ? { tone: "error", text: t("statusMailboxDisabled") }
              : { tone: "error", text: t("statusFailed") }
            : send.phase === "duplicate"
              /**
               * The server already has this message — three facts, three sentences. `warn`, not `error`:
               * nothing went wrong, the server declined to send a second copy. The branch is on `firstSend`, a
               * FACT from the server, because the three cases differ in what is true of the recipient's inbox:
               * `sent` means a copy is demonstrably out there, `unverified` means nobody knows and the Sent
               * folder is the place to look, `pending` means it is leaving now — "already sent" in the second
               * case would claim a delivery this product cannot prove. ABSENT falls through to the general
               * sentence, not a guess: a newer server may name a state this build has not heard of, and what is
               * true of all of them is that this press sent nothing.
               */
              ? {
                tone: "warn",
                text: t(
                  send.firstSend === "sent"
                    ? "statusDuplicateSent"
                    : send.firstSend === "unverified"
                      ? "statusDuplicateUnverified"
                      : send.firstSend === "pending"
                        ? "statusDuplicatePending"
                        : "statusDuplicate",
                ),
              }
              : null;

  if (!line) return null;
  return (
    <p className={`send-status ${line.tone}`} role="status" aria-live="polite">
      {line.text}
    </p>
  );
}
