/**
 * WHERE THE CALENDAR'S BODY STANDS, AND WHAT IT DRAWS THERE: now and today on the reader's clock, the place's span and
 * the Agenda's, the account's settings, and the occurrences of a span as faces, worked out from the mirror on every
 * version and kept by nobody.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  addDays,
  agendaFrom,
  dayOfIso,
  edgeOf,
  isoOfDay,
  monthOfDay,
  nowIn,
  occurrencesIn,
  spanOfView,
  shiftMonth,
  firstOfMonth,
  dayNumberOf,
  yearOf,
  weekStartOf,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
  type PlainDate,
  type SpanView,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { NONE } from "../host/index.js";
import { hoursInView } from "../calsettings/hours.js";
import { useCalendarSettings } from "../calsettings/settings-read.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { useFrame } from "../frame/commands.js";
import type { AnyPlaceId, CalendarPlaceId, Route } from "../frame/contract.js";
import { isCalendarPlace } from "../frame/product.js";
import { useText } from "../text/index.js";
import { AGENDA_DAYS, AGENDA_MORE } from "../agenda/index.js";
import { faceOf, type CalendarEventFace } from "./faces.js";
import { calendarTones } from "./tones.js";
import type { CalendarViewSettings } from "./view.js";

/** The views the head switches between, in its order. */
export const VIEWS = ["day", "week", "month", "year"] as const satisfies readonly SpanView[];
export type ViewId = (typeof VIEWS)[number];
export const isView = (place: AnyPlaceId): place is ViewId => (VIEWS as readonly string[]).includes(place);

/** The next visible span preserves a valid civil date at the end of February. */
export function shifted(place: CalendarPlaceId, anchor: string, n: number, oneDayWeek: boolean): string {
  let next: string;
  if (place === "month") {
    next = firstOfMonth(shiftMonth(monthOfDay(anchor), n));
  } else if (place === "year") {
    const year = Number(yearOf(anchor)) + n;
    if (year < 1 || year > 9999) return anchor;
    next = `${String(year).padStart(4, "0")}${anchor.slice(4)}`;
    if (next.endsWith("-02-29") && dayNumberOf(next) === null) next = `${next.slice(0, -2)}28`;
  } else {
    next = addDays(anchor, n * (place === "week" && !oneDayWeek ? 7 : 1));
  }
  return dayNumberOf(next) === null ? anchor : next;
}

/** A minute: the clock the body reads now by. */
const MINUTE_MS = 60_000;
/** Days Search looks ahead of today. */
const AHEAD_DAYS = 180;

export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(tick);
  }, [active]);
  return now;
}

/** The account's calendar settings, asked once per port; until they answer, the plain defaults. */
export function useSettings(port: CalendarPort | typeof NONE): CalendarViewSettings {
  const { said } = useCalendarSettings(port === NONE ? null : port, "none");
  return useMemo(
    () => ({
      /* The settings carry no week start yet: Monday. */
      ...(said === null ? {} : { newEventsCalendarId: said.newEventsCalendarId }),
      weekStart: 0,
      weekNumbers: said?.weekNumbers ?? false,
      secondZone: said?.secondZone ?? null,
      hours: hoursInView(said),
    }),
    [said],
  );
}

/** Calendar Search includes the mirrored past and the same upcoming span from either product. */
export function calendarSearchSpan(today: string, daysBack: number) {
  return { first: addDays(today, -daysBack), last: addDays(today, AHEAD_DAYS) };
}

/** The first and last day each place but the Agenda draws, around its anchor. */
function spanOf(
  place: CalendarPlaceId,
  anchor: string,
  today: string,
  weekStart: number,
  held: number,
): { first: string; last: string } {
  if (place === "calsearch") return calendarSearchSpan(today, held);
  if (place === "month") {
    const first = weekStartOf(`${monthOfDay(anchor)}-01`, weekStart);
    return { first, last: addDays(first, 41) };
  }
  return spanOfView(isView(place) ? place : "week", anchor, weekStart);
}

export interface Where {
  readonly place: CalendarPlaceId;
  readonly nowMs: number;
  readonly now: { readonly day: PlainDate; readonly minutes: number };
  readonly today: string;
  readonly anchorDay: PlainDate;
  readonly anchor: string;
  readonly span: Span;
  /** The Agenda's own days, as a place or beside the view: from its first day as far as it was scrolled. */
  readonly agenda: Span & {
    readonly days: number;
    readonly more: () => void;
    readonly keepAt: (place: CalendarPlaceId, day: string) => void;
  };
}

interface Span {
  readonly first: string;
  readonly last: string;
}

/**
 * Where the body stands: the place, now and today on the reader's clock, the anchor, the span the place draws and the
 * Agenda's. How far the Agenda reaches is a count of days, kept for its first day only.
 */
