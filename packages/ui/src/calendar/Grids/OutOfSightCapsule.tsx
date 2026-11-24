import type { CSSProperties, MouseEventHandler } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import type { CalendarTone } from "../tone.js";
import { CalendarSquare } from "./CalendarSquare.js";
import "./out-of-sight-capsule.css";

/** One thing out of sight: an event in its calendar's square, one on no calendar yet, one found in mail, or dated mail. */
export type OutOfSightItem = (
  | { kind: "calendar"; tone: CalendarTone }
  | { kind: "outlined" }
  | { kind: "dashed" }
  | { kind: "mail"; icon: IconName }
) & {
  /** The day alone has the room to say the time and the title too. */
  text?: string;
};

export interface OutOfSightCapsuleProps {
  /** The edge the things left by. */
  side: "above" | "below";
  /** What is wholly out of sight that way, the nearest first. Four are shown. */
  items: OutOfSightItem[];
  /** What a press does, said in full: the capsule shows squares and no word of its own. */
  label: string;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  /** Its day's column in the grid it stands in. */
  style?: Pick<CSSProperties, "gridColumn">;
}

const SHOWN = 4;

function mark(item: OutOfSightItem) {
  if (item.kind === "calendar") return <CalendarSquare tone={item.tone} />;
  if (item.kind === "mail") return <Icon name={item.icon} size={16} className="oh-oos-glyph" />;
  return <i className="oh-oos-sq" data-dashed={item.kind === "dashed" ? "" : undefined} aria-hidden />;
}

/**
 * What lies out of sight in a time grid, at the edge it left by: a chevron and the squares of what
 * is that way. A press goes to the nearest of them. With nothing out of sight there is no capsule.
 */
export function OutOfSightCapsule({ side, items, label, onPress, style }: OutOfSightCapsuleProps) {
  if (items.length === 0) return null;
  return (
    <button
      type="button"
      className="oh-control oh-oos"
      data-side={side}
      aria-label={label}
      style={style}
      onClick={onPress}
    >
      <Icon name="down" size={16} className="oh-oos-way" />
      {items.slice(0, SHOWN).map((item, i) => (
        <span className="oh-oos-item" key={i}>
          {item.text ? <span className="oh-oos-text">{item.text}</span> : null}
          {mark(item)}
        </span>
      ))}
    </button>
  );
}
