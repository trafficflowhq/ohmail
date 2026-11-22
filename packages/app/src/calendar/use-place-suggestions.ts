import { useId, useMemo, useRef } from "react";
import type { CalendarRecord } from "@ohmail/app-logic/calendar";
import { suggestionStore, useSuggestions, type SuggestionRow } from "@ohmail/ui/base";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";

const MAPS = "https://www.openstreetmap.org/search";
export const PLACE_CREDIT = "https://www.openstreetmap.org/copyright";

interface PlaceRow extends SuggestionRow {
  readonly value: string;
  readonly credit?: "osm";
  readonly source: object;
}

export function usePlaceSuggestions(place: string | null, onText: (place: string) => void) {
  const { host } = useFrame();
  const { engine } = host;
  const locale = useLocale();
  const t = useText("calendar");
  const id = useId();
  const anchor = useRef<HTMLInputElement>(null);
  const source = useMemo(() => ({ engine, locale, store: suggestionStore<PlaceRow>() }), [engine, locale]);
  const suggestions = useSuggestions<PlaceRow>({
    id,
    text: place ?? "",
    onText,
    free: true,
    store: source.store,
    own: (typed) => {
      const port = host.wires.calendar;
      if (port === NONE) return [];
      const readable = new Set(
        engine.store
          .entries<CalendarRecord>("calendar")
          .flatMap(({ entity }) => (entity?.shown && entity.access !== "busy" ? [entity.id] : [])),
      );
      const places = new Set<string>();
      const query = typed.trim().toLocaleLowerCase(locale);
      for (const { record } of port.events()) {
        const name = record.place?.trim();
        if (
          name &&
          !record.heldBack &&
          readable.has(record.calendarId) &&
          name.toLocaleLowerCase(locale).includes(query)
        )
          places.add(name);
      }
      return [
        {
          head: t("location.own"),
          rows: [...places]
            .slice(0, 6)
            .map((value) => ({ id: `held:${value}`, primary: value, value, source })),
        },
      ];
    },
    ask: async (text, signal) => {
      const answer = await engine.suggestPlaces?.({ text, lang: locale }, { signal });
      if (signal.aborted || answer?.state !== "ok") return [];
      return [
        {
          rows: answer.places.map(({ first, second }, index) => ({
            id: `result:${index}:${first}`,
            primary: first,
            secondary: second,
            value: [first, second].filter(Boolean).join(", "),
            credit: answer.credit ?? undefined,
            source,
          })),
        },
      ];
    },
    onTake: (row) => {
      if (row.source === source) onText(row.value);
    },
  });
  const groups = suggestions.list.groups.map((group) => ({
    ...group,
    rows: group.rows.filter((row) => row.source === source),
  }));
  return {
    field: suggestions.field,
    list: { ...suggestions.list, groups, anchor },
    anchor,
    credit: groups.some((group) => group.rows.some((row) => row.credit === "osm")),
  };
}

export function useMaps(place: string | null) {
  const open = useFrame().host.device.openLink;
  const t = useText("calendar");
  if (open === NONE || !place?.trim()) return undefined;
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
