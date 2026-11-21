/**
 * THE WEEK: seven days of hours, the lane of whole days above them, now on today. Where each event stands is the
 * grid's rule (`@ohmail/app-logic/calendar`), read on the reader's clock; the view hands the kit's chips their places
 * and opens an event through the frame's named command. On a phone's narrow width the week is the picked day's hours,
 * under the head's strip of the week's dates, so it draws no day head of its own.
 */
import { createContext, useContext, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import {
  AllDayRow,
  EventChip,
  OutOfSightCapsule,
  TimeGrid,
  dayColumn,
  type TimeGridDay as KitDay,
} from "@ohmail/ui/calendar";
import { contextTrigger, RefusalLine, type Point } from "@ohmail/ui/base";
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
  type PlainDate,
  type TimeGridDay,
} from "@ohmail/app-logic/calendar";
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

export type WeekContextTarget =
  | { kind: "event"; id: string; at: Point | Element; opener: HTMLButtonElement }
  | { kind: "time"; day: string; from: number; to: number; at: Point };

interface WeekContextActions {
  open: (target: WeekContextTarget) => void;
  slot: { day: string; from: number; to: number } | null;
}

export const WeekContextMenu = createContext<WeekContextActions | null>(null);

function useEventContext(menu: WeekContextActions | null) {
  const events = useRef(new WeakMap<EventTarget, string>());
  const trigger = (opener: HTMLButtonElement, id: string) =>
    contextTrigger((at) => menu?.open({ kind: "event", id, at, opener }));
  return {
    chip: (event: CalendarEventView) =>
      menu
        ? {
            ref: (opener: HTMLButtonElement | null) => {
              if (opener) events.current.set(opener, event.id);
            },
            onContextMenu: (press: MouseEvent<HTMLButtonElement>) => {
              press.stopPropagation();
              press.currentTarget.focus({ preventScroll: true });
              trigger(press.currentTarget, event.id).onContextMenu(press);
            },
          }
        : undefined,
    key: (press: KeyboardEvent<HTMLElement>) => {
      const opener = press.target;
      if (!menu || !(opener instanceof HTMLButtonElement)) return;
      const id = events.current.get(opener);
      if (!id) return;
      trigger(opener, id).onKeyDown({
        key: press.key,
        shiftKey: press.shiftKey,
        currentTarget: opener,
        preventDefault: () => {
          press.preventDefault();
          press.stopPropagation();
        },
      });
    },
  };
}

function timeContext(menu: WeekContextActions, day: string, event: MouseEvent<HTMLDivElement>) {
  if ((event.target as Element).closest("button, a")) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (bounds.height <= 0) return;
  const dayMinutes = 24 * 60;
  const minute = ((event.clientY - bounds.top) * dayMinutes) / bounds.height;
  const from = Math.max(0, Math.min(dayMinutes - 30, Math.floor(minute / 30) * 30));
  const to = Math.min(dayMinutes, from + 60);
  contextTrigger((at) => {
    if ("x" in at) menu.open({ kind: "time", day, from, to, at });
  }).onContextMenu(event);
}

/** The days the week shows: seven from the week's first day. */
export function weekSpan(anchor: PlainDate, settings: CalendarViewSettings): readonly PlainDate[] {
  return weekDays(anchor, settings.weekStart);
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
  const days = useMemo(() => (one ? all.filter((d) => sameDay(d, anchor)) : all), [one, all, anchor]);
  const hours = useHoursScroller({
    hours: settings.hours,
    hourDefault: plan.device === "phone" ? 56 : 60,
    room: plan,
    focusMinute: props.cursor,
    spanKey: isoOfDay(days[0]!),
    openId,
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
    free: false,
  });
  const open = (e: CalendarEventView): void => props.onOpen(e.ref);

  const calendar = useText("calendar");
  const menu = useContext(WeekContextMenu);
  const slot = menu?.slot;
  const context = useEventContext(menu);
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
    children: d.blocks.map((b) => (
      <EventChip
        key={b.item.id}
        size="block"
        {...blockChip(b, b.item.id === openId)}
        dense={dense}
        label={t("chip", { title: b.item.title, from: clockOf(b.from), to: clockOf(b.to) })}
        onPress={() => open(b.item)}
        {...context.chip(b.item)}
        {...timedResizeProps(props, b, {
          start: calendar("actions.resizeTimeStart"),
          end: calendar("actions.resizeTimeEnd"),
        })}
      />
    )),
  }));

  const lane = weekPills(model.lane.pills, crease, props, t, calendar, context.chip);

  return (
    <section className="cw-week" aria-label={t("hours")} onKeyDown={context.key}>
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
        onDayContextMenu={menu ? (day, event) => timeContext(menu, day, event) : undefined}
        onDayPointerDown={props.onSlot}
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
  contextChip: ReturnType<typeof useEventContext>["chip"],
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
        {...contextChip(p.item)}
        onPointerDown={props.onDrag ? (event) => props.onDrag?.(p.item.id, event) : undefined}
      />
    );
  });
}

export const weekView: CalendarView = {
  View: WeekView,
  span: (anchor, settings) => weekSpan(anchor, settings),
};
