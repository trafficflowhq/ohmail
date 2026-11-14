import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { addDays, clockOf } from "@ohmail/app-logic/calendar";
import { EventChip } from "@ohmail/ui/calendar";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";

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

interface DragCallbacks {
  moveTime: (delta: number) => DragTime | null;
  preview: (ghost: Ghost | null) => void;
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
  { preview, absorbClick, done, commit, moveTime }: DragCallbacks,
) {
  const source = chip.closest<HTMLElement>(DROP) ?? dayTarget(chip, down);
  const sourceDay = source?.dataset.calDropDay;
  if (!source || !sourceDay) return null;
  const kind = source.dataset.calDropKind;
  const start = source.getBoundingClientRect();
  const doc = chip.ownerDocument;
  const touch = down.pointerType === "touch";
  let held = false;
  let aborted = false;
  let target: HTMLElement | null = null;
  const activate = () => {
    held = true;
    chip.setPointerCapture?.(down.pointerId);
    chip.dataset.drag = "lifted";
  };
  const timer = touch ? setTimeout(activate, HOLD_MS) : null;

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    delete chip.dataset.drag;
    preview(null);
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
    if (!held && touch) {
      cleanup();
      return;
    }
    if (!held) activate();
    point.preventDefault();
    if (target) delete target.dataset.calDropActive;
    target = dayTarget(chip, point, kind);
    if (!target || kind !== "time") {
      if (target) target.dataset.calDropActive = "";
      preview(null);
      return;
    }
    const drop = destinationAt(point, target);
    preview(drop?.time ? timePreview(target, drop.day, drop.time, face) : null);
  };
  const end = (point: PointerEvent) => {
    if (point.pointerId !== down.pointerId) return;
    const destination = held && !aborted && !point.altKey ? dayTarget(chip, point, kind) : null;
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
  const [ghost, showGhost] = useState<Ghost | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const suppress = useRef<HTMLButtonElement | null>(null);
  const latest = useRef(actions);
  latest.current = actions;
  useLayoutEffect(() => () => stop.current?.(), [page]);

  function drag(face: CalendarEventFace, press: ReactPointerEvent<HTMLButtonElement>) {
    if (press.button !== 0 || press.altKey || stop.current) return;
    const expected = actions.moveVersion(face);
    if (!expected) return;
    const chip = press.currentTarget;
    stop.current = trackDrag(chip, press.nativeEvent, face, {
      moveTime: (delta) => actions.moveTime(face, delta, true),
      preview: (next) => showGhost((was) => (was?.day === next?.day && was?.top === next?.top ? was : next)),
      done: () => {
        stop.current = null;
      },
      absorbClick: () => {
        suppress.current = chip;
        setTimeout(() => {
          if (suppress.current === chip) suppress.current = null;
        }, 0);
      },
      commit: (days, minutes) => latest.current.start(face, { kind: "time", days, minutes }, chip, expected),
    });
  }

  return {
    drag,
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
