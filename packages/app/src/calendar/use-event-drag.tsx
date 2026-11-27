import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clockOf, daySpanOf, eventTimeOf, wallSpanOf, type ZoneSource } from "@ohmail/app-logic/calendar";
import { EventChip } from "@ohmail/ui/calendar";
import { cssPoint, cssRect } from "@ohmail/ui/viewport";
import type { CalendarEventFace } from "./faces.js";
import { changedTimes, resizeTimedRange, type EventChange } from "./event-time-change.js";
import { calendarInterval } from "./event-words.js";
import type { EventActions } from "./use-event-actions.js";
import type { DayEdge, TimedSegment } from "./view.js";
import { dayDelta, dayTarget, DROP, listenDrag, rangeBoxes, scrollDrag } from "./calendar-drag-target.js";
import { slotOnDay } from "./use-slot-draft.js";
import { useLocale, useText } from "../text/index.js";

const DAY_MINUTES = 24 * 60;
const DRAG_DISTANCE = 4;
const HOLD_MS = 420;

type DaySpan = NonNullable<ReturnType<typeof daySpanOf>>;
type DropKind = "month" | "time" | "all-day";
type TimeSlot = { day: string; from: number; to: number };

interface DestinationPreview {
  span: DaySpan;
  slot: TimeSlot | null;
  when: string;
}

interface Destination {
  change: EventChange | null;
  preview: DestinationPreview | null;
}

interface DragPreview extends DestinationPreview {
  face: CalendarEventFace;
  kind: DropKind;
  boxes: ReturnType<typeof rangeBoxes>;
  label: CSSProperties;
}

interface DragCallbacks {
  span: DaySpan | null;
  stepWeek?: (direction: -1 | 1) => void;
  destination: (days: number, delta: number | null) => Destination | null;
  preview: (copy: DragPreview | null) => void;
  done: () => void;
  absorbClick: () => void;
  commit: (change: EventChange) => void;
}

function dropKind(source: HTMLElement | null): DropKind | null {
  const kind = source?.dataset.calDropKind;
  return kind === "time" || kind === "month" || kind === "all-day" ? kind : null;
}

function verticalDelta(down: PointerEvent, point: PointerEvent, start: DOMRect, target: HTMLElement) {
  const end = target.getBoundingClientRect();
  return ((point.clientY - end.top) / end.height - (down.clientY - start.top) / start.height) * DAY_MINUTES;
}

function originalChips(view: HTMLElement, chip: HTMLButtonElement, face: CalendarEventFace) {
  const record = chip.dataset.record;
  if (!record || face.ref.occurrence !== null) return [chip];
  return [...view.querySelectorAll<HTMLElement>(".oh-ev[data-record]")].filter(
    (part) => part.dataset.record === record,
  );
}

