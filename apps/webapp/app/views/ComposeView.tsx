"use client";

/**
 * COMPOSE — a new message, and the three things that were wrong with it.
 *
 * ── THE THIRD ONE, AND THE WORST ────────────────────────────────────────────────────────
 *
 * This form rendered To, Subject and an editor, and **no From at all**. The sender was resolved
 * behind it by `sendingMailboxId` — the mailbox holding the account's NEWEST MESSAGE — so on an
 * account with two connected addresses the From line flipped with whichever one last received
 * mail, and nothing on screen said which had won. With ONE address it was no better: a stranger
 * could not tell what they were writing from.
 *
 * The row is now the first field, the value is a mailbox id (never an address — aliases are a
 * later slice), and it renders as static text when there is nothing to choose. `AppShell`
 * resolves it and this file shows it, so the id on the wire and the line on the screen are one
 * object — see `compose-from.ts`.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Send was a PRIMARY button rendered `aria-disabled` with the title *"Sending is disabled in
 * the demo — no mail leaves this tab."* On a live account that sentence was simply false, and
 * it became sharper the day the inline reply started really sending: a customer who had
 * just answered a message found Compose inert, with an explanation about a demo they were not
 * in. Alongside it, three fields — the AI-draft tag, the editor placeholder and the note next
 * to Send — were read UNCONDITIONALLY out of `@ohmail/fixtures`, so `#/compose` showed a
 * paying customer strings written for a fictional demo world. Demo content is fiction and must
 * never be shown to somebody as their own mail; a claim the product makes is a contract.
 *
 * ── WHAT IT IS NOW ──────────────────────────────────────────────────────────────────────
 *
 * A real compose over the SAME send path the reply uses — one `mail_send` mutation, one
 * Idempotency-Key, one four-outcome failure surface, one double-send lock (`mail-send.ts`).
 * Nothing here talks to the network and nothing here decides whether a send may go: this file
 * renders the form and reports what the state machine says. `AppShell` owns the fields (so a
 * half-written message survives leaving the view) and `compose.ts` owns the address parsing.
 *
 * NO import from `@ohmail/fixtures`, and `demo-zero-network.test.ts` now forbids one anywhere
 * under `app/` rather than trusting this comment.
 *
 * The AI-draft card above the editor is unchanged in spirit: it renders when the mirror holds
 * a `draft` entity with a body to review, which is the demo world today and the AI drafter
 * (Phase 3b) on a Cloud account later. Its label is app copy now, not a fixture string.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { addressBook } from "@ohmail/client-engine";
import type { EngineDraft, OhmailEngine } from "@ohmail/client-engine";
import type { Editor } from "@tiptap/react";
import { Button, Chip, Icon, useToast } from "@ohmail/ui";
import { useKeyBindings } from "../shell/keymap";
import { go } from "../shell/routing";
import { canSend, type SendState } from "../shell/mail-send";
import { RichEditor } from "../shell/RichEditor";
import { SendStatus } from "../shell/SendStatus";
import { RecipientField } from "../shell/RecipientField";
import { ComposeAttach } from "../components/ComposeAttach";
import type { ComposeFields, ComposePlan } from "../shell/compose";
import type { ResolvedFrom } from "../shell/compose-from";

export function ComposeView({
  engine,
  draft,
  fields,
  onFields,
  from,
  plan,
  send,
  onSend,
}: {
  engine: OhmailEngine;
  draft: EngineDraft | null;
  /** The form, owned by `AppShell` so it survives navigating away — see `compose.ts`. */
  fields: ComposeFields;
  onFields: (next: ComposeFields) => void;
  /**
   * WHICH ADDRESS THIS SENDS FROM — resolved by the shell, rendered here.
   *
   * The same object `plan.mutation.mailboxId` was built from, so the line on screen and the id
   * on the wire cannot be two different answers. This view does not choose; it shows the choice
   * and reports a new one, which is the same division of labour as the send state machine.
   */
  from: ResolvedFrom;
  /** The same object `canSend` judges and `onSend` dispatches. */
  plan: ComposePlan;
  send: SendState;
  onSend: () => void;
}) {
  const t = useTranslations("compose");
  const toast = useToast();
  /**
   * The live editor, handed over by `RichEditor` when ProseMirror is ready. It exists for the
   * one thing accepting a draft needs and `value` cannot express — putting the caret in the
   * message somebody is now expected to edit.
   */
  const editorRef = useRef<Editor | null>(null);
  const takeEditor = useCallback((e: Editor | null) => { editorRef.current = e; }, []);

  /**
   * EVERY ADDRESS THE MIRROR KNOWS, for the To field's suggestions.
   *
   * Built once per mount rather than per keystroke: it is a full pass over the message list,
   * and the set of people the user has corresponded with does not change while they are typing
   * a name. `from.address` is excluded because suggesting somebody their own address as a
   * recipient is noise — the selector cannot know whose mailbox it is reading, so the caller
   * says.
   */
  /**
   * ── THE "NOT AN ADDRESS" LINE WAITS FOR THE ENTRY TO BE FINISHED ────────────────────────
   *
   * `composePlan` re-parses the whole To field on every keystroke, so typing the `n` of a name
   * put a red error under the field immediately — while the suggestion list for that same
   * prefix was open above it. The field was telling the user they were wrong and offering them
   * four ways to be right, at the same time, about the same two letters.
   *
   * An entry that is still being typed is UNFINISHED, not invalid. So the line withholds
   * exactly one entry — the last one — and only while the field has focus and the value does
   * not already end in a comma. Everything the user has committed by typing a comma is still
   * reported the moment it is committed, and blurring reports the last one too.
   *
   * THIS IS A DISPLAY GATE AND NOTHING ELSE. `canSend` reads `plan.mutation.to`, which
   * `composePlan` empties whenever ANY entry is unparseable, so a genuinely bad address still
   * refuses to send whether or not this line is on screen. Suppressing the sentence cannot
   * loosen the guard, because the guard never read the sentence.
   */
  const [toFocused, setToFocused] = useState(false);
  const stillTyping =
    toFocused && !/,\s*$/.test(fields.to)
      ? (fields.to.split(",").pop() ?? "").trim()
      : null;
  const shownInvalid =
    stillTyping === null || stillTyping === ""
      ? plan.invalid
      : plan.invalid.filter((entry) => entry !== stillTyping);

  /**
   * ── CC AND BCC, BEHIND ONE AFFORDANCE ──────────────────────────────────────────────────
   *
   * Hidden by default because most messages have neither, and a compose form that opens with two
   * empty extra rows is answering a question nobody asked. Revealed by the "Cc/Bcc" toggle — and
   * revealed AUTOMATICALLY when the fields already hold text, so a restored draft or an AI draft
   * that addressed a Cc never hides recipients the user cannot see they have.
   *
   * The still-typing gate is the To field's, applied per field: an entry being typed is unfinished,
   * not wrong, so its "not an address" line is withheld while the field has focus and the value
   * does not already end in a comma. `gatedInvalid` is the shared shape; the To field keeps its own
   * literal form above because it is the one the reported bug was about.
   */
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [ccFocused, setCcFocused] = useState(false);
  const [bccFocused, setBccFocused] = useState(false);
  const ccBccOpen = showCcBcc || fields.cc.trim() !== "" || fields.bcc.trim() !== "";
  const ccShownInvalid = gatedInvalid(fields.cc, ccFocused, plan.cc.invalid);
  const bccShownInvalid = gatedInvalid(fields.bcc, bccFocused, plan.bcc.invalid);

  const book = useMemo(
    () => addressBook(engine.read(), { exclude: from.address ? [from.address] : [] }),
    [engine, from.address],
  );

  /**
   * Escape leaves. The complaint that Compose could not be left with the keyboard was
   * literally true: this view had no key bindings at all. `inInput` because focus is inside the
   * editor — a `contenteditable`, which `isTypingTarget` counts as typing exactly as it counted
   * the textarea — and it is focused the moment a draft is accepted, so without it the one
   * place you need the exit is the one place it would not work.
   *
   * ⌘↩ SENDS, and it is registered HERE rather than in the shell's global map because the
   * global `mod+Enter` belongs to the open reply editor. A view-scope binding outranks a
   * global one (`keymap.tsx`), so in Compose this one wins, and the `?` sheet — generated from
   * the registry — shows "Send message" instead of the reply's disabled row. It calls the same
   * `onSend` the button does, so the lock, the empty-body guard and the recipient rule apply
   * identically; there is no second path to SMTP.
   */
  useKeyBindings([
    { chord: "Escape", group: "app", label: t("keyLeave"), inInput: true, run: () => go("ohbox") },
    {
      chord: "mod+Enter",
      group: "message",
      label: t("keySend"),
      inInput: true,
      // ONE rule, the button's. A typo'd recipient is already expressed as `to: []` inside the
      // mutation (`composePlan`), so there is deliberately no second term about it here.
      disabled: !canSend(send, plan.mutation),
      run: () => onSend(),
    },
  ]);

  const [discarded, setDiscarded] = useState(false);
  const cardVisible = draft != null && !draft.accepted && !discarded;

  const takeDraft = (withToast: boolean) => {
    if (!draft) return;
    // The AI draft fills the message the user is writing — subject and recipient included
    // where the draft carries them, because a draft the drafter addressed is a draft the user
    // should not have to re-address.
    onFields({
      ...fields,
      to: fields.to || draft.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", "),
      // A draft the drafter addressed a Cc to fills the Cc line too — the same rule as `to`, and the
      // reason `ccBccOpen` reveals the row when it is non-empty. `bcc` is never on an AI draft.
      cc: fields.cc || draft.cc.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", "),
      subject: fields.subject || draft.subject,
      body: draft.body,
      // `EngineDraft.body` IS PLAIN TEXT, so the markup half is emptied rather than left
      // holding whatever the user had typed before. Carrying it over would mean the editor
      // rendering the old message's formatting around the new message's words — and, worse,
      // the html would be what went on the wire while `body` said something else entirely.
      // `RichEditor` escapes the text on the way in, so a draft containing a literal `<b>`
      // stays a literal `<b>`.
      html: "",
      // Spread FIRST so `fromMailboxId` survives: taking a draft fills the message, it does not
      // re-decide who is sending it. Written as a spread rather than by naming the field so the
      // next field added to `ComposeFields` is not silently dropped here too.
    });
    void engine.mutate({ kind: "draft_accept", draftId: draft.id });
    if (withToast) toast(t("toastUseDraft"));
    requestAnimationFrame(() => editorRef.current?.commands.focus("end"));
  };

  const locked = !canSend(send, plan.mutation);
  const inFlight = send.phase === "sending" || send.phase === "queued";

  return (
    <section className="view col view-compose">
      <div className="vhead">
        <h1>{t("title")}</h1>
      </div>
      <div className="scroller">
        <div className="compose-wrap">
          {/* ═══ THE HEADER BLOCK ═══════════════════════════════════════════════════════════
              From, To, Cc/Bcc and Subject as ONE compact block, then the editor, then the
              actions at the panel's bottom edge — the inline reply's proportions, which is
              the composition this form should have had from the start.

              What it replaces: five equally-weighted rows, each with its own 56px label
              gutter and its own hairline, a standalone Cc/Bcc strip between To and Subject,
              and a 150px editor sitting fourth among them. The message was the smallest
              thing on a screen whose entire purpose is writing one, and the addressing —
              which is answered in seconds and then never looked at again — took the top
              half. The reply editor gets this right (`InlineReply`): a recessed head, a
              dominant surface, one action row under it.

              The rows keep their `.c-field` chrome, because that is the product's form-field
              rule and this pass is about proportion, not a new field language. */}
          <div className="compose-head">
            {/* FROM. Before To, because it is the question the reader asks first and
                because the answer used to be nowhere on this screen at all — compose resolved
                its sender from whichever mailbox had received the newest message, and said
                nothing, so on an account with two addresses the From flipped with the post.

                A CONTROL ONLY WHEN THERE IS SOMETHING TO CHOOSE. One address renders as static
                text: a select with a single option is a decision nobody has, and the point of
                this line with one mailbox is that a stranger can see what they are writing
                from. Nothing renders when the account's mailboxes cannot be named at all —
                `from.address` is null — because a From line is a claim and there is nothing to
                claim yet.

                THE VALUE IS A MAILBOX ID. `from.choices` holds sendable mailboxes only, so a
                disconnected address is never offered; the server refuses it too
                (`drafts-service.ts` → `validMailbox`), and a control that offers what the server
                refuses is an inert affordance with extra steps. */}
            {from.address !== null ? (
              <div className="c-field">
                <label htmlFor="compose-from">{t("from")}</label>
                {from.choices.length > 1 ? (
                  <span className="c-select">
                    <select
                      id="compose-from"
                      className="c-input"
                      value={from.mailboxId ?? ""}
                      disabled={inFlight}
                      onChange={(e) => onFields({ ...fields, fromMailboxId: e.target.value })}
                    >
                      {from.choices.map((o) => (
                        <option key={o.id} value={o.id}>{o.address}</option>
                      ))}
                    </select>
                  </span>
                ) : (
                  <output id="compose-from" className="c-static">{from.address}</output>
                )}
              </div>
            ) : null}

            <div className="c-field">
              <label htmlFor="compose-to">{t("to")}</label>
              {/* The addresses this mailbox already knows, matched as you type. `book` is a
                  pure selector over the local mirror — no request per keystroke, and nothing
                  about what is being typed leaves the tab. See `RecipientField`. */}
              <RecipientField
                id="compose-to"
                value={fields.to}
                onChange={(next) => onFields({ ...fields, to: next })}
                book={book}
                disabled={inFlight}
                placeholder={t("toPlaceholder")}
                /* The error line below is the accessible name's partner: a field that is wrong
                   must SAY which entry is wrong, not merely refuse to enable Send. */
                invalid={shownInvalid.length > 0}
                describedBy={shownInvalid.length > 0 ? "compose-to-error" : undefined}
                onFocusChange={setToFocused}
              />
              {/* THE AFFORDANCE IS IN THE ROW IT ACTS ON, at its right edge.
                  It had a strip of its own between To and Subject — a full-width row whose
                  entire content was one 11.5px word, which cost the form a band of vertical
                  space and read as a fourth field rather than as a control on the third.
                  Cc and Bcc ARE recipients, so the way to more recipients belongs on the
                  recipient row; this is the same reasoning that keeps Move's destinations on
                  the bar rather than in a strip beneath it.

                  Still a button and not a checkbox, because it does one thing: show two more
                  inputs. `aria-expanded` names the state, and it vanishes once the rows are
                  open — there is nothing left to reveal.

                  IT MUST STAY INSIDE THIS `.c-field`. Lifted back out, the row's own
                  `:focus-within` hairline stops covering it and the toggle is once again a
                  control floating between two fields. `compose-composition.test.ts` asserts the
                  CONTAINMENT (`#compose-to`'s `.c-field` holds the button), not merely that a
                  Cc/Bcc button exists somewhere — the weaker assertion passes against the
                  layout this replaces. */}
              {!ccBccOpen ? (
                <button
                  type="button"
                  className="c-ccbcc-toggle"
                  aria-expanded={false}
                  aria-controls="compose-cc compose-bcc"
                  onClick={() => setShowCcBcc(true)}
                >
                  {t("ccBcc")}
                </button>
              ) : null}
            </div>
            {shownInvalid.length > 0 ? (
              <p className="c-error" id="compose-to-error">
                {t("toInvalid", { entries: shownInvalid.join(", ") })}
              </p>
            ) : null}

            {ccBccOpen ? (
              <>
                <div className="c-field">
                  <label htmlFor="compose-cc">{t("cc")}</label>
                  <RecipientField
                    id="compose-cc"
                    value={fields.cc}
                    onChange={(next) => onFields({ ...fields, cc: next })}
                    book={book}
                    disabled={inFlight}
                    placeholder={t("ccPlaceholder")}
                    invalid={ccShownInvalid.length > 0}
                    describedBy={ccShownInvalid.length > 0 ? "compose-cc-error" : undefined}
                    onFocusChange={setCcFocused}
                  />
                </div>
                {ccShownInvalid.length > 0 ? (
                  <p className="c-error" id="compose-cc-error">
                    {t("toInvalid", { entries: ccShownInvalid.join(", ") })}
                  </p>
                ) : null}

                <div className="c-field">
                  {/* Bcc says out loud what "blind" means, because a recipient who assumes a Cc is
                      a privacy incident. Delivered on the envelope, never a header — see `compose.ts`. */}
                  <label htmlFor="compose-bcc">{t("bcc")}</label>
                  <RecipientField
                    id="compose-bcc"
                    value={fields.bcc}
                    onChange={(next) => onFields({ ...fields, bcc: next })}
                    book={book}
                    disabled={inFlight}
                    placeholder={t("bccPlaceholder")}
                    invalid={bccShownInvalid.length > 0}
                    describedBy={bccShownInvalid.length > 0 ? "compose-bcc-error" : undefined}
                    onFocusChange={setBccFocused}
                  />
                </div>
                {bccShownInvalid.length > 0 ? (
                  <p className="c-error" id="compose-bcc-error">
                    {t("toInvalid", { entries: bccShownInvalid.join(", ") })}
                  </p>
                ) : null}
                <p className="c-hint">{t("bccHint")}</p>
              </>
            ) : null}

            {/* SUBJECT, BARE — no label gutter, the message's own type size.
                It is the last header row and the only one whose value is prose rather than an
                address, so a 56px "Subject" column beside it spent a sixth of the row's width
                restating what the placeholder already says. The label is not lost: `aria-label`
                carries the accessible name, which is what a screen reader reads, and the
                placeholder carries it for everyone else. Sized between the address rows and the
                body, because that is where a subject sits in the message it heads. */}
            <div className="c-field c-subject">
              <input
                id="compose-subject"
                className="c-input"
                type="text"
                aria-label={t("subject")}
                placeholder={t("subject")}
                value={fields.subject}
                readOnly={inFlight}
                onChange={(e) => onFields({ ...fields, subject: e.target.value })}
              />
            </div>
          </div>

          {cardVisible ? (
            <div className="draft-card">
              <span className="draft-tag">
                <Icon name="spark" size={12} /> {t("draftTag")}
              </span>
              <div className="draft-body">{draft.body}</div>
              {draft.rationale ? (
                <div className="grounding">
                  <Chip variant="rationale">
                    <DraftGrounding text={draft.rationale} />
                  </Chip>
                </div>
              ) : null}
              <div className="draft-btns">
                <Button variant="primary" onClick={() => takeDraft(true)}>
                  {t("useDraft")}
                </Button>
                <Button onClick={() => takeDraft(false)}>{t("edit")}</Button>
                {/* REGENERATE IS GONE, and its removal is the same fix as the Send tooltip.
                    It bumped a `shimmerKey` and toasted "Draft regenerated from the same
                    sources." — no request, no new draft, the same text on screen afterwards.
                    A button that reports work it did not do is the inert-affordance class this
                    slice exists to close, and there is no drafting endpoint behind it to wire
                    instead. It comes back with Phase 3b's re-draft call, not before. */}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDiscarded(true);
                    toast(t("toastDiscard"));
                  }}
                >
                  {t("discard")}
                </Button>
              </div>
            </div>
          ) : null}

          {/* THE TWO HALVES GO BACK INTO THE FORM SEPARATELY. `body` stays the plain
              rendering — every local check reads it, and `composePlan` sends the markup
              INSTEAD of it, never beside it. See `compose.ts`. */}
          <RichEditor
            editorRef={takeEditor}
            className="compose-editor"
            ariaLabel={t("editorAria")}
            placeholder={t("editorPlaceholder")}
            value={{ text: fields.body, html: fields.html }}
            /* The text is never taken away from the author, not even mid-send: a failed send
               whose draft had been cleared would be a message the user has to write twice. It
               stops taking INPUT, which is the textarea's `readOnly` this replaces. */
            editable={!inFlight}
            onChange={(v) => onFields({ ...fields, body: v.text, html: v.html })}
          />

          {/* THE ACTIONS, AT THE PANEL'S BOTTOM EDGE — `.reply-actions`' place in the reply.
              `.compose-foot` is what `margin-top: auto` acts on, so Send stays put whether the
              editor is holding two lines or twenty and the status line keeps its position under
              it. Grouped rather than left as two siblings because the pair is one region: the
              button and the sentence that explains what pressing it will do. */}
          <div className="compose-foot">
            {/* ATTACHMENTS — files ride the send, not the account. The bytes live only in the form
                (`compose.ts` strips them from the scratch buffer), so they reach the wire via
                `plan.mutation.attachments` and are stored nowhere. In the foot, above Send, so the
                pick-a-file control sits with the action it feeds; disabled while a send is in
                flight, like every other input. */}
            <ComposeAttach
              attachments={fields.attachments ?? []}
              onChange={(next) => onFields({ ...fields, attachments: next })}
              disabled={inFlight}
            />
            <div className="send-row">
              <Button
                variant="primary"
                disabled={locked}
                aria-busy={send.phase === "sending" || undefined}
                onClick={() => onSend()}
              >
                {send.phase === "sending" ? t("sending") : t("send")}
              </Button>
              {/* AN EMPTY SUBJECT SENDS — see `composePlan`. Said here, before the press, rather
                  than as a modal after it. */}
              {plan.noSubject && !inFlight ? (
                <span className="send-note">{t("noSubject")}</span>
              ) : null}
              {/* The scratch buffer, stated exactly as strongly as it is true: this browser, not
                  the mailbox. Drafts kept on the server are not built yet. */}
              <span className="send-note">{t("draftNote")}</span>
            </div>

            <SendStatus send={send} scope="compose" />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The invalid entries a field should SHOW, withholding the one still being typed.
 *
 * The To field has its own literal copy of this above (it is the surface the bug was reported
 * against); Cc and Bcc share this. An entry is "still being typed" when the field has focus and the
 * value does not already end in a comma — a trailing comma means the user committed it and moved
 * on, so its error is shown. It is a DISPLAY gate only: `composePlan` empties the mutation on any
 * invalid entry regardless, so nothing here can loosen the send guard.
 */
function gatedInvalid(raw: string, focused: boolean, invalid: string[]): string[] {
  const stillTyping = focused && !/,\s*$/.test(raw) ? (raw.split(",").pop() ?? "").trim() : null;
  return stillTyping === null || stillTyping === ""
    ? invalid
    : invalid.filter((entry) => entry !== stillTyping);
}

/** Bold the source spans of the grounding line, like the prototype. */
function DraftGrounding({ text }: { text: string }) {
  const marker = "Drafted from your ";
  if (text.startsWith(marker)) {
    const rest = text.slice(marker.length);
    const plus = rest.indexOf(" + ");
    if (plus >= 0) {
      return (
        <>
          {marker}
          <b>{rest.slice(0, plus)}</b>
          {rest.slice(plus)}
        </>
      );
    }
  }
  return <>{text}</>;
}
