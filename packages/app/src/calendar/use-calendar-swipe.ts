import { useRef, type MouseEvent, type PointerEvent } from "react";

/** Date surfaces take a horizontal swipe while leaving vertical scrolling to their sheet. */
export function useCalendarSwipe(step?: (direction: -1 | 1) => void, fold?: (folded: boolean) => void) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const consumed = useRef(false);
  if (!step) return undefined;
  return {
    "data-calendar-swipe": "",
    onPointerDown(event: PointerEvent<HTMLElement>) {
      consumed.current = false;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerCancel() {
      start.current = null;
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const began = start.current;
      start.current = null;
      if (
        !began ||
        event.pointerId !== began.id ||
        (event.target instanceof Element && event.target.closest("[data-cal-range-held]"))
      )
        return;
      const x = event.clientX - began.x;
      const y = event.clientY - began.y;
      if (Math.abs(x) >= 40 && Math.abs(x) > Math.abs(y)) {
        consumed.current = true;
        step(x < 0 ? 1 : -1);
      } else if (fold && Math.abs(y) >= 24 && Math.abs(y) > Math.abs(x)) {
        consumed.current = true;
        fold(y < 0);
      }
    },
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (!consumed.current || event.detail === 0) return;
      consumed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
