/**
 * THE CALENDAR'S OCCURRENCES OVER A FEW DAYS FROM TODAY, as mail's places read them: from the calendar's port on every
 * version, on the reader's clock, kept by nobody. Null where this host has no calendar or its zone is not known.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  addDays,
  dayOfIso,
  isoOfDay,
  nowIn,
  occurrencesIn,
  readerZones,
  type CalendarRecord,
  type ShownOccurrence,
} from "@ohmail/app-logic/calendar";
import type { ReaderNow } from "@ohmail/app-logic/calendar/beside";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useTimeZone } from "../text/index.js";

const MINUTE_MS = 60_000;
const still = () => () => undefined;
const zero = () => 0;

function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(tick);
  }, []);
  return now;
}

export interface Around {
  readonly now: ReaderNow;
  readonly shown: readonly ShownOccurrence[];
}

/** Today and the `days` after it. */
export function useOccurrencesAhead(days: number): Around | null {
  const { host } = useFrame();
  const port = host.wires.calendar === NONE ? null : host.wires.calendar;
  const version = useSyncExternalStore(
    port?.subscribe ?? still,
    port?.version ?? zero,
    port?.version ?? zero,
  );
  const zone = useTimeZone();
  const nowMs = useMinute();
  return useMemo(() => {
    void version;
    if (port === null) return null;
    const zones = readerZones();
    const at = nowIn(nowMs, zone, zones);
    if (at === null) return null;
    const day = isoOfDay(at.day);
    const calendars = host.engine.store
      .entries<CalendarRecord | null>("calendar")
      .map((e) => e.entity)
      .filter((c): c is CalendarRecord => c !== null);
    const { shown } = occurrencesIn({
      events: port.events(),
      calendars,
      query: { from: at.day, to: dayOfIso(addDays(day, days))! },
      zone,
      zones,
    });
    return { now: { day, minute: at.minutes, zone, zones }, shown };
  }, [host.engine, port, version, zone, nowMs, days]);
}
