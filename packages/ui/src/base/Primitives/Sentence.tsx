import type { ReactNode } from "react";
import { EndDot } from "./EndDot.js";
import "./sentence.css";

interface SentenceShared {
  /** `xl`: the one question of a page. */
  size?: "xl";
  /** Where it is the title of what it stands in, its level. */
  level?: 1 | 2 | 3;
  id?: string;
}

/** A sentence put together where it is drawn: the words, with the slots, the blanks and the dot that stand in them. */
interface SentenceOfParts extends SentenceShared {
  children: ReactNode;
  end?: never;
}

/**
 * A sentence handed whole, as a catalogue writes it, that ends in the dot: `hot` while something waits on the
 * person, `ink` once it is done. The sentence keeps its own punctuation, which a translation owns: its closing full
 * stop becomes the dot, a sentence that ends on a word gets one, and one that ends on any other mark (an ellipsis, a
 * question mark) is said as it stands.
 */
interface SentenceWhole extends SentenceShared {
  children: string;
  end: "hot" | "ink";
}

export type SentenceProps = SentenceOfParts | SentenceWhole;

/** Whether a sentence ends on a letter or a numeral once its closing full stop is off: then the dot ends it. */
const ENDS_ON_A_WORD = /[\p{L}\p{N}]$/u;

/** A line in the display face that is the control itself. One question a sentence; it ends in the dot. */
export function Sentence({ children, size, level, id, end }: SentenceProps) {
  const Line = level ? (`h${level}` as const) : "p";
  return (
    <Line id={id} className="oh-text oh-sentence" data-size={size}>
      {end ? whole(children as string, end) : children}
    </Line>
  );
}

function whole(written: string, end: "hot" | "ink"): ReactNode {
  const words = written.endsWith(".") && !written.endsWith("..") ? written.slice(0, -1) : written;
  return ENDS_ON_A_WORD.test(words) ? <EndDot kind={end}>{words}</EndDot> : written;
}
