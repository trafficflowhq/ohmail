import type { CSSProperties, MouseEventHandler } from "react";
import "./week-number.css";

export interface WeekNumberProps {
  /** The week of the row it starts. */
  number: number;
  /** Its name in full: "Week 46". */
  label: string;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  /** Its row, where the grid it stands in places it. */
  style?: Pick<CSSProperties, "gridRow">;
}

/**
 * The week of a row of days. It stands in the room left of the row's first day and takes none of
 * its own; a press opens that week. Which week a row carries is the app's to say.
 */
export function WeekNumber({ number, label, onPress, style }: WeekNumberProps) {
  return (
    <button
      type="button"
      className="oh-control oh-wn"
      aria-label={label}
      title={label}
      style={style}
      onClick={onPress}
    >
      {number}
    </button>
  );
}
