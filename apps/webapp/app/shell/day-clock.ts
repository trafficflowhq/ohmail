"use client";

import { useEffect, useState } from "react";
import { dayValue } from "./format";

/**
 * How often the shell asks whether the calendar day has turned. A day change moves every
 * relative label and every resurface horizon; nothing else here is worth a re-render, so the
 * watch compares the day and leaves the state alone when it has not changed.
 */
export const DAY_WATCH_MS = 60_000;

/**
 * THE SHELL'S RENDERED CLOCK, AND IT MOVES.
 *
 * It used to be `useMemo(() => new Date(), [])`: frozen at mount, so an app left open overnight
 * kept yesterday. Every relative label went with it, and "Tomorrow" was minted from a day that
 * had already passed — the booking resurfaced the moment it was made.
 *
 * `fixed` is the fixture world's instant: a demo whose clock moves changes under a frame, and it
 * takes no timer at all. Otherwise the value is re-read only when the calendar DAY in the
 * reader's zone differs from the one on screen — one re-render at midnight rather than 1 440 a
 * day, on a shell whose re-render cost is measured.
 */
export function useDayClock(fixed: Date | null): Date {
  const [now, setNow] = useState<Date>(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed !== null) return undefined;
    const id = setInterval(() => {
      setNow((prev) => (dayValue(prev.toISOString()) === dayValue(new Date().toISOString())
        ? prev
        : new Date()));
    }, DAY_WATCH_MS);
    return () => clearInterval(id);
  }, [fixed]);
  return fixed ?? now;
}
