/**
 * FROM MAIL ON THIS VERSION: the suggestions the mirror holds, through the one gate, as rows; the calendar Add writes
 * into; and Add itself, one press each, said once our server has answered. Nothing is kept: an event added shows as
 * on the calendar as soon as the mirror holds it.
 */
import { useMemo, useRef, useState } from "react";
import { isoOfDay, nowIn, readerZones, type CalendarPort } from "@ohmail/app-logic/calendar";
import {
  addFound,
  foundOf,
  targetCalendarOf,
  type CalendarSuggestionRecord,
  type FoundRow,
} from "@ohmail/app-logic/calendar/found";
import { useFrame, useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { useCalendarSettings } from "../calsettings/settings-read.js";
import { useSources } from "../calendar/where.js";

export function useFound(port: CalendarPort | typeof NONE) {
  const { host } = useFrame();
  const sources = useSources(port);
  const { said } = useCalendarSettings(port === NONE ? null : port, "none");
  const preferred = said?.newEventsCalendarId ?? null;
  const zone = useTimeZone();
  const zones = readerZones();
  const now = nowIn(Date.now(), zone, zones);
  const today = now === null ? null : isoOfDay(now.day);
  return useMemo(() => {
    if (port === NONE || today === null) return null;
    const suggestions = host.engine.store
      .entries<CalendarSuggestionRecord | null>("calendar_suggestion")
      .map((e) => e.entity)
      .filter((s): s is CalendarSuggestionRecord => s !== null);
    const rows = foundOf({
      suggestions,
      events: sources.events,
      calendars: sources.calendars,
      todayKey: today,
      zone,
      zones,
    });
    const target = targetCalendarOf(sources.calendars, sources.connections, preferred);
    const toneOf = (id: string | null) => (id === null ? null : (sources.tones.get(id) ?? null));
    const onCalendar = (row: FoundRow) =>
      row.alreadyOn === null
        ? null
        : (sources.events.find((e) => e.record.id === row.alreadyOn?.event)?.record.calendarId ?? null);
    return {
      rows,
      pending: rows.filter((row) => row.alreadyOn === null).length,
      today,
      target,
      toneOf,
      onCalendar,
    };
  }, [host.engine, port, sources, preferred, today, zone, zones]);
}

/** The found events whose Add is out, one set a port, shared by the list and the open card. */
const OUT = new WeakMap<CalendarPort, Set<string>>();
function outOf(port: CalendarPort): Set<string> {
  const known = OUT.get(port);
  if (known) return known;
  const made = new Set<string>();
  OUT.set(port, made);
  return made;
}

/**
 * Add, for one row or several, one press after the other into one calendar. Each row is read again from the newest
 * reading before its press: one gone, already on the calendar or being added by another Add is skipped. A refusal is
 * said by its word and stops the rest; what was taken is said once at the end; while a press is owed nothing is said.
 */
export function useAdd(port: CalendarPort, found: ReturnType<typeof useFound>) {
  const t = useText("frommail");
  const e = useText("event");
  const report = useReport();
  const [busy, setBusy] = useState(false);
  /* The newest reading, for the rows after the first press. */
  const latest = useRef(found);
  latest.current = found;
  const add = async (rows: readonly FoundRow[], calendarId: string) => {
    if (busy) return;
    setBusy(true);
    const out = outOf(port);
    let taken = 0;
    try {
      for (const row of rows) {
        const now = latest.current?.rows.find((r) => r.id === row.id);
        if (now === undefined || now.alreadyOn !== null || out.has(row.id)) continue;
        out.add(row.id);
        let heard: Awaited<ReturnType<typeof addFound>>;
        try {
          heard = await addFound(port, now, calendarId);
        } finally {
          out.delete(row.id);
        }
        /* The refusal is the last thing said: a count said after it would replace it. */
        if (heard.verdict?.kind === "refused") return void (heard.say !== null && report(e(heard.say)));
        if (heard.verdict?.kind === "taken") taken += 1;
      }
      if (taken > 1) report(t("addedMany", { count: taken }));
      else if (taken === 1) report(e("taken.create"));
    } finally {
      setBusy(false);
    }
  };
  return { add, busy };
}
