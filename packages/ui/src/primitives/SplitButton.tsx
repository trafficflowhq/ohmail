import type { ReactNode } from "react";
import { Icon } from "../icons.js";
import { Kbd } from "./Kbd.js";
import "./split-button.css";

export interface SplitButtonProps {
  /** Main segment content. */
  label: ReactNode;
  /** Fires when the main segment is pressed. */
  onPress: () => void;
  /**
   * THE ATTACHED ✓ SEGMENT — a SECOND, distinct decision: file AND mark read.
   *
   * OPTIONAL, and its absence is a real shape. A destination with no "read" verb — Screen out,
   * Spam, where you do not read what you are triaging out — passes nothing here and the capsule
   * renders as a single button. Grouped into one object rather than four loose optionals so the
   * type cannot admit a handler with no accessible name: the ✓ is icon-only, so `label` is the
   * only thing a screen reader has, and making it separately optional would let a caller ship a
   * button that announces nothing.
   */
  check?: {
    /** Fires when the ✓ segment is pressed. */
    onPress: () => void;
    /** Accessible name for the ✓ segment (required — it is icon-only). */
    label: string;
    /**
     * Keyboard hint shown inside the ✓ segment (e.g. "⇧R").
     *
     * The ✓ half is a SECOND verb wearing an icon, and the only thing that used to say so was a
     * legend detached from it at the other end of the bar. A cap here is the same move the
     * message action bar makes — the key sits on the verb it belongs to — and it is
     * `aria-hidden` because `label` already carries the accessible name.
     */
    kbdHint?: string;
    /** Native tooltip for the ✓ segment. */
    title?: string;
  };
  /** The AI-preselected destination: accent ring + warm main segment. */
  ai?: boolean;
  /** Quiet styling for the demoting destinations (Screen out, Spam). */
  quiet?: boolean;
  /** Keyboard hint shown inside the main segment (e.g. "y"). */
  kbdHint?: string;
  title?: string;
  className?: string;
}

/**
 * One capsule, one or two decisions. The main segment files; the attached
 * ✓ segment (when present) files and marks read, each with its own
 * handler. The ✓ half is omitted for a destination with no "read" verb
 * (Screen out, Spam): "mark it read" is meaningless for mail not being
 * admitted — callers express that by not passing `check`, and the capsule
 * reads as a single button. Both halves can carry their own keycap
 * (`kbdHint`, `check.kbdHint`): the key goes on the verb, exactly as the
 * message action bar's does.
 */
export function SplitButton({
  label,
  onPress,
  check,
  ai,
  quiet,
  kbdHint,
  title,
  className,
}: SplitButtonProps) {
  const cls = ["dbtn", quiet ? "quiet" : null, ai ? "ai" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls}>
      <button type="button" className="d-main" title={title} onClick={onPress}>
        {label}
        {kbdHint ? <Kbd>{kbdHint}</Kbd> : null}
      </button>
      {check ? (
        <button
          type="button"
          className="d-read"
          title={check.title}
          aria-label={check.label}
          onClick={check.onPress}
        >
          <Icon name="check" size={12} />
          {/* `aria-label` on this button already wins over its contents, so the cap is shown
              and never spoken. */}
          {check.kbdHint ? <Kbd className="d-readk">{check.kbdHint}</Kbd> : null}
        </button>
      ) : null}
    </span>
  );
}
