import type { ReactNode } from "react";
import { Icon } from "../icons.js";
import "./info-note.css";

export interface InfoNoteProps {
  /**
   * THE ONE LINE THAT IS ALWAYS VISIBLE. It has to stand alone: the disclosure is closed by
   * default, so anything a person must read before acting belongs here and not in `children`.
   */
  lead: ReactNode;
  /** The explanation that opens. Present in the DOM either way — see the note below. */
  children: ReactNode;
  /** Accessible name for the toggle, appended to the lead. Defaults to "More about this". */
  moreLabel: string;
  className?: string;
}

/**
 * A compact (i) disclosure — one line of essential text, the rest a press
 * away: explanations stay true and reachable but stop spending vertical
 * space until asked for. `<details>`, not a useState toggle: the summary
 * is a button to assistive technology, the open state is keyboard-operable,
 * and server render and hydration cannot disagree. Note for tests: the
 * collapsed text IS in the DOM (`<details>` hides, it does not unrender) —
 * asserting a sentence's presence proves it exists, not that anyone can
 * see it; a test that means "visible" reads `open` on the element.
 */
export function InfoNote({ lead, children, moreLabel, className }: InfoNoteProps) {
  return (
    <details className={className ? `infonote ${className}` : "infonote"}>
      <summary className="infonote-sum">
        <span className="infonote-lead">{lead}</span>
        {/* The affordance. `aria-hidden` because the summary already announces itself as a
            toggle and names itself with the lead; the label below is what says what opening
            it gets you, and it is the only part a reader needs that the lead does not give. */}
        <span className="infonote-i" aria-hidden="true">
          <Icon name="info" size={13} />
        </span>
        <span className="infonote-sr">{moreLabel}</span>
      </summary>
      <div className="infonote-more">{children}</div>
    </details>
  );
}
