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
  isoOfDay,
  nowIn,
  pillChip,
  sameDay,
  useHoursScroller,
  useTimeGrid,
  weekDays,
  type PlainDate,
  type TimeGridDay,
} from "@ohmail/app-logic/calendar";
import type {
  CalendarEventView,
  CalendarView,
  CalendarViewProps,
  CalendarViewSettings,
} from "../calendar/view.js";
import type { LayoutPlan } from "../frame/contract.js";
import { HeldNotice } from "../calendar/HeldNotice.js";
import { useLocale, useText } from "../text/index.js";
import "./week.css";

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
  const { anchor, settings, plan, clock, openId } = props;
  const all = useMemo(() => weekSpan(anchor, settings), [anchor, settings]);
  const { one, crease, dense } = weekLayout(plan, props.panel);
  const days = useMemo(() => (one ? all.filter((d) => sameDay(d, anchor)) : all), [one, all, anchor]);
  const hours = useHoursScroller({
    hours: settings.hours,
    hourDefault: plan.device === "phone" ? 56 : 60,
    room: plan,
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

  const capsule = (d: TimeGridDay<CalendarEventView>, side: "above" | "below") => {
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
        onPress={() => hours.show(nearest.top, side)}
      />
    );
  };

  const kitDays: KitDay[] = model.days.map((d) => ({
    ...dayHead(d.day, locale),
    id: d.id,
    today: d.today,
    picked: d.picked,
    above: capsule(d, "above"),
    below: capsule(d, "below"),
    children: d.blocks.map((b) => (
      <EventChip
        key={b.item.id}
        size="block"
        {...blockChip(b, b.item.id === openId)}
        dense={dense}
        label={t("chip", { title: b.item.title, from: clockOf(b.from), to: clockOf(b.to) })}
        onPress={() => open(b.item)}
      />
    )),
  }));

  const lane = model.lane.pills.map((p) => {
    const chip = pillChip(p, p.item.id === openId);
    return (
      <EventChip
        key={p.item.id}
        size="pill"
        {...chip}
        label={t("chipAllDay", { title: p.item.title })}
        style={{
          gridColumn: `${dayColumn(chip.first, crease)} / ${dayColumn(chip.last, crease) + 1}`,
          gridRow: chip.row + 1,
        }}
        onPress={() => open(p.item)}
      />
    );
  });

  return (
    <section className="cw-week" aria-label={t("hours")}>
      <HeldNotice
        edge={props.edge}
        first={isoOfDay(days[0]!)}
        last={isoOfDay(days.at(-1)!)}
        today={isoOfDay(nowIn(clock.nowMs, clock.zone, clock.zones)?.day ?? anchor)}
        className="cw-note"
      />
      {model.unplaced.length > 0 ? (
        <RefusalLine>{t("unplaced", { count: model.unplaced.length })}</RefusalLine>
      ) : null}
      {props.capped ? <RefusalLine>{t("capped")}</RefusalLine> : null}
      <TimeGrid
        days={kitDays}
        heads={!one}
        allDay={<AllDayRow label={t("allDay")}>{lane}</AllDayRow>}
        firstHour={0}
        hourLabels={hourLabels(0, 24)}
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
        scrollRef={hours.ref}
        onScroll={hours.onScroll}
      />
    </section>
  );
}

export const weekView: CalendarView = {
  View: WeekView,
  span: (anchor, settings) => weekSpan(anchor, settings),
};
