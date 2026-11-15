import "./now-line.css";

export interface NowLineProps {
  /** Where now stands on the hours it is drawn in, in px from their first hour. */
  top: number;
}

/**
 * The line of now, across today's column. It moves by its `top` alone and nothing in it animates.
 * A time grid draws it, and the time beside it in the gutter, from the minutes it is handed.
 */
export function NowLine({ top }: NowLineProps) {
  return <i className="oh-now" aria-hidden style={{ top }} />;
}
