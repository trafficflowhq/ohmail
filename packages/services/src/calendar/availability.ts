import { createHmac } from "node:crypto";
import {
  eventTimeOf, formatDuration, formatRRule, intlZones, parseDuration, parseRRule, platformZoneName, storedTimeOf,
} from "@ohmail/cal-core";
import type { CalendarEventRecord, CalendarTime } from "@ohmail/wire";

const zones = intlZones();

/** File-defined zones can name a person or a provider. Keep unknown clocks distinct and unresolved on the client. */
export function zoneForAvailability(zone: string, key: string): string {
  const name = platformZoneName(zone);
  if (name !== null && zones.offsetAt(name, 0) !== null) return name;
  return "Unresolved/" + createHmac("sha256", key).update("zone\0").update(zone).digest("hex");
}

function timeForAvailability(raw: CalendarTime | null, key: string): CalendarTime | null {
  if (!raw || typeof raw.value !== "string") return null;
  const parsed = eventTimeOf(raw);
  if (!parsed) return null;
  if (parsed.kind === "zoned") return storedTimeOf({ ...parsed, tzid: zoneForAvailability(parsed.tzid, key) });
  return storedTimeOf(parsed);
}

/** The stored occurrence key is a moment, or an unresolved clock with its zone. */
function occurrenceForAvailability(record: CalendarEventRecord, key: string): string {
  const occurrence = record.recurrenceId;
  if (!occurrence || /^-?\d{1,16}$/.test(occurrence)) return occurrence;
  const wall = /^(.*)\|(\d{8}T\d{4}(?:\d{2})?\|false)$/.exec(occurrence);
  if (wall) return (wall[1] ? zoneForAvailability(wall[1], key) : "") + "|" + wall[2];
  return record.occurrenceAt === null ? "" : String(Date.parse(record.occurrenceAt));
}

/** Only the occupancy projection crosses the wire. Other permissions keep their full event record. */
export function availabilityOf(record: CalendarEventRecord, key: string): CalendarEventRecord | null {
  const series = record.uid ? createHmac("sha256", key).update("series\0").update(record.uid).digest("hex") : record.id;
  const start = timeForAvailability(record.start, key);
  if (!start) return null;
  const repeat = record.repeat && {
    rules: record.repeat.rules.flatMap((value) => {
      const rule = parseRRule(value);
      return rule ? [formatRRule(rule)] : [];
    }),
    excluded: record.repeat.excluded.flatMap((value) => timeForAvailability(value, key) ?? []),
    added: record.repeat.added.flatMap((value) => timeForAvailability(value, key) ?? []),
  };
  const duration = record.duration && parseDuration(record.duration);
  return {
    id: record.id, calendarId: record.calendarId, uid: series, recurrenceId: occurrenceForAvailability(record, key),
    thisAndFuture: record.thisAndFuture, sequence: record.sequence, status: record.status,
    title: "", notes: null, place: null, callLink: null,
    start, end: timeForAvailability(record.end, key), duration: duration ? formatDuration(duration) : null,
    startsAt: record.startsAt, endsAt: record.endsAt, occurrenceAt: record.occurrenceAt, repeat,
    busy: record.busy, private: false, organizer: null, myAnswer: null, heldBack: record.heldBack,
    invitees: [], alarms: [], writes: [], cut: false, updatedAt: record.updatedAt,
  };
}
