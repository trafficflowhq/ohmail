import type { ReactNode } from "react";
import "./sentence.css";

export interface SentenceProps {
  /** The words, with the slots, the blanks and the dot that stand in them. */
  children: ReactNode;
  /** `xl`: the one question of a page. */
  size?: "xl";
  /** Where it is the title of what it stands in, its level. */
  level?: 1 | 2 | 3;
  id?: string;
}

/** A line in the display face that is the control itself. One question a sentence; it ends in the dot. */
export function Sentence({ children, size, level, id }: SentenceProps) {
  const Line = level ? (`h${level}` as const) : "p";
  return (
    <Line id={id} className="oh-text oh-sentence" data-size={size}>
      {children}
    </Line>
  );
}
