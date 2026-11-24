import "./spinner.css";

export interface SpinnerProps {
  /** Extra class for the host's placement. */
  className?: string;
}

/**
 * The waiting mark: a run travelling the full stop's outline while the outline holds still. A ring under oh, a
 * square under ohmarchy: the outline's corner is the full stop's own radius, and nothing turns, so a square never
 * reads as a spinning box.
 *
 * Decorative: every place that shows one says what it waits for in words, and a mark without a value has nothing a
 * screen reader could report.
 */
export function Spinner({ className }: SpinnerProps) {
  return (
    <svg
      className={className ? `oh-spin ${className}` : "oh-spin"}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="oh-spin-track" x="1.25" y="1.25" width="13.5" height="13.5" pathLength="100" />
      <rect className="oh-spin-run" x="1.25" y="1.25" width="13.5" height="13.5" pathLength="100" />
    </svg>
  );
}
