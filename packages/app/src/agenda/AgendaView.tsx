/**
 * THE AGENDA: days as groups from its first day on, whole days first, then by the hour. Beside a view it
 * is a panel whose first day is today while the span on screen holds today, else the span's first day;
 * on a phone it is a place of its own, the month small over the list. It lists the days it is handed a count
 * of, and asks for more at its foot as it is scrolled: the body works out the occurrences of exactly those days.
 * Where the list reaches past what this device holds, it says so.
 */
import { useLayoutEffect, useMemo, useRef, useState, type RefObject, type UIEvent } from "react";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { Button, RefusalLine } from "@ohmail/ui/base";
import { GroupHeading, ListHead, Row as MailRow } from "@ohmail/ui/mail";
import { AgendaRow, MiniMonth, SidePanel } from "@ohmail/ui/calendar";
import {
  addDays,
  agendaDays,
  clockTime,
  dayLong,
  dayShort,
  monthOfDay,
  firstOfMonth,
  shiftMonth,
  weekStartOf,
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
import { useGroundPiles, usePileCount } from "@ohmail/app-logic/piles";
import { usePresented, usePresentedMirror } from "@ohmail/app-logic/reading";
import { useDayClock } from "@ohmail/app-logic/session/day-clock";
import { stampOver } from "@ohmail/app-logic/text/format";
import type { EngineMessage } from "@ohmail/wire";
import { useFrame } from "../frame/commands.js";
import { useCalendarSwipe } from "../calendar/use-calendar-swipe.js";
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
  /** The phone app marks event days in the mini month above the list. */
  readonly miniMonthDots?: boolean;
  /** Asks for more days at the list's foot. */
  readonly onMore: () => void;
  readonly onClose?: () => void;
  readonly onRow?: (id: string, day: string) => void;
  readonly keysHere?: boolean;
}

/** Days the list holds at first, and how many more join at its foot. */
export const AGENDA_DAYS = 60;
export const AGENDA_MORE = 56;
const keyOf = (e: ViewEvent): string => e.id;

export function AgendaView({
  input,
  acts,
  edge,
  from,
  days,
  miniMonthDots,
  onMore,
  onClose,
  onRow,
  keysHere,
}: AgendaViewProps) {
  const t = useText("agenda");
  const locale = useLocale();
  const first = from ?? input.anchor;
  const scroller = useRef<HTMLDivElement>(null);
  const openRow = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (input.open !== null) openRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [first, input.open]);
  const [folded, setFolded] = useState(false);
  const swipe = useCalendarSwipe(
    (n) =>
      acts.pick(
        folded ? addDays(input.anchor, n * 7) : firstOfMonth(shiftMonth(monthOfDay(input.anchor), n)),
      ),
    setFolded,
  );
  const swipeList = useCalendarSwipe(
    input.device === "phone" ? (n) => acts.pick(addDays(input.anchor, n)) : undefined,
  );

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
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) onMore();
  };
  const content = (
    <>
      {keysHere ? <AgendaTop scroller={scroller} /> : null}
      <HeldNotice edge={edge} first={first} today={input.today} className="cal-ag-note" />
      {unplaced > 0 ? <RefusalLine>{t("unplaced", { count: unplaced })}</RefusalLine> : null}
      {agendaGroups({ groups, input, acts, onRow, openRow, t, locale })}
    </>
  );
  if (onClose)
    return (
      <SidePanel
        label={t("landmark")}
        head={
          <ListHead
            title={t("landmark")}
            hot={first === input.today}
            aside={<Button kind="quiet" size="s" icon="x" label={t("close")} onPress={onClose} />}
          />
        }
        arrives="slide"
        scrollRef={scroller}
        onScroll={onScroll}
      >
        {content}
      </SidePanel>
    );
  const list = (
    <div className="cal-ag-list" ref={scroller} onScroll={onScroll} data-scroll="calagenda" {...swipeList}>
      {content}
    </div>
  );
  if (input.device !== "phone") return <div className="cal-ag">{list}</div>;
  return (
    <div className="cal-ag" data-device="phone">
      <div className="cal-ag-pick" {...swipe}>
        <PhoneMonth input={input} acts={acts} folded={folded} busyDots={miniMonthDots} />
      </div>
      <div className="cal-ag-sheet">
        <button
          type="button"
          className="oh-control cal-ag-grab"
          aria-expanded={!folded}
          aria-label={t("month")}
          onClick={() => setFolded(!folded)}
        >
          <span className="cal-ag-grab-line" />
        </button>
        {list}
      </div>
    </div>
  );
}

