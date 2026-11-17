/**
 * THE RANGE VIEWS' REGISTERED STATES, drawn by address: Month, Year, Agenda and Search over an invented November,
 * held by hand from what the reference draws. The address carries the reference's own words (`screen=month`,
 * `at=2026-11-18`, `open=…`, `q=…`, `weeks=1`, `top=…`, `state=…`, `device=phone`, `face=ohmarchy`, `scheme=dark`)
 * and `lang`. The calendar's head, rail and panel are the calendar root's: here the view stands alone in the
 * sheet's place, and what the root draws is compared once the views are mounted in it.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  readerZones,
  type HeldEdge,
  type RangeActs,
  type RangeInput,
  type ViewEvent,
} from "@ohmail/app-logic/calendar";
import { AGENDA_DAYS, AgendaView } from "../../src/agenda/index.js";
import { SearchView } from "../../src/calsearch/index.js";
import { MonthView } from "../../src/month/index.js";
import { YearView } from "../../src/year/index.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import monthEn from "../../messages/month.en.json" with { type: "json" };
import monthDe from "../../messages/month.de.json" with { type: "json" };
import yearEn from "../../messages/year.en.json" with { type: "json" };
import yearDe from "../../messages/year.de.json" with { type: "json" };
import agendaEn from "../../messages/agenda.en.json" with { type: "json" };
import agendaDe from "../../messages/agenda.de.json" with { type: "json" };
import searchEn from "../../messages/calsearch.en.json" with { type: "json" };
import searchDe from "../../messages/calsearch.de.json" with { type: "json" };
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import calendarDe from "../../messages/calendar.de.json" with { type: "json" };

type EventTime = ViewEvent["start"];
const ZONE = "Europe/Zurich";
/** The reference's clock: Tuesday 10 November 2026, 09:24. */
const TODAY = "2026-11-10";
const NOW = 9 * 60 + 24;

const HUE = { studio: 153, personal: 243, catalogue: 288, family: 13, holiday: "neutral" } as const;
type Cal = keyof typeof HUE;
const at = (day: string, hhmm: string): EventTime => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  return { kind: "zoned", wall: { year: y, month: m, day: d, hour: h, minute: mi, second: 0 }, tzid: ZONE };
};
const date = (day: string): EventTime => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { kind: "date", year: y, month: m, day: d };
};
const next = (day: string, n: number): string => {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n);
  return new Date(t).toISOString().slice(0, 10);
};

let seq = 0;
function timed(
  day: string,
  from: string,
  to: string,
  title: string,
  cal: Cal,
  more: Partial<ViewEvent> = {},
): ViewEvent {
  const id = more.id ?? `ev-${++seq}`;
  return {
    id,
    ref: { event: id, occurrence: null, day },
    start: at(day, from),
    end: at(day, to),
    title,
    tone: HUE[cal],
    state: "plain",
    repeats: null,
    viewOnly: cal === "holiday",
    waits: false,
    status: null,
    second: null,
    people: [],
    notes: null,
    ...more,
  };
}
function whole(
  first: string,
  days: number,
  title: string,
  cal: Cal,
  more: Partial<ViewEvent> = {},
): ViewEvent {
  const id = more.id ?? `ev-${++seq}`;
  return {
    ...timed(first, "00:00", "00:00", title, cal, { id }),
    start: date(first),
    end: date(next(first, days)),
    ...more,
  };
}
/** A weekly series from the first Monday of the run to its last, as its days. */
function weekly(
  dow: number,
  from: string,
  to: string,
  title: string,
  cal: Cal,
  more: Partial<ViewEvent> = {},
): ViewEvent[] {
  const out: ViewEvent[] = [];
  for (let d = next("2026-10-26", dow); d <= "2026-12-06"; d = next(d, 7))
    out.push(timed(d, from, to, title, cal, { repeats: "series", ...more, id: `${more.id ?? title}@${d}` }));
  return out;
}

