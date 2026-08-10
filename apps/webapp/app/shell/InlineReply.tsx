"use client";

/**
 * REPLYING INSIDE THE MESSAGE.
 *
 * Three requirements that are really one: a reply belongs inside the message it answers.
 * Compose opened a dialog the keyboard could not leave; it took the message off the screen at
 * the moment you started answering it; and the conversation has to stay scrollable while you
 * write.
 *
 * Reply used to navigate `#/ohbox` → `#/compose`: the message you were answering left the
 * screen at the exact moment you started answering it. This renders inside
 * `<article class="msg">`, so the subject, the sender line and the body stay exactly where
 * they were and the editor opens underneath them.
 *
 * ── THE CONVERSATION IS ABOVE IT, AND IT IS NOT THIS COMPONENT'S ────────────────────────
 *
 * And the editor must not repeat the message that is already on screen.
 *
 * This used to render a `.reply-context` scroller of its own — the whole conversation,
 * oldest first, 190px tall, including the message being answered. `MessagePane` stood its
 * own copy down while that was up, so the LIST was never doubled; the focused message's body
 * was, once as the pane's `.msg-body` and once inside the quote. The reader got the same mail
 * twice in one scrolling column and had to scroll past a duplicate to reach the textarea.
 *
 * So the ownership inverted: the pane keeps the conversation in full message anatomy and
 * this is head + textarea + actions + status, scrolled into view on open. "Scroll through
 * the actual email conversation" is answered by the actual conversation — which is what the
 * request said — rather than by a quote of it in a nested scroller.
 *
 * NOTHING ABOUT THE PAYLOAD CHANGED. Sending was, and is, `{inReplyTo, body}` with `body`
 * exactly what was typed (`http-adapter.ts` `mailSend`). There has never been a quoted
 * original in outgoing mail and this slice did not add one: the parent's text in the payload
 * is how a `no_forward` message's redacted body would leave the account, and sensitive mail is
 * never forwarded.
 * What the editor shows and what it sends are two different questions, and only the first
 * one moved.
 *
 * The draft is kept in `localStorage`, per message: this is the client's own scratch
 * buffer, not an IMAP draft. Server-side drafts are a later phase and belong on the mailbox
 * itself; nothing here claims they already exist.
 */
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { Button, Kbd } from "@ohmail/ui";
import { rowAddress, senderName } from "./format";
import { canSend, type SendState } from "./mail-send";
import { RichEditor } from "./RichEditor";
import type { RichValue } from "./rich-text";
import type { DraftReplyControl, DraftedReply } from "./draft-reply";
import { SendStatus } from "./SendStatus";
import { useMailboxFacts } from "./MailStateProvider";
import { optionsFromFacts, replyRecipients, resolveReplyFrom } from "./compose-from";

/*
 * The scratch-buffer helpers and `canSend` used to live here and now live in `mail-send.ts`,
 * with the send machine that consumes them — clearing the buffer is part of what "the send
 * landed" means, and `canSend` is shared with Compose. Keeping them here while
 * `mail-send.ts` imported them would also have made a real import cycle out of what used to
 * be a type-only one.
 */

/**
 * What the shell hands the editor about a drafted reply: the control that buys one, and the
 * one that has arrived and has not been placed yet.
 *
 * `pending` is separate from the control's own phases on purpose. The purchase is FINISHED by
 * then — the action is spent and the text exists — and what is left is a question about the
 * editor's contents that only the person typing in it can answer. Folding it into the control
 * would put "you already wrote something" on the same axis as "this costs one AI action",
 * where a cancel would read as cancelling a spend that has already happened.
 */
export interface DraftReplyChrome {
  control: DraftReplyControl;
  /** A draft that arrived into an editor that already had text, and the message it answers. */
  pending: { draft: DraftedReply; messageId: string } | null;
  /** Place it. `replace` drops what was typed; `append` puts the draft below it. */
  resolve: (mode: "replace" | "append") => void;
}

