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
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type {
  AddressBookEntry,
  ComposeAttachment,
  EmailAddress,
  EngineMessage,
} from "@ohmail/client-engine";
import { Button, Kbd } from "@ohmail/ui";
import { ComposeAttach, composeAttachCap } from "../components/ComposeAttach";
import { rowAddress, senderName } from "./format";
import { displayAddress } from "./idn";
import { canSend, type SendState } from "./mail-send";
import { parseRecipients } from "./compose";
import { RichEditor } from "./RichEditor";
import type { RichValue } from "./rich-text";
import type { DraftReplyControl, DraftedReply } from "./draft-reply";
import { SendStatus } from "./SendStatus";
import { useMailboxFacts } from "./MailStateProvider";
import {
  formatRecipientLine,
  optionsFromFacts,
  replyAllRecipients,
  replyEnvelopeOnWire,
  replyEnvelopePlan,
  replyRecipients,
  resolveReplyFrom,
  type ReplyEnvelopeEdit,
} from "./compose-from";
import {
  RecipientField,
  focusMovedChip,
  gatedInvalid,
  moveRecipient,
  type RecipientMove,
  type RecipientRow,
} from "./RecipientField";

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
  replyAll = false,
  value,
  send = { phase: "idle" },
  onChange,
  onClose,
  onSend,
  draftReply,
  envelope = null,
  onEnvelope,
  book = [],
  fromId = null,
  onFrom,
  attachments = [],
  onAttachments,
}: {
  message: EngineMessage;
  /**
   * ANSWER EVERYONE ON THE MESSAGE, not the sender alone. The head then names the reply-all
   * envelope — `replyAllRecipients`, the same pure call `AppShell.sendReply` resolves for the
   * wire — so what the editor claims and what leaves the account are one decision. When that
   * call returns `null` (the audience degenerates to the plain reply's), the head AND the send
   * both fall back to the plain path, for the same reason from the same function.
   */
  replyAll?: boolean;
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
  /**
   * THE USER'S EDIT OF THE AUDIENCE, or `null` while the computed one stands — held by the
   * SHELL (like `replyBody`, and for the identical reason: `MessagePane` is mounted twice
   * while the reader is open, and two copies of who a reply goes to is how the visible head
   * and the sent envelope stop being one object). `null` means the head below renders the
   * computed audience and the wire carries the computed envelope, exactly as before this
   * field existed.
   */
  envelope?: ReplyEnvelopeEdit | null;
  /**
   * Report an edit. ABSENT means this surface has nowhere to keep one — the inert chrome, a
   * bare harness — and then the head stays a plain statement rather than a dead button.
   */
  onEnvelope?: (next: ReplyEnvelopeEdit) => void;
  /** `addressBook(reader)` for the recipient rows' suggestions. Empty where no mirror is. */
  book?: readonly AddressBookEntry[];
  /**
   * THE SENDER THE USER PICKED ON THIS REPLY, or `null` while the derived one stands — held by
   * the SHELL (like `envelope`, and for the identical reason: `MessagePane` is mounted twice while
   * the reader is open, and two copies of who a reply comes FROM is how the visible From line and
   * the sent `mailboxId` stop being one object). It feeds `resolveReplyFrom` here so the line and
   * the wire read one resolution, and it is per-message: the shell drops it when the editor
   * retargets, so a pick never rides to somebody else's mail.
   */
  fromId?: string | null;
  /**
   * Report a From pick. ABSENT means this surface cannot hold one — the inert chrome, a bare
   * harness, the desktop shell — and then the From line stays a plain statement rather than a
   * selector nothing is listening to, exactly as before this field existed.
   */
  onFrom?: (mailboxId: string) => void;
  /**
   * FILES TO RIDE THE SEND — held by the SHELL beside the reply body (mounted-twice again) and
   * carried onto the `mail_send` mutation, never into the `localStorage` reply scratch: the bytes
   * are zero-at-rest exactly as compose's are (`ComposeAttachment`). Empty on a plain reply.
   */
  attachments?: readonly ComposeAttachment[];
  /**
   * Report an attachment-list change. ABSENT means this surface has nowhere to keep files — the
   * inert chrome and every provider-less mount — and then no attach control is rendered at all,
   * rather than a dead one.
   */
  onAttachments?: (next: ComposeAttachment[]) => void;
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
  const from = resolveReplyFrom(options, message.mailboxId, fromId ?? null);
  // `useId`, not a static id: this editor is mounted twice while the reader is open, and a
  // duplicate `id`/`for` pair would tie the label to whichever select the document walked to first.
  const fromSelectId = useId();

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
  // The head names people; the ENVELOPE is `recipients` itself, which `AppShell.sendReply` reads
  // and which is never touched here. So the two lines below are decoded for display (`idn.ts`) and
  // the comparison that decides whether the address adds anything stays on the stored strings.
  const toName = target ? target.name ?? displayAddress(target.address) : senderName(message);
  const toAddr = target
    ? (target.name && target.name !== target.address ? displayAddress(target.address) : undefined)
    : rowAddress(message);

  /**
   * THE REPLY-ALL ENVELOPE, when this editor was opened as one — see the `replyAll` prop. The
   * same options feed it that feed the plain head above, so both heads and the wire read one
   * set of facts. `null` (a 1:1 message, or an audience the facts cannot enlarge) falls back
   * to the plain head below rather than claiming an "all" that is one person.
   */
  const all = replyAll ? replyAllRecipients(message, options.map((o) => o.address)) : null;
  const nameOf = (r: { name: string | null; address: string }): string =>
    r.name ?? displayAddress(r.address);

  /**
   * THE AUDIENCE IS ALWAYS EDITABLE. The head that names it is a BUTTON, and pressing it
   * turns the computed audience into three editable recipient rows (To, Cc, Bcc — the same
   * chip field every compose surface uses), prefilled with EXACTLY what the head claimed:
   * `formatRecipientLine` over the same `all`/`recipients` the sentences above rendered.
   * From that press on the user's strings are the envelope (`replyEnvelopePlan`), free-form —
   * remove the sender, add a Cc, blind-copy somebody; a reply's computed audience is a
   * default, not a cage.
   *
   * Untouched (`envelope === null`), NOTHING changed: the head renders as before and the
   * wire carries the computed envelope byte-for-byte — `inline-reply.test.ts` pins the
   * mutation's exact key set for that case.
   */
  const expand = onEnvelope === undefined
    ? undefined
    : (): void => {
        const to = all ? all.to : recipients ?? [message.from];
        // The trailing separator is what makes every prefilled entry a CHIP rather than text
        // sitting in the input — `splitRecipients` reads the final segment as the tail being
        // typed, and a prefill is settled, not half-typed.
        const asChips = (list: readonly EmailAddress[]): string => {
          const line = formatRecipientLine(list);
          return line === "" ? "" : `${line}, `;
        };
        onEnvelope({ to: asChips(to), cc: asChips(all ? all.cc : []), bcc: "" });
      };

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
   * still above the fold. The BOX is scrolled `block: "end"`, so it is the editor's BOTTOM edge
   * — the Send/Cancel actions row — that lands on screen, not merely its nearest edge (which on
   * a tall editor was its head, leaving the actions still below the fold). This is the
   * narrow-viewport and reader-overlay path; at split width with room the dock is sticky
   * (`reader.css`) and the editor never leaves the screen to begin with.
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
    box.current?.scrollIntoView?.({ block: "end" });
  }, [message.id]);

  const inFlight = send.phase === "sending" || send.phase === "queued";
  // LOCKED, not merely styled: `disabled` is what stops a second key being minted. Shared
  // with the state machine — see `canSend`. The mutation it judges carries the SAME envelope
  // fields `AppShell.sendReply` will put on the wire (`replyEnvelopePlan` over the same
  // options and the same edit — one derivation, two consumers), so the button and the machine
  // cannot reach different verdicts; an untouched reply still judges `{inReplyTo, body}` plus
  // the computed audience, which `canSend`'s reply branch never refuses when non-empty.
  // `body: value.text` and not the markup: `canSend` refuses an empty body, and an empty
  // ProseMirror document is `<p></p>` — four characters that would light Send up on a reply
  // nobody has written. The plain rendering is the only half that answers "is there anything
  // here", which is the same rule `isRichEmpty` states.
  const envPlan = replyEnvelopePlan(message, options.map((o) => o.address), replyAll, envelope);
  const locked = !canSend(send, {
    kind: "mail_send",
    inReplyTo: message.id,
    body: value.text,
    ...replyEnvelopeOnWire(envPlan),
  });

  /** The head's own sentence — shared by the static head and the button that opens the edit. */
  const headContent = all ? (
    <>
      <b>{t("toAll", { names: all.to.map(nameOf).join(", ") })}</b>
      {/* The Cc line, only when the envelope carries one — an empty "Cc" is a claim. */}
      {all.cc.length > 0 ? <small>{t("ccLine", { names: all.cc.map(nameOf).join(", ") })}</small> : null}
    </>
  ) : (
    <>
      <b>{t("to", { name: toName })}</b>
      {/* Only when it adds something — see `rowAddress`. */}
      {toAddr ? <small>{toAddr}</small> : null}
    </>
  );

  return (
    <div className="reply" data-reply-for={message.id} ref={box}>
      {envelope !== null && onEnvelope ? (
        <ReplyRecipients
          envelope={envelope}
          onEnvelope={onEnvelope}
          book={book}
          disabled={inFlight}
        />
      ) : expand ? (
        // The head IS the way in: pressing the audience opens it for editing. A button and
        // not a div-with-onClick, because "recipients always editable" has to be true from
        // the keyboard too. The hint is part of the accessible name, so a screen reader
        // hears what pressing does rather than only whom the reply addresses.
        <button type="button" className="reply-head reply-head-btn" onClick={expand} disabled={inFlight}>
          {headContent}
          <span className="reply-head-edit">{t("editRecipients")}</span>
        </button>
      ) : (
        <div className="reply-head">{headContent}</div>
      )}

      {/* FROM — a CONTROL when there is a choice, otherwise the sentence. This used to be static
          text on the premise that a reply's sender is a fact and not a choice; it is now editable
          when the account genuinely has one.
          A reply still has a right answer (the address the sender wrote to), so the derived one
          LEADS: the selector is offered only when the account has more than one sendable address
          AND the shell can hold a pick (`onFrom`). One address, or a surface that cannot keep an
          override, renders the plain statement; no facts renders nothing, because a From line is a
          claim.

          A PICK AND THE SUBSTITUTION NOTICE ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION. An honored
          pick makes `from.substituted` false (`resolveReplyFrom`), so choosing an address is what
          silences the "answers from the address above" line — the selector's value becomes the
          statement the sentence used to make, and re-announcing it as a substitution would be
          claiming the user was overruled when they were obeyed. */}
      {from.address !== null ? (
        <p className="reply-from">
          {onFrom && from.choices.length > 1 ? (
            <span className="reply-from-pick">
              <label htmlFor={fromSelectId} className="reply-from-label">{t("fromLabel")}</label>
              <span className="c-select">
                <select
                  id={fromSelectId}
                  className="c-input"
                  value={from.mailboxId ?? ""}
                  disabled={inFlight}
                  onChange={(e) => onFrom(e.target.value)}
                >
                  {/* Value is the mailbox id, label the address a human reads — the shape
                      `ComposeView` uses. Sendable choices only, so a disconnected address is never
                      offered and the wire cannot carry one the server would refuse. */}
                  {from.choices.map((o) => (
                    <option key={o.id} value={o.id}>{displayAddress(o.address)}</option>
                  ))}
                </select>
              </span>
            </span>
          ) : (
            <span>{t("from", { address: displayAddress(from.address) })}</span>
          )}
          {from.substituted ? (
            <span className="reply-from-sub">
              {from.substitutedFrom
                ? t("fromSubstituted", { was: displayAddress(from.substitutedFrom) })
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

      {/* ATTACHMENTS — files ride the send, never the account and never the scratch buffer
          (`compose-from`/`mail-send`: the reply buffer serialises only the body). Rendered only
          where the shell can hold the bytes (`onAttachments`); the cap follows the resolved From,
          so switching the sender moves the ceiling exactly as it does in compose. Disabled
          mid-send like every other input. */}
      {onAttachments ? (
        <ComposeAttach
          attachments={[...attachments]}
          onChange={onAttachments}
          disabled={inFlight}
          maxTotalBytes={composeAttachCap(from.maxMessageBytes)}
        />
      ) : null}

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

/**
 * THE OPENED AUDIENCE — To, Cc, Bcc as the same chip rows Compose has, over the edit strings
 * the shell holds.
 *
 * The markup deliberately mirrors `ComposeView`'s header rows — `.c-field`, the label gutter,
 * the `Cc/Bcc` toggle inside the To row, the error line under the row it belongs to, the Bcc
 * hint — because "wherever this appears" means the SAME field, not a cousin. What differs is
 * only what must: ids come from `useId` (this editor is mounted twice while the reader is
 * open, and `compose-to` may exist on another route's DOM at the same time), and the invalid
 * entries are parsed here from the strings rather than handed down from a plan, gated by the
 * same still-typing rule (`gatedInvalid`).
 *
 * Cross-row moves (drag, Alt+arrows) land in ONE `onEnvelope` via `moveRecipient`, for the
 * reason `ComposeView.moveChip` states: two onChange calls would each spread a stale copy of
 * the other row. Starting a drag opens the hidden Cc/Bcc rows so the drop target exists.
 */
function ReplyRecipients({
  envelope,
  onEnvelope,
  book,
  disabled,
}: {
  envelope: ReplyEnvelopeEdit;
  onEnvelope: (next: ReplyEnvelopeEdit) => void;
  book: readonly AddressBookEntry[];
  disabled: boolean;
}) {
  const t = useTranslations("compose");
  const base = useId();
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [focused, setFocused] = useState<Record<RecipientRow, boolean>>({
    to: false, cc: false, bcc: false,
  });
  // Revealed by the toggle, and revealed AUTOMATICALLY when the row holds text — a prefilled
  // reply-all Cc must never hide recipients the user cannot see they have. Same derivation
  // as Compose's `ccBccOpen`.
  const open = showCcBcc || envelope.cc.trim() !== "" || envelope.bcc.trim() !== "";

  const move = (mv: RecipientMove): void => {
    const next = moveRecipient(envelope, mv);
    if (!next) return;
    onEnvelope(next);
    focusMovedChip(`${base}-${mv.to}`, mv.entry);
  };
  const dragOpen = (active: boolean): void => { if (active) setShowCcBcc(true); };

  const row = (r: RecipientRow, extra?: ReactNode): ReactNode => {
    const shown = gatedInvalid(envelope[r], focused[r], parseRecipients(envelope[r]).invalid);
    const errId = `${base}-${r}-error`;
    return (
      <>
        <div className="c-field">
          <label htmlFor={`${base}-${r}`}>{t(r)}</label>
          <RecipientField
            id={`${base}-${r}`}
            value={envelope[r]}
            onChange={(next) => onEnvelope({ ...envelope, [r]: next })}
            book={book}
            disabled={disabled}
            invalid={shown.length > 0}
            describedBy={shown.length > 0 ? errId : undefined}
            onFocusChange={(f) => setFocused((cur) => ({ ...cur, [r]: f }))}
            row={r}
            onMove={move}
            onDragActive={dragOpen}
          />
          {extra}
        </div>
        {shown.length > 0 ? (
          <p className="c-error" id={errId}>{t("toInvalid", { entries: shown.join(", ") })}</p>
        ) : null}
      </>
    );
  };

  return (
    <div className="reply-rcpt">
      {row(
        "to",
        !open ? (
          <button
            type="button"
            className="c-ccbcc-toggle"
            aria-expanded={false}
            aria-controls={`${base}-cc ${base}-bcc`}
            onClick={() => setShowCcBcc(true)}
          >
            {t("ccBcc")}
          </button>
        ) : null,
      )}
      {open ? (
        <>
          {row("cc")}
          {row("bcc")}
          {/* Bcc says out loud what "blind" means — delivered on the envelope, never a header. */}
          <p className="c-hint">{t("bccHint")}</p>
        </>
      ) : null}
    </div>
  );
}