function trackDrag(
  chip: HTMLButtonElement,
  down: PointerEvent,
  face: CalendarEventFace,
  edge: DayEdge | undefined,
  { preview, absorbClick, done, commit, destination, span, stepWeek }: DragCallbacks,
) {
  const view = chip.closest<HTMLElement>(".cal-body-view");
  if (!view) return null;
  const source = chip.closest<HTMLElement>(DROP) ?? dayTarget(view, down);
  const kind = dropKind(source);
  if (!source || !kind) return null;
  const sourceDay =
    edge && span && kind !== "time" ? (edge === "start" ? span.first : span.last) : source.dataset.calDropDay;
  if (!sourceDay) return null;
  const start = source.getBoundingClientRect();
  const sourceBox = cssRect(chip);
  const origin = kind === "month" ? chip.parentElement : view;
  const rowOffset = sourceBox.top - (origin ? cssRect(origin).top : sourceBox.top);
  const doc = chip.ownerDocument;
  const lifted = originalChips(view, chip, face);
  const touch = down.pointerType === "touch";
  const holdToMove = touch && !(edge && kind === "time");
  let held = false;
  let aborted = false;
  let target: HTMLElement | null = null;
  let drop: Destination | null = null;
  const activate = () => {
    held = true;
    chip.setPointerCapture?.(down.pointerId);
    for (const original of lifted) original.dataset.drag = "lifted";
    view.dataset.calRangeHeld = "";
  };
  const timer = holdToMove ? setTimeout(activate, HOLD_MS) : null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    scroller?.stop();
    if (target) delete target.dataset.calDropActive;
    target = null;
    drop = null;
    for (const original of lifted) delete original.dataset.drag;
    delete view.dataset.calRangeHeld;
    preview(null);
  };
  const cleanup = () => {
    clear();
    detach();
    done();
  };

  const draw = (point: PointerEvent) => {
    if (target) delete target.dataset.calDropActive;
    target = dayTarget(view, point, kind);
    const day = target?.dataset.calDropDay;
    const delta = target && kind === "time" ? verticalDelta(down, point, start, target) : null;
    drop =
      day && (delta === null || Number.isFinite(delta)) ? destination(dayDelta(sourceDay, day), delta) : null;
    const copy = drop?.preview;
    if (!copy) {
      preview(null);
      return;
    }
    if (target && kind === "month") target.dataset.calDropActive = "";
    preview(previewAt(view, point, kind, face, copy, rowOffset, sourceBox.height));
  };

  const scroller =
    kind === "time" || kind === "month"
      ? scrollDrag(view, kind, draw, edge && kind === "time" ? stepWeek : undefined)
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
    // Use the last tracked change, including targets the action must refuse.
    const change = held && !aborted && !point.altKey && dayTarget(view, point, kind) ? drop?.change : null;
    cleanup();
    if (held) absorbClick();
    if (change && (edge || chip.isConnected)) commit(change);
  };
  const keepTouch = (point: TouchEvent) => {
    if (held && !aborted && point.cancelable) point.preventDefault();
  };
  const cancel = (point: PointerEvent) => {
    if (point.pointerId === down.pointerId) cleanup();
  };
  const abort = () => {
    aborted = true;
    clear();
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

function previewAt(
  view: HTMLElement,
  point: PointerEvent,
  kind: DropKind,
  face: CalendarEventFace,
  { span, slot, when }: DestinationPreview,
  rowOffset: number,
  height: number,
): DragPreview {
  return {
    span,
    slot,
    when,
    face,
    kind,
    boxes: kind === "time" ? [] : rangeBoxes(view, kind, span, rowOffset, height),
    label: labelPosition(view, point),
  };
}

function eventDestination(
  face: CalendarEventFace,
  change: EventChange | null,
  zone: string,
  zones: ZoneSource,
) {
  if (!change) return face;
  const times = changedTimes(change, face, zone, zones);
  const start = times?.start && eventTimeOf(times.start);
  const end = times?.end && eventTimeOf(times.end);
  return start && end ? { ...face, start, end } : null;
}

function timedSlot(event: CalendarEventFace, span: DaySpan, zone: string, zones: ZoneSource) {
  const wall = wallSpanOf(event, zone, zones);
  if (!wall || span.startMinute === null) return null;
  return { day: span.first, from: span.startMinute, to: span.startMinute + wall.to - wall.from };
}

function describeDestination(
  event: CalendarEventFace | null,
  zone: string,
  zones: ZoneSource,
  timed: boolean,
  when: (event: CalendarEventFace) => string,
): DestinationPreview | null {
  const span = event && daySpanOf(event, zone, zones);
  if (!event || !span) return null;
  const slot = timed ? timedSlot(event, span, zone, zones) : null;
  return timed && !slot ? null : { span, slot, when: when(event) };
}

function changeAt(
  edge: DayEdge | undefined,
  timed: DayEdge | undefined,
  days: number,
  minutes: number,
): EventChange | null {
  if (timed) return minutes ? { kind: "resize-time", edge: timed, minutes } : null;
  if (edge) return days ? { kind: "resize", edge, days } : null;
  return days || minutes ? { kind: "time", days, minutes } : null;
}

export function useEventDrag(
  actions: EventActions,
  page: string,
  zone: string,
  zones: ZoneSource,
  today: string,
  stepWeek?: (direction: -1 | 1) => void,
) {
  const t = useText("calendar");
  const locale = useLocale();
  const [ghost, showGhost] = useState<DragPreview | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const suppress = useRef<HTMLButtonElement | null>(null);
  const latest = useRef(actions);
  latest.current = actions;
  const step = useRef(stepWeek);
  step.current = stepWeek;
  useLayoutEffect(() => () => stop.current?.(), [page, zone]);

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
    const span = daySpanOf(face, zone, zones);
    const timedResize = resize && span && !span.allDay ? resize : undefined;
    const timeRange = timedResize && segment && wallSpanOf(face, zone, zones);
    stop.current = trackDrag(chip, press.nativeEvent, face, resize, {
      span,
      stepWeek: stepWeek && ((direction) => step.current?.(direction)),
      destination: (days, delta) => {
        const shift =
          delta === null
            ? null
            : timedResize && span && segment && timeRange
              ? resizeTimedRange(span.first, timeRange, timedResize, segment, delta, days)
              : actions.moveTime(face, delta, true);
        if (delta !== null && !shift) return null;
        const minutes = shift?.minutes ?? (timedResize ? days * DAY_MINUTES : 0);
        const change = changeAt(resize, timedResize, days, minutes);
        const event = eventDestination(face, change, zone, zones);
        const preview = describeDestination(event, zone, zones, delta !== null, (event) =>
          calendarInterval(event, zone, zones, today, locale, t),
        );
        return { change, preview };
      },
      preview: showGhost,
      done: () => {
        stop.current = null;
      },
      absorbClick: () => {
        suppress.current = chip;
        setTimeout(() => {
          if (suppress.current === chip) suppress.current = null;
        }, 0);
      },
      commit: (change) => {
        if (local) local(change);
        else latest.current.start(face, change, chip, expected);
      },
    });
  }

  return {
    drag,
    rangePreview: ghost && (
      <>
        {ghost.boxes.map((box) => (
          <div key={box.top} className="cal-day-range-preview" style={box}>
            <EventChip
              {...(ghost.kind === "month"
                ? { size: "line" as const, run: ghost.span.allDay || ghost.span.first !== ghost.span.last }
                : { size: "pill" as const })}
              drag="copy"
              title={ghost.face.title}
              tone={ghost.face.tone}
            />
          </div>
        ))}
        <div role="status" className="cal-drag-when" style={ghost.label}>
          {ghost.when}
        </div>
      </>
    ),
    preview: ghost?.slot
      ? (day: string, hourHeight: number) => {
          const part = ghost.slot && slotOnDay(ghost.slot, day);
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

function labelPosition(view: HTMLElement, point: PointerEvent): CSSProperties {
  const box = cssRect(view);
  const { x, y } = cssPoint(point);
  // Keep the date and time in the view even in a narrow column or at the scroll edge.
  return {
    ...(x - box.left < box.width / 2 ? { left: x - box.left } : { right: box.right - x }),
    ...(y - box.top < box.height / 2 ? { top: y - box.top } : { bottom: box.bottom - y }),
  };
}
