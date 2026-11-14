import { Dot } from "../Primitives/Dot.js";
import "./step-dots.css";

export interface StepDotsProps {
  /**
   * How far the walk is, in words: "Step 2 of 5, Mailbox", with the phase's own screen where it has several
   * ("…, 2 of 3"). The dots are one mark that says this, never five things to read.
   */
  label: string;
  /** How many phases the walk has, and the one it is in, counted from 0. */
  steps: number;
  at: number;
  /** Where the phase has several screens, which one this is, as it is printed: "2/3". It is said by `label`. */
  sub?: string;
}

/**
 * How far a walk is, at a page's top: a dot a phase, done in ink, the one it is in hot, those ahead hollow. It
 * shows where a person is and is no way to go there.
 */
export function StepDots({ label, steps, at, sub }: StepDotsProps) {
  return (
    <span className="oh-stepdots">
      {sub ? (
        <span className="oh-stepdots-sub" aria-hidden="true">
          {sub}
        </span>
      ) : null}
      <span className="oh-stepdots-mark" role="img" aria-label={label}>
        {Array.from({ length: steps }, (_, step) => (
          <Dot key={step} kind={step < at ? "ink" : step === at ? "hot" : "todo"} />
        ))}
      </span>
    </span>
  );
}
