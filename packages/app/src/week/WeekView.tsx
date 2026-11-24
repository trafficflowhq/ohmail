/**
 * THE WEEK: seven days of hours, the lane of whole days above them, now on today. Where each event stands is the
 * grid's rule (`@ohmail/app-logic/calendar`), read on the reader's clock; the view hands the kit's chips their places
 * and opens an event through the frame's named command. On a phone's narrow width the week is the picked day's hours,
 * under the head's strip of the week's dates, so it draws no day head of its own.
 */
import { useMemo } from "react";
import {
  AllDayRow,
  EventChip,
  OutOfSightCapsule,
  TimeGrid,
  dayColumn,
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
  pillChip,
  sameDay,
  useHoursScroller,
  useTimeGrid,
  weekDays,
  weekdayOfDay,
  type PlainDate,
  type TimeGridDay,
} from "@ohmail/app-logic/calendar";
import { freeHours } from "../day/DayView.js";
import { useCalendarMenu } from "../calendar/event-menu-trigger.js";
import { timedResizeProps } from "../calendar/view.js";
import type {
  CalendarEventView,
  CalendarView,
  CalendarViewProps,
  CalendarViewSettings,
} from "../calendar/view.js";
import type { LayoutPlan } from "../frame/contract.js";
import { useCalendarSwipe } from "../calendar/use-calendar-swipe.js";
import { useLocale, useText } from "../text/index.js";
import "./week.css";

/** The days the week shows: seven from the week's first day. */
export function weekSpan(anchor: PlainDate, settings: CalendarViewSettings): readonly PlainDate[] {
  const days = weekDays(anchor, settings.weekStart);
  return settings.weekends === false ? days.filter((day) => weekdayOfDay(day) < 5) : days;
}

/** On a phone's narrow width the week shows the picked day's hours alone; the unfolded phone's hinge falls after its fourth day. */
export function weekLayout(
  plan: LayoutPlan,
  panel: boolean,
): { one: boolean; crease: number; dense: boolean } {
  const one = plan.device === "phone" && plan.size === "compact";
  return {
    one,
    crease: !one && plan.device === "fold" && plan.columns === 2 ? 3 : 0,
    dense: !one && (plan.device !== "desktop" || panel),
  };
}

