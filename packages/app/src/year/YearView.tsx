/**
 * THE YEAR: twelve small months. A day with something is bold; a run of two days or more is marked on its
 * days. A press on a day opens its Day, on a month's name its Month.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { Dot, RefusalLine } from "@ohmail/ui/base";
import { MiniMonth } from "@ohmail/ui/calendar";
import {
  dayLong,
  monthName,
  monthOfDay,
  weekdayNames,
  yearMonths,
  yearOf,
  type HeldEdge,
  type RangeActs,
  type RangeInput,
  type ViewEvent,
} from "@ohmail/app-logic/calendar";
import { HeldNotice } from "../calendar/HeldNotice.js";
import { useLocale, useText } from "../text/index.js";
import "./year.css";

export interface YearViewProps {
  readonly input: RangeInput;
  readonly acts: RangeActs;
  readonly edge: HeldEdge;
}

const keyOf = (e: ViewEvent): string => e.id;

export function YearView({ input, acts, edge }: YearViewProps) {
  const t = useText("year");
  const locale = useLocale();
  const year = Number(yearOf(input.anchor));
  const pickedMonth = monthOfDay(input.anchor);
  const pickedSection = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (input.device !== "desktop") {
      pickedSection.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [input.device, pickedMonth]);
  const data = useMemo(
    () =>
      yearMonths({
        year,
        weekStart: input.weekStart,
        today: input.today,
        picked: input.anchor,
        zone: input.zone,
        zones: input.zones,
        items: input.events,
        keyOf,
      }),
    [year, input.weekStart, input.today, input.anchor, input.zone, input.zones, input.events],
  );
  const letters = weekdayNames(locale, input.weekStart, "narrow");
  const thisYear = yearOf(input.today);
  const tones = new Map(input.events.map((event) => [event.id, event.tone]));
  return (
    <div className="cal-yr" data-device={input.device}>
      <HeldNotice
        edge={edge}
        first={`${year}-01-01`}
        last={`${year}-12-31`}
        today={input.today}
        className="cal-yr-note"
      />
      {data.unplaced > 0 ? <RefusalLine>{t("unplaced", { count: data.unplaced })}</RefusalLine> : null}
      <div className="cal-yr-grid">
        {data.months.map((m) => {
          const name = monthName(m.month, locale);
          return (
            <section
              key={m.month}
              className="cal-yr-month"
              data-month={m.month}
              ref={m.month === pickedMonth ? pickedSection : undefined}
            >
              <h2 className="oh-text oh-display cal-yr-head">
                <button
                  type="button"
                  className="oh-control cal-yr-name"
                  aria-label={t("monthLabel", { month: `${name} ${m.month.slice(0, 4)}` })}
                  onClick={() => acts.view("month", `${m.month}-01`)}
                >
                  {name}
                  <Dot kind={m.hot ? "hot" : "ink"} />
                </button>
              </h2>
              <MiniMonth
                size="year"
                weekdays={letters}
                days={m.days.map((d) => ({
                  id: d.id,
                  number: String(d.day),
                  label: dayLong(d.id, locale, thisYear),
                  today: d.today,
                  picked: d.picked,
                  outside: d.outside,
                  busy: d.busy,
                  run: d.run
                    ? { tone: tones.get(d.run.key) ?? "neutral", first: d.run.first, last: d.run.last }
                    : undefined,
                }))}
                weekNumbers={
                  input.weekNumbers
                    ? m.rows.map((r) => ({ number: r.week, label: t("weekLabel", { number: r.week }) }))
                    : undefined
                }
                onDayPress={(id) =>
                  input.device === "phone" ? acts.view("month", `${m.month}-01`) : acts.view("day", id)
                }
                onWeekPress={(row) => acts.view("week", m.rows[row]!.first)}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
