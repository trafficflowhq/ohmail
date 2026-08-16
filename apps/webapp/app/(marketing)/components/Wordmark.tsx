/** The landing wordmark: lowercase "ohmail" with the terracotta period. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={["l-wordmark", className].filter(Boolean).join(" ")}>
      ohmail<span className="l-wordmark-dot" aria-hidden="true">.</span>
    </span>
  );
}

/**
 * A label whose trailing period is the brand mark — "Get ohmail." on the
 * CTAs, "oh." in the hero lockup. The whole string stays in the message (so
 * a translation owns its own punctuation) and only the last character is
 * lifted into the accent span; anything that does not end in a period is
 * rendered untouched.
 */
export function DotLabel({ text }: { text: string }) {
  if (!text.endsWith(".")) return <>{text}</>;
  /* one wrapping span, deliberately: .btn is an inline-flex row with a gap,
     and two bare children would put 7px of air before the period */
  return (
    <span>
      {text.slice(0, -1)}
      <span className="l-wordmark-dot">.</span>
    </span>
  );
}
