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
  weekStartOf,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
  type CalendarSettingsWire,
  type PlainDate,
  type SpanView,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { useFrame } from "../frame/commands.js";
import type { CalendarPlaceId, Route } from "../frame/contract.js";
import { isCalendarPlace } from "../frame/product.js";
import { useText } from "../text/index.js";
import { AGENDA_DAYS, AGENDA_MORE } from "../agenda/index.js";
import { faceOf, type CalendarEventFace } from "./faces.js";
import type { CalendarViewSettings } from "./view.js";

/** The views the head switches between, in its order. */
export const VIEWS = ["day", "week", "month", "year", "agenda"] as const satisfies readonly SpanView[];
export type ViewId = (typeof VIEWS)[number];
export const isView = (place: CalendarPlaceId): place is ViewId =>
  (VIEWS as readonly string[]).includes(place);

/** A minute: the clock the body reads now by. */
const MINUTE_MS = 60_000;
/** Days Search looks ahead of today. */
const AHEAD_DAYS = 180;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(tick);
  }, []);
  return now;
}

/** The account's calendar settings, asked once per port; until they answer, the plain defaults. */
export function useSettings(port: CalendarPort): CalendarViewSettings {
  const [said, setSaid] = useState<CalendarSettingsWire | null>(null);
  useEffect(() => {
    let live = true;
    port.settings().then(
      (s) => live && setSaid(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [port]);
  return useMemo(
    () => ({
      /* The settings carry no week start yet: Monday. */
      weekStart: 0,
      weekNumbers: said?.weekNumbers ?? false,
      secondZone: said?.secondZone ?? null,
      hours: {
        from: said?.dayFromMinute ?? 0,
        to: said?.dayToMinute ?? 24 * 60,
      },
    }),
    [said],
  );
}

/** The first and last day each place but the Agenda draws, around its anchor. */
function spanOf(
  place: CalendarPlaceId,
  anchor: string,
  today: string,
  weekStart: number,
  held: number,
): { first: string; last: string } {
  if (place === "calsearch") return { first: addDays(today, -held), last: addDays(today, AHEAD_DAYS) };
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
  readonly agenda: Span & { readonly days: number; readonly more: () => void };
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
  const place: CalendarPlaceId = isCalendarPlace(route.place) ? route.place : "week";
  const now = nowIn(nowMs, zone, zones);
  if (now === null) return null;
  const today = isoOfDay(now.day);
  const anchorDay = dayOfIso(route.sub) ?? now.day;
  const anchor = isoOfDay(anchorDay);
  const first =
    place === "agenda"
      ? anchor
      : agendaFrom(spanOfView(isView(place) ? place : "week", anchor, settings.weekStart), today);
  const days = reach.first === first ? reach.days : AGENDA_DAYS;
  const agenda = {
    first,
    last: addDays(first, days - 1),
    days,
    more: () => setReach({ first, days: days + AGENDA_MORE }),
  };
  const span =
    place === "agenda"
      ? agenda
      : spanOf(place, anchor, today, settings.weekStart, port.held().window.daysBack);
  return { place, nowMs, now, today, anchorDay, anchor, span, agenda };
}

/** What the mirror holds on this version, read again whenever the port's version moves, and the faces' words. */
export function useSources(port: CalendarPort) {
  const { host } = useFrame();
  const words = useText("event");
  const version = useSyncExternalStore(port.subscribe, port.version, port.version);
  const records = useMemo(() => {
    void version;
    const read = <T>(kind: string) =>
      host.engine.store
        .entries<T | null>(kind)
        .map((e) => e.entity)
        .filter((c): c is T => c !== null);
    const connections = new Map(
      read<CalendarConnectionRecord>("calendar_connection").map((c) => [c.id, c] as const),
    );
    return { calendars: read<CalendarRecord>("calendar"), connections, events: port.events() };
  }, [host.engine, port, version]);
  const faceWords = useMemo(
    () => ({
      waitingDevice: words("waiting.device"),
      waitingProvider: words("waiting.provider"),
      notSaved: words("notSaved"),
    }),
    [words],
  );
  return useMemo(() => ({ ...records, faceWords }), [records, faceWords]);
}

/**
 * A span's occurrences as faces, worked out from the mirror on this version and kept by nobody: again whenever the
 * records or the span move. No span, nothing worked out.
 */
export function useFaces(
  port: CalendarPort,
  sources: ReturnType<typeof useSources>,
  span: Span | null,
  today: string | null,
  zone: string,
  zones: ZoneSource,
) {
  const first = span?.first ?? null;
  const last = span?.last ?? null;
  return useMemo(() => {
    const from = dayOfIso(first);
    const to = dayOfIso(last);
    const at = dayOfIso(today);
    if (from === null || to === null || at === null) return null;
    const occurrences = occurrencesIn({ ...sources, query: { from, to }, zone, zones });
    return {
      capped: occurrences.capped,
      events: occurrences.shown.map((o): CalendarEventFace =>
        faceOf(o, sources.connections, sources.faceWords),
      ),
      /* The held window moves with the version, as the records do. */
      edge: edgeOf({ from, to }, port.held(), at),
    };
  }, [sources, first, last, today, zone, zones, port]);
}
