import { Fragment, type CSSProperties, type ReactNode, type Ref, type UIEventHandler } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import { cx } from "../tone.js";
import { WeekNumber } from "./WeekNumber.js";
import "./grid-sheet.css";
import "./month-grid.css";

export interface MonthGridDay {
  /** The app's own name for the day. */
  id: string;
  /** The date as it is written in its cell: "9", or "1 Dec" on a month's first day. */
  number: string;
  /** The day named in full. */
  label: string;
  today?: boolean;
  /** The day you picked, where it is not today. */
  picked?: boolean;
  /** A day of another month than the one the view names: it steps back. */
  outside?: boolean;
  /** Dated mail on this day: its glyph at the cell's end. */
  mail?: IconName;
  /**
   * The day's own lines, each placed by `style.gridColumn` (day `i` from 0 is column `i + 1`) and
   * `style.gridRow` (the first line is row 2). They take the keys in the days' order.
   */
  lines?: ReactNode;
  /** The day holds more than it shows: "+4", and what a press does, said in full. It follows the day's lines. */
  more?: { text: string; label: string };
}

export interface MonthGridWeek {
  id: string;
  /** Seven days. */
  days: MonthGridDay[];
  /** The week's number at the row's start, where the setting is on. */
  weekNumber?: { number: number; label: string };
  /** Where the week stands in the run, counted in rows. */
  at?: number;
  /** What runs across days of the week, placed by `style.gridColumn` ("1 / 4") and `style.gridRow`. It stands before the days' own lines. */
  children?: ReactNode;
}

export interface MonthGridProps {
  /** The seven weekdays in short, in the week's order. */
  weekdays: string[];
  weeks: MonthGridWeek[];
  /** The weeks as one run that scrolls: a row's height and the whole run's, in px. Left out: the weeks share the sheet. */
  run?: { rowHeight: number; height: number };
  /** A press on a date: its day. */
  onDayPress?: (id: string) => void;
  /** A press anywhere else in a day's cell: the day is picked. */
  onCellPress?: (id: string) => void;
  onMorePress?: (id: string) => void;
  onWeekPress?: (weekId: string) => void;
  scrollLabel?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

function Week({ week, props }: { week: MonthGridWeek; props: MonthGridProps }) {
  const { onDayPress, onCellPress, onMorePress, onWeekPress } = props;
  return (
    <div
      className="oh-mo-week"
      style={week.at === undefined ? undefined : ({ "--oh-mo-at": week.at } as CSSProperties)}
    >
      {week.weekNumber ? (
        <WeekNumber
          number={week.weekNumber.number}
          label={week.weekNumber.label}
          onPress={onWeekPress ? () => onWeekPress(week.id) : undefined}
        />
      ) : null}
      {week.days.map((d, i) => (
        <div
          key={d.id}
          className="oh-mo-cell"
          data-cal-drop-day={d.id}
          data-cal-drop-kind="month"
          data-out={d.outside ? "" : undefined}
          style={{ gridColumn: i + 1 }}
          onClick={onCellPress ? () => onCellPress(d.id) : undefined}
        />
      ))}
      {week.days.map((d, i) => (
        <div
          key={d.id}
          className="oh-mo-n"
          style={{ gridColumn: i + 1 }}
          data-out={d.outside ? "" : undefined}
          data-today={d.today ? "" : undefined}
          data-picked={d.picked && !d.today ? "" : undefined}
        >
          <button
            type="button"
            className="oh-control oh-mo-date"
            aria-label={d.label}
            aria-current={d.today ? "date" : undefined}
            onClick={onDayPress ? () => onDayPress(d.id) : undefined}
          >
            <span className="oh-mo-disc">{d.number}</span>
          </button>
          {d.mail ? <Icon name={d.mail} size={16} className="oh-mo-mail" /> : null}
        </div>
      ))}
      {week.children}
      {week.days.map((d, i) => (
        <Fragment key={d.id}>
          {d.lines}
          {d.more ? (
            <button
              type="button"
              className="oh-control oh-mo-more"
              style={{ gridColumn: i + 1 }}
              aria-label={d.more.label}
              onClick={onMorePress ? () => onMorePress(d.id) : undefined}
            >
              {d.more.text}
            </button>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The month: the weekdays, then the weeks. A day shows up to four lines, or three and how many
 * more; which lines, and in which row, is the app's to say. Handed a `run`, the weeks are one list
 * that scrolls, each at its own place, and the days of the other months step back.
 */
export function MonthGrid(props: MonthGridProps) {
  const { weekdays, weeks, run, scrollLabel, scrollRef, onScroll } = props;
  const numbers = weeks.some((w) => w.weekNumber) ? "" : undefined;
  const rows = weeks.map((w) => <Week key={w.id} week={w} props={props} />);
  return (
    <div className={cx("oh-cal-sheet", "oh-mo")}>
      <div className="oh-mo-wd">
        {weekdays.map((name, i) => (
          <span key={i} className="oh-mo-wd-name">
            {name}
          </span>
        ))}
      </div>
      {run ? (
        <div
          className="oh-mo-weeks"
          data-run=""
          data-numbers={numbers}
          role={scrollLabel ? "region" : undefined}
          aria-label={scrollLabel}
          ref={scrollRef}
          onScroll={onScroll}
          style={{ "--oh-mo-rowh": `${run.rowHeight}px` } as CSSProperties}
        >
          <div className="oh-mo-run" style={{ height: run.height }}>
            {rows}
          </div>
        </div>
      ) : (
        <div
          className="oh-mo-weeks"
          data-numbers={numbers}
          style={{ "--oh-mo-count": weeks.length } as CSSProperties}
        >
          {rows}
        </div>
      )}
    </div>
  );
}
