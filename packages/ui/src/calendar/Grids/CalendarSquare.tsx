import { cx, toneOf, toneStyle, type CalendarTone } from "../tone.js";
import "./calendar-square.css";

export interface CalendarSquareProps {
  /** Whose it is. Left out, the square wears the colour of the calendar part it stands in. */
  tone?: CalendarTone;
  /** 8 in a chip or rail row, 10 in the folded rail, 12 in the agenda gutter, 6 in the phone month. */
  size?: 6 | 8 | 10 | 12;
  /** A calendar that is hidden: the square is hollow. */
  hollow?: boolean;
}

/**
 * Whose it is: one square in the calendar's hue. It is decoration beside a name, never a state and
 * never a control of its own.
 */
export function CalendarSquare({ tone, size = 8, hollow = false }: CalendarSquareProps) {
  const own = tone === undefined ? { className: "" } : toneOf(tone);
  return (
    <span
      aria-hidden
      className={cx("oh-csq", own.className)}
      data-tone={own["data-tone"]}
      data-size={size === 8 ? undefined : size}
      data-hollow={hollow ? "" : undefined}
      style={tone === undefined ? undefined : toneStyle(tone)}
    />
  );
}
