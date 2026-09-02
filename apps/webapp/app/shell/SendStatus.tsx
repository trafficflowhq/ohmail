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
   * HAS THIS SEND BEEN GOING LONG ENOUGH TO SAY SO? — see {@link SENDING_LONG_MS}.
   *
   * A send that is still running after four seconds is no longer described by "Sending your
   * message": the reader has already decided nothing is happening, and repeating the opening
   * sentence is what makes a working button look broken. The line changes to say the product
   * still knows about it.
   *
   * Armed from `send.since`, the stamp the phase carries, rather than from a mount: the same
   * component instance sits through a whole compose session, and a timer keyed on its lifetime
   * would fire once and then never again for the next send. Re-armed on every change of that
   * stamp and cleared on every other phase, so a send that finishes in 200 ms leaves no timer
   * and a second send starts its own clock.
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
         * TWO QUEUED STATES, TWO SENTENCES, AND THE DIFFERENCE IS WHO HAS THE MESSAGE.
         *
         * `accepted` is the send route's own answer: it reserved the send under this key and
         * stopped waiting for the submission at its attempt ceiling. The server HAS it, the
         * submission is still in flight, and this hook's retry driver is what will report the
         * outcome — so from the reader's side this is the SAME condition as a long send, and it
         * says so. Without the flag the request may never have arrived at all — a transport
         * rejection, an offline press — and the only honest line is that it has not gone yet.
         *
         * ── WHY NOT `statusAccepted` ─────────────────────────────────────────────────────────
         *
         * That string says "ohmail sends it on its next pass", and for an INTERACTIVE send there
         * is no such pass. Both of `claimDue`'s arms require `drafts.send_key` to be non-null
         * (and a `send_at` to compare), which a manual send has never had; and the arm that does
         * claim a row runs verify-by-Sent, which never re-submits. The sentence is true of a
         * SCHEDULED send and of nothing this state can produce, so it is not said here. The key
         * stays in the catalogue for the surface that can honestly use it.
         *
         * Branching on the flag rather than on the phase is still the point: telling a reader
         * their request may not have arrived when a committed reservation says it did is the same
         * false claim in the other direction, and it is one careless `else` away.
         */
        ? { tone: "pending", text: t(send.accepted === true ? "statusSendingLong" : "statusQueued") }
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
