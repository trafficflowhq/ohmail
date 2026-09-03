import type { ReactNode } from "react";
import "./protected.css";

export interface ProtectedBlockProps {
  /**
   * "Verification code", from the host's catalogue — and "(redacted)" beside it.
   *
   * Both defaulted to their English here, and one call site (the Screener's held preview)
   * passes neither, so a German reader met an English block on exactly the mail this feature
   * exists for. A composite reads no catalogue; the host does.
   */
  label: ReactNode;
  redactedNote: ReactNode;
  /** The protection promise, rendered under the code line. */
  policy?: ReactNode;
  className?: string;
}

/**
 * The protected-OTP block: a tinted pool of light, no frame. The lock
 * draws itself shut; the redaction dots settle in one by one.
 */
export function ProtectedBlock({
  label,
  redactedNote,
  policy,
  className,
}: ProtectedBlockProps) {
  return (
    <div className={className ? `protected ${className}` : "protected"}>
      <svg
        className="ic lock-anim"
        viewBox="0 0 16 16"
        style={{ width: 26, height: 26, overflow: "visible" }}
        aria-hidden="true"
      >
        <path className="body-d" d="M3.8 7.2h8.4v6.2H3.8z" />
        <path className="shackle" d="M5.4 7.2V5.2a2.6 2.6 0 0 1 5.2 0v2" />
        <path className="body-d" d="M8 9.7v1.4" />
      </svg>
      <div className="code">
        {label}{" "}
        <span className="dots">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <i key={i} style={{ animationDelay: `${0.55 + i * 0.09}s` }}>
              ·
            </i>
          ))}
        </span>{" "}
        <small>{redactedNote}</small>
      </div>
      {policy ? <p>{policy}</p> : null}
    </div>
  );
}
