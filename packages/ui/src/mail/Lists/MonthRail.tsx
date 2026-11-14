import type { ReactNode } from "react";
import "./month-rail.css";

/** One step of the rail: a year, or a month of the year on show. */
export interface MonthRailEntry {
  id: string;
  /** As it is printed: "2026", "Nov". */
  label: string;
  /** Its whole name where the label is a short one: "November 2026". */
  title?: string;
  /** A year: it stands heavier than its months. */
  year?: boolean;
}

export interface MonthRailProps {
  /** The rail's name: "Month", or "Year" where it steps by years alone. */
  label: string;
  /** The steps, newest first, as the app lays them out for the room it has. */
  entries: readonly MonthRailEntry[];
  /** The step the list is at. */
  current?: string;
  onPick?: (id: string) => void;
  /** The list it steps through: the rows, and what the list says under them. */
  children?: ReactNode;
}

/**
 * The way through a long list's time, at the list's right edge. It holds the list: the rail stays at the top of
 * the box the rows scroll in while they run under it, and the rows end where the rail starts. With no step to
 * take, the list stands as if alone: its boxes are there and draw nothing.
 */
export function MonthRail({ label, entries, current, onPick, children }: MonthRailProps) {
  /* The same box with and without steps: rows that stand before the steps arrive keep their nodes, and the keys. */
  if (entries.length === 0)
    return (
      <div className="oh-monthrail" data-bare="">
        <div key="list" className="oh-monthrail-list">
          {children}
        </div>
      </div>
    );
  return (
    <div className="oh-monthrail">
      <div key="keep" className="oh-monthrail-keep">
        <nav className="oh-monthrail-steps" aria-label={label}>
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="oh-control oh-monthrail-step"
              data-year={entry.year ? "" : undefined}
              aria-current={entry.id === current ? "true" : undefined}
              aria-label={entry.title}
              title={entry.title}
              onClick={() => onPick?.(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </div>
      <div key="list" className="oh-monthrail-list">
        {children}
      </div>
    </div>
  );
}
