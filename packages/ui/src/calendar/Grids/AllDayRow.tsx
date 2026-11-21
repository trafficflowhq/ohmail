import { Children, type CSSProperties, type ReactNode } from "react";
import { dayColumn } from "./time-grid-layout.js";
import "./all-day-row.css";

export interface AllDayRowProps {
  /** The accessible name of the lane when it holds events. */
  label: string;
  /** How many days the lane spans, where it stands outside a time grid. Inside one it takes the grid's. */
  days?: number;
  targets?: readonly string[];
  crease?: number;
  /**
   * The pills, each placed by `style.gridColumn` and `style.gridRow`: column 1 is the gutter, so day
   * `i` (from 0) is column `i + 2`; a run takes the first free row.
   */
  children?: ReactNode;
}

/**
 * Events that last the whole day, and runs across days. The lane stands above the hours, outside
 * what scrolls. With nothing in it, it is a strip of air and says nothing.
 */
export function AllDayRow({ label, days, targets, crease = 0, children }: AllDayRowProps) {
  const none = Children.count(children) === 0;
  return (
    <div
      className="oh-allday"
      role={none ? undefined : "group"}
      aria-label={none ? undefined : label}
      data-none={none ? "" : undefined}
      data-cal-all-day-lane={targets ? "" : undefined}
      style={days === undefined ? undefined : ({ "--oh-tg-days": days } as CSSProperties)}
    >
      {none
        ? null
        : targets?.map((day, index) => (
            <span
              key={day}
              aria-hidden
              data-cal-drop-day={day}
              data-cal-drop-kind="all-day"
              style={{ gridColumn: dayColumn(index, crease), gridRow: "1 / -1" }}
            />
          ))}
      {children}
    </div>
  );
}
