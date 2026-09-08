import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../primitives/Button.js";
import { Kbd } from "../primitives/Kbd.js";
import { TextField } from "../primitives/TextField.js";
import "./focus-reply.css";

export interface FocusReplyMessage {
  subject: string;
  from: string;
  preview: string;
}

export interface FocusReplyOverlayProps {
  open: boolean;
  /** Zero-based position in the pile. */
  step: number;
  total: number;
  /** The current message; omit to show the done state. */
  message?: FocusReplyMessage;
  value?: string;
  onChange?: (value: string) => void;
  /**
   * THE EDITOR, SUPPLIED BY THE APP — and when it is, `value`/`onChange` are not used at all.
   *
   * The run steps through the same messages the inline reply answers and writes into the SAME
   * per-message scratch buffer, so whatever the two surfaces offer has to be one grammar. Once
   * that buffer can hold formatting, a plain `<textarea>` here is not a smaller editor, it is a
   * lossy one: it would render markup as its flattened text and then overwrite the markup with
   * that flattening the first time somebody pressed a key.
   *
   * A slot rather than moving the rich editor into this package: it belongs to the webapp — it
   * knows the app's copy, its sanitizer allowlist and its scratch-buffer shape — and `@ohmail/ui`
   * is also the desktop's, which has no business acquiring ProseMirror to render a card. The
   * textarea stays as the default for every caller that has no editor to hand in.
   */
  editor?: ReactNode;
  onDone: () => void;
  onSkip: () => void;
  onClose: () => void;
  /** ReactNode so the host can put the verb's keycap ON the button (the always-on-caps law). */
  doneLabel: ReactNode;
  skipLabel: string;
  /** Rendered when the pile is exhausted (step >= total). */
  emptyState?: ReactNode;
  /** Every other word this overlay says. See {@link FocusReplyCopy}. */
  copy: FocusReplyCopy;
}

/**
 * The overlay's words, brought by the host.
 *
 * `doneLabel` and `skipLabel` used to default to "Done → next" and "Skip", and the six strings
 * below were literals in the markup — so a German reader stepping through their Answer Later pile
 * met an English dialog inside a German app. A composite reads no catalogue; the host does, and
 * hands the words down. Required rather than defaulted, so a missing one is a type error and not
 * a locale nobody on the team reads.
 */
export interface FocusReplyCopy {
  /** The dialog's accessible name. */
  ariaLabel: string;
  /** The done state: the sentence, and the way back. */
  empty: ReactNode;
  emptyBack: string;
  /** "3 of 12" — the host places both numbers, because not every language puts them in this order. */
  progress: (step: number, total: number) => ReactNode;
  /** The default textarea's placeholder and accessible name. Unused when `editor` is supplied. */
  placeholder: string;
  replyAria: string;
  /** The word beside the esc keycap. */
  exit: string;
}

/**
 * Reply Run: steps through the Answer Later pile, one message per
 * screen, with the hairline progress bar filling on the spring.
 *
 * The component name and `focus-reply.css` keep their historical names;
 * only the words a user reads or hears changed.
 */
export function FocusReplyOverlay({
  open,
  step,
  total,
  message,
  value,
  onChange,
  editor,
  onDone,
  onSkip,
  onClose,
  doneLabel,
  skipLabel,
  emptyState,
  copy,
}: FocusReplyOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Only the textarea is this component's to focus. A supplied editor focuses itself — it owns
  // a document and a selection, and reaching into one from outside is how a caret ends up
  // somewhere the user did not put it.
  useEffect(() => {
    if (open && message) textareaRef.current?.focus();
  }, [open, message, step]);

  if (!open) return null;

  const finished = step >= total || !message;
  return (
    <div
      className="fr-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fr-card" role="dialog" aria-modal="true" aria-label={copy.ariaLabel}>
        {finished ? (
          (emptyState ?? (
            <div className="empty" style={{ padding: "20px 10px" }}>
              <span className="glyph">🕊</span>
              <b>{copy.empty}</b>
              <div style={{ marginTop: 18 }}>
                <Button variant="primary" onClick={onClose}>
                  {copy.emptyBack}
                </Button>
              </div>
            </div>
          ))
        ) : (
          <>
            <div className="fr-prog num">
              <span>{copy.progress(step + 1, total)}</span>
              <span className="fr-bar">
                <i style={{ width: `${((step + 1) / total) * 100}%` }} />
              </span>
            </div>
            <h3>{message.subject}</h3>
            <div className="from">{message.from}</div>
            <p className="prev">{message.preview}</p>
            {editor ?? (
              <TextField
                multiline
                ref={textareaRef}
                placeholder={copy.placeholder}
                aria-label={copy.replyAria}
                value={value}
                onChange={onChange ? (e) => onChange(e.target.value) : undefined}
              />
            )}
            <div className="fr-foot">
              <Button variant="primary" onClick={onDone}>
                {doneLabel}
              </Button>
              <Button onClick={onSkip}>{skipLabel}</Button>
              <span className="esc">
                <Kbd>esc</Kbd> {copy.exit}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
