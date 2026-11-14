import type { ReactNode } from "react";
import { Icon } from "../../icons/Icon.js";
import "./letter-history.css";

export interface LetterHistoryProps {
  /** The handle's word: "Show history", "Hide history", "Show more (33% shown)". */
  label: string;
  /** Folded or shown. Left out where the handle brings the next page of a long letter: it folds nothing. */
  open?: boolean;
  onPress?: () => void;
  /** The quoted part, drawn while it is shown. */
  children?: ReactNode;
}

/**
 * Quoted history behind one quiet word, where the quoted part begins; the same handle brings the
 * next page of a very long letter. A button: Enter and Space, no key of its own.
 */
export function LetterHistory({ label, open, onPress, children }: LetterHistoryProps) {
  return (
    <>
      <p className="oh-text oh-history">
        <button type="button" className="oh-control oh-history-handle" aria-expanded={open} onClick={onPress}>
          <Icon name="more" size={16} />
          <span>{label}</span>
        </button>
      </p>
      {open && children ? <div className="oh-history-quoted">{children}</div> : null}
    </>
  );
}
