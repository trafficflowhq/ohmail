import type { MouseEventHandler, Ref } from "react";
import "./slot.css";

export interface SlotProps {
  /** The word. Where nobody has chosen, it says what is missing. */
  children: string;
  /** `fill`: a proposal, until it is decided. `done`: decided. `none`: nobody has chosen. Left out: a word that opens a menu. */
  kind?: "fill" | "done" | "none";
  /** Names it where the word alone does not. */
  label?: string;
  /** Whether its menu stands open. */
  expanded?: boolean;
  /** It stands on a row of a list. */
  listed?: boolean;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}

/** A word you can press: a place in a sentence, a window in the setup, a date. It opens a menu. */
export function Slot({ children, kind, label, expanded, listed, onPress, ref }: SlotProps) {
  return (
    <button
      ref={ref}
      type="button"
      className="oh-control oh-slot"
      data-kind={kind}
      data-listed={listed ? "" : undefined}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={expanded ?? false}
      onClick={onPress}
    >
      {children}
      {kind === "done" ? null : <i className="oh-slot-arrow" aria-hidden="true" />}
    </button>
  );
}
