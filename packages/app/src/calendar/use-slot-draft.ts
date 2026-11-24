import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { resizeSlot } from "@ohmail/app-logic/calendar";
import { dayDelta, dayTarget, listenDrag, scrollDrag } from "./calendar-drag-target.js";
import type { useNewEvent } from "./use-new-event.js";

const DAY_MINUTES = 24 * 60;
const STEP = 15;
const DRAG_DISTANCE = 4;
const HOLD_MS = 420;

type Create = NonNullable<ReturnType<typeof useNewEvent>>;
type SlotPreview =
  { kind: "time"; day: string; from: number; to: number } | { kind: "month"; first: string; last: string };

export function useSlotDraft(create: Create | null, page: string, stepWeek?: (direction: -1 | 1) => void) {
  const [preview, showPreview] = useState<SlotPreview | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const step = useRef(stepWeek);
  step.current = stepWeek;
  const enabled = create !== null;
  useLayoutEffect(() => () => stop.current?.(), [page, enabled]);

  const startSlot = create
    ? (day: string, event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || event.altKey || !event.isPrimary || stop.current) return;
        const cell = event.currentTarget;
        const kind = cell.dataset.calDropKind;
        if (kind !== "time" && kind !== "month") return;
        if (kind === "time" && (event.target as Element).closest("button, a")) return;
        if (kind === "month" && event.pointerType !== "touch") event.preventDefault();
        stop.current = trackSlot(
          day,
          kind,
          cell,
          event.nativeEvent,
          create,
          stepWeek && ((direction) => step.current?.(direction)),
          showPreview,
          () => {
            stop.current = null;
          },
        );
      }
    : undefined;
  return { startSlot, preview };
}

function trackSlot(
  day: string,
  kind: "time" | "month",
  cell: HTMLElement,
  press: PointerEvent,
  create: Create,
  stepWeek: ((direction: -1 | 1) => void) | undefined,
  preview: (slot: SlotPreview | null) => void,
  stopped: () => void,
) {
  const doc = cell.ownerDocument;
  const window = doc.defaultView;
  const view = cell.closest<HTMLElement>(".cal-body-view");
  if (!window || !view) return null;
  const touch = press.pointerType === "touch";
  const { pointerId, clientX: x, clientY: y } = press;
  const pressed = kind === "time" ? minuteAt(cell, press) : 0;
  const first = Math.max(0, Math.min(DAY_MINUTES - STEP, Math.floor(pressed / STEP) * STEP));
  const tapStart = Math.max(0, Math.min(DAY_MINUTES - STEP, snap(pressed)));
  let held = false;
  let moved = false;
  let cancelled = false;
  let slot: SlotPreview | null = null;

  const rangeAt = (point: PointerEvent) => slotRangeAt(view, day, kind, first, point);
  const scroller = scrollDrag(
    view,
    kind,
    (point) => {
      slot = rangeAt(point);
      preview(slot);
    },
    stepWeek,
  );

  const activate = () => {
    held = true;
    view.dataset.calRangeHeld = "";
    if (cell.isConnected) cell.setPointerCapture?.(pointerId);
    slot =
      kind === "time"
        ? { kind, day, from: first, to: Math.min(DAY_MINUTES, first + (touch ? 60 : STEP)) }
        : { kind, first: day, last: day };
    preview(slot);
  };
  const timer = touch ? setTimeout(activate, HOLD_MS) : undefined;

  const done = () => {
    clearTimeout(timer);
    scroller.stop();
    detach();
    delete view.dataset.calRangeHeld;
    if (held) preview(null);
    stopped();
  };
  const cancel = (point: PointerEvent) => {
    if (point.pointerId === pointerId) done();
  };
  const escape = (key: KeyboardEvent) => {
    if (key.key !== "Escape" || cancelled) return;
    key.preventDefault();
    key.stopPropagation();
    cancelled = true;
    clearTimeout(timer);
    scroller.stop();
    if (held) preview(null);
  };
  const keepTouch = (point: TouchEvent) => {
    if (held && point.cancelable) point.preventDefault();
  };
  const distance = (point: PointerEvent) => Math.abs(point.clientX - x) + Math.abs(point.clientY - y);
  const move = (point: PointerEvent) => {
    if (point.pointerId !== pointerId || cancelled || (!held && distance(point) < DRAG_DISTANCE)) return;
    if (!held && touch) return done();
    if (!held) activate();
    moved = true;
    point.preventDefault();
    scroller.move(point);
  };
  const release = (point: PointerEvent) => {
    if (point.pointerId !== pointerId) return;
    const range = !cancelled && !point.altKey && held && (moved ? rangeAt(point) : slot);
    done();
    if (kind === "month" && held) suppressMonthClick(view);
    if (range) {
      if (range.kind === "month") create(range.first, range.last);
      else create(range.day, range.from, range.to);
    } else if (
      !held &&
      !cancelled &&
      !point.altKey &&
      kind === "time" &&
      (!touch || distance(point) < DRAG_DISTANCE)
    ) {
      const target = dayTarget(view, point, kind);
      if (!target || target.dataset.calDropDay !== day) return;
      const last =
        distance(point) < DRAG_DISTANCE
          ? Math.min(DAY_MINUTES, tapStart + 60)
          : Math.min(DAY_MINUTES, snap(minuteAt(target, point)));
      create(day, Math.min(tapStart, last), tapStart === last ? last + STEP : Math.max(tapStart, last));
    }
  };

  if (!touch && kind === "time") cell.setPointerCapture?.(pointerId);
  const detach = listenDrag(doc, touch ? keepTouch : null, {
    move,
    end: release,
    cancel,
    escape,
    cleanup: done,
  });
  return done;
}

