import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { addDays, clockOf, dayLong, isoOfDay, resizeSlot } from "@ohmail/app-logic/calendar";
import { EventChip } from "@ohmail/ui/calendar";
import type { CalendarEventFace } from "./faces.js";
import { resizedDays } from "./event-time-change.js";
import type { EventActions } from "./use-event-actions.js";
import type { DayEdge, TimedSegment } from "./view.js";
import { useLocale, useText } from "../text/index.js";

const DAY_MS = 86_400_000;
const DAY_MINUTES = 24 * 60;
const DROP = "[data-cal-drop-day]";
const DRAG_DISTANCE = 4;
const HOLD_MS = 420;

function dayTarget(element: HTMLElement, point: PointerEvent, kind?: string) {
  const doc = element.ownerDocument;
  const hits = doc.elementsFromPoint?.(point.clientX, point.clientY) ?? [
    doc.elementFromPoint?.(point.clientX, point.clientY),
  ];
  const view = element.closest(".cal-body-view");
  for (const hit of hits) {
    const target = hit?.closest<HTMLElement>(DROP);
    if (target && (!kind || target.dataset.calDropKind === kind) && view?.contains(target)) return target;
    const lane = hit?.closest("[data-cal-all-day-lane]");
    if (lane && (!kind || kind === "all-day") && view?.contains(lane)) {
      for (const column of lane.querySelectorAll<HTMLElement>(DROP)) {
        const rect = column.getBoundingClientRect();
        if (rect.left <= point.clientX && point.clientX < rect.right) return column;
      }
    }
  }
  return null;
}

interface Ghost {
  day: string;
  face: CalendarEventFace;
  top: number;
  height: number;
  minute: number;
}

interface RangeGhost {
  first: string;
  last: string;
  face: CalendarEventFace;
  month: boolean;
  boxes: { left: number; top: number; width: number; height: number }[];
}

interface DragCallbacks {
  moveTime: (delta: number) => DragTime | null;
  preview: (ghost: Ghost | null) => void;
  range: (preview: RangeGhost | null) => void;
  done: () => void;
  absorbClick: () => void;
  commit: (days: number, minutes: number) => void;
}

type DragTime = { minute: number; minutes: number; length: number };

function dayDelta(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS;
}

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
  );
  return time && { day, days, time };
}

function timePreview(
  target: HTMLElement,
  day: string,
  time: DragTime,
  face: CalendarEventFace,
): Ghost | null {
  const scale = target.clientHeight / DAY_MINUTES;
  if (!scale) return null;
  const { minute, length } = time;
  return { day, face, minute, top: minute * scale, height: Math.min(length, DAY_MINUTES - minute) * scale };
}

function trackDrag(
  chip: HTMLButtonElement,
  down: PointerEvent,
  face: CalendarEventFace,
  edge: DayEdge | undefined,
  { preview, range, absorbClick, done, commit, moveTime }: DragCallbacks,
) {
  const source = chip.closest<HTMLElement>(DROP) ?? dayTarget(chip, down);
  const sourceDay =
    edge && face.start.kind === "date" && face.end.kind === "date"
      ? edge === "start"
        ? isoOfDay(face.start)
        : addDays(isoOfDay(face.end), -1)
      : source?.dataset.calDropDay;
  if (!source || !sourceDay) return null;
  const kind = source.dataset.calDropKind;
  const timedResize = edge !== undefined && kind === "time";
  const start = source.getBoundingClientRect();
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
  };
  const timer = holdToMove ? setTimeout(activate, HOLD_MS) : null;

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    delete chip.dataset.drag;
    preview(null);
    range(null);
    if (target) delete target.dataset.calDropActive;
    detach();
    done();
  };
  const destinationAt = (point: PointerEvent, target: HTMLElement) =>
    dragDestination(down, point, start, sourceDay, target, face, moveTime);

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
    if (target) delete target.dataset.calDropActive;
    target = timedResize ? source : dayTarget(chip, point, kind);
    if (target && face.start.kind === "date" && face.end.kind === "date") {
      const drop = destinationAt(point, target);
      const days =
        drop &&
        (edge
          ? resizedDays(face.start, face.end, edge, drop.days)
          : {
              first: addDays(isoOfDay(face.start), drop.days),
              last: addDays(isoOfDay(face.end), drop.days - 1),
            });
      range(days ? rangePreview(chip, face, target, days) : null);
      return;
    }
    if (!target || kind !== "time") {
      if (target) target.dataset.calDropActive = "";
      preview(null);
      range(null);
      return;
    }
    const drop = destinationAt(point, target);
    preview(drop?.time ? timePreview(target, timedResize ? sourceDay : drop.day, drop.time, face) : null);
  };
  const end = (point: PointerEvent) => {
    if (point.pointerId !== down.pointerId) return;
    const destination =
      held && !aborted && !point.altKey ? (timedResize ? source : dayTarget(chip, point, kind)) : null;
    cleanup();
    if (held) absorbClick();
    if (!destination || !chip.isConnected) return;
    const drop = destinationAt(point, destination);
    if (drop) commit(drop.days, drop.time?.minutes ?? 0);
  };
  const keepTouch = (point: TouchEvent) => {
    if (held && !aborted && point.cancelable) point.preventDefault();
  };
  const cancel = (point: PointerEvent) => {
    if (point.pointerId === down.pointerId) cleanup();
  };
  const abort = () => {
    aborted = true;
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

  const detach = listen(doc, touch ? keepTouch : null, { move, end, cancel, escape, cleanup });
  return cleanup;
}

