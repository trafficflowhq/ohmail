/**
 * THE CALENDAR ACCOUNTS AS SETTINGS SHOWS THEM: each connection with its calendars and the one state a person reads,
 * worked out from the mirror's records on every version and kept by nobody.
 */
import type { CalendarConnectionRecord, CalendarRecord, CalendarSyncFault } from "@ohmail/wire";
import { viewOnlyOf } from "../offers.js";
import type { CalendarWay } from "./port.js";

/** `inStep`: read as it should be. `signedOut`: only a new sign-in brings it back. `failing`: its last reading failed. */
export type AccountState = "inStep" | "signedOut" | "failing" | "removing";

export interface CalendarAccount {
  readonly connection: CalendarConnectionRecord;
  readonly way: CalendarWay;
  readonly state: AccountState;
  /** Why its last reading failed, where it did. */
  readonly fault: CalendarSyncFault | null;
  readonly calendars: readonly CalendarRecord[];
}

/** iCloud is a CalDAV server our server knows by its host. */
const ICLOUD = /(^|\.)icloud\.com$/i;

export function wayOfConnection(c: CalendarConnectionRecord): CalendarWay {
  if (c.provider === "caldav" && c.serverHost !== null && ICLOUD.test(c.serverHost)) return "icloud";
  return c.provider;
}

function stateOf(c: CalendarConnectionRecord): AccountState {
  if (c.status === "removing") return "removing";
  if (c.status === "reconnect") return "signedOut";
  return c.status === "failing" || c.errorCode !== null ? "failing" : "inStep";
}

/** Every connection, oldest first, with its own calendars in the order the mirror holds them. */
export function accountsOf(
  connections: readonly CalendarConnectionRecord[],
  calendars: readonly CalendarRecord[],
): readonly CalendarAccount[] {
  return [...connections]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
    .map((connection) => ({
      connection,
      way: wayOfConnection(connection),
      state: stateOf(connection),
      fault: connection.errorCode,
      calendars: calendars.filter((k) => k.connectionId === connection.id),
    }));
}

/** The calendars new events may go to: neither looked at only nor behind a connection that waits. */
export function writableOf(
  calendars: readonly CalendarRecord[],
  connections: readonly CalendarConnectionRecord[],
): readonly CalendarRecord[] {
  const byId = new Map(connections.map((c) => [c.id, c] as const));
  return calendars.filter((k) => !viewOnlyOf(k, byId.get(k.connectionId)));
}

/** Where a new event goes: the chosen calendar while it can be written, else the first one that can, else none. */
export function newEventsCalendarOf(
  chosen: string | null,
  writable: readonly CalendarRecord[],
): CalendarRecord | null {
  return writable.find((k) => k.id === chosen) ?? writable[0] ?? null;
}