export function WeekView(props: CalendarViewProps) {
  const t = useText("week");
  const locale = useLocale();
  const swipe = useCalendarSwipe(props.stepDay);
  const { anchor, settings, plan, clock, openId } = props;
  const all = useMemo(() => weekSpan(anchor, settings), [anchor, settings]);
  const { one, crease, dense } = weekLayout(plan, props.panel);
  const days = useMemo(() => (one ? [anchor] : all), [one, all, anchor]);
  const hours = useHoursScroller({
    hours: settings.hours,
    hourDefault: plan.device === "phone" ? 56 : 60,
    fixedHourHeight: props.fixedHourHeight,
    room: plan,
    focusMinute: props.cursor,
    spanKey: isoOfDay(days[0]!),
    openId,
    revealOpen: props.revealOpen,
    openTop: () => model.days.flatMap((d) => d.blocks).find((b) => b.item.id === openId)?.top ?? null,
  });
  const model = useTimeGrid({
    events: props.events,
    days,
    zone: clock.zone,
    zones: clock.zones,
    nowMs: clock.nowMs,
    hourPx: hours.hourPx,
    inView: hours.inView,
    picked: anchor,
    free: one,
  });
  const open = (e: CalendarEventView): void => props.onOpen(e.ref);

  const calendar = useText("calendar");
  const dayWords = useText("day");
  const context = useCalendarMenu();
  const slot = context.slot;
  const kitDays: KitDay[] = model.days.map((d) => ({
    ...dayHead(d.day, locale),
    id: d.id,
    today: d.today,
    cursor:
      slot?.day === d.id
        ? { minutes: slot.from, length: slot.to - slot.from }
        : props.cursor != null && sameDay(d.day, anchor)
          ? { minutes: props.cursor, length: 60 }
          : undefined,
    picked: d.picked,
    above: capsule(d, "above", hours.show, t),
    below: capsule(d, "below", hours.show, t),
    free: d.free.map((gap) => ({ minutes: gap.at, text: freeHours(dayWords, gap.minutes) })),
    children: d.blocks.map((b) => (
      <EventChip
        key={b.item.id}
        size="block"
        {...blockChip(b, b.item.id === openId)}
        dense={dense}
        label={t("chip", { title: b.item.title, from: clockOf(b.from), to: clockOf(b.to) })}
        onPress={() => open(b.item)}
        {...context.eventProps<HTMLButtonElement>(b.item)}
        {...timedResizeProps(props, b, {
          start: calendar("actions.resizeTimeStart"),
          end: calendar("actions.resizeTimeEnd"),
        })}
      />
    )),
  }));

  const lane = weekPills(model.lane.pills, crease, props, t, calendar, context.eventProps);

  return (
    <section className="cw-week" aria-label={t("hours")}>
      {model.unplaced.length > 0 ? (
        <RefusalLine>{t("unplaced", { count: model.unplaced.length })}</RefusalLine>
      ) : null}
      {props.capped ? <RefusalLine>{t("capped")}</RefusalLine> : null}
      <TimeGrid
        days={kitDays}
        heads={!one}
        allDay={
          <AllDayRow label={t("allDay")} targets={kitDays.map((day) => day.id)} crease={crease}>
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
        dense={dense}
        crease={crease}
        onDayPress={(id) => {
          const day = model.days.find((m) => m.id === id)?.day;
          if (day !== undefined) props.onDay(day);
        }}
        onDayContextMenu={context.time}
        onDayMenuKey={context.timeKey}
        onDayPointerDown={props.onSlot}
        scrollRoomForSheet={props.revealOpen && plan.device === "phone"}
        scrollRef={hours.ref}
        scrollGestures={swipe}
        onScroll={hours.onScroll}
      />
    </section>
  );
}

function capsule(
  d: TimeGridDay<CalendarEventView>,
  side: "above" | "below",
  show: ReturnType<typeof useHoursScroller>["show"],
  t: ReturnType<typeof useText>,
) {
  const list = side === "above" ? d.above : d.below;
  const nearest = list.length > 0 ? d.blocks.find((b) => b.item.id === list[0]!.item.id) : undefined;
  return nearest === undefined ? null : (
    <OutOfSightCapsule
      side={side}
      items={list.map((s) =>
        s.item.tone === null
          ? { kind: "outlined" as const }
          : { kind: "calendar" as const, tone: s.item.tone },
      )}
      label={t(side, { count: list.length })}
      onPress={() => show(nearest.top, side)}
    />
  );
}

function weekPills(
  pills: ReturnType<typeof useTimeGrid<CalendarEventView>>["lane"]["pills"],
  crease: number,
  props: CalendarViewProps,
  t: ReturnType<typeof useText>,
  calendar: ReturnType<typeof useText>,
  contextChip: ReturnType<typeof useCalendarMenu>["eventProps"],
) {
  return pills.map((p) => {
    const chip = pillChip(p, p.item.id === props.openId);
    return (
      <EventChip
        key={p.item.id}
        size="pill"
        {...chip}
        dayEdges={
          props.onDrag &&
          (props.openId === null || props.openId === p.item.id || p.item.state === "draft") &&
          !p.item.viewOnly
            ? {
                start: p.before ? undefined : calendar("actions.resizeStart"),
                end: p.after ? undefined : calendar("actions.resizeEnd"),
              }
            : undefined
        }
        label={t("chipAllDay", { title: p.item.title })}
        style={{
          gridColumn: `${dayColumn(chip.first, crease)} / ${dayColumn(chip.last, crease) + 1}`,
          gridRow: chip.row + 1,
        }}
        onPress={() => props.onOpen(p.item.ref)}
        {...contextChip<HTMLButtonElement>(p.item)}
        onPointerDown={props.onDrag ? (event) => props.onDrag?.(p.item.id, event) : undefined}
      />
    );
  });
}

export const weekView: CalendarView = {
  View: WeekView,
  span: (anchor, settings) => weekSpan(anchor, settings),
};
