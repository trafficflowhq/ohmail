/**
 * THE WEEK'S AND THE DAY'S REGISTERED STATES, by the reference's own address words, over the invented world: Mila
 * Brunner's week of 9 November 2026, read off the reference's pictures, its clock at Tuesday 10 November, 09:24 in
 * Zürich. The calendar's states page mounts what this returns inside the calendar's body: `timeStateOf` answers the
 * keys whose difference is the grid's own (the span, the hours in view, the room, the look) and `null` for every
 * other key (a card, a menu, a panel, the rail, mail's marks), which another part of the calendar draws.
 */
import type { EventTime } from "@ohmail/app-logic/calendar";
import type { CalendarEventView, CalendarViewProps } from "../../src/calendar/view.js";

const ZONE = "Europe/Zurich";
/** The calendars' hues on the ring (the reference turns its ring by the accent; the model's to say). */
const HUE = { mila: 240, studio: 150, catalogue: 285 } as const;

const at = (day: number, hour: number, minute = 0): EventTime => ({
  kind: "zoned",
  wall: { year: 2026, month: 11, day, hour, minute, second: 0 },
  tzid: ZONE,
});

function ev(
  id: string,
  title: string,
  day: number,
  from: [number, number],
  to: [number, number],
  face: Partial<CalendarEventView> & { tone: number },
): CalendarEventView {
  return {
    id,
    title,
    start: at(day, from[0], from[1]),
    end: at(day, to[0], to[1]),
    state: "plain",
    repeats: null,
    viewOnly: false,
    waits: false,
    status: null,
    second: null,
    ref: { event: id, occurrence: null, day: `2026-11-${String(day).padStart(2, "0")}` },
    ...face,
  };
}

/** The week of 9 November as the reference draws it, without what mail adds (found events, dated mail). */
export const WEEK_OF_9_NOVEMBER: readonly CalendarEventView[] = [
  ev("ev-studio-monday", "Studio Monday", 9, [9, 0], [9, 30], { tone: HUE.studio, repeats: "series" }),
  ev("ev-menu-cards", "Menu cards to print", 9, [15, 0], [15, 30], { tone: HUE.mila }),
  ev("ev-invoices", "Invoices, new template", 10, [9, 0], [10, 0], { tone: HUE.mila }),
  ev("ev-catalogue-weekly", "Catalogue weekly", 10, [14, 0], [15, 0], {
    tone: HUE.catalogue,
    repeats: "series",
  }),
  ev("ev-poster-review", "Poster review", 10, [14, 30], [15, 30], {
    tone: HUE.studio,
    second: "Studio, Winterthur",
  }),
  ev("ev-bouldering", "Bouldering with Tim", 10, [18, 30], [20, 0], {
    tone: HUE.mila,
    second: "Boulder hall, Winterthur",
    repeats: "series",
  }),
  ev("ev-kiln-technician", "Kiln technician", 11, [8, 0], [12, 0], { tone: HUE.studio, second: "Kiln room" }),
  ev("ev-open-bench", "Open bench", 11, [18, 0], [20, 0], {
    tone: HUE.studio,
    second: "Studio, Winterthur",
    repeats: "series",
  }),
  ev("ev-run-reto", "Run with Reto", 12, [7, 0], [7, 45], { tone: HUE.mila, repeats: "series" }),
  ev("ev-dentist", "Dentist", 12, [9, 30], [10, 45], { tone: HUE.mila }),
  ev("ev-glaze-evening", "Glaze evening", 12, [10, 0], [10, 30], { tone: HUE.mila, waits: true }),
  ev("ev-glaze-firing", "Glaze firing", 12, [13, 0], [14, 0], {
    tone: HUE.studio,
    second: "Kiln room",
    repeats: "series",
  }),
  ev("ev-catalogue-checkin", "Catalogue check-in", 12, [16, 30], [17, 0], { tone: HUE.catalogue }),
  ev("ev-film-night", "Film night", 12, [20, 15], [22, 30], { tone: HUE.mila, second: "Kino Seeblick" }),
  ev("ev-lunch-anna", "Lunch with Anna", 13, [12, 15], [13, 15], {
    tone: HUE.mila,
    second: "Gartenlokal Rosa",
  }),
  ev("ev-glaze-review", "Glaze test review", 13, [15, 0], [16, 0], { tone: HUE.mila }),
  ev("ev-pizza", "Pizza, wood oven", 13, [18, 0], [21, 0], { tone: HUE.studio, second: "Studio yard" }),
  ev("ev-monte-bre", "Monte Brè with Reto", 14, [12, 0], [16, 30], { tone: HUE.mila, second: "Lugano" }),
];

/** The reference's clock: Tuesday 10 November 2026, 09:24 in Zürich. */
export const REFERENCE_NOW = Date.UTC(2026, 10, 10, 8, 24);

/** Keys of `week` and `day` whose difference is the grid's own. */
const OWN_WORDS = new Set(["screen", "product", "at", "hours", "show", "device", "face", "scheme", "lang"]);

/** The view and its props for a key of `week` or `day`, or `null` where another part of the calendar draws the state. */
export function timeStateOf(search: URLSearchParams): {
  view: "week" | "day";
  props: Partial<CalendarViewProps> & { anchor: CalendarViewProps["anchor"] };
} | null {
  const screen = search.get("screen");
  if (screen !== "week" && screen !== "day") return null;
  if ([...search.keys()].some((k) => !OWN_WORDS.has(k))) return null;
  const show = search.get("show");
  if (show !== null && show !== "night") return null;
  const day = /^2026-11-(\d\d)$/.exec(search.get("at") ?? "");
  const hours = /^(\d{1,2})-(\d{1,2})$/.exec(search.get("hours") ?? "");
  const from = show === "night" ? 0 : hours ? Number(hours[1]) * 60 : 7 * 60;
  const to = hours ? Number(hours[2]) * 60 : 21 * 60;
  return {
    view: screen,
    props: {
      anchor: { kind: "date", year: 2026, month: 11, day: day ? Number(day[1]) : 10 },
      events: WEEK_OF_9_NOVEMBER,
      settings: { weekStart: 0, weekNumbers: false, secondZone: null, hours: { from, to } },
    },
  };
}
