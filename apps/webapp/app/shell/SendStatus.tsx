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
import { formatFileSize } from "@ohmail/ui";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import { SENDING_LONG_MS, type SendState, type ShowSend } from "./mail-send";
import { activeFormatLocale } from "./locale";
import { readColumnHidden } from "./narrow";

/** The reading column the layout hides below its breakpoint (app.css and zero-layout.css). */
const HIDABLE_COLUMN = ".view.split > .read-col";

/**
 * Can anyone see this line? The reading column renders at every width and is hidden by CSS alone,
 * so a line there counts only while the column stands. No element yet (an idle line) answers yes.
 */
export function lineSeen(el: Element | null): boolean {
  return el === null || !(readColumnHidden() && el.closest(HIDABLE_COLUMN) !== null);
}

export type SendTone = "pending" | "warn" | "error";

/** The ceiling as the sentences name it, `{size}` in every line that takes one. */
export function sendLineValues(): { size: string } {
  return { size: formatFileSize(DRAFT_BODY_MAX_BYTES, activeFormatLocale()) };
}

/**
 * THE LINE A SEND STATE SAYS — the key within `reply` or `compose`, or `null`. One derivation for
 * the line under the editor and the shell's toast when no editor shows the lane, so the two can
 * never say different things about one send.
 */
export function sendLine(send: SendState, longAt: boolean): { tone: SendTone; key: string } | null {
  /* ANOTHER MESSAGE'S SEND HOLDS THE LANE (`composeStateOnScreen`): this one says only that it waits
     for it, never that other message's state. */
  if (send.previous === true) return { tone: "pending", key: "statusPreviousSending" };
  return (
    send.phase === "sending"
      ? { tone: "pending", key: longAt ? "statusSendingLong" : "statusSending" }
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
        ? { tone: "pending", key: send.accepted === true ? "statusSendingLong" : "statusQueued" }
        : send.phase === "unverified"
          ? { tone: "warn", key: "statusUnverified" }
          : send.phase === "failed"
            /**
             * Every refusal gets the product's own words — the wire never renders. `statusFailed` used to quote the
             * server, which shipped "Nicht gesendet: authentication required" — the API middleware's English 401 text
             * inside a German UI (owner report 2026-08-21). The failed line says the one thing true of every refusal —
             * the draft is kept and Send is the retry — with the server's text kept in `send.reason`. A named refusal
             * gets its own sentence, branched on the CODE so a reworded server message cannot change which renders.
             * The SESSION's "sign in" is never said: one send's 401 cannot tell a deploy blip from a revocation — the
             * SyncBar owns that claim. `mailbox_not_signed_in` is the server saying THIS MAILBOX has no sign-in here.
             */
            ? send.code === "mailbox_disabled"
              ? { tone: "error", key: "statusMailboxDisabled" }
              /* The person's mail server could not be reached at the dial: nothing left, draft kept. */
              : send.code === "send_unreachable"
                ? { tone: "error", key: "statusUnreachable" }
              /* It took the dial and would not serve it now, past the send's own retries: nothing left. */
              : send.code === "send_busy"
                ? { tone: "error", key: "statusBusy" }
              /* The mail server would not secure the connection, or refused the sign-in: nothing left. */
              : send.code === "send_not_secured"
                ? { tone: "error", key: "statusNotSecured" }
              : send.code === "send_login_refused"
                ? { tone: "error", key: "statusLoginRefused" }
              /* No sign-in for this mailbox here: the file's own sentence, and no Try again. */
              : send.code === "mailbox_not_signed_in"
                ? { tone: "error", key: "statusNotSignedIn" }
              : send.code === "forward_original_unavailable"
                ? { tone: "error", key: "statusForwardOriginalUnavailable" }
              /* A forward's kept files: an older server cannot leave any out, or the original's files changed. */
              : send.code === "forward_parts_unsupported"
                ? { tone: "error", key: "statusForwardPartsUnsupported" }
              : send.code === "forward_parts_changed"
                ? { tone: "error", key: "statusForwardPartsChanged" }
              /**
               * A FORWARD'S ORIGINAL THAT DID NOT READ BACK, and a dial that ran out of time. Each
               * reached a person as "Sending didn't work … Try again" (2026-10-19: a forwarded PDF
               * whose read the server cut short), which names neither what failed nor what helps.
               */
              : send.code === "attachment_part_mismatch"
                ? { tone: "error", key: "statusAttachmentMismatch" }
              : send.code === "forward_source_moved"
                ? { tone: "error", key: "statusForwardSourceMoved" }
              : send.code === "send_timeout"
                ? { tone: "error", key: "statusTimeout" }
              /* PAST THE DRAFT CEILING: the save was refused, so nothing left and the row holds
                 older words. Neither "kept" nor "Try again" is true until the text is shorter. */
              : send.code === "draft_too_large"
                ? { tone: "error", key: "statusTooLong" }
              : send.code === "payload_too_large"
                ? { tone: "error", key: "statusTooLarge" }
              /* THIS PAGE MAY NOT UPLOAD FILES THIS LARGE: nothing left, the draft is kept, and a
                 smaller set of files goes inline. */
              : send.code === "staging_refused"
                ? { tone: "error", key: "statusStagingRefused" }
              /**
               * ANOTHER WINDOW WROTE THIS DRAFT BETWEEN THE LAST SAVE AND THIS PRESS. `warn`, not
               * `error`: nothing failed and nothing left — the row simply is not the message this
               * screen was looking at, and sending it would have delivered somebody else's words.
               * The editor is untouched (only a confirmation spends it), so the words are still
               * here; pressing Send again writes them back and goes.
               */
              : send.code === "draft_changed"
                ? { tone: "warn", key: "statusDraftChanged" }
                /* The save before the send was refused: nothing went, and the row may not hold these
                   words, so this never says the draft is kept. */
                : send.code === "validation_failed" || send.code === "from_mailbox_unconfirmed"
                  ? { tone: "error", key: "statusNotSavedFirst" }
                /**
                 * THIS CLIENT COULD NOT SAVE THE DRAFT, so it cannot say which version would
                 * have gone — and it refuses rather than sending a row it never vouched for.
                 * `warn` for `draft_changed`'s reason and not `statusFailed`'s: nothing left
                 * and nothing is lost, the words are still in the editor, and the remedy is
                 * the press that is already on screen. Its own sentence because the reader's
                 * next move differs — nobody else wrote this draft, the save did not land.
                 */
                : send.code === "draft_unsaved"
                  ? { tone: "warn", key: "statusDraftUnsaved" }
                  : { tone: "error", key: "statusFailed" }
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
                key: send.firstSend === "sent"
                  ? "statusDuplicateSent"
                  : send.firstSend === "unverified"
                    ? "statusDuplicateUnverified"
                    : send.firstSend === "pending"
                      ? "statusDuplicatePending"
                      : "statusDuplicate",
              }
              : null);
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
