import type { CSSProperties } from "react";
import { TagDot } from "../../base/index.js";
import "./figure-table.css";

/** One row of figures: what it counts, its dot where it has a hue, and a figure a column. */
export interface FigureRow {
  id: string;
  name: string;
  /** Its dot, in the hue of what it counts. Left out: no dot. */
  hue?: number;
  figures: readonly string[];
}

export interface FigureTableProps {
  /** The table's name, where the sheet it stands on does not already say what it counts. */
  label?: string;
  /** The columns' names: the first names what a row counts, each of the others a figure. */
  columns: readonly string[];
  rows: readonly FigureRow[];
  /** The last row: what the figures come to. */
  sum?: { name: string; figures: readonly string[] };
}

/**
 * A few rows of figures under their columns' names. Under a finger the names' row gives way and every figure
 * stands under its own column's name.
 */
export function FigureTable({ label, columns, rows, sum }: FigureTableProps) {
  const [first, ...rest] = columns;
  const figures = (values: readonly string[]) =>
    values.map((value, at) => (
      <span key={at} className="oh-figuretable-figure" role="cell" data-column={rest[at]}>
        {value}
      </span>
    ));
  return (
    <div
      className="oh-figuretable"
      role="table"
      aria-label={label}
      style={{ "--oh-figuretable-n": rest.length } as CSSProperties}
    >
      <div className="oh-figuretable-row" role="row" data-head="">
        <span className="oh-figuretable-name" role="columnheader">
          {first}
        </span>
        {rest.map((column) => (
          <span key={column} className="oh-figuretable-figure" role="columnheader">
            {column}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.id} className="oh-figuretable-row" role="row">
          <span className="oh-figuretable-name" role="cell">
            {row.hue === undefined ? null : <TagDot hue={row.hue} />}
            <span className="oh-figuretable-word">{row.name}</span>
          </span>
          {figures(row.figures)}
        </div>
      ))}
      {sum ? (
        <div className="oh-figuretable-row" role="row" data-sum="">
          <span className="oh-figuretable-name" role="cell">
            <span className="oh-figuretable-word">{sum.name}</span>
          </span>
          {figures(sum.figures)}
        </div>
      ) : null}
    </div>
  );
}
