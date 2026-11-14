import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import { cssPoint } from "../../base/ui-zoom.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import { cx, toneOf, toneStyle, type CalendarTone } from "../tone.js";
import { CalendarSquare } from "./CalendarSquare.js";
import "./agenda-row.css";

/** What stands in the gutter: the calendar's square, an outline (on no calendar yet), the letter's glyph (found in mail), dated mail's glyph, a draft's dashes. */
export type AgendaMark =
  | { kind: "calendar"; tone: CalendarTone }
  | { kind: "outlined" }
  | { kind: "found" }
  | { kind: "mail"; icon: IconName }
  | { kind: "draft"; tone: CalendarTone };

export interface AgendaRowProps {
  mark: AgendaMark;
  title: string;
  /** What stands where the time does: the hours, "all day", "until 10:00", or the day in a list across many days. */
  time: string;
  /** The second line: the place, who it is from. */
  second?: string;
  /** Before the time: a tag. */
  tag?: ReactNode;
  /** On now: bold, and its time in the hot ink. */
  now?: boolean;
  /** A lighter drawing: maybe, a found event, dated mail. */
  quiet?: boolean;
  /** Cancelled, or declined and still shown: struck. */
  off?: boolean;
  /** It waits for you: the dot before the time. */
  waits?: boolean;
  /** The one that is open. */
  open?: boolean;
  /** What the typing line makes: dashed, and no button. */
  draft?: boolean;
  /** Controls of the row's own under its lines: the answers, Add. */
  tail?: ReactNode;
  /** The accessible name, where the words drawn do not say enough. */
  label?: string;
  onOpen?: () => void;
  /** A right click, the menu key or Shift F10: the row's menu, where the pointer is. */
  onMenu?: (at: { x: number; y: number }) => void;
  ref?: Ref<HTMLDivElement>;
}

function gutter(mark: AgendaMark): ReactNode {
  if (mark.kind === "calendar") return <CalendarSquare tone={mark.tone} size={12} />;
  if (mark.kind === "outlined") return <i className="oh-erow-out" aria-hidden />;
  if (mark.kind === "draft") return <i className="oh-erow-drsq" aria-hidden />;
  if (mark.kind === "found") {
    return (
      <i className="oh-erow-found" aria-hidden>
        <Icon name="frommail" size={16} className="oh-erow-ico" />
      </i>
    );
  }
  return <Icon name={mark.icon} size={18} className="oh-erow-ico" />;
}

/**
 * One event in a list: the Agenda, Invitations, From mail, Search. A press takes the calendar to
 * the event and opens it there; the open row is marked and nothing moves under the press.
 */
export function AgendaRow(p: AgendaRowProps) {
  const tone = p.mark.kind === "draft" ? p.mark.tone : null;
  const own = toneOf(tone);
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    p.onOpen?.();
  };
  const menu = p.onMenu
    ? (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        p.onMenu?.(cssPoint(event));
      }
    : undefined;
  const press = p.draft
    ? {}
    : {
        role: "button",
        tabIndex: 0,
        "aria-expanded": p.open ?? false,
        "aria-label": p.label,
        onClick: p.onOpen,
        onKeyDown: key,
        onContextMenu: menu,
      };
  return (
    <div
      ref={p.ref}
      className={cx("oh-erow", own.className)}
      data-tone={own["data-tone"]}
      style={toneStyle(tone)}
      data-now={p.now ? "" : undefined}
      data-quiet={p.quiet ? "" : undefined}
      data-off={p.off ? "" : undefined}
      data-open={p.open ? "" : undefined}
      data-draft={p.draft ? "" : undefined}
      data-tail={p.tail ? "" : undefined}
      {...press}
    >
      <span className="oh-erow-mark">{gutter(p.mark)}</span>
      <span className="oh-erow-first">
        <span className="oh-erow-title">{p.title}</span>
        <span className="oh-erow-room" />
        {p.waits ? <span className="oh-cal-wait" aria-hidden /> : null}
        {p.tag}
        <time className="oh-erow-time">{p.time}</time>
      </span>
      <span className="oh-erow-second">{p.second ?? " "}</span>
      {p.tail ? (
        <span
          className="oh-erow-tail"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {p.tail}
        </span>
      ) : null}
    </div>
  );
}
