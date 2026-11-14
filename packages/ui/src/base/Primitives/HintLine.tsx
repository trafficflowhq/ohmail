import "./hint-line.css";
import { KeyHint } from "./KeyHint.js";

export interface HintLineProps {
  /** The keys of the zone that has them, each with what it does, in order. */
  hints: readonly { key: string; label: string }[];
  /** Shown whatever the face says: where key hints are switched on. */
  shown?: boolean;
}

/** One line at a column's foot that says what the keys do here. A decoration: the key help says it to everyone. */
export function HintLine({ hints, shown }: HintLineProps) {
  return (
    <p className="oh-text oh-hintline" data-shown={shown ? "" : undefined} aria-hidden="true">
      {hints.map((hint) => (
        <span key={`${hint.key} ${hint.label}`} className="oh-hintline-item">
          <KeyHint>{hint.key}</KeyHint>
          {hint.label}
        </span>
      ))}
    </p>
  );
}