export function useWhere(
  port: CalendarPort,
  route: Route,
  settings: CalendarViewSettings,
  zone: string,
  zones: ZoneSource,
): Where | null {
  const nowMs = useNow();
  const [reach, setReach] = useState<{ first: string | null; days: number }>({
    first: null,
    days: AGENDA_DAYS,
  });
  const [heldAgenda, setHeldAgenda] = useState<{ first: string; place: CalendarPlaceId; day: string } | null>(
    null,
  );
  const place: CalendarPlaceId = isCalendarPlace(route.place) ? route.place : "week";
  const now = nowIn(nowMs, zone, zones);
  const currentDay = route.sub ?? (now && isoOfDay(now.day));
  const keepAgenda =
    route.words.panel === "agenda" && heldAgenda?.place === place && heldAgenda.day === currentDay;
  useEffect(() => {
    if (!keepAgenda) setHeldAgenda(null);
  }, [keepAgenda]);
  if (now === null) return null;
  const today = isoOfDay(now.day);
  const anchorDay = dayOfIso(route.sub) ?? now.day;
  const anchor = isoOfDay(anchorDay);
  const first = keepAgenda
    ? heldAgenda.first
    : place === "agenda"
      ? anchor
      : agendaFrom(spanOfView(isView(place) ? place : "week", anchor, settings.weekStart), today);
  const days = reach.first === first ? reach.days : AGENDA_DAYS;
  const agenda = {
    first,
    last: addDays(first, days - 1),
    days,
    more: () => setReach({ first, days: days + AGENDA_MORE }),
    keepAt: (destination: CalendarPlaceId, day: string) => setHeldAgenda({ first, place: destination, day }),
  };
  const span =
    place === "agenda"
      ? agenda
      : spanOf(place, anchor, today, settings.weekStart, port.held().window.daysBack);
  return { place, nowMs, now, today, anchorDay, anchor, span, agenda };
}

/** What the mirror holds on this version, read again whenever the port's version moves, and the faces' words. */
const silent = () => () => undefined;
const zero = () => 0;

export function useSources(port: CalendarPort | typeof NONE) {
  const { host } = useFrame();
  const words = useText("event");
  const mailWords = useText("calmail");
  const version = useSyncExternalStore(
    port === NONE ? silent : port.subscribe,
    port === NONE ? zero : port.version,
    port === NONE ? zero : port.version,
  );
  const records = useMemo(() => {
    void version;
    if (port === NONE)
      return {
        calendars: [],
        tones: calendarTones([]),
        connections: new Map<string, CalendarConnectionRecord>(),
        events: [],
      };
    const read = <T>(kind: string) =>
      host.engine.store
        .entries<T | null>(kind)
        .map((e) => e.entity)
        .filter((c): c is T => c !== null);
    const connections = new Map(
      read<CalendarConnectionRecord>("calendar_connection").map((c) => [c.id, c] as const),
    );
    const calendars = read<CalendarRecord>("calendar");
    return { calendars, tones: calendarTones(calendars), connections, events: port.events() };
  }, [host.engine, port, version]);
  const faceWords = useMemo(
    () => ({
      busy: () => mailWords("busy"),
      waitingDevice: words("waiting.device"),
      waitingProvider: words("waiting.provider"),
      notSaved: words("notSaved"),
    }),
    [words, mailWords],
  );
  return useMemo(() => ({ ...records, faceWords }), [records, faceWords]);
}

/**
 * A span's occurrences as faces, worked out from the mirror on this version and kept by nobody: again whenever the
 * records or the span move. No span, nothing worked out.
 */
export function useFaces(
  port: CalendarPort | typeof NONE,
  sources: ReturnType<typeof useSources>,
  span: Span | null,
  today: string | null,
  zone: string,
  zones: ZoneSource,
) {
  const own = useKnownOwnAddresses();
  const first = span?.first ?? null;
  const last = span?.last ?? null;
  return useMemo(() => {
    const from = dayOfIso(first);
    const to = dayOfIso(last);
    const at = dayOfIso(today);
    if (port === NONE || from === null || to === null || at === null) return null;
    const occurrences = occurrencesIn({ ...sources, query: { from, to }, zone, zones });
    return {
      capped: occurrences.capped,
      events: occurrences.shown.map((o): CalendarEventFace =>
        faceOf(o, sources.connections, sources.faceWords, sources.tones.get(o.calendar.id) ?? "neutral", own),
      ),
      /* The held window moves with the version, as the records do. */
      edge: edgeOf({ from, to }, port.held(), at),
    };
  }, [sources, first, last, today, zone, zones, port, own]);
}
