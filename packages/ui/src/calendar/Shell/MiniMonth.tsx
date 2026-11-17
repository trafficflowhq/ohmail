import type { MouseEventHandler } from "react";
import { Button } from "../../base/Primitives/Button.js";
import { Dot } from "../../base/Primitives/Dot.js";
import { WeekNumber } from "../Grids/WeekNumber.js";
import "./mini-month.css";

export interface MiniMonthDay {
  /** The app's own name for the day. */
  id: string;
  number: string;
  /** The day named in full: "Tuesday 10 November". */
  label: string;
  today?: boolean;
  /** The day you picked, where it is not today. */
  picked?: boolean;
  /** A day of the month before or after. */
  outside?: boolean;
  /** A day that cannot be picked here: in the second ink of a day outside the month, answering no pointer, and said to be unavailable. */
  disabled?: boolean;
  /** A day with something: its date is bold. */
  busy?: boolean;
  /** The week on screen stands on one band: where this day lies in it. */
  band?: "in" | "start" | "end" | "only";
}

export interface MiniMonthHead {
  /** The month's name, with its year where that is another one. */
  title: string;
  /** The month holds today: its dot is hot. */
  hot: boolean;
  before: { label: string; onPress?: MouseEventHandler<HTMLButtonElement> };
  after: { label: string; onPress?: MouseEventHandler<HTMLButtonElement> };
  /** A press on the month's name goes to that month: its name where the title is not its whole name. */
  open?: { label?: string; onPress?: MouseEventHandler<HTMLButtonElement> };
}

export interface MiniMonthProps {
  /** The head: the month's name and the two ways on. Left out in a menu, and in a widget. */
  head?: MiniMonthHead;
  /** The seven weekdays, one letter each, in the week's order. */
  weekdays: string[];
  /** Six weeks of days. */
  days: MiniMonthDay[];
  size?: "rail" | "phone" | "widget";
  /** One for each row, where the setting is on; `null` leaves a row without. */
  weekNumbers?: ({ number: number; label: string } | null)[];
  onDayPress?: (id: string) => void;
  /** A press on a week's number, by its row from 0. */
  onWeekPress?: (row: number) => void;
}

/**
 * A month to find a day in. A day with something is marked by a bold date alone; today and the
 * picked day carry their disc; only the week on screen is banded. It has no colour but hot.
 */
export function MiniMonth({
  head,
  weekdays,
  days,
  size = "rail",
  weekNumbers,
  onDayPress,
  onWeekPress,
}: MiniMonthProps) {
  return (
    <div className="oh-mini" data-size={size === "rail" ? undefined : size}>
      {head ? (
        <div className="oh-mini-head">
          {head.open ? (
            <button
              type="button"
              className="oh-control oh-display oh-mini-title"
              data-press=""
              aria-label={head.open.label}
              onClick={head.open.onPress}
            >
              {head.title}
              <Dot kind={head.hot ? "hot" : "ink"} />
            </button>
          ) : (
            <span className="oh-display oh-mini-title">
              {head.title}
              <Dot kind={head.hot ? "hot" : "ink"} />
            </span>
          )}
          <Button kind="quiet" size="s" icon="back" label={head.before.label} onPress={head.before.onPress} />
          <Button kind="quiet" size="s" icon="fwd" label={head.after.label} onPress={head.after.onPress} />
        </div>
      ) : null}
      <div className="oh-mini-grid">
        {weekdays.map((letter, i) => (
          <span key={i} className="oh-mini-wd" aria-hidden>
            {letter}
          </span>
        ))}
        {days.map((d) => (
          <button
            key={d.id}
            type="button"
            className="oh-control oh-mini-day"
            data-out={d.outside ? "" : undefined}
            data-off={d.disabled ? "" : undefined}
            disabled={d.disabled}
            data-today={d.today ? "" : undefined}
            data-picked={d.picked && !d.today ? "" : undefined}
            data-busy={d.busy ? "" : undefined}
            data-band={d.band}
            aria-label={d.label}
            aria-current={d.today ? "date" : undefined}
            onClick={onDayPress ? () => onDayPress(d.id) : undefined}
          >
            <span className="oh-mini-disc">{d.number}</span>
          </button>
        ))}
        {weekNumbers?.map((w, row) =>
          w ? (
            <WeekNumber
              key={row}
              number={w.number}
              label={w.label}
              style={{ gridRow: `${row + 2} / ${row + 3}` }}
              onPress={onWeekPress ? () => onWeekPress(row) : undefined}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}
