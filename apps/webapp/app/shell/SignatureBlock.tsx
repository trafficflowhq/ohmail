"use client";

/**
 * THE SIGNATURE BLOCK — the removable, editable tail of an outgoing message.
 *
 * One component for every compose surface (the compose form and the inline reply/forward
 * dock), because the ruling is one rule: the signature is a DISTINCT BLOCK below the writing
 * area, visibly part of the outgoing message and never silently pasted into the prose. What it
 * shows is {@link effectiveSignature} over the surface's state, the account's stored map and
 * the RESOLVED sending mailbox — the same derivation the send serializes, so the block and the
 * wire cannot disagree (`signature.ts` owns both).
 *
 * ── THE TWO GESTURES ─────────────────────────────────────────────────────────────────────
 *
 * × strikes it FOR THIS MESSAGE — the block disappears and nothing is appended; the stored
 * signature is untouched (that lives in Settings). Typing in it EDITS it for this message —
 * it is the user's text, and from the first keystroke their version stands whatever the From
 * selector later does (the follows-From rule's one exception, `signature.ts`). There is no
 * separate "restore" control: a struck block stays struck for this message, which is what the
 * strike meant.
 *
 * ── TWO SHAPES, BECAUSE A SIGNATURE MAY NOW CARRY FORMATTING (0.16) ──────────────────────
 *
 * The stored signature used to be plain multi-line text and this block was a textarea for it.
 * Settings → Signatures now mounts the compose editor, so a mailbox may store MARKUP as well —
 * and the block renders whichever shape the send will actually carry:
 *
 *   markup, while FOLLOWING  a read-only view of the document, drawn by the compose editor
 *                            itself with no toolbar. The same component that wrote it, so the
 *                            pane, this block and the message cannot render three ways.
 *   everything else          the textarea, byte for byte as before — a mailbox with no markup,
 *                            an edited block, a shell that carries no markup map at all.
 *
 * THIS IS NOT A PREFERENCE, IT IS A PUBLISHED CLAIM. The released notes say of signatures, in
 * these words, "What you see is what ships". A block showing plain text above a message whose
 * html part carries bold would make that sentence false, and site and product copy are judged
 * against the code here. `signatures-rich.test.tsx` quotes the sentence beside the assertion.
 *
 * ── AND WHY EDITING A FORMATTED BLOCK HANDS BACK PLAIN TEXT ──────────────────────────────
 *
 * `SignatureState.edited` holds a STRING, because a hand-edited block is what BOTH halves of
 * the message will carry — the plain part cannot hold markup and the html part must say the
 * same thing. So a formatted block offers an explicit control that says what it does: it
 * reports the DERIVED words (the same words the message's text part carries) as an `edited`
 * state, and from then on this is the plain textarea. The step is visible and the invariant
 * survives it, which a silently-degrading rich editor here would not manage.
 *
 * A rich editor that stayed rich in the `edited` state was the other option and it is a larger
 * change than this one: `SignatureState` is shared with the phone, and the per-message reopen
 * scratch (`readReplyMeta`) would have to round-trip a second field. Worth doing on its own
 * terms, not smuggled in here.
 *
 * NOTHING RENDERS when there is nothing to show: a sender with no stored signature, a struck
 * block, an edit deleted down to blank, or a surface that cannot name the sender. Absence is
 * the resting state, not a collapsed control.
 */
import { useTranslations } from "next-intl";
import { TextField } from "@ohmail/ui";
import { effectiveSignature, effectiveSignatureHtml, type SignatureState } from "./signature";
import { RichEditor } from "./RichEditor";

export function SignatureBlock({
  sig,
  onSig,
  signatures,
  signaturesHtml,
  mailboxId,
  disabled,
}: {
  /** The surface's own state — the compose form's field, or the shell's per-reply state. */
  sig: SignatureState;
  onSig: (next: SignatureState) => void;
  /** The account's stored signatures, server-confirmed (`useConsentState().signatures`). */
  signatures: Readonly<Record<string, string>>;
  /**
   * The account's stored signature MARKUP, server-confirmed
   * (`useConsentState().signaturesHtml`) — only the mailboxes whose signature has formatting.
   *
   * OPTIONAL, AND ABSENT IS ITS OWN STATE rather than a synonym for "no formatting". A shell
   * that carries no markup map — the desktop window's local transport, the demo — supplies
   * nothing here, and the answer is the plain block: the text half is always present and is
   * always the same words, so falling back to it is the safe direction. Distinguishing the two
   * matters because a rule that reads "absent means none" would silently take the same branch
   * for a shell that HAS markup and failed to pass it.
   */
  signaturesHtml?: Readonly<Record<string, string>>;
  /** The RESOLVED sending mailbox — the same id the mutation will carry. */
  mailboxId: string | null;
  /** True while a send is in flight — the block freezes with every other input. */
  disabled: boolean;
}) {
  const t = useTranslations("compose");
  const text = effectiveSignature(sig, signatures, mailboxId);
  // The SAME derivation the send seals (`withSignature`'s third argument). `{}` for a shell that
  // supplies no map, which answers `null` — the plain branch below. See the prop's docstring.
  const html = effectiveSignatureHtml(sig, signaturesHtml ?? {}, mailboxId);
  if (text === null) return null;
  return (
    <div className="sig-block" role="group" aria-label={t("signature")}>
      <div className="sig-head">
        <span className="sig-tag" aria-hidden="true">{t("signature")}</span>
        {/* Offered only for the formatted shape, because it is the only shape whose editing
            changes something: it trades the markup for the words underneath it, and the label
            says so. The plain block is already a textarea — there is nothing to convert. */}
        {html !== null ? (
          <button
            type="button"
            className="sig-edit-text"
            disabled={disabled}
            onClick={() => onSig({ kind: "edited", text })}
          >
            {t("signatureEditAsText")}
          </button>
        ) : null}
        {/* The strike. It acts on THIS message only, and the label says so — a reader must not
            fear it deletes the stored signature. Disabled mid-send like every other input. */}
        <button
          type="button"
          className="sig-remove"
          aria-label={t("signatureRemove")}
          title={t("signatureRemove")}
          disabled={disabled}
          onClick={() => onSig({ kind: "removed" })}
        >
          ×
        </button>
      </div>
      {html !== null ? (
        /* The document as the message will carry it. `editable: false` with no toolbar: this is
           a view, and the control above is how it becomes editable. `onChange` cannot fire on a
           non-editable editor and is a no-op rather than a throw, because a throw would be a
           promise about TipTap's internals rather than about this component. */
        <RichEditor
          className="sig-rich"
          ariaLabel={t("signatureAria")}
          value={{ text, html }}
          onChange={() => {}}
          editable={false}
          toolbar={false}
        />
      ) : (
        /* Sized to the text it holds (+1 keeps the next line visible while typing), bounded so
           a long signature scrolls inside the block rather than burying the actions below it. */
        <TextField
          multiline
          shape="line"
          className="sig-text"
          aria-label={t("signatureAria")}
          value={text}
          readOnly={disabled}
          rows={Math.min(Math.max(text.split("\n").length, 1) + 1, 8)}
          onChange={(e) => onSig({ kind: "edited", text: e.target.value })}
        />
      )}
    </div>
  );
}
