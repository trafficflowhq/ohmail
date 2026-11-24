import { useEffect, useReducer } from "react";
import type { AwayRow } from "./model.js";

const MAX_TIMER_DELAY = 2_147_483_647;

/** Follow the saved schedule even while no newer server answer arrives. */
export function useAwaySchedule(row: Pick<AwayRow, "enabled" | "startsAt" | "endsAt"> | null) {
  const [tick, wake] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  const start = row?.startsAt ? Date.parse(row.startsAt) : NaN;
  const end = row?.endsAt ? Date.parse(row.endsAt) : NaN;
  const ended = row?.enabled === true && end <= now;
  const upcoming = row?.enabled === true && !ended && start > now;
  const next = upcoming ? start : row?.enabled && end > now ? end : null;
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(wake, Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY)));
    return () => clearTimeout(timer);
  }, [next, tick]);
  return { ended, upcoming };
}
