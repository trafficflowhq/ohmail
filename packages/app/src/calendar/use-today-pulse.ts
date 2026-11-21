import { useLayoutEffect, useRef, type RefObject } from "react";
import { motionMs, motionReduced } from "@ohmail/ui/base";
import type { CalendarPlaceId } from "../frame/contract.js";

export interface TodayVisit {
  readonly id: number;
  readonly place: CalendarPlaceId;
  readonly top: number | undefined;
}

function revealNow(now: HTMLElement) {
  const scroller = now.closest<HTMLElement>("[data-today-scroll]");
  if (!scroller?.clientHeight) return;
  const viewport = scroller.getBoundingClientRect();
  const line = now.getBoundingClientRect();
  const hour = Number.parseFloat(getComputedStyle(scroller).getPropertyValue("--oh-tg-hour"));
  const scale = viewport.height / scroller.offsetHeight || 1;
  if (!Number.isFinite(hour)) return;
  if (line.top < viewport.top || line.bottom > viewport.bottom - (hour * scale) / 2) {
    scroller.scrollTop += (line.top - viewport.top) / scale - hour;
  }
}

/** Wait for Month's scroll to arrive before marking the badge. Day and Week place their hours in layout. */
export function useTodayPulse(
  body: RefObject<HTMLElement | null>,
  view: RefObject<HTMLDivElement | null>,
  visit: TodayVisit | null,
  monthScroll?: RefObject<HTMLDivElement | null>,
) {
  const played = useRef<TodayVisit | null>(null);
  useLayoutEffect(() => {
    const scope = body.current;
    const canvas = view.current;
    if (!scope || !canvas || !visit || visit === played.current) return;
    if (visit.place !== "day" && visit.place !== "week" && visit.place !== "month") return;
    const scroller = monthScroll?.current;
    let frame: number;
    let timer: ReturnType<typeof setTimeout>;
    let clear: (() => void) | undefined;

    const arrive = () => {
      if (scroller && visit.top !== undefined && Math.abs(scroller.scrollTop - visit.top) > 1) return;
      const target = '[data-today-pulse-target="badge"]';
      const inGrid = canvas.querySelectorAll<HTMLElement>(target);
      const badges = inGrid.length ? inGrid : scope.querySelectorAll<HTMLElement>(target);
      if (!badges.length) return;
      played.current = visit;
      scroller?.removeEventListener("scroll", schedule);
      const now = canvas.querySelector<HTMLElement>('[data-today-pulse-target="now"]');
      if (now) revealNow(now);

      const reduced = motionReduced(scope);
      for (const badge of badges) badge.dataset.todayPulse = reduced ? "outline" : "ring";
      if (now && !reduced) now.dataset.todayPulse = "ring";
      clear = () => {
        for (const badge of badges) delete badge.dataset.todayPulse;
        if (now) delete now.dataset.todayPulse;
      };
      timer = setTimeout(clear, motionMs(scope, reduced ? "--d-today-outline" : "--d-today-pulse"));
    };

    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(arrive);
    }
    // Leave a paint between removal and reapplying the animation on the same badge.
    frame = requestAnimationFrame(() => {
      scroller?.addEventListener("scroll", schedule, { passive: true });
      schedule();
    });
    return () => {
      scroller?.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      clear?.();
    };
  }, [body, view, visit, monthScroll]);
}
