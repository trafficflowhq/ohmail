import type { MouseEventHandler } from "react";
import { Dot } from "../../base/Primitives/Dot.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import { CalendarSquare } from "../Grids/CalendarSquare.js";
import type { CalendarTone } from "../tone.js";
import "./calendar-row.css";

export interface CalendarRowProps {
  name: string;
  /** Whose hue; `"neutral"` for a calendar without one and for a kind of mail. */
  tone: CalendarTone;
  /** Whether it shows on the calendar. Hidden, its square is hollow and its name steps back. */
  shown: boolean;
  /** The switch's name: "Show Mila". */
  switchLabel: string;
  onToggle?: (shown: boolean) => void;
  /** New events go here: the ink dot after the name, and what it says. */
  defaultLabel?: string;
  /** View only: a lock, and what it says. */
  viewOnlyLabel?: string;
  /** The lock shows only while the row is pointed at or holds the keys. */
  quiet?: boolean;
  /** Whether the name's menu stands open. */
  menuOpen?: boolean;
  onMenu?: MouseEventHandler<HTMLButtonElement>;
  /** A kind of mail that draws on the calendar (dated mail, events found in mail): its glyph. The whole row is then the switch. */
  layerIcon?: IconName;
}

/**
 * A calendar: its square shows or hides it and its name opens its menu. A kind of mail that draws on
 * the calendar is a row of the same kind, with a grey square, and is one switch as a whole.
 */
export function CalendarRow(p: CalendarRowProps) {
  const square = <CalendarSquare tone={p.tone} hollow={!p.shown} />;
  if (p.layerIcon) {
    return (
      <button
        type="button"
        className="oh-control oh-calrow"
        data-hidden={p.shown ? undefined : ""}
        role="switch"
        aria-checked={p.shown}
        aria-label={p.switchLabel}
        onClick={() => p.onToggle?.(!p.shown)}
      >
        <span className="oh-calrow-sq">{square}</span>
        <span className="oh-calrow-name">
          <span className="oh-calrow-word">{p.name}</span>
          <Icon name={p.layerIcon} size={16} className="oh-calrow-ico" />
        </span>
      </button>
    );
  }
  const name = (
    <>
      <span className="oh-calrow-word">
        {p.name}
        {p.defaultLabel ? (
          <span title={p.defaultLabel}>
            <Dot kind="ink" />
          </span>
        ) : null}
      </span>
      {p.viewOnlyLabel ? (
        <Icon name="lock" size={16} label={p.viewOnlyLabel} className="oh-calrow-ico" />
      ) : null}
    </>
  );
  return (
    <div className="oh-calrow" data-hidden={p.shown ? undefined : ""} data-quiet={p.quiet ? "" : undefined}>
      <button
        type="button"
        disabled={p.onToggle === undefined}
        className="oh-control oh-calrow-sq"
        role="switch"
        aria-checked={p.shown}
        aria-label={p.switchLabel}
        onClick={() => p.onToggle?.(!p.shown)}
      >
        {square}
      </button>
      {p.onMenu ? (
        <button
          type="button"
          className="oh-control oh-calrow-name"
          title={p.name}
          aria-haspopup="menu"
          aria-expanded={p.menuOpen ?? false}
          onClick={p.onMenu}
        >
          {name}
        </button>
      ) : (
        <span className="oh-calrow-name" title={p.name}>
          {name}
        </span>
      )}
    </div>
  );
}
