import { useSyncExternalStore } from "react";
import { viewOnlyOf, type CalendarConnectionRecord, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { useCalendarGuest, useFrame, type CalendarGuest } from "../frame/commands.js";
import { fragmentOf } from "../frame/route.js";
import { isCalendarPlace } from "../frame/product.js";
import { NONE } from "../host/index.js";

const noChanges = () => () => undefined;

export function useNewEvent(withGuest?: CalendarGuest) {
  const { host, route, commands } = useFrame();
  const guest = useCalendarGuest();
  const port = host.wires.calendar;
  const canCreate = useSyncExternalStore(
    port === NONE ? noChanges : port.subscribe,
    () => {
      if (port === NONE) return false;
      const connections = host.engine.store.entries<CalendarConnectionRecord | null>("calendar_connection");
      return host.engine.store
        .entries<CalendarRecord | null>("calendar")
        .some(
          ({ entity: calendar }) =>
            calendar?.shown &&
            !viewOnlyOf(
              calendar,
              connections.find(({ entity }) => entity?.id === calendar.connectionId)?.entity ?? undefined,
            ),
        );
    },
    () => false,
  );
  if (!canCreate) return null;
  return () => {
    const here = isCalendarPlace(route.place) && route.place !== "calsettings" && route.place !== "frommail";
    const place = here ? route.place : "week";
    const target = { place, sub: here ? route.sub : null, open: null, stage: null, words: { panel: "new" } };
    if (guest) guest.current = withGuest ?? null;
    commands.go(target, { history: "open-dialog" });
    if (guest && host.device.address.read() !== fragmentOf(target)) guest.current = null;
  };
}