function agendaGroups({
  groups,
  input,
  acts,
  onRow,
  openRow,
  t,
  locale,
}: Pick<AgendaViewProps, "input" | "acts" | "onRow"> & {
  groups: ReturnType<typeof agendaDays<ViewEvent>>["days"];
  openRow: RefObject<HTMLDivElement | null>;
  t: ReturnType<typeof useText>;
  locale: ReturnType<typeof useLocale>;
}) {
  const thisYear = yearOf(input.today);
  const nameOf = (day: string) =>
    day === input.today
      ? t("today")
      : day === addDays(input.today, 1)
        ? t("tomorrow")
        : dayShort(day, locale, thisYear);
  return groups.map((g) => {
    const count = g.rows.length;
    return (
      <section key={g.day} className="cal-ag-day" aria-label={dayLong(g.day, locale, thisYear)}>
        <GroupHeading count={count ? t("count", { count }) : undefined} hot={g.today}>
          {nameOf(g.day)}
        </GroupHeading>
        {count ? (
          <div role="list" className="cal-ag-rows">
            {g.rows.map((r) => (
              <Row
                key={`${g.day}|${r.key}`}
                row={r}
                day={g.day}
                input={input}
                openRow={openRow}
                onOpen={() => {
                  if (onRow) onRow(r.item.id, g.day);
                  else acts.event(r.item.id === input.open ? null : r.item);
                }}
              />
            ))}
          </div>
        ) : (
          <p className="cal-ag-none">{g.today ? t("nothingToday") : t("nothing")}</p>
        )}
        {g.today && <AnswerLaterGroup zone={input.zone} />}
      </section>
    );
  });
}

function AnswerLaterGroup({ zone }: { zone: string }) {
  return usePresentedMirror() === null ? null : <AnswerLaterRows zone={zone} />;
}

function AnswerLaterRows({ zone }: { zone: string }) {
  const t = useText("agenda");
  const { commands } = useFrame();
  const mirror = usePresented();
  const count = usePileCount("later");
  const stamp = stampOver(useDayClock(null, zone));
  const letters = useGroundPiles().replyLater.flatMap(({ messageId }) => {
    const message = messageId ? mirror.get<EngineMessage>("message", messageId) : undefined;
    return message ?? [];
  });
  return letters.length ? (
    <section aria-label={t("answerLater")}>
      <GroupHeading count={count ? t("count", { count }) : undefined}>{t("answerLater")}</GroupHeading>
      <div className="cal-ag-rows" role="list">
        {letters.map((message) => {
          const name = message.from.name?.trim() || message.from.address;
          return (
            <MailRow
              key={message.id}
              who={name}
              people={[{ name, address: message.from.address }]}
              subject={message.subject}
              when={message.date ? stamp(message.date) : undefined}
              unread={message.unread}
              onOpen={() => commands.go({ place: "later", open: message.id }, { entered: true })}
            />
          );
        })}
      </div>
    </section>
  ) : null;
}

function AgendaTop({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const t = useText("agenda");
  useKeyBindings(
    [
      {
        chord: "g g",
        label: t("top"),
        group: "navigate",
        run: () => {
          if (scroller.current) scroller.current.scrollTop = 0;
        },
      },
    ],
    "view",
  );
  return null;
}

function Row({
  row,
  day,
  input,
  openRow,
  onOpen,
}: {
  row: AgendaRowData<ViewEvent>;
  day: string;
  input: RangeInput;
  openRow: RefObject<HTMLDivElement | null>;
  onOpen: () => void;
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
  const open = row.first && e.id === input.open;
  return (
    <AgendaRow
      ref={open ? openRow : undefined}
      mark={{ kind: "calendar", tone: e.tone }}
      title={e.title}
      recordId={e.ref.event}
      saving={!!e.status && !e.status.failed}
      time={words}
      second={[e.second, ...e.people].filter(Boolean).join(" · ") || undefined}
      now={now}
      off={e.state === "off"}
      quiet={e.state === "maybe"}
      waits={e.waits}
      open={open}
      onOpen={onOpen}
    />
  );
}

/** The phone's month over the list: a press picks the day the list starts from. */
function PhoneMonth({
  input,
  acts,
  folded,
  busyDots,
}: {
  input: RangeInput;
  acts: RangeActs;
  folded: boolean;
  busyDots?: boolean;
}) {
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
  const weekOfAnchor = weekStartOf(input.anchor, input.weekStart);
  const weeks = folded ? grid.weeks.filter((week) => week.id === weekOfAnchor) : grid.weeks;
  const busy = new Set(
    grid.weeks.flatMap((w) =>
      w.pieces.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_, k) => addDays(w.id, p.from + k))),
    ),
  );
  return (
    <div className="cal-ag-month">
      <MiniMonth
        size="phone"
        busyDots={busyDots}
        weekdays={weekdayNames(locale, input.weekStart, "narrow")}
        days={weeks.flatMap((w) =>
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