export function InlineReply({
  message,
  value,
  send = { phase: "idle" },
  onChange,
  onClose,
  onSend,
  draftReply,
}: {
  message: EngineMessage;
  /**
   * BOTH HALVES — the markup and the plain rendering of it. `text` is what `canSend` judges
   * and what the optimistic row shows; `html` is what goes on the wire when there is any.
   * See `rich-text.ts`, which owns the storage rules for the same pair.
   */
  value: RichValue;
  /** How the send is going — see `mail-send.ts`. Defaults to idle for panes with no shell. */
  send?: SendState;
  onChange: (next: RichValue) => void;
  onClose: () => void;
  onSend: () => void;
  /**
   * THE AI DRAFTER'S OFFER, rendered above the editor the draft lands in.
   *
   * Deliberately not a modal. Compose was moved out of a dialog because the keyboard could
   * not leave it, and a purchase confirmation is exactly the shape that would put one back —
   * over the message being answered, at the moment of answering it. It is also where it
   * belongs: what is being bought is text for THIS editor, so the price and the destination
   * are on screen together and cancelling leaves the half-written reply untouched.
   *
   * Optional, because this component is mounted bare in more than one harness and in the
   * desktop shell, where there is no drafter to offer.
   */
  draftReply?: DraftReplyChrome;
}) {
  const t = useTranslations("reply");
  const box = useRef<HTMLDivElement>(null);

  /**
   * WHICH ADDRESS IS ANSWERING.
   *
   * A reply goes out from the mailbox the message ARRIVED in — `Engine.enrich` has always
   * derived that from the parent (`engine.ts:671`) and this slice does not change it. What it
   * changes is that the editor now says so, and that the one case where the default is not
   * available is stated instead of discovered afterwards.
   *
   * The SAME pure call `AppShell.sendReply` makes, over the same options, so the sentence below
   * and the id on the wire are one decision. `resolveReplyFrom` returns nothing at all when the
   * facts cannot be seen (Desktop, demo, a pane mounted with no provider) — and no line is
   * rendered then, because a From line is a claim.
   *
   * THE MIRROR'S `"mailbox"` ENTITIES ARE DELIBERATELY NOT CONSULTED HERE, though Compose does
   * use them. Reading them needs `useEngine()`, which throws outside an `EngineProvider`, and
   * this component is mounted bare in more than one harness. The trade is honest rather than
   * merely convenient: the fixture rows carry no status, so on the demo and the Desktop they
   * could only ever repeat the parent's own mailbox — the substitution, which is the whole
   * reason this line is worth rendering on a reply, is a fact only `GET /mailboxes` holds.
   */
  const facts = useMailboxFacts();
  const options = facts ? optionsFromFacts(facts) : [];
  const from = resolveReplyFrom(options, message.mailboxId);

  /**
   * WHO THIS IS ADDRESSED TO. `enrich` answers `[parent.from]` by default, which is yourself on
   * a message you sent — so on a self-authored message (a thread you started, or your own turn
   * in one) the head would read "To: <you>" while the wire, corrected in `AppShell.sendReply`,
   * goes to the correspondent. `replyRecipients` closes that gap here so the head names the same
   * recipient the send carries; it returns `null` for the ordinary case and when the facts are
   * unreadable, and then the head falls back to the sender exactly as before.
   */
  const recipients = replyRecipients(message, options.map((o) => o.address));
  const target = recipients?.[0] ?? null;
  const toName = target ? target.name ?? target.address : senderName(message);
  const toAddr = target
    ? (target.name && target.name !== target.address ? target.address : undefined)
    : rowAddress(message);

  /**
   * BRING THE EDITOR TO THE READER.
   *
   * The conversation above is no longer a bounded 190px quote — it is the real thread, as
   * tall as it is, inside the column that scrolls (`.read-col` / `.reader`; the conversation
   * deliberately has no scroller of its own, see `app.css`). On a deep thread the editor can
   * therefore open below the fold, and an editor nobody can see is the compose dialog's
   * failure wearing different clothes.
   *
   * `focus()` alone already scrolls in a browser, which is exactly why the scroll is stated
   * separately: that is a side effect of focusing rather than an intent, and what it brings
   * into view is the CARET — so a tall editor could arrive with its head and its `to` line
   * still above the fold. The BOX is scrolled, `block: "nearest"`, so a column that is
   * already showing it does not jump.
   *
   * `scrollIntoView` is optional-chained on the METHOD, not only the node: jsdom does not
   * implement it (see `body-open.test.ts`, which stubs it for the views that call it
   * unguarded), and the suites that drive the whole shell must not have to patch the DOM in
   * order to open a reply editor.
   *
   * THE FOCUS IS THE EDITOR'S OWN JOB NOW, and the `key` below is what makes that correct.
   * `RichEditor` focuses on mount when `autoFocus` is set, and keying it on the message id
   * remounts it when the pane swaps to a different message — which is also what gives the new
   * message its own empty document rather than the previous one's, and its own undo history.
   * Reaching in through the editor handle instead would race: `immediatelyRender: false` means
   * there is no editor at all during the commit this effect runs in.
   */
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
  }, [message.id]);

  const inFlight = send.phase === "sending" || send.phase === "queued";
  // LOCKED, not merely styled: `disabled` is what stops a second key being minted. Shared
  // with the state machine — see `canSend`. The mutation it judges is the one this editor
  // would send, so the button and the machine cannot reach different verdicts; a reply needs
  // no recipient of its own (`enrich` derives it from the parent), which is why `inReplyTo`
  // and `body` are the whole shape here.
  // `body: value.text` and not the markup: `canSend` refuses an empty body, and an empty
  // ProseMirror document is `<p></p>` — four characters that would light Send up on a reply
  // nobody has written. The plain rendering is the only half that answers "is there anything
  // here", which is the same rule `isRichEmpty` states.
  const locked = !canSend(send, { kind: "mail_send", inReplyTo: message.id, body: value.text });

  return (
    <div className="reply" data-reply-for={message.id} ref={box}>
      <div className="reply-head">
        <b>{t("to", { name: toName })}</b>
        {/* Only when it adds something — see `rowAddress`. */}
        {toAddr ? <small>{toAddr}</small> : null}
      </div>

      {/* FROM, and the substitution said out loud. Static text, never a control: a
          reply has a right answer — the address the sender wrote to — and offering to change it
          here is a different feature from being able to SEE it. */}
      {from.address !== null ? (
        <p className="reply-from">
          <span>{t("from", { address: from.address })}</span>
          {from.substituted ? (
            <span className="reply-from-sub">
              {from.substitutedFrom
                ? t("fromSubstituted", { was: from.substitutedFrom })
                : t("fromSubstitutedUnknown")}
            </span>
          ) : null}
        </p>
      ) : null}

      {draftReply ? <DraftReplyCard chrome={draftReply} messageId={message.id} /> : null}

      {/* NO QUOTED CONTEXT HERE. It was a `.reply-context` scroller between the head and the
          editor; the conversation it held is the pane's, above — see the header.

          KEYED ON THE MESSAGE. ProseMirror owns a document, a selection and an undo history,
          and none of the three belongs to the next message the pane swaps to. The key is also
          what makes `autoFocus` mean "focus the reply you just opened" rather than "focus the
          first reply ever opened in this pane". */}
      <RichEditor
        key={message.id}
        className="reply-editor"
        ariaLabel={t("editorAria")}
        placeholder={t("placeholder")}
        autoFocus
        value={value}
        /* The text is never taken away from the author, not even mid-send: a failed send
           whose draft had been cleared would be a reply the user has to write twice. It stops
           taking INPUT, which is the textarea's `readOnly` this replaces. */
        editable={!inFlight}
        onChange={onChange}
      />

      <div className="reply-actions">
        <Button
          variant="primary"
          disabled={locked}
          aria-busy={send.phase === "sending" || undefined}
          onClick={() => onSend()}
        >
          {send.phase === "sending" ? t("sending") : t("send")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
        <span className="reply-hint">
          <Kbd>esc</Kbd> {t("hintEsc")}
        </span>
      </div>

      <SendStatus send={send} scope="reply" />
    </div>
  );
}

