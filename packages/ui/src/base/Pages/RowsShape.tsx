import { Bar } from "./shape-bar.js";
import "./rows-shape.css";

/* How wide each bar of a row is, in parts of a hundred: who, the subject, the first line. */
const ROWS = [
  [34, 62, 84],
  [27, 74, 68],
  [41, 58, 76],
  [30, 70, 88],
  [37, 66, 62],
  [25, 54, 80],
  [39, 71, 71],
  [32, 60, 78],
  [28, 68, 66],
] as const;

export interface RowsShapeProps {
  /** How many rows stand: as many as the list's room shows. Left out: nine. */
  rows?: number;
  /** It stands among a list's own rows (one row still owed): no box of its own around its rows. */
  within?: boolean;
}

/**
 * A list's rows as shape, in the list's own measures, while its mail is owed: never a word of mail, and nothing
 * for a screen reader (what is being read is said by the list's own line).
 */
export function RowsShape({ rows = ROWS.length, within }: RowsShapeProps) {
  const shapes = Array.from({ length: Math.max(0, rows) }, (_, at) => ROWS[at % ROWS.length]!);
  return (
    <div className="oh-rowsshape" data-within={within ? "" : undefined} aria-hidden="true">
      {shapes.map(([who, subject, first], at) => (
        <span key={at} className="oh-rowsshape-row">
          <i className="oh-rowsshape-face" />
          <span className="oh-rowsshape-first">
            <Bar part={who} as="who" />
            <Bar as="time" />
          </span>
          <Bar part={subject} />
          <Bar part={first} as="more" />
        </span>
      ))}
    </div>
  );
}
