/**
 * A WEEK OR A DAY MOUNTED ALONE, over invented events: the props the calendar's body hands a view, the reader's words
 * in either language, and a plan for each room. What a press opens is recorded.
 */
import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { intlZones, type EventTime, type PlainDate } from "@ohmail/app-logic/calendar";
import type {
  CalendarEventView,
  CalendarViewProps,
  CalendarViewSettings,
  EventRef,
} from "../../src/calendar/view.js";
import type { LayoutPlan } from "../../src/frame/contract.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import dayDe from "../../messages/day.de.json" with { type: "json" };
import dayEn from "../../messages/day.en.json" with { type: "json" };
import weekDe from "../../messages/week.de.json" with { type: "json" };
import weekEn from "../../messages/week.en.json" with { type: "json" };
import calendarDe from "../../messages/calendar.de.json" with { type: "json" };
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };

export const ZURICH = "Europe/Zurich";
export const zones = intlZones();
export const TIME_WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: { ...weekEn, ...dayEn, ...calendarEn },
  de: { ...weekDe, ...dayDe, ...calendarDe },
};

export const at = (year: number, month: number, day: number, hour: number, minute = 0): EventTime => ({
  kind: "zoned",
  wall: { year, month, day, hour, minute, second: 0 },
  tzid: ZURICH,
});
export const date = (year: number, month: number, day: number): PlainDate => ({
  kind: "date",
  year,
  month,
  day,
});

/** An invented event on the studio's calendar (hue 210), plain, changeable. */
export function event(
  id: string,
  start: EventTime,
  end: EventTime,
  face: Partial<CalendarEventView> = {},
): CalendarEventView {
  return {
    id,
    start,
    end,
    title: id,
    tone: 210,
    state: "plain",
    repeats: null,
    viewOnly: false,
    waits: false,
    status: null,
    second: null,
    ref: { event: id, occurrence: null, day: "" },
    ...face,
  };
}

export const SETTINGS: CalendarViewSettings = {
  weekStart: 0,
  weekNumbers: false,
  secondZone: null,
  hours: { from: 7 * 60, to: 21 * 60 },
};

export const PLANS: Readonly<Record<"desktop" | "phone" | "fold", LayoutPlan>> = {
  desktop: {
    size: "expanded",
    short: false,
    pointer: "fine",
    device: "desktop",
    pose: null,
    rail: "words",
    columns: 2,
    handles: true,
  },
  phone: {
    size: "compact",
    short: false,
    pointer: "coarse",
    device: "phone",
    pose: null,
    rail: "dock",
    columns: 1,
    handles: false,
  },
  fold: {
    size: "medium",
    short: false,
    pointer: "coarse",
    device: "fold",
    pose: null,
    rail: "icons",
    columns: 2,
    handles: false,
  },
};

export interface Mounted {
  readonly opened: EventRef[];
  readonly days: PlainDate[];
  readonly rerender: (next: Partial<CalendarViewProps>) => void;
  readonly container: HTMLElement;
}

export function mountView(
  View: ComponentType<CalendarViewProps>,
  props: Partial<CalendarViewProps> & { anchor: PlainDate },
  locale: "en" | "de" = "en",
): Mounted {
  const opened: EventRef[] = [];
  const days: PlainDate[] = [];
  const base: CalendarViewProps = {
    events: [],
    capped: false,
    edge: { earlier: null, later: null, load: "none" },
    openId: null,
    clock: { zone: ZURICH, zones, nowMs: Date.UTC(2026, 10, 18, 13, 0) },
    settings: SETTINGS,
    plan: PLANS.desktop,
    panel: false,
    onOpen: (ref) => opened.push(ref),
    onDay: (d) => days.push(d),
    ...props,
  };
  const tree = (p: CalendarViewProps) => (
    <TextProvider locale={locale} messages={TIME_WORDS[locale]} timeZone={ZURICH}>
      <View {...p} />
    </TextProvider>
  );
  const out = render(tree(base));
  let now = base;
  return {
    opened,
    days,
    container: out.container,
    rerender: (next) => {
      now = { ...now, ...next };
      out.rerender(tree(now));
    },
  };
}
