import { agendaDays, dayNumberOf, type ZoneSource } from "@ohmail/app-logic/calendar";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { Where } from "./where.js";

export function useEventBrowse({
  where,
  route,
  keysHere,
  zone,
  zones,
  events,
  panelOn,
}: Pick<PaneProps, "route" | "keysHere"> & {
  where: Where | null;
  zone: string;
  zones: ZoneSource;
  events: readonly CalendarEventFace[];
  panelOn: boolean;
}) {
  const { commands } = useFrame();
  const t = useText("calendar");
  const agenda = panelOn || where?.place === "agenda";
  const openAgendaRow = (id: string, day: string) => {
    if (!where) return;
    if (route.open === id) return commands.event(null);
    const place = where.place === "year" ? "week" : where.place;
    where.agenda.keepAt(place, day);
    commands.go({ place, sub: day, open: id, words: route.words });
  };
  const walk = (n: number) => {
    if (!where) return;
    const span = agenda ? where.agenda : where.span;
    const days = dayNumberOf(span.last)! - dayNumberOf(span.first)! + 1;
    const sorted = agendaDays({
      from: span.first,
      days,
      today: where.today,
      zone,
      zones,
      items: events,
      keyOf: (event) => event.id,
    }).days;
    const placed = new Map<string, { id: string; day: string; upcoming: boolean }>();
    for (const day of sorted) {
      if (day.day > span.last) break;
      for (const row of day.rows) {
        if (placed.has(row.item.id)) continue;
        const upcoming =
          day.day > where.anchor ||
          (day.day === where.anchor &&
            (day.day !== where.today ||
              row.allDay ||
              row.lastDay > day.day ||
              (row.endMinute ?? row.startMinute ?? 0) > where.now.minutes));
        placed.set(row.item.id, { id: row.item.id, day: day.day, upcoming });
      }
    }
    const rows = [...placed.values()];
    const current = rows.findIndex(({ id }) => id === route.open);
    const first = agenda ? -1 : rows.findIndex(({ upcoming }) => upcoming);
    const start = first === -1 ? (n === 1 ? 0 : rows.length - 1) : Math.max(0, first + Math.min(0, n));
    const next = rows[current === -1 ? start : current + n];
    if (!next) return;
    if (panelOn) openAgendaRow(next.id, next.day);
    else
      commands.go({
        place: where.place,
        sub: agenda ? route.sub : next.day,
        open: next.id,
        words: route.words,
      });
  };
  const bind = (chord: string, label: string, direction: number) => ({
    chord,
    label,
    group: "navigate" as const,
    when: (event: KeyboardEvent) => {
      const dialog = event.target instanceof HTMLElement ? event.target.closest('[role="dialog"]') : null;
      // The open event takes focus. Its read card still lets the reader walk the list.
      return (
        dialog === null ||
        (route.open !== null && dialog.querySelector("input, textarea, select, [contenteditable]") === null)
      );
    },
    run: () => walk(direction),
  });
  const available =
    keysHere &&
    where !== null &&
    where.place !== "calsearch" &&
    route.words.panel !== "new" &&
    route.words.panel !== "invitations";
  const canEnter =
    route.open === null && (where?.place === "agenda" || where?.place === "day" || where?.place === "week");
  useKeyBindings(
    available
      ? [
          bind("j", t("nextEvent"), 1),
          bind("k", t("previousEvent"), -1),
          ...(where?.place === "agenda"
            ? [bind("ArrowDown", t("nextEvent"), 1), bind("ArrowUp", t("previousEvent"), -1)]
            : []),
        ]
      : [],
    "view",
  );
  // The timed grid's hour cursor gets Enter first.
  useKeyBindings(available && canEnter ? [bind("Enter", t("openEvent"), 1)] : [], "global");
  return openAgendaRow;
}
