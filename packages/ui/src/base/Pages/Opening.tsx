import type { ReactNode } from "react";
import { EndDot } from "../Primitives/EndDot.js";
import { useSaidOnArrival } from "../said-on-arrival.js";
import "./opening.css";
import { RowsShape } from "./RowsShape.js";
import { Bar } from "./shape-bar.js";

export type OpeningProps =
  | {
      /** `window`: the menu, the list and the reading column as shape. `phone`: the list as shape. */
      kind: "window" | "phone";
      /** What is happening, said only once the wait has lasted: a line, how far it is, a note. */
      status?: { label: string; count?: string; note?: string };
    }
  | {
      kind: "web";
      label?: string;
      action?: ReactNode;
      /** Delay the server's Reload link while the page's scripts have time to run. */
      late?: boolean;
      /** Show the opening status immediately while the Reload link is delayed. */
      immediate?: boolean;
    };

/* The shapes: how wide each bar is, in parts of a hundred. A menu's groups. */
const MENU = [[58, 46, 52], [44], [56, 38, 50], [48, 40, 44, 52]] as const;

/** While the app opens: its own measures as bars, and never a word of mail. No spinner. */
export function Opening(props: OpeningProps) {
  if (props.kind === "web") {
    return (
      <main className="oh-opening" data-kind="web">
        <div
          className="oh-opening-web"
          data-late={props.late ? "" : undefined}
          data-immediate={props.immediate ? "" : undefined}
        >
          <p className="oh-display oh-opening-title" role="status">
            {props.label ? <EndDot kind="hot">{props.label}</EndDot> : null}
          </p>
          {props.action}
        </div>
      </main>
    );
  }
  return <OpeningShape {...props} />;
}

function OpeningShape({ kind, status }: Exclude<OpeningProps, { kind: "web" }>) {
  /* The line appears once the wait has lasted: said by a change inside a region that stands. */
  const held = useSaidOnArrival(Boolean(status)) ? true : undefined;
  const line = status ? (
    <div className="oh-opening-line" role="status" aria-live="polite">
      <b className="oh-opening-say" aria-hidden={held}>
        <EndDot kind="hot">{status.label}</EndDot>
      </b>
      {status.count ? (
        <span className="oh-opening-count" aria-hidden={held}>
          {status.count}
        </span>
      ) : null}
      {status.note ? (
        <small className="oh-opening-note" aria-hidden={held}>
          {status.note}
        </small>
      ) : null}
    </div>
  ) : null;
  const rows = <RowsShape />;
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
