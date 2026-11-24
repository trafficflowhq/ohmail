import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { resizeSlot } from "@ohmail/app-logic/calendar";

const DAY_MINUTES = 24 * 60;
const STEP = 15;
const DRAG_DISTANCE = 4;
const EDGE_DISTANCE = 36;
const EDGE_SCROLL = 10;

type Create = (day: string, from: number, to: number) => void;
type SlotPreview = { day: string; from: number; to: number; scale: number };

export function useSlotDraft(create: Create | null, page: string) {
  const [preview, showPreview] = useState<SlotPreview | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const enabled = create !== null;
  useLayoutEffect(() => () => stop.current?.(), [page, enabled]);

  const startSlot = create
    ? (day: string, event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.altKey || (event.target as Element).closest("button, a")) return;
        stop.current?.();
        stop.current = trackSlot(
          day,
          event.currentTarget,
          event.nativeEvent,
          create,
          (slot) => {
            showPreview((was) =>
              was?.day === slot?.day &&
              was?.from === slot?.from &&
              was?.to === slot?.to &&
              was?.scale === slot?.scale
                ? was
                : slot,
            );
          },
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
  column: HTMLDivElement,
  press: globalThis.PointerEvent,
  create: Create,
  preview: (slot: SlotPreview | null) => void,
  stopped: () => void,
) {
  const bounds = column.getBoundingClientRect();
  const scroller = column.closest<HTMLElement>("[data-today-scroll]");
  const doc = column.ownerDocument;
  const view = doc.defaultView;
  if (!bounds.height || !scroller || !view) return null;
  const { pointerId, clientX: x, clientY: y } = press;
  const touch = press.pointerType === "touch";
  const minuteAt = (clientY: number, box: DOMRect) => ((clientY - box.top) / box.height) * DAY_MINUTES;
  const maxStart = DAY_MINUTES - STEP;
  const snap = (minute: number) => Math.round(minute / STEP) * STEP;
  const pressed = minuteAt(y, bounds);
  const first = Math.max(0, Math.min(maxStart, Math.floor(pressed / STEP) * STEP));
  const tapStart = Math.max(0, Math.min(maxStart, snap(pressed)));
  let latest: globalThis.PointerEvent | null = null;
  let frame: number | null = null;

  const targetAt = (point: globalThis.PointerEvent) => {
    if (point.altKey || !column.isConnected) return null;
    // The column moves under the pointer when the hours scroll.
    const box = column.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return contains(box, point) && contains(viewport, point) ? { box, viewport } : null;
  };
  const rangeAt = (point: globalThis.PointerEvent, box: DOMRect) => {
    const minute = minuteAt(point.clientY, box);
    const from = first;
    const to = from + STEP;
    const edge = minute < from ? "start" : "end";
    const { minute: start, length } = resizeSlot({ edge, from, to }, minute - (edge === "start" ? from : to));
    return { from: start, to: start + length };
  };

  const refresh = () => {
    if (!latest) return;
    const target = targetAt(latest);
    preview(
      target ? { day, ...rangeAt(latest, target.box), scale: column.clientHeight / DAY_MINUTES } : null,
    );
  };

  const scrollEdge = () => {
    frame = null;
    const point = latest;
    const target = point && targetAt(point);
    if (!point || !target || !scrollAtEdge(scroller, target.viewport, point.clientY)) return;
    refresh();
    frame = view.requestAnimationFrame(scrollEdge);
  };

  const done = () => {
    doc.removeEventListener("pointermove", move);
    doc.removeEventListener("pointerup", release);
    doc.removeEventListener("pointercancel", cancel);
    doc.removeEventListener("keydown", escape, true);
    scroller.removeEventListener("scroll", refresh);
    view.removeEventListener("blur", done);
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (latest) preview(null);
    stopped();
  };
  const cancel = (point: globalThis.PointerEvent) => {
    if (point.pointerId === pointerId) done();
  };
  const escape = (key: KeyboardEvent) => {
    if (key.key !== "Escape") return;
    key.preventDefault();
    key.stopPropagation();
    done();
  };
  const move = (point: globalThis.PointerEvent) => {
    if (point.pointerId !== pointerId) return;
    if (!latest && Math.abs(point.clientX - x) + Math.abs(point.clientY - y) < DRAG_DISTANCE) return;
    latest = point;
    point.preventDefault();
    refresh();
    if (frame === null) frame = view.requestAnimationFrame(scrollEdge);
  };
  const release = (point: globalThis.PointerEvent) => {
    if (point.pointerId !== pointerId) return;
    done();
    const distance = Math.abs(point.clientY - y);
    if (touch && Math.abs(point.clientX - x) + distance > DRAG_DISTANCE) return;
    const target = targetAt(point);
    if (!target) return;
    const { box } = target;
    if (latest) {
      const { from, to } = rangeAt(point, box);
      create(day, from, to);
    } else {
      const last =
        distance < DRAG_DISTANCE
          ? Math.min(DAY_MINUTES, tapStart + 60)
          : Math.max(0, Math.min(DAY_MINUTES, snap(minuteAt(point.clientY, box))));
      create(day, Math.min(tapStart, last), tapStart === last ? last + STEP : Math.max(tapStart, last));
    }
  };

  if (!touch) {
    column.setPointerCapture?.(pointerId);
    doc.addEventListener("pointermove", move, { passive: false });
    doc.addEventListener("keydown", escape, true);
    scroller.addEventListener("scroll", refresh);
  }
  doc.addEventListener("pointerup", release);
  doc.addEventListener("pointercancel", cancel);
  view.addEventListener("blur", done);
  return done;
}

function contains(box: DOMRect, { clientX, clientY }: globalThis.PointerEvent): boolean {
  return clientX >= box.left && clientX < box.right && clientY >= box.top && clientY < box.bottom;
}

function scrollAtEdge(scroller: HTMLElement, { top, bottom }: DOMRect, y: number): boolean {
  const step = y < top + EDGE_DISTANCE ? -EDGE_SCROLL : y > bottom - EDGE_DISTANCE ? EDGE_SCROLL : 0;
  if (!step) return false;
  const before = scroller.scrollTop;
  scroller.scrollTop += step;
  return scroller.scrollTop !== before;
}
