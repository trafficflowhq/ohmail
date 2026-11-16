/**
 * THE TIME GRID AS A VIEW DRAWS IT: for each day shown, its events placed in pixels with their lanes, its free
 * stretches and what lies out of sight; the lane above the hours; now. Derived from what it is handed on every call,
 * kept by nobody: the hook memoises on its inputs alone.
 */
import { useMemo } from "react";
import type { PlainDate, ZoneSource } from "@ohmail/cal-core";
import { allDayLane, type AllDayLane } from "./all-day.js";
import { isoOfDay, nowIn, sameDay } from "./days.js";
import { freeStretches, outOfSight, type FreeStretch } from "./edges.js";
import { laneLimits, lanesOf, type Laned, type LaneLimits } from "./lanes.js";
import { placeDays, type GridItem, type Segment } from "./place.js";

export interface TimeGridInput<T extends GridItem> {
  readonly events: readonly T[];
  readonly days: readonly PlainDate[];
  /** The reader's zone, and where zone rules come from. */
  readonly zone: string;
  readonly zones: ZoneSource;
  readonly nowMs: number;
  /** An hour's height in px. */
  readonly hourPx: number;
  /** The minutes of the day the scroller shows now; `null` before it has been measured (nothing is out of sight yet). */
  readonly inView: { readonly from: number; readonly to: number } | null;
  /** The day picked, where it is not today. */
  readonly picked: PlainDate | null;
  /** Print the free stretches (the day alone). */
  readonly free: boolean;
}

/** A block of the hours: its lane and its place in px from the first hour (00:00). */
export interface TimeBlock<T extends GridItem = GridItem> extends Laned<T> {
  readonly top: number;
  readonly height: number;
  /** Px of it above a later block that laps over it. */
  readonly roomPx: number | undefined;
  /** The line of now crosses it. */
  readonly nowCrosses: boolean;
}

export interface TimeGridDay<T extends GridItem = GridItem> {
  readonly day: PlainDate;
  readonly id: string;
  readonly today: boolean;
  readonly picked: boolean;
  readonly blocks: readonly TimeBlock<T>[];
  readonly free: readonly FreeStretch[];
  readonly above: readonly Segment<T>[];
  readonly below: readonly Segment<T>[];
}

export interface TimeGridModel<T extends GridItem = GridItem> {
  readonly days: readonly TimeGridDay<T>[];
  readonly lane: AllDayLane<T>;
  /** Now in minutes of today, where today is shown; `null` otherwise. */
  readonly now: { readonly minutes: number } | null;
  /** Events whose time cannot be read here: said by the view, never drawn. */
  readonly unplaced: readonly T[];
  readonly limits: LaneLimits;
}

const px = (minutes: number, hourPx: number): number => (minutes * hourPx) / 60;

export function timeGridModel<T extends GridItem>(input: TimeGridInput<T>): TimeGridModel<T> {
  const { days, hourPx } = input;
  const limits = laneLimits(hourPx);
  const placed = placeDays(input.events, days, input.zone, input.zones);
  const now = nowIn(input.nowMs, input.zone, input.zones);
  const todayAt = now === null ? -1 : days.findIndex((d) => sameDay(d, now.day));
  const out = days.map((day, i): TimeGridDay<T> => {
    const segments = placed.timed[i]!;
    const nowHere = i === todayAt && now !== null ? now.minutes : null;
    const blocks = lanesOf(segments, limits).map((l): TimeBlock<T> => ({
      ...l,
      top: px(l.from, hourPx),
      height: px(l.to - l.from, hourPx),
      roomPx: l.room === null ? undefined : px(l.room, hourPx),
      nowCrosses: nowHere !== null && l.from < nowHere && l.to > nowHere,
    }));
    const sight =
      input.inView === null ? { above: [], below: [] } : outOfSight(segments, input.inView, limits.shortest);
    return {
      day,
      id: isoOfDay(day),
      today: i === todayAt,
      picked: input.picked !== null && sameDay(day, input.picked) && i !== todayAt,
      blocks,
      free: input.free ? freeStretches(segments) : [],
      above: sight.above,
      below: sight.below,
    };
  });
  return {
    days: out,
    lane: allDayLane(placed.allDay, days),
    now: todayAt >= 0 && now !== null ? { minutes: now.minutes } : null,
    unplaced: placed.unplaced,
    limits,
  };
}

/** The model for a view, worked out again only when one of its inputs is another value. */
export function useTimeGrid<T extends GridItem>(input: TimeGridInput<T>): TimeGridModel<T> {
  const { events, days, zone, zones, nowMs, hourPx, inView, picked, free } = input;
  const from = inView?.from ?? null;
  const to = inView?.to ?? null;
  return useMemo(
    () =>
      timeGridModel({
        events,
        days,
        zone,
        zones,
        nowMs,
        hourPx,
        inView: from === null || to === null ? null : { from, to },
        picked,
        free,
      }),
    [events, days, zone, zones, nowMs, hourPx, from, to, picked, free],
  );
}
