import type { ReactNode } from "react";
import "./letter-history.css";

export interface LetterQuoteProps {
  /** Who wrote it and when, as one line: "On Fri 6 Nov 2026 at 18:31, Mila Brunner wrote:". */
  attribution: string;
  /** What was written; a quote it carries itself comes after its text. */
  children: ReactNode;
}

/** A quoted message: who wrote it, then its text behind a line. */
export function LetterQuote({ attribution, children }: LetterQuoteProps) {
  return (
    <>
      <p className="oh-text oh-history-attribution">{attribution}</p>
      <blockquote className="oh-history-quote">{children}</blockquote>
    </>
  );
}
