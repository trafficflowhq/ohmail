import { useMemo } from "react";
import { isoOfDay, nowIn, readerZones } from "@ohmail/app-logic/calendar";
import { useSharedCalendarSettings } from "../calsettings/settings-read.js";
import { findCalendarEvents } from "../calsearch/find.js";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import type { SearchBeside } from "../search/beside.js";
import { useTimeZone } from "../text/index.js";
import { calendarSearchSpan, useFaces, useNow, useSources } from "./where.js";

/** Mail Search reads the same local occurrences as Calendar Search. */
export function useCalendarMatches(): SearchBeside["events"] {
  const { host, commands } = useFrame();
  const enabled = typeof useSharedCalendarSettings()?.said?.enabledAt === "string";
  const port = enabled ? host.wires.calendar : NONE;
  const zone = useTimeZone();
  const zones = readerZones();
  const now = nowIn(useNow(port !== NONE), zone, zones);
  const today = now === null ? null : isoOfDay(now.day);
  const sources = useSources(port);
  const span =
    port === NONE || today === null ? null : calendarSearchSpan(today, port.held().window.daysBack);
  const faces = useFaces(port, sources, span, today, zone, zones);

  return useMemo(() => {
    if (faces === null || today === null) return NONE;
    return (text: string) => {
      const count = findCalendarEvents(text, faces.events, today, zone, zones).hits.length;
      return count === 0
        ? null
        : {
            count,
            open: () => commands.go({ place: "calsearch", words: { q: text } }),
          };
    };
  }, [commands, faces, today, zone, zones]);
}