/**
 * THE DRAFTER'S CARD — the price before the spend, then the one question the spend leaves open.
 *
 * ── IT SAYS WHAT IT COSTS, IN THE UNIT THE PLAN IS SOLD IN ───────────────────────────────
 *
 * "1 AI action", never credits: credits are an internal ledger unit nobody is quoted a plan in.
 * The number is `DRAFT_REPLY_COST_ACTIONS`, which is what the route charges per accepted
 * request — not a figure derived from a balance this tab happens to be holding. Whether the
 * account can afford it is the server's decision and nothing here second-guesses it; a refusal
 * arrives as the server's own sentence and is rendered verbatim (`draft-reply.ts`).
 *
 * ── AND IT NEVER CLOBBERS WHAT SOMEBODY WROTE ────────────────────────────────────────────
 *
 * A draft landing in an empty editor is unambiguous and goes straight in. A draft landing on
 * top of a half-written reply is not, so it asks — replace, or add below — and the editor keeps
 * its text until the question is answered. There is no third option to dismiss the draft,
 * because the action has already been paid for by the time this appears and throwing the result
 * away behind a small button is not something to make easy.
 *
 * NOTHING HERE SENDS AND NOTHING HERE DISPATCHES A MUTATION. A generated draft is not an
 * answered message: the Reply Run's debt is discharged by a send settling and by nothing else
 * (`onSendSettled`), and that separation is the reason this card can only put text in a box.
 */
