import { useSyncExternalStore } from "react";
import { viewOnlyOf, type CalendarConnectionRecord, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";

const noChanges = () => () => undefined;

export function useNewEvent() {
  const { host, route, commands } = useFrame();
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
    const place = route.place === "calsettings" || route.place === "frommail" ? "week" : route.place;
    commands.go({ place, sub: route.sub, words: { panel: "new" } }, { history: "open-dialog" });
  };
}
