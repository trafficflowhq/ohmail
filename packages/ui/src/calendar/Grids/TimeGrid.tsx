import type {
  CSSProperties,
  HTMLAttributes,
  MouseEventHandler,
  PointerEvent,
  ReactNode,
  Ref,
  UIEventHandler,
} from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import { cx } from "../tone.js";
import { NowLine } from "./NowLine.js";
import { dayColumn, hourGivesWay, minuteTop } from "./time-grid-layout.js";
import "./grid-sheet.css";
import "./time-grid.css";

/** Dated mail at its hour: a round mark at the column's end. */
export interface TimeGridMark {
  id: string;
  /** Its time, in minutes of the day. */
  minutes: number;
  icon: IconName;
  /** What it is and which letter, said in full. */
  label: string;
  onPress?: MouseEventHandler<HTMLButtonElement>;
}

export interface TimeGridDay {
  /** The app's own name for the day. */
  id: string;
  /** The head: the weekday in short, the date's number, and the day named in full. */
  weekday: string;
  date: string;
  label: string;
  today?: boolean;
  /** The day you picked, where it is not today. */
  picked?: boolean;
  /** What stands in the day's hours: its chips, each placed by its own `place`. */
  children?: ReactNode;
  marks?: TimeGridMark[];
  /** The free stretch between two events, printed at its middle minute. */
  free?: { minutes: number; text: string }[];
  /** The hour the keys stand on. */
  cursor?: { minutes: number; length: number };
  /** What lies out of sight above and below: an out-of-sight capsule each. */
  above?: ReactNode;
  below?: ReactNode;
}

export interface TimeGridProps {
  days: TimeGridDay[];
  /** `false` leaves the day heads out: the day alone, whose head is the view's own title. */
  heads?: boolean;
  /** The lane above the hours: an all-day row. */
  allDay?: ReactNode;
  /** The first hour drawn, and one label for each hour line from it on: the last line is the last label. */
  firstHour: number;
  hourLabels: string[];
  secondAxis?: { readonly label: string; readonly hours: readonly string[] };
  /** An hour's height in px. The app reads it from the room it has. */
  hourHeight: number;
  /** Now, in minutes of the day, and its time as it is written. Drawn on today, inside the hours. */
  now?: { minutes: number; label: string };
  dragPreview?: { day: string; chip: ReactNode };
  /** A narrow window: titles and marks at the small size. */
  dense?: boolean;
  /** The unfolded phone: the index of the first day after the hinge. */
  crease?: number;
  onDayPress?: (id: string) => void;
  /** A press on a day's empty time: the start of a draft. */
  onDayPointerDown?: (id: string, event: PointerEvent<HTMLDivElement>) => void;
  onDayContextMenu?: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  /** The hours' scroller: the app opens it on the hours it set. */
  scrollRef?: Ref<HTMLDivElement>;
  scrollGestures?: Pick<
    HTMLAttributes<HTMLDivElement>,
    "onPointerDown" | "onPointerCancel" | "onPointerUp" | "onClickCapture"
  > & { "data-calendar-swipe"?: string };
  onScroll?: UIEventHandler<HTMLDivElement>;
}

interface Frame {
  firstHour: number;
  hourHeight: number;
  crease: number;
  /** Now, where a line of now is drawn at all. */
  nowAt: number | null;
}

function Heads({
  days,
  crease,
  onDayPress,
}: {
  days: TimeGridDay[];
  crease: number;
  onDayPress?: (id: string) => void;
}) {
  return (
    <div className="oh-tg-heads">
      <span />
      {days.map((d, i) => (
        <button
          key={d.id}
          type="button"
          className="oh-control oh-tg-day"
          style={{ gridColumn: dayColumn(i, crease) }}
          data-today={d.today ? "" : undefined}
          data-picked={d.picked && !d.today ? "" : undefined}
          aria-label={d.label}
          aria-current={d.today ? "date" : undefined}
          onClick={onDayPress ? () => onDayPress(d.id) : undefined}
        >
          <span className="oh-tg-wd">{d.weekday}</span>
          <span className="oh-tg-dn" data-today-pulse-target={d.today ? "badge" : undefined}>
            {d.date}
          </span>
        </button>
      ))}
    </div>
  );
}

function Edge({ side, days, crease }: { side: "above" | "below"; days: TimeGridDay[]; crease: number }) {
  return (
    <div className="oh-tg-edge" data-side={side}>
      {days.map((d, i) => {
        const capsule = side === "above" ? d.above : d.below;
        return capsule ? (
          <span key={d.id} className="oh-tg-edge-cell" style={{ gridColumn: dayColumn(i, crease) }}>
            {capsule}
          </span>
        ) : null;
      })}
    </div>
  );
}

