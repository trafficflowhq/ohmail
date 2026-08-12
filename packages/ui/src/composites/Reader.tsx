import { useEffect, type ReactNode } from "react";
import { Kbd } from "../primitives/Kbd.js";
import "./reader.css";

export interface ReaderProps {
  open: boolean;
  onClose: () => void;
  /** Usually a <ReadingPane> — rendered as the floating lift-3 sheet. */
  children: ReactNode;
  /** The fading top hint; null disables it. */
  hint?: ReactNode | null;
  /**
   * Escape returns from reading mode. Pass `false` while something INSIDE the sheet owns
   * Escape — the inline reply editor does. Without the opt-out both handlers
   * fire on one keypress: the editor closes and the message it was quoting disappears
   * from under it in the same frame, which reads as Esc having lost the draft.
   */
  closeOnEscape?: boolean;
  ariaLabel?: string;
  /**
   * The accessible name of the on-screen back control — a translated string, because the
   * default below is English and this package has no catalogue. The control itself is
   * unconditional in the DOM and gated to overlay widths by the stylesheet: at phone width
   * the esc hint is (rightly) suppressed for coarse pointers by the app, which left the
   * overlay with no visible exit at all — backdrop tap worked, and nothing said so.
   */
  closeLabel?: string;
}

/**
 * Reading mode — the exhale. While open, `reading` is set on <body> so
 * app chrome marked with the .shell class recedes exactly like the
 * prototype. Escape and a backdrop click both return.
 */
export function Reader({
  open,
  onClose,
  children,
  hint,
  closeOnEscape = true,
  ariaLabel = "Reading",
  closeLabel = "Back",
}: ReaderProps) {
  useEffect(() => {
    if (!open) return;
    document.body.classList.add("reading");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEscape) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("reading");
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, closeOnEscape]);

  if (!open) return null;
  return (
    <>
      <span className="reader-hint">
        {hint === undefined ? (
          <>
            <Kbd>esc</Kbd> to return
          </>
        ) : (
          hint
        )}
      </span>
      <div
        className="reader"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* The on-screen way back. Always in the DOM (a keyboard user may want a visible,
            focusable exit too); reader.css displays it only at overlay widths, where the
            backdrop is not visible enough to read as tappable and the esc hint is suppressed
            for coarse pointers. A child of the dialog, so its click is its OWN handler —
            never the backdrop's target check. */}
        <button type="button" className="reader-close" aria-label={closeLabel} onClick={onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        {children}
      </div>
    </>
  );
}
