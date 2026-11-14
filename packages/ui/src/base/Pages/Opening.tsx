import type { CSSProperties } from "react";
import { EndDot } from "../Primitives/EndDot.js";
import "./opening.css";

export interface OpeningProps {
  /** `window`: the menu, the list and the reading column as shape. `phone`: the list as shape. */
  kind: "window" | "phone";
  /** What is happening, said only once the wait has lasted: a line, how far it is, a note. */
  status?: { label: string; count?: string; note?: string };
}

/* The shapes: how wide each bar is, in parts of a hundred. A menu's groups, and a list's rows (who, subject, first line). */
const MENU = [[58, 46, 52], [44], [56, 38, 50], [48, 40, 44, 52]] as const;
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
  [36, 56, 82],
] as const;
const wide = (part: number): CSSProperties => ({ "--oh-opening-part": `${part}%` }) as CSSProperties;
const Bar = ({ part, as }: { part?: number; as?: string }) => (
  <i className="oh-opening-bar" data-as={as} style={part === undefined ? undefined : wide(part)} />
);

/** While the app opens: its own measures as bars, and never a word of mail. No spinner. */
export function Opening({ kind, status }: OpeningProps) {
  const line = status ? (
    <div className="oh-opening-line" role="status" aria-live="polite">
      <b className="oh-opening-say">
        <EndDot kind="hot">{status.label}</EndDot>
      </b>
      {status.count ? <span className="oh-opening-count">{status.count}</span> : null}
      {status.note ? <small className="oh-opening-note">{status.note}</small> : null}
    </div>
  ) : null;
  const rows = (
    <div className="oh-opening-rows" aria-hidden="true">
      {ROWS.map(([who, subject, first]) => (
        <span key={`${who}-${subject}`} className="oh-opening-row">
          <i className="oh-opening-face" />
          <span className="oh-opening-first">
            <Bar part={who} as="who" />
            <Bar as="time" />
          </span>
          <Bar part={subject} />
          <Bar part={first} as="more" />
        </span>
      ))}
    </div>
  );
  if (kind === "phone")
    return (
      <div className="oh-opening" data-kind="phone">
        <div className="oh-opening-top" aria-hidden="true">
          <Bar as="title" />
        </div>
        {line ?? <span />}
        <div className="oh-opening-sheet">{rows}</div>
      </div>
    );
  return (
    <div className="oh-opening" data-kind="window">
      <div className="oh-opening-menu" aria-hidden="true">
        <i className="oh-opening-pill" data-as="switch" />
        <i className="oh-opening-pill" data-as="write" />
        {MENU.map((group) => (
          <span key={group.join("-")} className="oh-opening-group">
            {group.map((part) => (
              <span key={part} className="oh-opening-item">
                <i className="oh-opening-sign" />
                <Bar part={part} />
              </span>
            ))}
          </span>
        ))}
      </div>
      <div className="oh-opening-foot">{line}</div>
      <div className="oh-opening-sheet">
        <div className="oh-opening-head" aria-hidden="true">
          <Bar as="title" />
        </div>
        {rows}
      </div>
    </div>
  );
}
