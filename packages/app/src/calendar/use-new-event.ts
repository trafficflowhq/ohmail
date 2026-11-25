import { useSyncExternalStore } from "react";
import { viewOnlyOf, type CalendarConnectionRecord, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { useCalendarDraftSeed, useFrame, type CalendarDraftSeed } from "../frame/commands.js";
import { fragmentOf } from "../frame/route.js";
import { isCalendarPlace } from "../frame/product.js";
import { useText } from "../text/index.js";
import { NONE } from "../host/index.js";

const noChanges = () => () => undefined;

export function useNewEvent(seed?: CalendarDraftSeed, accountsFallback = false) {
  const { host, route, commands } = useFrame();
  const draftSeed = useCalendarDraftSeed();
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
  if (!canCreate) {
    if (!accountsFallback || port === NONE) return null;
    return () => commands.go({ place: "calsettings" });
  }
  return (day?: string, from?: number | string, to?: number) => {
    const here = isCalendarPlace(route.place) && route.place !== "calsettings" && route.place !== "frommail";
    const place = here ? route.place : "week";
    const target = {
      place,
      sub: day ?? (here ? route.sub : null),
      open: null,
      stage: null,
      words: {
        panel: "new",
        ...(typeof from === "string"
          ? { slot: `date-${from}` }
          : from !== undefined && to !== undefined && { slot: `${from}-${to}` }),
      },
    };
    if (draftSeed) draftSeed.current = seed ?? null;
    commands.go(target, { history: "open-dialog" });
    if (draftSeed && host.device.address.read() !== fragmentOf(target)) draftSeed.current = null;
  };
}

export function useNewEventKey(create: ReturnType<typeof useNewEvent>, enabled: boolean) {
  const t = useText("calendar");
  useKeyBindings(
    create && enabled
      ? [{ chord: "c", group: "navigate", label: t("create.title"), run: () => create() }]
      : [],
    "global",
  );
}
