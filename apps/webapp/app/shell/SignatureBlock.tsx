"use client";

/**
 * The signature block — the removable, editable tail of an outgoing message. One component for
 * every compose surface, one rule: the signature is a distinct block below the writing area, never
 * silently pasted into the prose. It shows {@link effectiveSignature} over the surface's state, the
 * account's stored map and the resolved sending mailbox — the same derivation the send serializes,
 * so the block and the wire cannot disagree (`signature.ts`). Two gestures: × strikes it for THIS
 * message (stored signature untouched, no restore control — struck stays struck); typing edits it
 * for this message, and from the first keystroke the user's version stands whatever the From
 * selector later does. Nothing renders when there is nothing to show — absence is the resting state.
 */

/**
 * Two shapes, because a signature may carry formatting (0.16): markup while FOLLOWING renders
 * read-only through the compose editor itself — the same component that wrote it; everything else
 * is the textarea, byte for byte. Not a preference but a published claim — "What you see is what
 * ships" (`signatures-rich.test.tsx` quotes the sentence beside the assertion). Editing a
 * formatted block hands back PLAIN text: `SignatureState.edited` holds a string, because a
 * hand-edited block is what both halves of the message carry — the step is visible and the
 * invariant survives it; a rich `edited` state would round-trip a second field through the
 * phone-shared state and the reopen scratch, worth doing on its own terms.
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
   * The account's stored signature MARKUP, server-confirmed (`useConsentState().signaturesHtml`) —
   * only the mailboxes whose signature has formatting. Optional, and ABSENT is its own state rather
   * than a synonym for "no formatting": a shell that carries no markup map — the desktop window's
   * local transport, the demo — supplies nothing, and the answer is the plain block (the text half
   * is always present and always the same words, the safe direction). The distinction matters
   * because "absent means none" would silently take the same branch for a shell that HAS markup
   * and failed to pass it.
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
