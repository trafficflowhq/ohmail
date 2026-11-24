import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  addDays,
  clockOf,
  dayLong,
  daySpanOf,
  isoOfDay,
  wallSpanOf,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { EventChip } from "@ohmail/ui/calendar";
import type { CalendarEventFace } from "./faces.js";
import { canStartTimeChange, resizedDays, resizeTimedRange, type EventChange } from "./event-time-change.js";
import type { EventActions } from "./use-event-actions.js";
import type { DayEdge, TimedSegment } from "./view.js";
import { dayDelta, dayTarget, DROP, listenDrag, scrollDrag } from "./calendar-drag-target.js";
import { slotOnDay } from "./use-slot-draft.js";
import { useLocale, useText } from "../text/index.js";

const DAY_MINUTES = 24 * 60;
const DRAG_DISTANCE = 4;
const HOLD_MS = 420;

interface Ghost {
  day: string;
  face: CalendarEventFace;
  minute: number;
  length: number;
}

interface RangeGhost {
  first: string;
  last: string;
  face: CalendarEventFace;
  month: boolean;
  boxes: { left: number; top: number; width: number; height: number }[];
}

interface DragCallbacks {
  moveTime: (delta: number, days: number) => DragTime | null;
  timedSpan: ReturnType<typeof daySpanOf>;
  stepWeek?: (direction: -1 | 1) => void;
  canResizeTime: (minutes: number) => boolean;
  preview: (ghost: Ghost | null) => void;
  range: (preview: RangeGhost | null) => void;
  done: () => void;
  absorbClick: () => void;
  commit: (days: number, minutes: number) => void;
}

type DragTime = { minute: number; minutes: number; length: number; day?: string };

/** A drop moves the grabbed segment by this many days. The start can be a different segment. */
function dragDestination(
  down: PointerEvent,
  point: PointerEvent,
  start: DOMRect,
  sourceDay: string,
  target: HTMLElement,
  face: CalendarEventFace,
  moveTime: DragCallbacks["moveTime"],
) {
  const dropDay = target.dataset.calDropDay;
  if (!dropDay) return null;
  const days = dayDelta(sourceDay, dropDay);
  const day = addDays(face.ref.day, days);
  if (target.dataset.calDropKind !== "time") return { day, days, time: null };
  const end = target.getBoundingClientRect();
  if (!start.height || !end.height) return null;
  const time = moveTime(
    ((point.clientY - end.top) / end.height - (down.clientY - start.top) / start.height) * DAY_MINUTES,
    days,
  );
  return time && { day, days, time };
}

