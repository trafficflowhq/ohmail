import type { ReactNode } from "react";
import { Count, Tag } from "../../base/index.js";
import "./figure-line.css";

export interface FigureLineProps {
  /** The figure the sheet is about, as it is printed: "12.4 GB". */
  figure: string;
  /** What it is of, after it: "of 50 GB · trial". */
  of?: string;
  /** What says once what the figure counts: an InfoMark. */
  info?: ReactNode;
  /** A word at the line's end: "Your plan". */
  tag?: string;
}

/** The figure a sheet is about: the number first, large and in the ink, then what it is of. */
export function FigureLine({ figure, of, info, tag }: FigureLineProps) {
  return (
    <p className="oh-text oh-figureline">
      <Count kind="point">{figure}</Count>
      {of ? <span className="oh-figureline-of">{of}</span> : null}
      {info}
      {tag ? <Tag>{tag}</Tag> : null}
    </p>
  );
}
