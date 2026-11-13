/**
 * THE AGENDA: days as groups from its first day on, whole days first, then by the hour. Beside a view it
 * is a panel whose first day is today while the span on screen holds today, else the span's first day;
 * on a phone it is a place of its own, the month small over the list. It lists the days it is handed a count
 * of, and asks for more at its foot as it is scrolled: the body works out the occurrences of exactly those days.
 * Where the list reaches past what this device holds, it says so.
 */
import { useMemo, type UIEvent } from "react";
import { RefusalLine } from "@ohmail/ui/base";
import { GroupHeading } from "@ohmail/ui/mail";
import { AgendaRow, MiniMonth } from "@ohmail/ui/calendar";
import {
  addDays,
  agendaDays,
  clockTime,
  dayLong,
  dayShort,
  monthOfDay,
  monthWeeks,
  rowTime,
  weekdayNames,
  yearOf,
  type AgendaRowData,
  type HeldEdge,
  type RangeActs,
  type RangeInput,
  type ViewEvent,
} from "@ohmail/app-logic/calendar";
import { HeldNotice } from "../calendar/HeldNotice.js";
import { useLocale, useText } from "../text/index.js";
import "./agenda.css";

export interface AgendaViewProps {
  readonly input: RangeInput;
  readonly acts: RangeActs;
  readonly edge: HeldEdge;
  /** The list's first day; left out, the picked day. */
  readonly from?: string;
  /** How many days from its first one the list holds: what the body worked the occurrences out over. */
  readonly days: number;
  /** Asks for more days at the list's foot. */
  readonly onMore: () => void;
}

/** Days the list holds at first, and how many more join at its foot. */
export const AGENDA_DAYS = 60;
export const AGENDA_MORE = 56;
const keyOf = (e: ViewEvent): string => e.id;

export function AgendaView({ input, acts, edge, from, days, onMore }: AgendaViewProps) {
  const t = useText("agenda");
  const locale = useLocale();
  const first = from ?? input.anchor;
  const { days: groups, unplaced } = useMemo(
    () =>
      agendaDays({
        from: first,
        days,
        today: input.today,
        zone: input.zone,
        zones: input.zones,
        items: input.events,
        keyOf,
        keepFirst: from === undefined,
      }),
    [first, days, input.today, input.zone, input.zones, input.events, from],
  );
  const thisYear = yearOf(input.today);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) onMore();
  };
  const nameOf = (day: string) =>
    day === input.today
      ? t("today")
      : day === addDays(input.today, 1)
        ? t("tomorrow")
        : dayShort(day, locale, thisYear);
  const list = (
    <div className="cal-ag-list" onScroll={onScroll} data-scroll="calagenda">
      <HeldNotice
        edge={edge}
        first={first}
        last={addDays(first, days - 1)}
        today={input.today}
        className="cal-ag-note"
      />
      {unplaced > 0 ? <RefusalLine>{t("unplaced", { count: unplaced })}</RefusalLine> : null}
      {groups.map((g) => {
        const count = g.rows.length;
        return (
          <section key={g.day} className="cal-ag-day" aria-label={dayLong(g.day, locale, thisYear)}>
            <GroupHeading count={count ? t("count", { count }) : undefined} hot={g.today}>
              {nameOf(g.day)}
            </GroupHeading>
            {count ? (
              <div role="list" className="cal-ag-rows">
                {g.rows.map((r) => (
                  <Row key={`${g.day}|${r.key}`} row={r} day={g.day} input={input} acts={acts} />
                ))}
              </div>
            ) : (
              <p className="cal-ag-none">{g.today ? t("nothingToday") : t("nothing")}</p>
            )}
          </section>
        );
      })}
    </div>
  );
  if (input.device !== "phone") return <div className="cal-ag">{list}</div>;
  return (
    <div className="cal-ag" data-device="phone">
      <PhoneMonth input={input} acts={acts} />
      <div className="cal-ag-sheet">{list}</div>
    </div>
  );
}

function Row({
  row,
  day,
  input,
  acts,
}: {
  row: AgendaRowData<ViewEvent>;
  day: string;
  input: RangeInput;
  acts: RangeActs;
}) {
  const t = useText("agenda");
  const locale = useLocale();
  const { time, now } = rowTime({ ...row, day }, input.today, input.nowMinute);
  const words =
    time.kind === "allDay"
      ? t("allDay")
      : time.kind === "until"
        ? t("until", { time: clockTime(time.minute, locale) })
        : time.kind === "untilDay"
          ? t("untilDay", { day: dayShort(time.day, locale, yearOf(input.today)) })
          : time.to === null
            ? clockTime(time.from, locale)
            : t("span", { from: clockTime(time.from, locale), to: clockTime(time.to, locale) });
  const e = row.item;
  return (
    <AgendaRow
      mark={{ kind: "calendar", tone: e.tone }}
      title={e.title}
      time={words}
      second={[e.second, ...e.people].filter(Boolean).join(" · ") || undefined}
      now={now}
      off={e.state === "off"}
      quiet={e.state === "maybe"}
      waits={e.waits}
      open={row.first && e.id === input.open}
      onOpen={() => acts.event(e.id === input.open ? null : e)}
    />
  );
}

/** The phone's month over the list: a press picks the day the list starts from. */
function PhoneMonth({ input, acts }: { input: RangeInput; acts: RangeActs }) {
  const locale = useLocale();
  const grid = useMemo(
    () =>
      monthWeeks({
        month: monthOfDay(input.anchor),
        weekStart: input.weekStart,
        today: input.today,
        picked: input.anchor,
        zone: input.zone,
        zones: input.zones,
        weekNumbers: false,
        items: input.events,
        keyOf,
        open: null,
      }),
    [input.anchor, input.weekStart, input.today, input.zone, input.zones, input.events],
  );
  const busy = new Set(
    grid.weeks.flatMap((w) =>
      w.pieces.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_, k) => addDays(w.id, p.from + k))),
    ),
  );
  return (
    <div className="cal-ag-month">
      <MiniMonth
        size="phone"
        weekdays={weekdayNames(locale, input.weekStart, "narrow")}
        days={grid.weeks.flatMap((w) =>
          w.days.map((d) => ({
            id: d.id,
            number: String(d.day),
            label: dayLong(d.id, locale, yearOf(input.today)),
            today: d.today,
            picked: d.picked,
            outside: d.outside,
            busy: busy.has(d.id) || d.more > 0,
          })),
        )}
        onDayPress={(id) => acts.pick(id)}
      />
    </div>
  );
}
