/**
 * An invented week in November 2026 for the range views (Month, Year, Agenda, Search), and their text, in
 * either language. Times are written as the calendar writes them: a zoned clock time, or a date.
 */
import type { ReactNode } from "react";
import {
  readerZones,
  type HeldEdge,
  type RangeActs,
  type RangeInput,
  type ViewEvent,
} from "@ohmail/app-logic/calendar";

type EventTime = ViewEvent["start"];
import { AGENDA_DAYS } from "../../src/agenda/index.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import monthEn from "../../messages/month.en.json" with { type: "json" };
import monthDe from "../../messages/month.de.json" with { type: "json" };
import yearEn from "../../messages/year.en.json" with { type: "json" };
import yearDe from "../../messages/year.de.json" with { type: "json" };
import agendaEn from "../../messages/agenda.en.json" with { type: "json" };
import agendaDe from "../../messages/agenda.de.json" with { type: "json" };
import searchEn from "../../messages/calsearch.en.json" with { type: "json" };
import searchDe from "../../messages/calsearch.de.json" with { type: "json" };
import calsettingsEn from "../../messages/calsettings.en.json" with { type: "json" };
import calsettingsDe from "../../messages/calsettings.de.json" with { type: "json" };
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import calendarDe from "../../messages/calendar.de.json" with { type: "json" };

export const ZONE = "Europe/Zurich";
const wall = (y: number, mo: number, d: number, h: number, mi: number) => ({
  year: y,
  month: mo,
  day: d,
  hour: h,
  minute: mi,
  second: 0,
});
export const at = (y: number, mo: number, d: number, h = 0, mi = 0): EventTime => ({
  kind: "zoned",
  wall: wall(y, mo, d, h, mi),
  tzid: ZONE,
});
export const date = (y: number, mo: number, d: number): EventTime => ({
  kind: "date",
  year: y,
  month: mo,
  day: d,
});

export function ev(
  key: string,
  title: string,
  start: EventTime,
  end: EventTime,
  more: Partial<ViewEvent> = {},
): ViewEvent {
  return {
    id: key,
    ref: { event: key, occurrence: null, day: "" },
    start,
    end,
    title,
    second: null,
    people: [],
    notes: null,
    tone: 150,
    state: "plain",
    waits: false,
    viewOnly: false,
    repeats: null,
    status: null,
    ...more,
  };
}

export const WORLD: readonly ViewEvent[] = [
  ev("studio", "Studio Monday", at(2026, 11, 16, 9), at(2026, 11, 16, 9, 45)),
  ev("poster", "Poster review", at(2026, 11, 18, 14, 30), at(2026, 11, 18, 15, 30), {
    second: "Studio, Winterthur",
    people: ["Jonas Halter"],
  }),
  ev("tech", "Tech check, main hall", at(2026, 11, 20, 16), at(2026, 11, 20, 16, 15), {
    second: "Makersfest, Hall 2",
    people: ["Petra Wyss"],
    waits: true,
  }),
  ev("fest", "Makersfest", date(2026, 11, 20), date(2026, 11, 23), { tone: 140 }),
  ev("old", "Tech check", at(2026, 10, 2, 10), at(2026, 10, 2, 11)),
  ev("holiday", "First Advent", date(2026, 11, 29), date(2026, 11, 30), { viewOnly: true, tone: "neutral" }),
];

export function rangeInput(more: Partial<RangeInput> = {}): RangeInput {
  return {
    events: WORLD,
    anchor: "2026-11-16",
    today: "2026-11-16",
    nowMinute: 9 * 60 + 24,
    zone: ZONE,
    zones: readerZones(),
    weekStart: 0,
    weekNumbers: false,
    open: null,
    device: "desktop",
    ...more,
  };
}

export interface ActLog {
  readonly acts: RangeActs;
  readonly said: string[];
}
/** The acts a view asks for, written down in order. */
export function actLog(): ActLog {
  const said: string[] = [];
  return {
    said,
    acts: {
      event: (e) => said.push(`event ${e ? e.id : "none"}`),
      pick: (d) => said.push(`pick ${d}`),
      view: (v, d) => said.push(`view ${v} ${d}`),
      reveal: (e) => said.push(`reveal ${e.id}`),
    },
  };
}

export const NO_EDGE: HeldEdge = { earlier: null, later: null, load: "none" };

/** The Agenda's days as the body hands them at first, with nobody asking for more. */
export const FIRST_REACH = { days: AGENDA_DAYS, onMore: () => undefined } as const;

const WORDS: Record<"en" | "de", Messages> = {
  en: { ...monthEn, ...yearEn, ...agendaEn, ...searchEn, ...calendarEn, ...calsettingsEn },
  de: { ...monthDe, ...yearDe, ...agendaDe, ...searchDe, ...calendarDe, ...calsettingsDe },
};

export function Words({ lang = "en", children }: { lang?: "en" | "de"; children: ReactNode }) {
  return (
    <TextProvider locale={lang} messages={fillOver(WORDS.en, WORDS[lang])} timeZone={ZONE}>
      {children}
    </TextProvider>
  );
}
