import type { ReactNode } from "react";
import { Dot, Icon, type IconName } from "@ohmail/ui/base";
import "./sheet.css";

/**
 * A SHEET OF THE DOORS' OWN, beside a page's sentence: what an app may do, what is erased and what is kept, where a
 * token is read, the ways out of a wall. It stands on the stage as a white sheet, and what stands on it takes the
 * sheet's soft ground.
 */
export function DoorSheet({ children, kind }: { children: ReactNode; kind: "facts" | "ways" }): ReactNode {
  return (
    <div className="way-sheet" data-kind={kind}>
      {children}
    </div>
  );
}

/** A list of facts on a sheet: an optional small title, each fact after its dot, and a plain line under them. */
export function Facts(p: {
  title?: string;
  items: readonly string[];
  fine?: ReactNode;
  /** The delete page's two sheets stand one over the other: each a little tighter. */
  tight?: boolean;
}): ReactNode {
  return (
    <div className="way-sheet" data-kind="facts" data-tight={p.tight ? "" : undefined}>
      {p.title === undefined ? null : <h3 className="way-sheet-title">{p.title}</h3>}
      <ul className="way-fact-list">
        {p.items.map((item) => (
          <li key={item} className="way-fact">
            <span className="way-fact-dot">
              <Dot kind="ink" />
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {p.fine === undefined ? null : <p className="way-fine">{p.fine}</p>}
    </div>
  );
}

/** The ways out of a wall, on a sheet: one row each. */
export function Ways({ children }: { children: ReactNode }): ReactNode {
  return (
    <DoorSheet kind="ways">
      <div className="way-rows" role="list">
        {children}
      </div>
    </DoorSheet>
  );
}

/** A way out: its icon, its name, and the one line that says what it does. The whole row is the press. */
export function Way(p: {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <div role="listitem">
      <button type="button" className="way-row" onClick={p.onPress} disabled={p.disabled}>
        <span className="way-row-icon">
          <Icon name={p.icon} size={20} />
        </span>
        <span className="way-row-label">{p.label}</span>
        <span className="way-row-hint">{p.hint}</span>
      </button>
    </div>
  );
}
