import { useLayoutEffect, useRef, type PointerEvent } from "react";

const DAY_MINUTES = 24 * 60;
const STEP = 15;

type Create = (day: string, from: number, to: number) => void;

export function useSlotDraft(create: Create | null, page: string) {
  const stop = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => stop.current?.(), [page]);

  if (!create) return undefined;
  return (day: string, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.altKey || (event.target as Element).closest("button, a")) return;
    const column = event.currentTarget;
    const bounds = column.getBoundingClientRect();
    if (!bounds.height) return;
    const id = event.pointerId;
    const { clientX: x, clientY: y } = event;
    const touch = event.pointerType === "touch";
    const minuteAt = (clientY: number, top: number) =>
      Math.round((((clientY - top) / bounds.height) * DAY_MINUTES) / STEP) * STEP;
    const first = Math.max(0, Math.min(DAY_MINUTES - STEP, minuteAt(y, bounds.top)));
    const doc = column.ownerDocument;
    const done = () => {
      doc.removeEventListener("pointerup", release);
      doc.removeEventListener("pointercancel", cancel);
      doc.defaultView?.removeEventListener("blur", done);
      stop.current = null;
    };
    const cancel = (point: globalThis.PointerEvent) => {
      if (point.pointerId === id) done();
    };
    const release = (point: globalThis.PointerEvent) => {
      if (point.pointerId !== id) return;
      done();
      const distance = Math.abs(point.clientY - y);
      if (point.altKey || !column.isConnected) return;
      if (touch && distance + Math.abs(point.clientX - x) > 4) return;
      if (point.clientX < bounds.left || point.clientX >= bounds.right) return;
      const last =
        distance < 4
          ? Math.min(DAY_MINUTES, first + 60)
          : Math.max(0, Math.min(DAY_MINUTES, minuteAt(point.clientY, column.getBoundingClientRect().top)));
      create(day, Math.min(first, last), first === last ? first + STEP : Math.max(first, last));
    };

    stop.current?.();
    stop.current = done;
    doc.addEventListener("pointerup", release);
    doc.addEventListener("pointercancel", cancel);
    doc.defaultView?.addEventListener("blur", done);
    if (!touch) column.setPointerCapture?.(id);
  };
}