function trackDrag(
  chip: HTMLButtonElement,
  down: PointerEvent,
  face: CalendarEventFace,
  edge: DayEdge | undefined,
  { preview, range, absorbClick, done, commit, moveTime, timedSpan, stepWeek, canResizeTime }: DragCallbacks,
) {
  const view = chip.closest<HTMLElement>(".cal-body-view");
  if (!view) return null;
  const source = chip.closest<HTMLElement>(DROP) ?? dayTarget(view, down);
  const kind = source?.dataset.calDropKind;
  const monthResize = edge && kind === "month" && timedSpan && !timedSpan.allDay;
  const sourceDay =
    edge && timedSpan && (timedSpan.allDay || monthResize)
      ? edge === "start"
        ? timedSpan.first
        : timedSpan.last
      : source?.dataset.calDropDay;
  if (!source || !sourceDay) return null;
  const timedResize = edge !== undefined && kind === "time";
  const start = source.getBoundingClientRect();
  const sourceBox = chip.getBoundingClientRect();
  const origin = (kind === "month" ? chip.parentElement : view)?.getBoundingClientRect();
  const rowOffset = sourceBox.top - (origin?.top ?? sourceBox.top);
  const doc = chip.ownerDocument;
  const touch = down.pointerType === "touch";
  const holdToMove = touch && !timedResize;
  let held = false;
  let aborted = false;
  let target: HTMLElement | null = null;
  const activate = () => {
    held = true;
    chip.setPointerCapture?.(down.pointerId);
    chip.dataset.drag = "lifted";
    view.dataset.calRangeHeld = "";
  };
  const timer = holdToMove ? setTimeout(activate, HOLD_MS) : null;

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    delete chip.dataset.drag;
    delete view.dataset.calRangeHeld;
    scroller?.stop();
    preview(null);
    range(null);
    if (target) delete target.dataset.calDropActive;
    detach();
    done();
  };
  const destinationAt = (point: PointerEvent, target: HTMLElement) =>
    dragDestination(down, point, start, sourceDay, target, face, moveTime);

  const draw = (point: PointerEvent) => {
    if (target) delete target.dataset.calDropActive;
    target = dayTarget(view, point, kind);
    const drop = target && destinationAt(point, target);
    const days = drop && daysAt(face, edge, drop.days, monthResize ? timedSpan : null, canResizeTime);
    if (target && kind !== "time" && !monthResize && !days) target.dataset.calDropActive = "";
    range(target && days ? rangePreview(view, face, target, days, rowOffset, sourceBox.height) : null);
    preview(ghostAt(face, drop, timedResize ? canResizeTime : undefined));
  };

  const scroller =
    kind === "time" || kind === "month"
      ? scrollDrag(view, kind, draw, timedResize ? stepWeek : undefined)
      : null;
  const move = (point: PointerEvent) => {
    if (point.pointerId !== down.pointerId || aborted) return;
    if (point.altKey) {
      abort();
      return;
    }
    const distance = Math.abs(point.clientY - down.clientY) + Math.abs(point.clientX - down.clientX);
    if (!held && distance < DRAG_DISTANCE) return;
    if (!held && holdToMove) {
      cleanup();
      return;
    }
    if (!held) activate();
    point.preventDefault();
    if (scroller) scroller.move(point);
    else draw(point);
  };
  const end = (point: PointerEvent) => {
    if (point.pointerId !== down.pointerId) return;
    const destination = held && !aborted && !point.altKey ? dayTarget(view, point, kind) : null;
    cleanup();
    if (held) absorbClick();
    if (!destination || (!edge && !chip.isConnected)) return;
    const drop = destinationAt(point, destination);
    if (drop) commit(drop.days, monthResize ? drop.days * DAY_MINUTES : (drop.time?.minutes ?? 0));
  };
  const keepTouch = (point: TouchEvent) => {
    if (held && !aborted && point.cancelable) point.preventDefault();
  };
  const cancel = (point: PointerEvent) => {
    if (point.pointerId === down.pointerId) cleanup();
  };
  const abort = () => {
    aborted = true;
    scroller?.stop();
    delete chip.dataset.drag;
    preview(null);
    range(null);
    if (target) delete target.dataset.calDropActive;
    target = null;
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !held || aborted) return;
    event.preventDefault();
    event.stopPropagation();
    abort();
  };

  const detach = listenDrag(doc, touch ? keepTouch : null, { move, end, cancel, escape, cleanup });
  return cleanup;
}

function ghostAt(
  face: CalendarEventFace,
  drop: ReturnType<typeof dragDestination>,
  canResizeTime?: (minutes: number) => boolean,
): Ghost | null {
  const time = drop?.time;
  if (!time || (time.minutes && canResizeTime && !canResizeTime(time.minutes))) return null;
  return { day: time.day ?? drop.day, face, minute: time.minute, length: time.length };
}

function daysAt(
  face: CalendarEventFace,
  edge: DayEdge | undefined,
  days: number,
  monthSpan: ReturnType<typeof daySpanOf>,
  canResizeTime: (minutes: number) => boolean,
) {
  if (face.start.kind === "date" && face.end.kind === "date") {
    return edge
      ? resizedDays(face.start, face.end, edge, days)
      : { first: addDays(isoOfDay(face.start), days), last: addDays(isoOfDay(face.end), days - 1) };
  }
  if (!monthSpan || (days && !canResizeTime(days * DAY_MINUTES))) return null;
  const first = edge === "start" ? addDays(monthSpan.first, days) : monthSpan.first;
  const last = edge === "end" ? addDays(monthSpan.last, days) : monthSpan.last;
  return first <= last ? { first, last } : null;
}