function DraftReplyCard({
  chrome,
  messageId,
}: {
  chrome: DraftReplyChrome;
  messageId: string;
}) {
  const t = useTranslations("draftReply");
  const { control, pending, resolve } = chrome;

  // The placement question wins when both could render: the purchase is over, and the offer
  // it came from has already closed itself.
  if (pending && pending.messageId === messageId) {
    return (
      <div className="dr-card" role="group" aria-label={t("replaceTitle")}>
        <b className="dr-title">{t("replaceTitle")}</b>
        <p className="dr-body">{t("replaceBody")}</p>
        <div className="dr-btns">
          <Button variant="primary" onClick={() => resolve("append")}>{t("append")}</Button>
          <Button onClick={() => resolve("replace")}>{t("replace")}</Button>
        </div>
      </div>
    );
  }

  // An offer belongs to the message it was opened on. Without this the card would follow the
  // reader to whatever message it was pointed at next, still quoting a price for the first one.
  if (control.phase === "closed" || control.messageId !== messageId) return null;

  const running = control.phase === "running";
  return (
    <div className="dr-card" role="group" aria-label={t("offerTitle")}>
      <b className="dr-title">{t("offerTitle")}</b>
      <p className="dr-body">{t("offerBody")}</p>
      <div className="dr-btns">
        <Button variant="primary" disabled={running} onClick={control.confirm}>
          {t("confirm")}
        </Button>
        <Button variant="ghost" disabled={running} onClick={control.cancel}>
          {t("cancel")}
        </Button>
      </div>
      {/* Whatever the server said, verbatim — an empty balance, a message the drafter is not
          allowed to read, no model connected on this deployment. Each is a different actionable
          fact and none of them is inferable from a status code. */}
      {control.notice ? (
        <p className="dr-note" role="status">{control.notice}</p>
      ) : null}
    </div>
  );
}
