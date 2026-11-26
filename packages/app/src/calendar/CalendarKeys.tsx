import { useKeyBindings, type KeyBinding } from "@ohmail/app-logic/keys";
import { addDays, dayOfIso } from "@ohmail/app-logic/calendar";
import { isCalendarPlace } from "../frame/product.js";
import { useFrame } from "../frame/commands.js";
import type { CalendarPlaceId, Route, RouteTarget } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText, type Text } from "../text/index.js";
import { calendarGridKeys } from "./use-grid-keys.js";
import { newEventKey, useNewEvent } from "./use-new-event.js";
import { useCalendarCheck } from "./check.js";
import { isView, shifted, VIEWS } from "./where.js";

export const CALENDAR_KEYS = {
  settings: "g ,",
  check: "p",
  search: "/",
  fromMail: "g f",
  invitations: "g i",
  today: "t",
  agenda: "g a",
  date: "g d",
  before: "[",
  after: "]",
} as const;

function calendarKey(chord: string, label: string, run: () => void): KeyBinding {
  return { chord, label, run, group: "navigate", place: "calendar" };
}

const teachCalendarKey = (binding: KeyBinding): KeyBinding => ({ ...binding, helpOnly: true });
const nothing = () => undefined;

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
  const create = useNewEvent();
  const available =
    isCalendarPlace(route.place) &&
    host.wires.calendar !== NONE &&
    route.stage === null &&
    route.words.panel !== "new";
  const sub = dayOfIso(route.sub) === null ? null : route.sub;
  const outsideView = route.place === "calsettings" || route.place === "frommail";
  const keys: KeyBinding[] = [
    calendarKey(CALENDAR_KEYS.settings, t("settings"), () => {
      if (route.place === "calsettings") commands.closeCalendarSettings();
      else commands.go({ place: "calsettings" });
    }),
    ...(check ? [calendarKey(CALENDAR_KEYS.check, ts("accounts.checkNow"), check.run)] : []),
    {
      ...calendarKey(CALENDAR_KEYS.search, t("search"), () => commands.go({ place: "calsearch" })),
      when: route.open === null ? undefined : fromCalendarReadCard,
    },
    calendarKey(CALENDAR_KEYS.fromMail, t("fromMail"), () => commands.go({ place: "frommail" })),
    calendarKey(CALENDAR_KEYS.invitations, t("invitations"), () => commands.go(invitationsRoute(route))),
    ...(!available || outsideView
      ? VIEWS.map((view, i) =>
          calendarKey(String(i + 1), t(`view.${view}`), () => commands.go({ place: view, sub })),
        )
      : []),
  ];
  useKeyBindings(
    available
      ? keys
      : [
          ...keys,
          ...calendarHelp(t),
          ...calendarGridKeys(t),
          ...(create ? [newEventKey(t, create)] : []),
        ].map(teachCalendarKey),
    "global",
  );
  return null;
}

type Navigation = {
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
};

function navigationKeys(
  t: Text,
  {
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
  }: Omit<Navigation, "enabled">,
): KeyBinding[] {
  const bind = (chord: string, label: string, run: () => void) => ({
    ...calendarKey(chord, label, run),
    when: eventOpen ? fromCalendarReadCard : undefined,
  });
  return [
    ...views.map(({ shortcut, label, value }) => bind(shortcut, label, () => select(value))),
    bind(CALENDAR_KEYS.today, t("today"), todayNow),
    bind(CALENDAR_KEYS.agenda, t("agenda"), agenda),
    ...(panelOn && !eventOpen ? [bind("Escape", t("closeAgenda"), agenda)] : []),
    ...(dated
      ? [
          bind(CALENDAR_KEYS.date, t("goToDate"), openDate),
          bind(CALENDAR_KEYS.before, t("before"), () => step(-1)),
          bind(CALENDAR_KEYS.after, t("after"), () => step(1)),
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
  ];
}

function calendarHelp(t: Text): KeyBinding[] {
  return navigationKeys(t, {
    eventOpen: false,
    place: "month",
    anchor: "",
    dated: true,
    panelOn: true,
    views: [],
    select: nothing,
    todayNow: nothing,
    agenda: nothing,
    openDate: nothing,
    step: nothing,
    toDate: nothing,
    selectDay: nothing,
  });
}

export function useCalendarNavigationKeys({ enabled, ...navigation }: Navigation) {
  const t = useText("calendar");
  useKeyBindings(enabled ? navigationKeys(t, navigation) : [], "view");
}
