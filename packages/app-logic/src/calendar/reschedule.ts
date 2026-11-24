import {
  addDays,
  instantOf,
  resolveWall,
  storedTimeOf,
  wallFromSeconds,
  wallIn,
  wallInstants,
  wallSeconds,
  type EventTime,
  type ZoneSource,
} from "@ohmail/cal-core";
import type { CalendarEventFields } from "@ohmail/wire";

import { MINUTES_PER_DAY, wallSpanOf, type GridItem } from "./grid/place.js";

const SECONDS_PER_DAY = 24 * 60 * 60;

function atMoment(time: EventTime, at: number, zones: ZoneSource): EventTime | null {
  if (time.kind === "instant") return { kind: "instant", epochMs: at };
  if (time.kind !== "zoned") return null;
  const wall = wallIn(at, time.tzid, zones);
  // A provider's zoned form cannot name the second reading of a folded hour.
  return wall && resolveWall(wall, time.tzid, zones) === at ? { ...time, wall } : null;
}

/** Move by the viewer's calendar and clock, keeping whole days whole and timed events their length. */
export function reschedule(
  start: EventTime,
  end: EventTime,
  days: number,
  minutes: number,
  zone: string,
  zones: ZoneSource,
): Pick<CalendarEventFields, "start" | "end"> | null {
  if (days === 0 && minutes === 0) return null;
  const by = days * SECONDS_PER_DAY + minutes * 60;
  if (start.kind === "date" && end.kind === "date") {
    if (days === 0) return null;
    return { start: storedTimeOf(addDays(start, days)), end: storedTimeOf(addDays(end, days)) };
  }
  if (start.kind === "floating" && end.kind === "floating") {
    return {
      start: storedTimeOf({ ...start, wall: wallFromSeconds(wallSeconds(start.wall) + by) }),
      end: storedTimeOf({ ...end, wall: wallFromSeconds(wallSeconds(end.wall) + by) }),
    };
  }
  if (start.kind === "date" || end.kind === "date" || start.kind === "floating" || end.kind === "floating")
    return null;
  const from = instantOf(start, zones);
  const to = instantOf(end, zones);
  const shown = from && wallIn(from.epochMs, zone, zones);
  if (!from || !to || !shown || to.epochMs <= from.epochMs) return null;
  const proposed = wallSeconds(shown) + by;
  const at = resolveWall(wallFromSeconds(proposed), zone, zones);
  const target = at === null ? null : wallIn(at, zone, zones);
  if (at === null || !target || wallSeconds(target) !== proposed || at === from.epochMs) return null;
  const first = atMoment(start, at, zones);
  const last = atMoment(end, at + to.epochMs - from.epochMs, zones);
  return first && last ? { start: storedTimeOf(first), end: storedTimeOf(last) } : null;
}

/** The vertical destination in its own day, shared by the visible drag and the write. */
export function moveTime(item: GridItem, delta: number, snap: boolean, zone: string, zones: ZoneSource) {
  const span = wallSpanOf(item, zone, zones);
  if (!span) return null;
  const dayMinutes = 24 * 60;
  const step = 15;
  const start = ((span.from % dayMinutes) + dayMinutes) % dayMinutes;
  const length = span.to - span.from;
  const last = start + length > dayMinutes ? dayMinutes - step : dayMinutes - length;
  const proposed = start + delta;
  const bounded = snap
    ? Math.min(Math.floor(last / step) * step, Math.round(proposed / step) * step)
    : Math.min(last, proposed);
  const minute = Math.max(0, bounded);
  return { minute, minutes: minute - start, length };
}

/** Change one end on the reader's clock and keep the other end in its original form. */
export function resizeTime(
  item: GridItem,
  edge: "start" | "end",
  minutes: number,
  zone: string,
  zones: ZoneSource,
): Pick<CalendarEventFields, "start" | "end"> | null {
  const { start, end } = item;
  if (!minutes || start.kind === "date" || end.kind === "date") return null;
  const time = item[edge];
  const paired = (changed: EventTime) => ({
    start: storedTimeOf(edge === "start" ? changed : start),
    end: storedTimeOf(edge === "end" ? changed : end),
  });
  if (start.kind === "floating" && end.kind === "floating" && time.kind === "floating") {
    const shifted = wallSeconds(time.wall) + minutes * 60;
    const from = edge === "start" ? shifted : wallSeconds(start.wall);
    const to = edge === "end" ? shifted : wallSeconds(end.wall);
    return from < to ? paired({ ...time, wall: wallFromSeconds(shifted) }) : null;
  }
  if (start.kind === "floating" || end.kind === "floating") return null;
  const from = instantOf(start, zones)?.epochMs;
  const to = instantOf(end, zones)?.epochMs;
  if (from === undefined || to === undefined) return null;
  const old = edge === "start" ? from : to;
  const shown = wallIn(old, zone, zones);
  if (!shown) return null;
  const delta = minutes * 60_000;
  const proposed = wallFromSeconds(wallSeconds(shown) + minutes * 60);
  const candidates = wallInstants(proposed, zone, zones).filter(
    (at) => Math.sign(at - old) === Math.sign(delta),
  );
  const at = candidates.sort((a, b) => Math.abs(a - old - delta) - Math.abs(b - old - delta))[0];
  if (at === undefined || (edge === "start" ? at >= to : at <= from)) return null;
  const changed = atMoment(time, at, zones);
  return changed && paired(changed);
}

/** A timed grip snaps the dragged end to a quarter hour within its day. */
export function resizeSlot(
  { edge, from, to }: { edge: "start" | "end"; from: number; to: number },
  delta: number,
) {
  const step = 15;
  const start = edge === "start";
  const old = start ? from : to;
  const min = start ? 0 : Math.floor(from / step) * step + step;
  const max = start ? Math.ceil(to / step) * step - step : MINUTES_PER_DAY;
  const next = Math.max(min, Math.min(max, Math.round((old + delta) / step) * step));
  return { minute: start ? next : from, minutes: next - old, length: start ? to - next : next - from };
}