const WORLD: ViewEvent[] = [
  ...weekly(0, "09:00", "09:45", "Studio Monday", "studio"),
  ...weekly(1, "14:00", "14:45", "Catalogue weekly", "catalogue", {
    second: "13:00–13:45 Porto · Call",
    people: ["Inês Carvalho"],
  }).map((e) => (e.ref.day === "2026-11-17" ? { ...e, waits: true } : e)),
  ...weekly(1, "18:30", "20:00", "Bouldering with Tim", "personal", { second: "Boulder hall, Winterthur" }),
  ...weekly(3, "07:00", "07:45", "Run with Reto", "personal"),
  ...weekly(3, "13:00", "14:00", "Glaze firing", "studio"),
  ...weekly(3, "16:30", "17:00", "Catalogue check-in", "catalogue"),
  whole("2026-11-01", 1, "All Saints' Day (regional)", "holiday"),
  whole("2026-11-04", 1, "Tim Berger's birthday", "family", { viewOnly: true }),
  timed("2026-11-04", "10:00", "11:00", "Catalogue captions", "catalogue"),
  timed("2026-11-06", "14:00", "15:00", "Poster photos: twelve tiles", "studio"),
  timed("2026-11-08", "18:00", "21:00", "Dinner at Mum's", "family"),
  timed("2026-11-09", "15:00", "15:30", "Menu cards to Gartenlokal Rosa", "personal"),
  timed("2026-11-10", "09:00", "10:00", "Invoices, new template", "personal"),
  timed("2026-11-10", "14:30", "15:30", "Poster review", "studio", {
    id: "ev-poster-review",
    second: "Studio, Winterthur",
    people: ["Jonas Halter"],
  }),
  timed("2026-11-11", "08:00", "12:00", "Kiln technician", "studio", {
    second: "Kiln room",
    people: ["Ben Arnold"],
  }),
  ...weekly(2, "18:00", "21:00", "Open bench", "studio", { second: "Studio, Winterthur" }).filter(
    (e) => e.ref.day >= "2026-11-11",
  ),
  timed("2026-11-12", "09:30", "10:30", "Dentist", "personal"),
  timed("2026-11-13", "12:15", "13:30", "Lunch with Anna", "personal"),
  timed("2026-11-13", "15:00", "16:00", "Glaze test review", "personal"),
  timed("2026-11-13", "18:00", "21:00", "Pizza, wood oven", "studio", { second: "Studio yard" }),
  timed("2026-11-14", "12:00", "16:30", "Monte Brè with Reto", "personal", { second: "Lugano" }),
  whole("2026-11-20", 3, "Makersfest", "studio"),
  timed("2026-11-16", "10:00", "11:00", "Slides, last pass", "studio"),
  timed("2026-11-16", "14:00", "15:00", "Stand list with Jonas", "studio"),
  timed("2026-11-17", "16:00", "17:00", "Pack samples for Porto", "catalogue"),
  timed("2026-11-18", "06:55", "09:10", "Flight to Porto", "personal"),
  timed("2026-11-18", "11:30", "17:00", "Catalogue shoot, day 1", "catalogue", { waits: true }),
  timed("2026-11-18", "20:30", "22:30", "Dinner with Inês and Duarte", "catalogue"),
  timed("2026-11-19", "10:00", "15:00", "Catalogue shoot, day 2", "catalogue"),
  timed("2026-11-19", "16:20", "20:10", "Flight to Zürich", "personal"),
  timed("2026-11-20", "10:00", "11:00", "Talk rehearsal", "studio"),
  timed("2026-11-20", "15:30", "16:00", "Stand set-up, Hall 2", "studio"),
  timed("2026-11-20", "16:00", "16:15", "Tech check, main hall", "personal", {
    id: "ev-techcheck",
    tone: null,
    state: "to-answer",
    waits: true,
    second: "Makersfest, Hall 2, Zürich",
    people: ["Petra Wyss"],
  }),
  timed("2026-11-21", "13:00", "17:00", "Stand shift", "studio"),
  timed("2026-11-22", "10:00", "14:00", "Stand shift", "studio"),
  timed("2026-11-22", "16:00", "18:00", "Stand take-down", "studio"),
  whole("2026-11-23", 3, "Days off", "personal"),
  whole("2026-11-24", 1, "Photo selects due", "catalogue", { viewOnly: true }),
  whole("2026-11-26", 1, "Lea Brunner's birthday", "family", { viewOnly: true }),
  whole("2026-11-27", 1, "Proofs due", "catalogue", { viewOnly: true }),
  timed("2026-11-27", "15:00", "16:00", "Month-end books", "personal"),
  whole("2026-11-29", 1, "First Advent", "holiday"),
  whole("2026-12-04", 1, "Catalogue to print", "catalogue", { viewOnly: true }),
  whole("2026-12-05", 1, "Open studio? (hold)", "studio", { state: "maybe" }),
  whole("2026-12-06", 1, "St Nicholas' Day", "holiday"),
];

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
const screen = q.get("screen") ?? "month";
const state = q.get("state");
document.documentElement.setAttribute("data-face", q.get("face") === "ohmarchy" ? "ohmarchy" : "paper");
document.documentElement.setAttribute("data-theme", q.get("scheme") === "dark" ? "dark" : "light");
document.documentElement.setAttribute("data-product", "cal");
document.documentElement.setAttribute("lang", lang);

