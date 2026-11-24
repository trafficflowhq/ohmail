import type { ReactNode } from "react";
import { Dot } from "@ohmail/ui/base";
import "./progress.css";

/** The steps of a new account, as the design counts them: account, factor, codes, plan, mailbox. */
const STEPS = 5;

/**
 * HOW FAR A NEW ACCOUNT IS, at a first step's top (a household invite, a server's first account): the part of the
 * step it is at, for the eye ("1/3"), and the account's five steps as dots, the first one on screen and the rest ahead,
 * said to a screen reader as one picture by its sentence (`said`).
 */
export function Steps({ said, part }: { said: string; part: string }): ReactNode {
  return (
    <span className="way-steps">
      <span className="way-steps-part" aria-hidden="true">
        {part}
      </span>
      <span className="way-steps-dots" role="img" aria-label={said}>
        {Array.from({ length: STEPS }, (_, i) => (
          <Dot key={i} kind={i === 0 ? "hot" : "todo"} />
        ))}
      </span>
    </span>
  );
}
