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
  moreLabel?: string;
  className?: string;
}

/**
 * A COMPACT (i) DISCLOSURE — one line of essential text, and the rest a press away.
 *
 * The problem it solves is a layout one. Several explanations in this app grew to three
 * sentences of furniture sitting above the content they explain, pushing the first row of a
 * list off the fold on a short window and taking two lines of a decision bar that has a
 * segmented control in the same row. They are all still TRUE and all still worth having — an
 * explanation that disappears is one nobody can go back to — so the answer is not to delete
 * them but to stop spending vertical space on them until they are asked for.
 *
 * ── WHY `<details>` AND NOT A `useState` TOGGLE ──────────────────────────────────────────────
 *
 * Three things come free and none of them are free by hand: the summary is a button to assistive
 * technology with the lead line as its accessible name, the open state is keyboard-operable with
 * no key handling of our own, and there is no client state, so a server-rendered page and its
 * hydrated self cannot disagree about whether the note is open.
 *
 * The fourth is the one worth stating outright, because it looks like a mistake if you meet it
 * in a test: **the collapsed text is in the DOM.** `<details>` hides its content with the
 * browser's own rules rather than by not rendering it, so `textContent` sees the whole
 * explanation whether or not it is on screen. That is the correct behaviour — find-in-page
 * reaches it, and a screen reader can walk it — but it does mean a test asserting the presence
 * of some detail sentence proves the sentence EXISTS, not that anybody can see it. A test that
 * means "visible" has to read `open` on the `<details>`.
 */
export function InfoNote({ lead, children, moreLabel = "More about this", className }: InfoNoteProps) {
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
