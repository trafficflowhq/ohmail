/**
 * THE HOURS' SCROLLER: how tall an hour is, where the hours stand when a span opens, and which minutes are in view.
 * The hours in view fill the sheet's height, no hour lower than a line of type; the whole day is always there, a
 * scroll away. Only a new span, new hours or a newly opened event move the hours: the person's own scroll stands.
 */
import { useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";

const HOUR_LEAST = 28;

export interface HoursScroller {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly hourPx: number;
  /** The minutes of the day in view; `null` until the first scroll has been read. */
  readonly inView: { readonly from: number; readonly to: number } | null;
  readonly onScroll: (e: UIEvent<HTMLDivElement>) => void;
  /** Brings a block that is out of sight into view, from the edge it left by. */
  readonly show: (top: number, side: "above" | "below") => void;
}

export interface HoursScrollerInput {
  /** The hours in view, in minutes of the day. */
  readonly hours: { readonly from: number; readonly to: number };
  /** An hour's height before the sheet has been measured. */
  readonly hourDefault: number;
  /** Fit the hours to the sheet including the space behind the dock. */
  readonly fitBehindDock?: boolean;
  readonly focusMinute?: number | null;
  /** What the sheet's room depends on: measured again when it changes. */
  readonly room: unknown;
  /** The span's own name: a new one stands on the hours in view again. */
  readonly spanKey: string;
  /** The open event's id, and its top in px of `hourPx` where it stands in the span (asked after the render). */
  readonly openId: string | null;
  readonly openTop: () => number | null;
  /** A letter opened its event, so keep it above the phone sheet. */
  readonly revealOpen?: boolean;
}

/** An hour's height that fits `span` hours into `height` px. */
export const fitHour = (height: number, spanHours: number, least = HOUR_LEAST): number =>
  Math.max(least, Math.floor(height / Math.max(1, spanHours)));

function gridRoom(el: HTMLDivElement) {
  const css = getComputedStyle(el);
  const pixels = (name: string) => parseFloat(css.getPropertyValue(name)) || 0;
  const clearance = css.getPropertyValue("--cal-grid-foot").trim();
  // For a calculation, the kit's footer spacer exposes the resolved token in pixels.
  const foot =
    clearance && !clearance.endsWith("px")
      ? parseFloat(getComputedStyle(el, "::after").height) || 0
      : pixels("--cal-grid-foot");
  return {
    view: Math.max(0, el.clientHeight - foot),
    air: pixels("--cal-grid-air"),
    least: pixels("--cal-grid-hour-min") || HOUR_LEAST,
  };
}

/** Where the hours stand: on the open event when it lies outside the hours in view, else at their first hour. */
export function homeTop(o: {
  from: number;
  hourPx: number;
  viewPx: number;
  openTop: number | null;
  revealOpen?: boolean;
}): number {
  const home = (o.from * o.hourPx) / 60;
  const out =
    o.openTop !== null && (o.revealOpen || o.openTop < home || o.openTop > home + o.viewPx - o.hourPx);
  return out && o.openTop !== null ? Math.max(0, o.openTop - o.hourPx) : home;
}

export function useHoursScroller(input: HoursScrollerInput): HoursScroller {
  const { hours, room, fitBehindDock } = input;
  const ref = useRef<HTMLDivElement | null>(null);
  const [hourPx, setHourPx] = useState(input.hourDefault);
  const [inView, setInView] = useState<{ from: number; to: number } | null>(null);
  const spanHours = (hours.to - hours.from) / 60;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const { view, air, least } = gridRoom(el);
      const height = fitBehindDock ? el.clientHeight : view;
      if (height > 0) setHourPx(fitHour(height - 2 * air, spanHours, least));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [room, spanHours, fitBehindDock]);

  const placedFor = useRef<string | null>(null);
  const key = `${input.spanKey} ${hours.from} ${hourPx} ${input.openId ?? ""}`;
  const openTop = input.openTop;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || placedFor.current === key) return;
    const top = openTop();
    if (input.revealOpen && input.openId && top === null) return;
    placedFor.current = key;
    el.scrollTop = homeTop({
      from: hours.from,
      hourPx,
      viewPx: gridRoom(el).view,
      openTop: top,
      revealOpen: input.revealOpen,
    });
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || input.focusMinute == null) return;
    const top = (input.focusMinute * hourPx) / 60;
    if (top < el.scrollTop || top + hourPx > el.scrollTop + gridRoom(el).view) {
      el.scrollTop = Math.max(0, top - hourPx);
    }
  }, [input.focusMinute, hourPx]);

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    setInView({ from: (el.scrollTop / hourPx) * 60, to: ((el.scrollTop + gridRoom(el).view) / hourPx) * 60 });
  };
  const show = (top: number, side: "above" | "below"): void => {
    const el = ref.current;
    if (el !== null)
      el.scrollTop =
        side === "above" ? Math.max(0, top - hourPx / 2) : Math.max(0, top - gridRoom(el).view + hourPx);
  };
  return { ref, hourPx, inView, onScroll, show };
}
