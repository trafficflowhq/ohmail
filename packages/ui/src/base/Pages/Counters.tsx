import { EndDot } from "../Primitives/EndDot.js";
import "./counters.css";

export interface Counter {
  /** The id its numeral carries: an anchor for what points at it, and the row's own key. Nothing writes into it. */
  id?: string;
  /** The numeral, as it is printed: "1,204". A count rises by handing the next figure: the part draws what it holds. */
  figure: string;
  /** What it counts, in words: "screened", "in History". */
  words: string;
  /** The dot its words end in. Left out: ink. */
  end?: "hot" | "ink" | "none";
}

export interface CountersProps {
  /** `xl`: a page's own figures, in the place of its sentence. */
  size?: "xl";
  /** A numeral and its words a line. */
  rows: readonly Counter[];
}

/**
 * What is being counted, as the page's own sentence: a list of numerals in the display face, each with its words
 * beside it, ending in the dot. The numerals stand in one column, set to the right, so they count up in place.
 */
export function Counters({ size, rows }: CountersProps) {
  if (rows.length === 0) return null;
  return (
    <dl className="oh-counters" data-size={size}>
      {rows.map((row) => (
        <div key={row.id ?? row.words} className="oh-counters-row">
          <dt id={row.id} className="oh-counters-figure">
            {row.figure}
          </dt>
          <dd className="oh-counters-words">
            {row.end === "none" ? row.words : <EndDot kind={row.end ?? "ink"}>{row.words}</EndDot>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