function listen(
  doc: Document,
  touchmove: ((event: TouchEvent) => void) | null,
  listeners: {
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
    escape: (event: KeyboardEvent) => void;
    cleanup: () => void;
  },
) {
  const { move, end, cancel, escape, cleanup } = listeners;
  doc.addEventListener("pointermove", move, { passive: false });
  doc.addEventListener("pointerup", end);
  doc.addEventListener("pointercancel", cancel);
  if (touchmove) doc.addEventListener("touchmove", touchmove, { passive: false });
  doc.addEventListener("keydown", escape, true);
  doc.defaultView?.addEventListener("blur", cleanup);
  return () => {
    doc.removeEventListener("pointermove", move);
    doc.removeEventListener("pointerup", end);
    doc.removeEventListener("pointercancel", cancel);
    if (touchmove) doc.removeEventListener("touchmove", touchmove);
    doc.removeEventListener("keydown", escape, true);
    doc.defaultView?.removeEventListener("blur", cleanup);
  };
}

export function useEventDrag(actions: EventActions, page: string) {
  const t = useText("calendar");
  const locale = useLocale();
  const [range, showRange] = useState<RangeGhost | null>(null);
  const [ghost, showGhost] = useState<Ghost | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const suppress = useRef<HTMLButtonElement | null>(null);
  const latest = useRef(actions);
  latest.current = actions;
  useLayoutEffect(() => () => stop.current?.(), [page]);

  function drag(
    face: CalendarEventFace,
    press: ReactPointerEvent<HTMLButtonElement>,
    local?: (first: string, last: string) => void,
    segment?: TimedSegment,
  ) {
    if (press.button !== 0 || press.altKey || stop.current) return;
    const expected = local ? undefined : actions.moveVersion(face);
    if (!local && !expected) return;
    const chip = press.currentTarget;
    const edge = (press.target as HTMLElement).closest<HTMLElement>("[data-cal-resize]")?.dataset.calResize;
    const resize: DayEdge | undefined = edge === "start" || edge === "end" ? edge : undefined;
    const timed = resize && segment ? { edge: resize, ...segment } : null;
    stop.current = trackDrag(chip, press.nativeEvent, face, resize, {
      moveTime: (delta) => (timed ? resizeSlot(timed, delta) : actions.moveTime(face, delta, true)),
      preview: (next) =>
        showGhost((was) =>
          was?.day === next?.day && was?.top === next?.top && was?.height === next?.height ? was : next,
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
        if (!local) {
          latest.current.start(
            face,
            timed
              ? { kind: "resize-time", edge: timed.edge, minutes }
              : resize
                ? { kind: "resize", edge: resize, days }
                : { kind: "time", days, minutes },
            chip,
            expected ?? undefined,
          );
        } else if (resize) {
          const span = resizedDays(face.start, face.end, resize, days);
          if (span) local(span.first, span.last);
        } else if (face.start.kind === "date" && face.end.kind === "date" && days) {
          local(addDays(isoOfDay(face.start), days), addDays(isoOfDay(face.end), days - 1));
        }
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
      ? {
          day: ghost.day,
          chip: (
            <EventChip
              size="block"
              drag="copy"
              title={ghost.face.title}
              tone={ghost.face.tone}
              second={clockOf(ghost.minute)}
              place={{ top: ghost.top, height: ghost.height }}
            />
          ),
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
  chip: HTMLElement,
  face: CalendarEventFace,
  target: HTMLElement,
  days: { first: string; last: string },
): RangeGhost | null {
  const view = chip.closest(".cal-body-view");
  if (!view) return null;
  const kind = target.dataset.calDropKind;
  const month = kind === "month";
  const origin = view.getBoundingClientRect();
  const source = chip.getBoundingClientRect();
  const sourceWeek = month ? chip.parentElement?.getBoundingClientRect() : null;
  const rowOffset = source.top - (sourceWeek?.top ?? origin.top);
  const rows = new Map<number, { left: number; right: number }>();
  for (const cell of view.querySelectorAll<HTMLElement>(DROP)) {
    const day = cell.dataset.calDropDay;
    if (!day || day < days.first || day > days.last || cell.dataset.calDropKind !== kind) continue;
    const rect = cell.getBoundingClientRect();
    if (!rect.width || rect.bottom <= origin.top || rect.top >= origin.bottom) continue;
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
      height: source.height,
    })),
  };
}