const WORDS: Record<"en" | "de", Messages> = {
  en: { ...monthEn, ...yearEn, ...agendaEn, ...searchEn, ...calendarEn },
  de: { ...monthDe, ...yearDe, ...agendaDe, ...searchDe, ...calendarDe },
};
const input: RangeInput = {
  events: state === "empty" ? [] : WORLD,
  anchor: q.get("at") ?? TODAY,
  today: TODAY,
  nowMinute: NOW,
  zone: ZONE,
  zones: readerZones(),
  weekStart: 0,
  weekNumbers: q.get("weeks") === "1",
  open: q.get("open"),
  device: device === "phone" ? "phone" : device === "desktop" ? "desktop" : "fold",
};
const acts: RangeActs = {
  event: () => undefined,
  pick: () => undefined,
  view: () => undefined,
  reveal: () => undefined,
};
/* The Microsoft 365 copy is held from 10 May, six months before the clock. */
const edge: HeldEdge = { earlier: "2026-05-10", later: null, load: async () => true };

function Search() {
  const [query, setQuery] = useState(q.get("q") ?? (state === "blank" ? "" : "tehc check"));
  return (
    <SearchView
      input={input}
      acts={acts}
      query={query}
      onQuery={setQuery}
      held={{ from: "2026-05-10", to: "2027-05-09" }}
    />
  );
}
const view =
  screen === "year" ? (
    <YearView input={input} acts={acts} edge={edge} />
  ) : screen === "agenda" ? (
    <AgendaView
      input={input}
      acts={acts}
      edge={edge}
      from={device === "phone" ? undefined : TODAY}
      days={AGENDA_DAYS}
      onMore={() => undefined}
    />
  ) : screen === "calsearch" ? (
    <Search />
  ) : (
    <MonthView input={input} acts={acts} edge={edge} top={q.get("top")} />
  );
/* The sheet's place in the reference: beside the words rail under the head; on a phone, under the head on the ground. */
const place =
  device === "phone"
    ? { top: 116, left: 0, right: 0, bottom: 0 }
    : { top: 64, left: device === "desktop" ? 256 : 76, right: 12, bottom: 12 };

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={fillOver(WORDS.en, WORDS[lang])} timeZone={ZONE}>
    <div className="oh-root" style={{ position: "fixed", inset: 0 }}>
      <main
        style={{
          position: "absolute",
          ...place,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: device === "phone" ? 0 : "var(--r-sheet)",
          background: device === "phone" ? "transparent" : "var(--sheet)",
        }}
      >
        {view}
      </main>
    </div>
  </TextProvider>,
);