export function useEventDrag(
  actions: EventActions,
  page: string,
  zone: string,
  zones: ZoneSource,
  stepWeek?: (direction: -1 | 1) => void,
) {
  const t = useText("calendar");
  const locale = useLocale();
  const [range, showRange] = useState<RangeGhost | null>(null);
  const [ghost, showGhost] = useState<Ghost | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const suppress = useRef<HTMLButtonElement | null>(null);
  const latest = useRef(actions);
  latest.current = actions;
  const step = useRef(stepWeek);
  step.current = stepWeek;
  useLayoutEffect(() => () => stop.current?.(), [page]);

  function drag(
    face: CalendarEventFace,
    press: ReactPointerEvent<HTMLButtonElement>,
    local?: (change: EventChange) => void,
    segment?: TimedSegment,
  ) {
    if (press.button !== 0 || press.altKey || stop.current) return;
    const expected = local ? undefined : actions.moveVersion(face);
    if (!local && !expected) return;
    const chip = press.currentTarget;
    const edge = (press.target as HTMLElement).closest<HTMLElement>("[data-cal-resize]")?.dataset.calResize;
    const resize: DayEdge | undefined = edge === "start" || edge === "end" ? edge : undefined;
    const timedSpan = daySpanOf(face, zone, zones);
    const timed = resize && timedSpan && !timedSpan.allDay;
    const timeRange = timed && segment && wallSpanOf(face, zone, zones);
    stop.current = trackDrag(chip, press.nativeEvent, face, resize, {
      timedSpan,
      stepWeek: stepWeek && ((direction) => step.current?.(direction)),
      canResizeTime: (minutes) =>
        !!resize && canStartTimeChange(face, { kind: "resize-time", edge: resize, minutes }, zone, zones),
      moveTime: (delta, days) =>
        timed && segment && timeRange
          ? resizeTimedRange(timedSpan.first, timeRange, resize, segment, delta, days)
          : actions.moveTime(face, delta, true),
      preview: (next) =>
        showGhost((was) =>
          was?.day === next?.day && was?.minute === next?.minute && was?.length === next?.length ? was : next,
        ),
      range: showRange,
      done: () => {
        stop.current = null;
      },
      absorbClick: () => {
        suppress.current = chip;
        setTimeout(() => {
          if (suppress.current === chip) suppress.current = null;
        }, 0);
      },
      commit: (days, minutes) => {
        const change: EventChange = timed
          ? { kind: "resize-time", edge: resize, minutes }
          : resize
            ? { kind: "resize", edge: resize, days }
            : { kind: "time", days, minutes };
        if (local) local(change);
        else latest.current.start(face, change, chip, expected);
      },
    });
  }

  return {
    drag,
    rangePreview: range?.boxes.map((box) => (
      <div key={box.top} className="cal-day-range-preview" style={box}>
        <EventChip
          {...(range.month ? ({ size: "line", run: true } as const) : ({ size: "pill" } as const))}
          drag="copy"
          title={t("actions.resizePreview", {
            first: dayLong(range.first, locale, range.first.slice(0, 4)),
            last: dayLong(range.last, locale, range.first.slice(0, 4)),
            title: range.face.title,
          })}
          tone={range.face.tone}
        />
      </div>
    )),
    preview: ghost
      ? (day: string, hourHeight: number) => {
          const part = slotOnDay(
            { day: ghost.day, from: ghost.minute, to: ghost.minute + ghost.length },
            day,
          );
          return (
            part && (
              <EventChip
                size="block"
                drag="copy"
                title={ghost.face.title}
                tone={ghost.face.tone}
                second={clockOf(part.from)}
                place={{
                  top: (part.from * hourHeight) / 60,
                  height: ((part.to - part.from) * hourHeight) / 60,
                }}
              />
            )
          );
        }
      : null,
    suppressClick: (event: MouseEvent) => {
      if (event.detail && suppress.current?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

function rangePreview(
  view: HTMLElement,
  face: CalendarEventFace,
  target: HTMLElement,
  days: { first: string; last: string },
  rowOffset: number,
  height: number,
): RangeGhost {
  const kind = target.dataset.calDropKind;
  const month = kind === "month";
  const origin = view.getBoundingClientRect();
  const viewport = (month ? view.querySelector(".oh-mo-weeks") : view)?.getBoundingClientRect() ?? origin;
  const rows = new Map<number, { left: number; right: number }>();
  for (const cell of view.querySelectorAll<HTMLElement>(DROP)) {
    const day = cell.dataset.calDropDay;
    if (!day || day < days.first || day > days.last || cell.dataset.calDropKind !== kind) continue;
    const rect = cell.getBoundingClientRect();
    if (!rect.width || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    const top = month ? (cell.parentElement?.getBoundingClientRect().top ?? rect.top) : origin.top;
    const row = rows.get(top);
    rows.set(top, {
      left: Math.min(row?.left ?? rect.left, rect.left),
      right: Math.max(row?.right ?? rect.right, rect.right),
    });
  }
  return {
    ...days,
    face,
    month,
    boxes: [...rows].map(([top, { left, right }]) => ({
      left: left - origin.left,
      top: top - origin.top + rowOffset,
      width: right - left,
      height,
    })),
  };
}