function suppressMonthClick(view: HTMLElement) {
  const doc = view.ownerDocument;
  const consume = (click: MouseEvent) => {
    if (!click.detail || !(click.target instanceof Node) || !view.contains(click.target)) return;
    click.preventDefault();
    click.stopPropagation();
  };
  doc.addEventListener("click", consume, true);
  doc.defaultView?.setTimeout(() => doc.removeEventListener("click", consume, true), 0);
}

function minuteAt(target: HTMLElement, point: PointerEvent) {
  const { top, height } = target.getBoundingClientRect();
  return ((point.clientY - top) / height) * DAY_MINUTES;
}

function slotRangeAt(
  view: HTMLElement,
  day: string,
  kind: "time" | "month",
  first: number,
  point: PointerEvent,
): SlotPreview | null {
  const target = !point.altKey && dayTarget(view, point, kind);
  const last = target && target.dataset.calDropDay;
  if (!last) return null;
  if (kind === "month") return day <= last ? { kind, first: day, last } : { kind, first: last, last: day };
  const minute = minuteAt(target, point);
  const offset = dayDelta(day, last);
  if (offset < 0) {
    const from = Math.max(0, Math.min(DAY_MINUTES - STEP, snap(minute)));
    return { kind, day: last, from, to: first - offset * DAY_MINUTES };
  }
  if (offset > 0)
    return { kind, day, from: first, to: offset * DAY_MINUTES + Math.min(DAY_MINUTES, snap(minute)) };
  const edge = minute < first ? "start" : "end";
  const grip = edge === "start" ? first : first + STEP;
  const { minute: from, length } = resizeSlot({ edge, from: first, to: first + STEP }, minute - grip);
  return { kind, day, from, to: from + length };
}

function snap(minute: number) {
  return Math.round(minute / STEP) * STEP;
}

export function slotOnDay(slot: { day: string; from: number; to: number }, day: string) {
  const offset = dayDelta(slot.day, day);
  if (offset < 0) return null;
  const from = offset === 0 ? slot.from : 0;
  const to = Math.min(DAY_MINUTES, slot.to - offset * DAY_MINUTES);
  return to > from ? { from, to } : null;
}
