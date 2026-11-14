import type { ReactNode } from "react";
import { EndDot } from "../../base/index.js";
import "./blank-column.css";

export interface BlankColumnProps {
  /** What the place holds, as a count or a label: "5 unread", "All read", "Nothing open". */
  children: string;
  /** Something in it is unread: the full stop is hot. */
  hot?: boolean;
  /** What the place shows under its label while nothing is open: the day's events. */
  below?: ReactNode;
}

/** Nothing is open: the column says what the place holds, and nothing else. */
export function BlankColumn({ children, hot, below }: BlankColumnProps) {
  return (
    <div className="oh-blankcolumn" data-blank-column="">
      <div className="oh-blankcolumn-content">
        <p className="oh-text oh-display oh-blankcolumn-label">
          <EndDot kind={hot ? "hot" : "ink"}>{children}</EndDot>
        </p>
      </div>
      {below}
    </div>
  );
}
