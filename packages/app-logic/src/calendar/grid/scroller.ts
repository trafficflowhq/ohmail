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
  /** What the sheet's room depends on: measured again when it changes. */
  readonly room: unknown;
  /** The span's own name: a new one stands on the hours in view again. */
  readonly spanKey: string;
  /** The open event's id, and its top in px of `hourPx` where it stands in the span (asked after the render). */
  readonly openId: string | null;
  readonly openTop: () => number | null;
}

/** An hour's height that fits `span` hours into `height` px. */
export const fitHour = (height: number, spanHours: number): number =>
  Math.max(HOUR_LEAST, Math.floor(height / Math.max(1, spanHours)));

/** Where the hours stand: on the open event when it lies outside the hours in view, else at their first hour. */
export function homeTop(o: { from: number; hourPx: number; viewPx: number; openTop: number | null }): number {
  const home = (o.from * o.hourPx) / 60;
  const out = o.openTop !== null && (o.openTop < home || o.openTop > home + o.viewPx - o.hourPx);
  return out && o.openTop !== null ? Math.max(0, o.openTop - o.hourPx) : home;
}

export function useHoursScroller(input: HoursScrollerInput): HoursScroller {
  const { hours, room } = input;
  const ref = useRef<HTMLDivElement | null>(null);
  const [hourPx, setHourPx] = useState(input.hourDefault);
  const [inView, setInView] = useState<{ from: number; to: number } | null>(null);
  const spanHours = (hours.to - hours.from) / 60;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && el.clientHeight > 0) setHourPx(fitHour(el.clientHeight, spanHours));
  }, [room, spanHours]);

  const placedFor = useRef<string | null>(null);
  const key = `${input.spanKey} ${hours.from} ${hourPx} ${input.openId ?? ""}`;
  const openTop = input.openTop;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || placedFor.current === key) return;
    placedFor.current = key;
    el.scrollTop = homeTop({ from: hours.from, hourPx, viewPx: el.clientHeight, openTop: openTop() });
  });

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    setInView({ from: (el.scrollTop / hourPx) * 60, to: ((el.scrollTop + el.clientHeight) / hourPx) * 60 });
  };
  const show = (top: number, side: "above" | "below"): void => {
    const el = ref.current;
    if (el !== null)
      el.scrollTop =
        side === "above" ? Math.max(0, top - hourPx / 2) : Math.max(0, top - el.clientHeight + hourPx);
  };
  return { ref, hourPx, inView, onScroll, show };
}
