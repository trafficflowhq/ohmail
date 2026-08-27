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
 * ── WHY A TEXTAREA AND NOT A SECOND RICH EDITOR ──────────────────────────────────────────
 *
 * The stored signature is plain multi-line text (mail 0075), and the block renders exactly
 * what will be serialized. A rich editor here would mint markup the Settings editor cannot
 * store and the plain half of the send cannot carry — two shapes for one value.
 *
 * NOTHING RENDERS when there is nothing to show: a sender with no stored signature, a struck
 * block, an edit deleted down to blank, or a surface that cannot name the sender. Absence is
 * the resting state, not a collapsed control.
 */
import { useTranslations } from "next-intl";
import { effectiveSignature, type SignatureState } from "./signature";

export function SignatureBlock({
  sig,
  onSig,
  signatures,
  mailboxId,
  disabled,
}: {
  /** The surface's own state — the compose form's field, or the shell's per-reply state. */
  sig: SignatureState;
  onSig: (next: SignatureState) => void;
  /** The account's stored signatures, server-confirmed (`useConsentState().signatures`). */
  signatures: Readonly<Record<string, string>>;
  /** The RESOLVED sending mailbox — the same id the mutation will carry. */
  mailboxId: string | null;
  /** True while a send is in flight — the block freezes with every other input. */
  disabled: boolean;
}) {
  const t = useTranslations("compose");
  const text = effectiveSignature(sig, signatures, mailboxId);
  if (text === null) return null;
  return (
    <div className="sig-block" role="group" aria-label={t("signature")}>
      <div className="sig-head">
        <span className="sig-tag" aria-hidden="true">{t("signature")}</span>
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
      {/* Sized to the text it holds (+1 keeps the next line visible while typing), bounded so
          a long signature scrolls inside the block rather than burying the actions below it. */}
      <textarea
        className="sig-text"
        aria-label={t("signatureAria")}
        value={text}
        readOnly={disabled}
        rows={Math.min(Math.max(text.split("\n").length, 1) + 1, 8)}
        onChange={(e) => onSig({ kind: "edited", text: e.target.value })}
      />
    </div>
  );
}
