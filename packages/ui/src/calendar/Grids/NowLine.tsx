import "./now-line.css";

export interface NowLineProps {
  /** Where now stands on the hours it is drawn in, in px from their first hour. */
  top: number;
}

/**
 * The line of now, across today's column. Its dot can echo the date badge when Today is pressed.
 * A time grid draws it, and the time beside it in the gutter, from the minutes it is handed.
 */
export function NowLine({ top }: NowLineProps) {
  return <i className="oh-now" data-today-pulse-target="now" aria-hidden style={{ top }} />;
}