function Column({
  day,
  index,
  frame,
  props,
}: {
  day: TimeGridDay;
  index: number;
  frame: Frame;
  props: TimeGridProps;
}) {
  const at = (minutes: number): number => minuteTop(minutes, frame.firstHour, frame.hourHeight);
  const { onDayPointerDown, onDayContextMenu } = props;
  return (
    <div
      className="oh-tg-col"
      style={{ gridColumn: dayColumn(index, frame.crease) }}
      data-today={day.today ? "" : undefined}
    >
      <div
        className="oh-tg-in"
        data-cal-drop-day={day.id}
        data-cal-drop-kind="time"
        role="group"
        aria-label={day.label}
        onPointerDown={onDayPointerDown ? (e) => onDayPointerDown(day.id, e) : undefined}
        onContextMenu={onDayContextMenu ? (e) => onDayContextMenu(day.id, e) : undefined}
      >
        {day.children}
        {props.dragPreview?.day === day.id ? props.dragPreview.chip : null}
        {day.marks?.map((m) => (
          <button
            key={m.id}
            type="button"
            className="oh-control oh-tg-mark"
            style={{ top: at(m.minutes) }}
            aria-label={m.label}
            title={m.label}
            onClick={m.onPress}
          >
            <Icon name={m.icon} size={16} className="oh-tg-mark-ico" />
          </button>
        ))}
        {day.free?.map((f) => (
          <span key={f.minutes} className="oh-tg-free" style={{ top: at(f.minutes) }}>
            {f.text}
          </span>
        ))}
        {day.today && frame.nowAt !== null ? <NowLine top={at(frame.nowAt)} /> : null}
        {day.cursor ? (
          <i
            className="oh-tg-cursor"
            aria-hidden
            style={{ top: at(day.cursor.minutes), height: (day.cursor.length * frame.hourHeight) / 60 - 2 }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The week and the day: the day heads, the all-day lane, and the hours with a column for each day.
 * The heads and the lane stay put while the hours scroll. Where each event stands is the app's to
 * say (a chip's `place`); the grid draws the hours, today's line of now, mail's marks and the free
 * stretches from the minutes it is handed.
 */
export function TimeGrid(props: TimeGridProps) {
  const {
    days,
    heads = true,
    allDay,
    firstHour,
    hourLabels,
    secondAxis,
    hourHeight,
    now,
    dense,
    scrollRef,
    scrollGestures,
    onScroll,
  } = props;
  const crease =
    props.crease !== undefined && props.crease > 0 && props.crease < days.length ? props.crease : 0;
  const lastHour = firstHour + hourLabels.length - 1;
  const inHours = now !== undefined && now.minutes >= firstHour * 60 && now.minutes <= lastHour * 60;
  const nowAt = now !== undefined && inHours && days.some((d) => d.today) ? now.minutes : null;
  const frame: Frame = { firstHour, hourHeight, crease, nowAt };
  const style = {
    "--oh-tg-days": days.length,
    "--oh-tg-hour": `${hourHeight}px`,
    "--oh-tg-hours": hourLabels.length - 1,
    ...(crease ? { "--oh-tg-a": crease, "--oh-tg-b": days.length - crease } : null),
  } as CSSProperties;
  return (
    <div
      className={cx("oh-cal-sheet", "oh-tg")}
      data-second-zone={secondAxis ? "" : undefined}
      data-dense={dense ? "" : undefined}
      data-crease={crease || undefined}
      style={style}
    >
      {heads ? <Heads days={days} crease={crease} onDayPress={props.onDayPress} /> : null}
      {allDay}
      <div
        className="oh-tg-scroll"
        data-today-scroll=""
        ref={scrollRef}
        onScroll={onScroll}
        {...scrollGestures}
      >
        <Edge side="above" days={days} crease={crease} />
        <div className="oh-tg-grid">
          <div className="oh-tg-axis">
            {hourLabels.map((label, i) =>
              hourGivesWay(firstHour + i, nowAt) ? null : (
                <span key={i} className="oh-tg-hr" style={{ top: i * hourHeight }}>
                  {label}
                </span>
              ),
            )}
            {secondAxis ? (
              <div role="group" aria-label={secondAxis.label}>
                {secondAxis.hours.map((label, i) => (
                  <span key={i} className="oh-tg-hr" data-second="" style={{ top: i * hourHeight }}>
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
            {now !== undefined && nowAt !== null ? (
              <span className="oh-tg-hr" data-now="" style={{ top: minuteTop(nowAt, firstHour, hourHeight) }}>
                {now.label}
              </span>
            ) : null}
          </div>
          {days.map((d, i) => (
            <Column key={d.id} day={d} index={i} frame={frame} props={props} />
          ))}
        </div>
        <Edge side="below" days={days} crease={crease} />
      </div>
    </div>
  );
}
