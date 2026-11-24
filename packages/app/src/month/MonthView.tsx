import { GroupHeading } from "@ohmail/ui/mail";
/**
 * THE MONTH: six weeks from the week of the picked day's month (or from the week the run was scrolled to).
 * A press on a date opens its Day, on a cell picks the day (on the picked one, opens it), on +N opens the
 * Day, on a line opens the event. On a phone's width: the month small, the picked day's rows below.
 */
import { useMemo } from "react";
import { RefusalLine } from "@ohmail/ui/base";
import { AgendaRow, EventChip, MiniMonth, MonthGrid, type MonthGridWeek } from "@ohmail/ui/calendar";
import {
  addDays,
  agendaDays,
  clockTime,
  dayAndMonth,
  dayLong,
  dayShort,
  monthOfDay,
  monthWeeks,
  shiftMonth,
  firstOfMonth,
  rowTime,
  weekdayNames,
  yearOf,
  type HeldEdge,
  type RangeActs,
  type RangeInput,
  type ViewEvent,
} from "@ohmail/app-logic/calendar";
import type { CalendarEventDrag } from "../calendar/view.js";
import { useCalendarSwipe } from "../calendar/use-calendar-swipe.js";
import { HeldNotice } from "../calendar/HeldNotice.js";
import { useLocale, useText } from "../text/index.js";
import type { MonthRun } from "./use-month-run.js";
import "./month.css";

export interface MonthViewProps {
  readonly input: RangeInput;
  readonly acts: RangeActs;
  readonly edge: HeldEdge;
  readonly onDrag?: CalendarEventDrag;
  /** The week the run was scrolled to, where it was. */
  readonly top?: string | null;
  readonly run?: MonthRun | null;
}

const keyOf = (e: ViewEvent): string => e.id;

export function MonthView({ input, acts, edge, run, top: at, onDrag }: MonthViewProps) {
  const t = useText("month");
  const month = monthOfDay(input.anchor);
  const visibleMonth = run?.month ?? month;
  const top = run?.first ?? at;
  const count = run?.count;
  const grid = useMemo(
    () =>
      monthWeeks({
        month: visibleMonth,
        weekStart: input.weekStart,
        today: input.today,
        picked: input.anchor,
        zone: input.zone,
        zones: input.zones,
        weekNumbers: input.weekNumbers,
        items: input.events,
        keyOf,
        open: input.open,
        top,
        count,
      }),
    [
      visibleMonth,
      input.weekStart,
      input.today,
      input.anchor,
      input.zone,
      input.zones,
      input.weekNumbers,
      input.events,
      input.open,
      top,
      count,
    ],
  );
  const swipe = useCalendarSwipe((n) => acts.pick(firstOfMonth(shiftMonth(month, n))));
  const notice = (
    <>
      <HeldNotice
        edge={edge}
        first={run?.visibleFirst ?? grid.weeks[0]!.id}
        today={input.today}
        className="cal-mo-note"
      />
      {grid.unplaced > 0 ? <RefusalLine>{t("unplaced", { count: grid.unplaced })}</RefusalLine> : null}
    </>
  );

  if (input.device === "phone")
    return (
      <div className="cal-mo" data-device="phone">
        {notice}
        <div className="cal-mo-pick" {...swipe}>
          <PhoneMonth input={input} acts={acts} grid={grid} />
        </div>
        <PickedDay input={input} acts={acts} />
      </div>
    );
  return (
    <div className="cal-mo" data-device={input.device}>
      {notice}
      <div className="cal-mo-grid">
        <GridMonth input={input} acts={acts} grid={grid} run={run} onDrag={onDrag} />
      </div>
    </div>
  );
}

/** The phone's picked day: its rows under the month. */
function PickedDay({ input, acts }: { input: RangeInput; acts: RangeActs }) {
  const t = useText("month");
  const locale = useLocale();
  const day = useMemo(
    () =>
      agendaDays({
        from: input.anchor,
        days: 1,
        today: input.today,
        zone: input.zone,
        zones: input.zones,
        items: input.events,
        keyOf,
        keepFirst: true,
      }).days[0],
    [input.anchor, input.today, input.zone, input.zones, input.events],
  );
  const rows = day?.rows ?? [];
  const hot = input.anchor === input.today;
  const heading = hot ? t("today") : dayShort(input.anchor, locale, yearOf(input.today));
  return (
    <section className="cal-mo-day" aria-label={heading}>
      <GroupHeading count={rows.length ? String(rows.length) : undefined} hot={hot}>
        {heading}
      </GroupHeading>
      {rows.length ? (
        <div role="list">
          {rows.map((r) => {
            const { time, now } = rowTime({ ...r, day: input.anchor }, input.today, input.nowMinute);
            const words =
              time.kind === "allDay"
                ? t("allDay")
                : time.kind === "until"
                  ? t("until", { time: clockTime(time.minute, locale) })
                  : time.kind === "untilDay"
                    ? t("untilDay", { day: dayShort(time.day, locale) })
                    : time.to === null
                      ? clockTime(time.from, locale)
                      : t("span", { from: clockTime(time.from, locale), to: clockTime(time.to, locale) });
            return (
              <AgendaRow
                key={r.key}
                mark={{ kind: "calendar", tone: r.item.tone }}
                title={r.item.title}
                recordId={r.item.ref.event}
                saving={!!r.item.status && !r.item.status.failed}
                time={words}
                second={[r.item.second, ...r.item.people].filter(Boolean).join(" · ") || undefined}
                now={now}
                off={r.item.state === "off"}
                quiet={r.item.state === "maybe"}
                waits={r.item.waits}
                open={r.key === input.open}
                onOpen={() => acts.event(r.item)}
              />
            );
          })}
        </div>
      ) : (
        <p className="cal-mo-none">{t("nothing")}</p>
      )}
    </section>
  );
}

