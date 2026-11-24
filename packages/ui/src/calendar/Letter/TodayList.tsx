import { useId, type CSSProperties, type ReactNode } from "react";
import { Dot } from "../../base/Primitives/Dot.js";
import { design } from "../../base/tokens.js";
import { Icon } from "../../icons/Icon.js";
import { CalendarSquare } from "../Grids/CalendarSquare.js";
import type { CalendarTone } from "../tone.js";
import "./today-list.css";

export interface TodayListRow {
  id: string;
  /** What leads the row: the calendar's square, an outline (on no calendar yet), the letter's glyph (found in mail). */
  mark: { kind: "calendar"; tone: CalendarTone } | { kind: "outlined" } | { kind: "found" };
  /** The hour, "now", or the day and the hour. */
  time: string;
  title: string;
  /** It is on now. */
  now?: boolean;
  /** Coming up only: what it waits for, where it is from. */
  tag?: { text: string; hot?: boolean };
  /** Opens the event's day. */
  onPress?: () => void;
}

export interface TodayListProps {
  /** `today`: the rest of the day, in the Ohbox's blank column. `coming`: what comes up with one person, on their card. */
  kind: "today" | "coming";
  /** Its name for a screen reader, where it has no heading of its own. */
  label: string;
  /** Today: the heading, with the calendar's dot, and the date beside it. */
  heading?: { title: string; date?: string };
  actions?: ReactNode;
  rows: readonly TodayListRow[];
  /** How many more there are than rows, as it is printed: "+2". */
  more?: string;
}

/* The calendar's own colour, inside mail: the values the tokens hold for it, one of which the
   stylesheet picks by the document's face and scheme. Ohmarchy has one accent, the theme's own. */
function calendarColours(): CSSProperties {
  const cal = design.accents[design.productAccent.cal].paper;
  const own = design.accents[design.productAccent.mail].ohmarchy;
  return {
    "--oh-today-hot-pl": cal.light.hot,
    "--oh-today-hot-pd": cal.dark.hot,
    "--oh-today-hot-ol": own.light.hot,
    "--oh-today-hot-od": own.dark.hot,
    "--oh-today-ink-pl": cal.light["hot-ink"],
    "--oh-today-ink-pd": cal.dark["hot-ink"],
    "--oh-today-ink-ol": own.light["hot-ink"],
    "--oh-today-ink-od": own.dark["hot-ink"],
  } as CSSProperties;
}
const COLOURS = calendarColours();

function mark(m: TodayListRow["mark"]): ReactNode {
  if (m.kind === "calendar") return <CalendarSquare tone={m.tone} />;
  if (m.kind === "outlined") return <i className="oh-today-out" aria-hidden="true" />;
  return <Icon name="frommail" size={16} className="oh-today-ico" />;
}

/**
 * Where the calendar shows in mail beside a letter's own card and row: Today, under the count of
 * an empty reading column, and Coming up on a person's card. Each row opens its event's day.
 */
export function TodayList({ kind, label, heading, rows, more, actions }: TodayListProps) {
  const id = useId();
  const named = heading ? { "aria-labelledby": id } : { "aria-label": label };
  return (
    <div className="oh-today" data-kind={kind} role="group" style={COLOURS} {...named}>
      {heading ? (
        <h4 id={id} className="oh-text oh-display oh-today-head">
          {heading.title}
          {heading.date ? (
            <>
              <Dot kind="ink" />
              <small className="oh-today-date">{heading.date}</small>
            </>
          ) : null}
          {kind === "coming" && more ? <small className="oh-today-date">{more}</small> : null}
        </h4>
      ) : null}
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="oh-control oh-today-row"
          data-now={row.now ? "" : undefined}
          onClick={row.onPress}
        >
          {kind === "today" ? (
            <>
              {mark(row.mark)}
              <time className="oh-today-time">{row.time}</time>
              <span className="oh-today-title">{row.title}</span>
            </>
          ) : (
            <>
              <span className="oh-today-mark">{mark(row.mark)}</span>
              <span className="oh-today-lines">
                <span className="oh-today-title">{row.title}</span>
                <span className="oh-today-second">
                  <time className="oh-today-time">{row.time}</time>
                  {row.tag ? (
                    <span className="oh-tag oh-today-tag" data-hot={row.tag.hot ? "" : undefined}>
                      {row.tag.text}
                    </span>
                  ) : null}
                </span>
              </span>
            </>
          )}
        </button>
      ))}
      {more && kind === "today" ? <p className="oh-text oh-today-more">{more}</p> : null}
      {actions}
    </div>
  );
}
