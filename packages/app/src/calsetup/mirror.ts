/**
 * THE CALENDAR'S RECORDS AS SETUP AND SETTINGS READ THEM: the connections, the calendars and the events, read again
 * whenever the calendar's port moves and kept by nobody. Where the host hands in no port there is nothing to read.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { CalendarConnectionRecord, CalendarPort, CalendarRecord } from "@ohmail/app-logic/calendar";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";

export interface CalendarMirror {
  readonly port: CalendarPort;
  readonly connections: readonly CalendarConnectionRecord[];
  readonly calendars: readonly CalendarRecord[];
  /** The events on each calendar, by the calendar's id. */
  readonly eventsOn: (calendarIds: ReadonlySet<string>) => number;
}

const still = () => () => undefined;
const zero = () => 0;

export function useCalendarMirror(): CalendarMirror | null {
  const { host } = useFrame();
  const port = host.wires.calendar === NONE ? null : host.wires.calendar;
  const version = useSyncExternalStore(
    port?.subscribe ?? still,
    port?.version ?? zero,
    port?.version ?? zero,
  );
  return useMemo(() => {
    void version;
    if (port === null) return null;
    const read = <T>(kind: string) =>
      host.engine.store
        .entries<T | null>(kind)
        .map((e) => e.entity)
        .filter((c): c is T => c !== null);
    const events = port.events();
    return {
      port,
      connections: read<CalendarConnectionRecord>("calendar_connection"),
      calendars: read<CalendarRecord>("calendar"),
      eventsOn: (ids) => events.filter((e) => ids.has(e.record.calendarId)).length,
    };
  }, [host.engine, port, version]);
}
