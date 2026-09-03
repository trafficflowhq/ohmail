import "./spinner.css";

export interface SpinnerProps {
  /** Extra class for the host's sizing/placement hooks (`mbx-spin`, …). */
  className?: string;
}

/**
 * The waiting mark — a segment travelling the frame's perimeter while the frame holds still.
 *
 * Decorative by contract: every host that shows one already announces its sentence in a
 * `role="status"` region, and an indeterminate mark has no value a screen reader could report,
 * so it is `aria-hidden` here rather than at every mount. The shape follows the radius token
 * (`spinner.css`) — a ring under paper, a square frame under ohmarchy — with no face read.
 */
export function Spinner({ className }: SpinnerProps) {
  return (
    <svg
      className={className ? `spin ${className}` : "spin"}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="spin-track" x="1" y="1" width="10" height="10" pathLength="100" />
      <rect className="spin-run" x="1" y="1" width="10" height="10" pathLength="100" />
    </svg>
  );
}
