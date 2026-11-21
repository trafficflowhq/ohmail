/**
 * THE DAY: one day's hours, the lane of its whole days above them, now on today, and between two events an hour or
 * more apart the free stretch printed. It has no day head: the calendar's head says the day. What lies out of sight
 * above or below says its time and its title. Where each event stands is the grid's rule, read on the reader's clock.
 */
import {
  AllDayRow,
  EventChip,
  OutOfSightCapsule,
  TimeGrid,
  type TimeGridDay as KitDay,
} from "@ohmail/ui/calendar";
import { RefusalLine } from "@ohmail/ui/base";
import {
  blockChip,
  clockOf,
  dayHead,
  hourLabels,
  otherHourLabels,
  isoOfDay,
  nowIn,
  pillChip,
  useHoursScroller,
  useTimeGrid,
  type PlainDate,
  type Segment,
  type TimeGridDay,
} from "@ohmail/app-logic/calendar";
import { timedResizeProps } from "../calendar/view.js";
import type { CalendarEventView, CalendarView, CalendarViewProps } from "../calendar/view.js";
import { HeldNotice } from "../calendar/HeldNotice.js";
import { useCalendarSwipe } from "../calendar/use-calendar-swipe.js";
import { useLocale, useText } from "../text/index.js";
import "./day.css";

/** The day shows its anchor alone. */
export const daySpan = (anchor: PlainDate): readonly PlainDate[] => [anchor];

export function DayView(props: CalendarViewProps) {
  const t = useText("day");
  const locale = useLocale();
  const swipe = useCalendarSwipe(props.stepDay);
  const { anchor, settings, plan, clock, openId } = props;
  const days = daySpan(anchor);
  const hours = useHoursScroller({
    hours: settings.hours,
    hourDefault: plan.device === "phone" ? 56 : 60,
    room: plan,
    focusMinute: props.cursor,
    spanKey: isoOfDay(anchor),
    openId,
    openTop: () => model.days[0]!.blocks.find((b) => b.item.id === openId)?.top ?? null,
  });
  const model = useTimeGrid({
    events: props.events,
    days,
    zone: clock.zone,
    zones: clock.zones,
    nowMs: clock.nowMs,
    hourPx: hours.hourPx,
    inView: hours.inView,
    picked: null,
    free: true,
  });
  const open = (e: CalendarEventView): void => props.onOpen(e.ref);
  const said = (s: Segment<CalendarEventView>): string => `${clockOf(s.from)} ${s.item.title}`;
  const freeText = (minutes: number) => freeHours(t, minutes);

  const calendar = useText("calendar");
  const kitDays: KitDay[] = model.days.map((d) => ({
    ...dayHead(d.day, locale),
    id: d.id,
    today: d.today,
    cursor: props.cursor != null ? { minutes: props.cursor, length: 60 } : undefined,
    above: outOfSight(d, "above", t, said, hours.show),
    below: outOfSight(d, "below", t, said, hours.show),
    free: d.free.map((f) => ({ minutes: f.at, text: freeText(f.minutes) })),
    children: d.blocks.map((b) => (
      <EventChip
        key={b.item.id}
        size="block"
        {...blockChip(b, b.item.id === openId)}
        label={t("chip", { title: b.item.title, from: clockOf(b.from), to: clockOf(b.to) })}
        onPress={() => open(b.item)}
        {...timedResizeProps(props, b, {
          start: calendar("actions.resizeTimeStart"),
          end: calendar("actions.resizeTimeEnd"),
        })}
      />
    )),
  }));

  const lane = model.lane.pills.map((p) => (
    <EventChip
      key={p.item.id}
      size="pill"
      {...pillChip(p, p.item.id === openId)}
      dayEdges={
        props.onDrag && (openId === null || openId === p.item.id) && !p.item.viewOnly
          ? {
              start: p.before ? undefined : calendar("actions.resizeStart"),
              end: p.after ? undefined : calendar("actions.resizeEnd"),
            }
          : undefined
      }
      label={t("chipAllDay", { title: p.item.title })}
      style={{ gridColumn: "2 / 3", gridRow: p.row + 1 }}
      onPress={() => open(p.item)}
      onPointerDown={props.onDrag ? (event) => props.onDrag?.(p.item.id, event) : undefined}
    />
  ));

  return (
    <section className="cd-day" aria-label={t("hours")}>
      <HeldNotice
        edge={props.edge}
        first={isoOfDay(days[0]!)}
        last={isoOfDay(days.at(-1)!)}
        today={isoOfDay(nowIn(clock.nowMs, clock.zone, clock.zones)?.day ?? anchor)}
        className="cd-note"
      />
      {model.unplaced.length > 0 ? (
        <RefusalLine>{t("unplaced", { count: model.unplaced.length })}</RefusalLine>
      ) : null}
      {props.capped ? <RefusalLine>{t("capped")}</RefusalLine> : null}
      <TimeGrid
        days={kitDays}
        heads={false}
        allDay={
          <AllDayRow label={t("allDay")} targets={kitDays.map((day) => day.id)}>
            {lane}
          </AllDayRow>
        }
        {...(props.dragPreview ? { dragPreview: props.dragPreview } : {})}
        firstHour={0}
        hourLabels={hourLabels(0, 24)}
        secondAxis={
          settings.secondZone
            ? {
                label: settings.secondZone,
                hours: otherHourLabels(anchor, clock.zone, settings.secondZone, clock.zones),
              }
            : undefined
        }
        hourHeight={hours.hourPx}
        now={
          model.now === null ? undefined : { minutes: model.now.minutes, label: clockOf(model.now.minutes) }
        }
        onDayPointerDown={props.onSlot}
        scrollRef={hours.ref}
        scrollGestures={swipe}
        onScroll={hours.onScroll}
      />
    </section>
  );
}

export const dayView: CalendarView = { View: DayView, span: (anchor) => daySpan(anchor) };

function freeHours(t: ReturnType<typeof useText>, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? t("freeHours", { hours: h }) : t("freeHoursMinutes", { hours: h, minutes: m });
}

function outOfSight(
  day: TimeGridDay<CalendarEventView>,
  side: "above" | "below",
  t: ReturnType<typeof useText>,
  say: (segment: Segment<CalendarEventView>) => string,
  show: ReturnType<typeof useHoursScroller>["show"],
) {
  const list = side === "above" ? day.above : day.below;
  const nearest = list.length > 0 ? day.blocks.find((b) => b.item.id === list[0]!.item.id) : undefined;
  return nearest === undefined ? null : (
    <OutOfSightCapsule
      side={side}
      items={list.map((s) =>
        s.item.tone === null
          ? { kind: "outlined" as const, text: say(s) }
          : { kind: "calendar" as const, tone: s.item.tone, text: say(s) },
      )}
      label={t(side, { count: list.length })}
      onPress={() => show(nearest.top, side)}
    />
  );
}
