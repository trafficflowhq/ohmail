import type { ReactNode } from "react";
import { Avatar } from "../primitives/Avatar.js";
import "./doorbell.css";

/**
 * How many faces a knock is allowed to show.
 *
 * The doorbell rendered ONE circle per waiting sender. That was invisible while the
 * Screener was structurally empty on Cloud; the moment it started returning senders, an
 * account with 86 waiting senders drew 86 letters — 852px of them, measured — and shoved the
 * label and the "Screener ›" affordance off the right-hand edge. Four is the number that
 * still reads as "some people are waiting" at 390px and leaves room for the sentence that
 * says how many. The count lives in the LABEL; the stack is a texture, not a census.
 */
const DEFAULT_MAX = 4;

export interface DoorbellProps {
  /** Waiting senders' initials, stacked. Capped at `max`; the rest collapse into "+N". */
  initials: string[];
  /** Per-sender tint hues, index-aligned with `initials`. Optional. */
  hues?: number[];
  /** "<b>3 new senders</b> waiting" */
  message: ReactNode;
  actionLabel: string;
  onPress: () => void;
  /** Collapses the doorbell away (all decided). */
  gone?: boolean;
  /** Faces shown before the overflow counter. */
  max?: number;
  ariaLabel?: string;
  className?: string;
}

/** The Screener doorbell — a knock, not a nag. */
export function Doorbell({
  initials,
  hues,
  message,
  actionLabel,
  onPress,
  gone,
  max = DEFAULT_MAX,
  ariaLabel,
  className,
}: DoorbellProps) {
  const cls = ["doorbell", gone ? "gone" : null, className].filter(Boolean).join(" ");
  // `Math.max(0, …)` so `max={0}` (or a negative) degrades to "no faces, just the count"
  // rather than to `slice(0, -1)`, which would silently drop exactly one sender.
  const limit = Math.max(0, max);
  const shown = initials.slice(0, limit);
  const overflow = initials.length - shown.length;
  return (
    <button type="button" className={cls} aria-label={ariaLabel} onClick={onPress}>
      <span className="avs">
        {shown.map((i, idx) => (
          <Avatar key={`${i}-${idx}`} initials={i} size="s" hue={hues?.[idx]} />
        ))}
        {overflow > 0 ? (
          <span className="av s more" aria-hidden="true">
            +{overflow}
          </span>
        ) : null}
      </span>
      <span className="db-txt">{message}</span>
      <span className="db-go">{actionLabel}</span>
    </button>
  );
}
