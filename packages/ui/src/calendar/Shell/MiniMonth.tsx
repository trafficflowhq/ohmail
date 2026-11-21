import type { MouseEventHandler } from "react";
import { Button } from "../../base/Primitives/Button.js";
import { EndDot } from "../../base/Primitives/EndDot.js";
import { cx, toneOf, toneStyle, type CalendarTone } from "../tone.js";
import { CalendarSquare } from "../Grids/CalendarSquare.js";
import { WeekNumber } from "../Grids/WeekNumber.js";
import { useDayKeys } from "./day-keys.js";
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
  marks?: readonly CalendarTone[];
  run?: { readonly tone: CalendarTone; readonly first: boolean; readonly last: boolean };
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
  size?: "rail" | "phone" | "widget" | "strip" | "year";
  label?: string;
  /** The marked days of the phone month view use tighter rows than the Agenda picker. */
  compactDays?: boolean;
  /** One for each row, where the setting is on; `null` leaves a row without. */
  weekNumbers?: ({ number: number; label: string } | null)[];
  onDayPress?: (id: string) => void;
  /** A press on a week's number, by its row from 0. */
  onWeekPress?: (row: number) => void;
  /** The keys go to the day that holds them as it is drawn: a picker in a menu. Not where a finger is used. */
  takesKeys?: boolean;
}

/**
 * A month to find a day in. A day with something is marked by a bold date alone; today and the
 * picked day carry their disc. A selected week or a multi-day event may carry a band.
 * Its days are one stop of Tab, walked by the keys (`day-keys.ts`).
 */
export function MiniMonth({
  head,
  weekdays,
  days,
  size = "rail",
  label,
  weekNumbers,
  onDayPress,
  onWeekPress,
  takesKeys,
  compactDays,
}: MiniMonthProps) {
  const { grid, before, after, stopId, hold, keys } = useDayKeys(days, size, takesKeys, onDayPress);
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, r) => days.slice(r * 7, r * 7 + 7));

  return (
    <div
      className="oh-mini"
      data-size={size === "rail" ? undefined : size}
      data-compact-days={compactDays ? "" : undefined}
    >
      {head ? miniMonthHead(head, before, after) : null}
      <div className="oh-mini-grid">
        {/* The grid, its weeks and its cells are said, and laid out by the grid around them. */}
        <div
          ref={grid}
          className="oh-mini-days"
          role="grid"
          aria-label={label ?? head?.title}
          onKeyDown={keys}
        >
          {weekdays.map((letter, i) => (
            <span key={i} className="oh-mini-wd" aria-hidden>
              {letter}
            </span>
          ))}
          {weeks.map((week, r) => (
            <div key={r} className="oh-mini-days" role="row">
              {week.map((d) => (
                <span key={d.id} className="oh-mini-days" role="gridcell">
                  <button
                    type="button"
                    className="oh-control oh-mini-day"
                    data-out={d.outside ? "" : undefined}
                    data-off={d.disabled ? "" : undefined}
                    disabled={d.disabled}
                    data-today={d.today ? "" : undefined}
                    data-picked={d.picked && !d.today ? "" : undefined}
                    data-busy={d.busy ? "" : undefined}
                    data-band={
                      d.band ??
                      (d.run
                        ? d.run.first
                          ? d.run.last
                            ? "only"
                            : "start"
                          : d.run.last
                            ? "end"
                            : "in"
                        : undefined)
                    }
                    aria-label={d.label}
                    aria-current={d.today ? "date" : undefined}
                    tabIndex={d.id === stopId ? 0 : -1}
                    onFocus={() => hold(d.id)}
                    onClick={onDayPress ? () => onDayPress(d.id) : undefined}
                  >
                    {d.run ? (
                      <span
                        aria-hidden
                        className={cx("oh-mini-run", toneOf(d.run.tone).className)}
                        data-tone={toneOf(d.run.tone)["data-tone"]}
                        data-first={d.run.first || undefined}
                        data-last={d.run.last || undefined}
                        style={toneStyle(d.run.tone)}
                      />
                    ) : null}
                    <span className="oh-mini-disc" data-today-pulse-target={d.today ? "badge" : undefined}>
                      {d.number}
                    </span>
                    {d.marks?.length ? (
                      <span className="oh-mini-marks" aria-hidden>
                        {d.marks.map((tone, index) => (
                          <CalendarSquare key={index} size={6} tone={tone} />
                        ))}
                      </span>
                    ) : null}
                  </button>
                </span>
              ))}
            </div>
          ))}
        </div>
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

function miniMonthHead(
  head: MiniMonthHead,
  before: ReturnType<typeof useDayKeys>["before"],
  after: ReturnType<typeof useDayKeys>["after"],
) {
  return (
    <div className="oh-mini-head">
      {head.open ? (
        <button
          type="button"
          className="oh-control oh-display oh-mini-title"
          data-press=""
          aria-label={head.open.label}
          onClick={head.open.onPress}
        >
          <EndDot kind={head.hot ? "hot" : "ink"}>{head.title}</EndDot>
        </button>
      ) : (
        <span className="oh-display oh-mini-title">
          <EndDot kind={head.hot ? "hot" : "ink"}>{head.title}</EndDot>
        </span>
      )}
      <Button
        ref={before}
        kind="quiet"
        size="s"
        icon="back"
        label={head.before.label}
        onPress={head.before.onPress}
      />
      <Button
        ref={after}
        kind="quiet"
        size="s"
        icon="fwd"
        label={head.after.label}
        onPress={head.after.onPress}
      />
    </div>
  );
}
