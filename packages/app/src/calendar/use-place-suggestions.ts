import type { PlaceSuggestAnswer } from "@ohmail/wire";
import { createElement, useId, useMemo, useRef, useState } from "react";
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/app-logic/calendar";
import { Icon, suggestionStore, useSuggestions, type SuggestionRow } from "@ohmail/ui/base";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";

import { placeRegion, placeSecondLine } from "./place-region.js";

const MAPS = "https://www.openstreetmap.org/search";
export const PLACE_CREDIT = "https://www.openstreetmap.org/copyright";

interface PlaceRow extends SuggestionRow {
  readonly value: string;
  readonly credit?: "osm";
  readonly source: object;
}

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");
const words = (text: string) =>
  fold(text)
    .split(/[\s,;.\-/()|@·–]+/u)
    .filter(Boolean);
const link = /(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|\bwww\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$))/i;
const noPlace = /^(call|phone|video call|online)$/i;
const physicalPlace = (place: string) => !!place && !link.test(place) && !noPlace.test(place);

function ownPlaces(
  events: readonly { record: CalendarEventRecord }[],
  readable: ReadonlySet<string>,
  typed: string,
  exclude?: string,
) {
  const places = new Map<string, { value: string; count: number; last: string }>();
  const query = words(typed);
  for (const { record } of events) {
    const value = record.place?.trim() ?? "";
    if (
      record.id === exclude ||
      record.status === "cancelled" ||
      record.heldBack ||
      !readable.has(record.calendarId) ||
      !physicalPlace(value) ||
      value === record.callLink?.trim() ||
      !query.every((part) => words(value).some((word) => word.startsWith(part)))
    )
      continue;
    const key = fold(value).replace(/\s+/gu, " ");
    const prior = places.get(key);
    const last = record.startsAt;
    places.set(
      key,
      prior && prior.last >= last
        ? { ...prior, count: prior.count + 1 }
        : { value, last, count: (prior?.count ?? 0) + 1 },
    );
  }
  return [...places.entries()].sort(([, a], [, b]) => b.count - a.count || b.last.localeCompare(a.last));
}

function remoteRows(
  answer: PlaceSuggestAnswer,
  own: readonly PlaceRow[],
  source: { region: ReturnType<typeof placeRegion>; locale: string },
): PlaceRow[] {
  const seen = new Set(own.map(({ value }) => fold(value)));
  return answer.places.flatMap(({ first, second: locality, kind, country }) => {
    const second = placeSecondLine(locality, country, source.region.home, source.locale);
    const value = [first, second].filter(Boolean).join(", ");
    const key = fold(value);
    if (seen.has(key) || seen.has(fold(first)) || !physicalPlace(first)) return [];
    seen.add(key);
    return [
      {
        id: `result:${key}`,
        primary: first,
        secondary: second,
        value,
        credit: answer.credit ?? undefined,
        mark: createElement(Icon, {
          name: kind === "address" ? "house" : kind === "town" ? "town" : "place",
          size: 20,
        }),
        source,
      },
    ];
  });
}

export function usePlaceSuggestions(
  place: string | null,
  onText: (place: string) => void,
  {
    phone,
    exclude,
    zone,
    onTake,
  }: { phone: boolean; exclude?: string; zone?: string | null; onTake?: () => void },
) {
  const { host } = useFrame();
  const { engine } = host;
  const locale = useLocale();
  const t = useText("calendar");
  const deviceZone = useTimeZone();
  const id = useId();
  const anchor = useRef<HTMLInputElement>(null);
  const source = useMemo(
    () => ({
      engine,
      locale,
      region: placeRegion(zone, deviceZone),
      store: suggestionStore<PlaceRow>(),
    }),
    [engine, locale, zone, deviceZone],
  );
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const own = (typed: string) => {
    const port = host.wires.calendar;
    if (port === NONE) return [];
    const readable = new Set(
      engine.store
        .entries<CalendarRecord>("calendar")
        .flatMap(({ entity }) => (entity?.shown && entity.access !== "busy" ? [entity.id] : [])),
    );
    return ownPlaces(port.events(), readable, typed, exclude)
      .slice(0, phone ? (typed.trim() ? 2 : 5) : 3)
      .map(([key, { value }]) => ({
        id: `held:${key}`,
        primary: value,
        value,
        mark: createElement(Icon, { name: "clock", size: 20 }),
        source,
      }));
  };
  const suggestions = useSuggestions<PlaceRow>({
    id,
    text: place ?? "",
    onText: (value) => {
      setUnavailable(null);
      onText(value);
    },
    free: true,
    limit: phone ? 5 : 6,
    store: source.store,
    drop: 3600,
    own: (typed) => [{ head: t("location.own"), rows: own(typed) }],
    ask: async (text, signal) => {
      const question = { text, lang: locale, ...source.region };
      const answer = await engine.suggestPlaces?.(question, { signal });
      if (signal.aborted) return [];
      if (answer?.state !== "ok") {
        if (answer?.state === "failed" || answer?.state === "down" || answer?.state === "offline") {
          setUnavailable(text);
        }
        // A limit or outage is not an answer to this prefix. The next visit may succeed.
        throw new Error("No place suggestions");
      }
      setUnavailable(null);
      return [{ rows: remoteRows(answer, own(text), source) }];
    },
    onTake: (row) => {
      if (row.source !== source) return;
      setUnavailable(null);
      onText(row.value);
      onTake?.();
    },
  });
  const groups = suggestions.list.groups.map((group) => ({
    ...group,
    rows: group.rows.filter((row) => row.source === source),
  }));
  return {
    ...suggestions,
    list: {
      ...suggestions.list,
      groups,
      anchor,
      align: "text" as const,
      span: ".oh-ecard, .oh-qa",
      avoid: ".cal-edit-panel",
    },
    anchor,
    unavailable: unavailable !== null && unavailable === place?.trim(),
    credit: groups.some((group) => group.rows.some((row) => row.credit === "osm")),
  };
}

export function useMaps(place: string | null) {
  const open = useFrame().host.device.openLink;
  const t = useText("calendar");
  if (open === NONE || !place || !physicalPlace(place.trim())) return undefined;
  return {
    label: t("location.maps"),
    title: t("location.mapsTitle"),
    onPress: () => {
      const target = new URL(MAPS);
      target.searchParams.set("query", place.trim());
      open(target.href);
    },
  };
}
