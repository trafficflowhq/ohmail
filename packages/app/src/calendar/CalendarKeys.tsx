import { useKeyBindings } from "@ohmail/app-logic/keys";
import { addDays, dayOfIso } from "@ohmail/app-logic/calendar";
import { isCalendarPlace } from "../frame/product.js";
import { useFrame } from "../frame/commands.js";
import type { CalendarPlaceId, Route, RouteTarget } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { useCalendarCheck } from "./check.js";
import { isView, shifted, VIEWS } from "./where.js";

/** Read cards leave navigation active while editors own their keys. */
export function fromCalendarReadCard(event: KeyboardEvent): boolean {
  const dialog = event.target instanceof HTMLElement ? event.target.closest('[role="dialog"]') : null;
  return dialog !== null && dialog.querySelector("input, textarea, select, [contenteditable]") === null;
}

export function invitationsRoute(route: Route): RouteTarget {
  return {
    place: isView(route.place) || route.place === "agenda" ? route.place : "week",
    sub: dayOfIso(route.sub) === null ? null : route.sub,
    open: route.open,
    words: route.words.panel === "invitations" ? {} : { panel: "invitations" },
  };
}

export function CalendarKeys() {
  const { commands, route, host } = useFrame();
  const t = useText("calendar");
  const ts = useText("calsettings");
  const check = useCalendarCheck();
  const available =
    isCalendarPlace(route.place) &&
    host.wires.calendar !== NONE &&
    route.stage === null &&
    route.words.panel !== "new";
  const sub = dayOfIso(route.sub) === null ? null : route.sub;
  const bind = (chord: string, label: string, run: () => void) => ({
    chord,
    group: "navigate" as const,
    label,
    run,
  });
  const outsideView = route.place === "calsettings" || route.place === "frommail";
  useKeyBindings(
    available
      ? [
          bind("g ,", t("settings"), () => {
            if (route.place === "calsettings") commands.closeCalendarSettings();
            else commands.go({ place: "calsettings" });
          }),
          ...(check ? [bind("p", ts("accounts.checkNow"), check.run)] : []),
          {
            ...bind("/", t("search"), () => commands.go({ place: "calsearch" })),
            when: route.open === null ? undefined : fromCalendarReadCard,
          },
          bind("g f", t("fromMail"), () => commands.go({ place: "frommail" })),
          bind("g i", t("invitations"), () => commands.go(invitationsRoute(route))),
          ...(outsideView
            ? VIEWS.map((view, i) =>
                bind(String(i + 1), t(`view.${view}`), () => commands.go({ place: view, sub })),
              )
            : []),
        ]
      : [],
    "global",
  );
  return null;
}

export function useCalendarNavigationKeys({
  enabled,
  eventOpen,
  place,
  anchor,
  dated,
  panelOn,
  views,
  select,
  todayNow,
  agenda,
  openDate,
  step,
  toDate,
  selectDay,
}: {
  enabled: boolean;
  eventOpen: boolean;
  place: CalendarPlaceId;
  anchor: string;
  dated: boolean;
  panelOn: boolean;
  views: readonly { value: CalendarPlaceId; label: string; shortcut: string }[];
  select: (view: CalendarPlaceId) => void;
  todayNow: () => void;
  agenda: () => void;
  openDate: () => void;
  step: (n: number) => void;
  toDate: (day: string | null) => void;
  selectDay: (day: string) => void;
}) {
  const t = useText("calendar");
  const bind = (chord: string, label: string, run: () => void) => ({
    chord,
    label,
    group: "navigate" as const,
    run,
    when: eventOpen ? fromCalendarReadCard : undefined,
  });
  useKeyBindings(
    enabled
      ? [
          ...views.map(({ shortcut, label, value }) => bind(shortcut, label, () => select(value))),
          bind("t", t("today"), todayNow),
          bind("g a", t("agenda"), agenda),
          ...(panelOn && !eventOpen ? [bind("Escape", t("closeAgenda"), agenda)] : []),
          ...(dated
            ? [
                bind("g d", t("goToDate"), openDate),
                bind("[", t("before"), () => step(-1)),
                bind("]", t("after"), () => step(1)),
                bind("ArrowLeft", t("previousDay"), () => toDate(shifted("day", anchor, -1, false))),
                bind("h", t("previousDay"), () => toDate(shifted("day", anchor, -1, false))),
                bind("ArrowRight", t("nextDay"), () => toDate(shifted("day", anchor, 1, false))),
                bind("l", t("nextDay"), () => toDate(shifted("day", anchor, 1, false))),
                ...(place === "month" || place === "year"
                  ? [
                      bind("ArrowUp", t("previousWeek"), () => toDate(addDays(anchor, -7))),
                      bind("ArrowDown", t("nextWeek"), () => toDate(addDays(anchor, 7))),
                      ...(!eventOpen ? [bind("Enter", t("view.day"), () => selectDay(anchor))] : []),
                    ]
                  : []),
              ]
            : []),
        ]
      : [],
    "view",
  );
}
