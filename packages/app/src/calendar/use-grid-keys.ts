import { useState } from "react";
import { daySpanOf, type ZoneSource } from "@ohmail/app-logic/calendar";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import type { EventRef, Route } from "../frame/contract.js";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { Where } from "./where.js";

export function useGridKeys({
  where,
  events,
  route,
  keysHere,
  zone,
  zones,
  open,
  create,
}: {
  where: Where | null;
  events: readonly CalendarEventFace[];
  route: Route;
  keysHere: boolean;
  zone: string;
  zones: ZoneSource;
  open: (event: EventRef) => void;
  create: ((day: string, from: number, to: number) => void) | null;
}): number | null {
  const t = useText("calendar");
  const [picked, setPicked] = useState<{ span: string; minute: number } | null>(null);
  const span = `${where?.place ?? ""}/${where?.anchor ?? ""}`;
  const minute = picked?.span === span ? picked.minute : null;
  const grid = where?.place === "day" || where?.place === "week";
  const first = where?.anchor === where?.today ? Math.floor((where?.now.minutes ?? 0) / 60) * 60 : 9 * 60;
  const move = (n: number) =>
    setPicked({ span, minute: minute === null ? first : Math.max(0, Math.min(23 * 60, minute + n)) });
  const hit = () => {
    if (minute === null || where === null) return undefined;
    return events.find((event) => {
      const time = daySpanOf(event, zone, zones);
      if (!time || time.allDay || where.anchor < time.first || where.anchor > time.last) return false;
      const from = where.anchor === time.first ? (time.startMinute ?? 0) : 0;
      const to = where.anchor === time.last ? (time.endMinute ?? 1440) : 1440;
      return from < minute + 60 && to > minute;
    });
  };
  const bind = (chord: string, label: string, run: () => void) => ({
    chord,
    group: "navigate" as const,
    label,
    run,
  });
  const available = grid && keysHere && route.open === null && route.words.panel !== "new";
  useKeyBindings(
    available
      ? [
          bind("ArrowUp", t("previousHour"), () => move(-60)),
          bind("ArrowDown", t("nextHour"), () => move(60)),
          ...(minute === null
            ? []
            : [
                bind("Escape", t("clearHour"), () => setPicked(null)),
                {
                  ...bind("Enter", t(hit() ? "openEvent" : "create.title"), () => {
                    const event = hit();
                    if (event) open(event.ref);
                    else if (where) create?.(where.anchor, minute, minute + 60);
                    setPicked(null);
                  }),
                  when: (event: KeyboardEvent) =>
                    !(event.target instanceof HTMLElement && event.target.closest("button, a")),
                },
              ]),
        ]
      : [],
    "view",
  );
  return available ? minute : null;
}