type Grid = ReturnType<typeof monthWeeks<ViewEvent>>;

/** The phone's month: small, a day with something bold. */
function PhoneMonth({ input, acts, grid }: { input: RangeInput; acts: RangeActs; grid: Grid }) {
  const t = useText("month");
  const locale = useLocale();
  const thisYear = yearOf(input.today);
  return (
    <MiniMonth
      size="phone"
      compactDays
      weekdays={weekdayNames(locale, input.weekStart, "narrow")}
      days={grid.weeks.flatMap((week) =>
        week.days.map((d, index) => ({
          id: d.id,
          number: String(d.day),
          label: dayLong(d.id, locale, thisYear),
          today: d.today,
          picked: d.picked,
          outside: d.outside,
          busy: week.pieces.some((piece) => piece.from <= index && index <= piece.to) || d.more > 0,
          marks: [
            ...new Set(
              week.pieces
                .filter((piece) => piece.from <= index && index <= piece.to)
                .map((piece) => piece.item.tone),
            ),
          ].slice(0, 3),
        })),
      )}
      weekNumbers={
        input.weekNumbers
          ? grid.weeks.map((w) =>
              w.number ? { number: w.number.week, label: t("weekLabel", { number: w.number.week }) } : null,
            )
          : undefined
      }
      onDayPress={(id) => (id === input.anchor ? acts.view("day", id) : acts.pick(id))}
      onWeekPress={(row) => acts.view("week", grid.weeks[row]!.id)}
    />
  );
}

/** The desktop's weeks: runs across the week, timed lines on their day, +N. */
function GridMonth({
  input,
  acts,
  grid,
  run,
  onDrag,
}: {
  input: RangeInput;
  acts: RangeActs;
  grid: Grid;
  run?: MonthRun | null;
  onDrag: CalendarEventDrag | undefined;
}) {
  const t = useText("month");
  const calendar = useText("calendar");
  const locale = useLocale();
  const thisYear = yearOf(input.today);
  const weeks: MonthGridWeek[] = grid.weeks.map((w, index) => ({
    id: w.id,
    at: run ? run.start + index : undefined,
    weekNumber: w.number
      ? { number: w.number.week, label: t("weekLabel", { number: w.number.week }) }
      : undefined,
    children: w.pieces
      .filter((p) => p.run)
      .map((p) => (
        <EventChip
          key={p.key}
          size="line"
          run
          title={p.item.title}
          recordId={p.item.ref.event}
          saving={!!p.item.status && !p.item.status.failed}
          tone={p.item.tone}
          state={p.item.state === "plain" ? undefined : p.item.state}
          open={p.key === input.open}
          waits={p.item.waits}
          viewOnly={p.item.viewOnly}
          dayEdges={
            onDrag &&
            (input.open === null || input.open === p.item.id) &&
            p.item.start.kind === "date" &&
            !p.item.viewOnly
              ? {
                  start: p.goesOnBefore ? undefined : calendar("actions.resizeStart"),
                  end: p.goesOnAfter ? undefined : calendar("actions.resizeEnd"),
                }
              : undefined
          }
          style={{ gridColumn: `${p.from + 1} / ${p.to + 2}`, gridRow: p.row + 2 }}
          onPress={() => acts.event(p.item)}
          onPointerDown={onDrag ? (event) => onDrag(p.item.id, event) : undefined}
        />
      )),
    days: w.days.map((d, i) => ({
      id: d.id,
      number: d.day === 1 ? dayAndMonth(d.id, locale) : String(d.day),
      label: dayLong(d.id, locale, thisYear),
      today: d.today,
      picked: d.picked,
      outside: d.outside,
      lines: w.pieces
        .filter((p) => !p.run && p.from === i)
        .map((p) => {
          const time = clockTime(p.startMinute ?? 0, locale);
          return (
            <EventChip
              key={p.key}
              size="line"
              title={p.item.title}
              recordId={p.item.ref.event}
              saving={!!p.item.status && !p.item.status.failed}
              time={time}
              tone={p.item.tone}
              state={p.item.state === "plain" ? undefined : p.item.state}
              open={p.key === input.open}
              waits={p.item.waits}
              viewOnly={p.item.viewOnly}
              style={{ gridColumn: i + 1, gridRow: p.row + 2 }}
              onPress={() => acts.event(p.item)}
              onPointerDown={onDrag ? (event) => onDrag(p.item.id, event) : undefined}
            />
          );
        }),
      more:
        d.more > 0
          ? {
              text: t("more", { count: d.more }),
              label: t("moreLabel", { count: d.more, day: dayLong(d.id, locale, thisYear) }),
            }
          : undefined,
    })),
  }));
  return (
    <MonthGrid
      weekdays={weekdayNames(locale, input.weekStart, "short")}
      weeks={weeks}
      run={run ? { rowHeight: run.rowHeight, height: run.height } : undefined}
      scrollLabel={run ? t("title") : undefined}
      scrollRef={run?.scrollRef}
      onScroll={run?.onScroll}
      onDayPress={(id) => acts.view("day", id)}
      onCellPress={(id) => (id === input.anchor ? acts.view("day", id) : acts.pick(id))}
      onMorePress={(id) => acts.view("day", id)}
      onWeekPress={(id) => acts.view("week", id)}
    />
  );
}
