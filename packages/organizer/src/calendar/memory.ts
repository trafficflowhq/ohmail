/**
 * The process's memory of the calendar's passes: open readings, failure counts, when each
 * connection was last listed. Bounded, and never the only copy of anything: a reading lost here is
 * read again from the token its calendar row keeps.
 *
 * The bound on kept readings is held by not taking another in, never by giving up one that is
 * being read: nine long readings at once would otherwise end none of them. A place is given up
 * only by a reading nobody turns any more, and what says so is the roster, never the time since
 * its last turn: a lane with much to read turns each connection rarely, and reads them all.
 */
import type { CalendarSyncMemory, OpenReading } from "./types.js";
import { MAX_OPEN_READINGS } from "./words.js";

/** Entries a map of counts or times keeps before its oldest goes. */
const MAX_REMEMBERED = 10_000;

export function newCalendarSyncMemory(): CalendarSyncMemory {
  return {
    bearers: { grants: new Map(), refreshing: new Map() },
    readings: new Map(), failures: new Map(), listedAt: new Map(), unlisted: new Map(),
    forcedAt: new Map(), massDrop: new Map(), crowded: new Map(), exchangeLookups: new Map(), exchangeScannedAt: new Map(),
  };
}

/** Is there a place to keep one more reading from this turn to the next? */
export function hasPlace(memory: CalendarSyncMemory): boolean {
  return memory.readings.size < MAX_OPEN_READINGS;
}

/**
 * Keep `reading` for `calendarId` from this turn to the next. `false`: every place is taken, and
 * none of the readings that hold one is given up for this one.
 */
export function keepReading(memory: CalendarSyncMemory, calendarId: string, reading: OpenReading): boolean {
  if (!memory.readings.has(calendarId) && !hasPlace(memory)) return false;
  memory.readings.set(calendarId, reading);
  return true;
}

/** The connections whose readings hold a place, each once. */
export function connectionsKept(memory: CalendarSyncMemory): string[] {
  return [...new Set([...memory.readings.values()].map((r) => r.connectionId))];
}

/** The kept readings of one connection, given up: a connection that waits holds no place. */
export function releaseReadings(memory: CalendarSyncMemory, connectionId: string): void {
  for (const [calendarId, reading] of memory.readings) {
    if (reading.connectionId === connectionId) memory.readings.delete(calendarId);
  }
}

/** The kept readings of every connection that is not among `read`, given up: nobody goes on with them. */
export function releaseAllBut(memory: CalendarSyncMemory, read: ReadonlySet<string>): void {
  for (const [calendarId, reading] of memory.readings) {
    if (!read.has(reading.connectionId)) memory.readings.delete(calendarId);
  }
}

/** Remember a value under a key, the oldest key forgotten past the bound. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
