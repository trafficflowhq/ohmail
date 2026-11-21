"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { dayValueIn } from "../reader/resurface-times.js";

/**
 * How often the shell asks whether the calendar day has turned. A day change moves every
 * relative label and every resurface horizon; nothing else here is worth a re-render, so the
 * watch compares the day and leaves the state alone when it has not changed.
 */
export const DAY_WATCH_MS = 60_000;

/**
 * THE DAY A HOST SAYS IT IS, where it says one: the demo's frozen day (its invented letters are dated around it). Null on
 * every real host: the clock is the device's. Provided once above the panes by the mail ground.
 */
export const HandedDay = createContext<Date | null>(null);

/** The instant a dated sentence is made at: the handed day where a host says one, else now. */
export function useNowAt(): () => Date {
  const fixed = useContext(HandedDay);
  return fixed === null ? currentInstant : () => fixed;
}
const currentInstant = (): Date => new Date();

/**
 * THE SHELL'S RENDERED CLOCK, AND IT MOVES.
 *
 * It was `useMemo(() => new Date(), [])`: frozen at mount, so an app left open overnight kept
 * yesterday and "Tomorrow" was minted from a day that had already passed. `fixed` is the fixture
 * world's instant — a demo whose clock moves changes under a frame — and it arms no timer at
 * all. Otherwise the value is re-read only when the calendar DAY in the reader's zone differs
 * from the one on screen: one re-render at midnight rather than 1 440 a day. `zone` is that
 * zone, told by whoever mounts the clock: this file reads no shell's own.
 */
export function useDayClock(given: Date | null, zone: string): Date {
  /* The day a host says it is (the demo's), handed above the panes, stands where the caller hands none. */
  const handed = useContext(HandedDay);
  const fixed = given ?? handed;
  const [now, setNow] = useState<Date>(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed !== null) return undefined;
    const id = setInterval(() => {
      setNow((prev) => (dayValueIn(prev.toISOString(), zone) === dayValueIn(new Date().toISOString(), zone)
        ? prev
        : new Date()));
    }, DAY_WATCH_MS);
    return () => clearInterval(id);
  }, [fixed, zone]);
  return fixed ?? now;
}
