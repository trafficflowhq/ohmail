/**
 * THE CALENDAR'S PART OF THE ACCOUNT'S EXPORT: what a person configured, to carry elsewhere. One
 * declared map says, for every calendar table, which columns the document carries; every other
 * column is never carried, for the reason the map gives. The builder reads only what the map
 * carries. Events are not carried at all: the provider holds them, as the mailbox holds the mail,
 * so the document counts them and nothing more. No sign-in, token, provider's id, original text
 * or id of ours is ever in it.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import {
  calAlarms, calCalendars, calConnections, calEvents, calSettings, calSuggestions, calWrites,
} from "@trafficflow/db/mail";
import type { CalendarTableName } from "@trafficflow/db/calendar";
import type { Db } from "../context.js";

export type ExportAnswer =
  | { readonly carries: readonly string[]; readonly rest: string }
  | { readonly never: string };

/** Every calendar table, total: the columns carried, and why the others never are. */
export const CALENDAR_EXPORT: Readonly<Record<CalendarTableName, ExportAnswer>> = {
  cal_settings: {
    carries: ["enabled_at", "second_zone", "week_numbers", "day_from_minute", "day_to_minute", "new_events_calendar_id"],
    rest: "the row's own stamps: when it changed is no part of a choice",
  },
  cal_connections: {
    carries: ["provider", "label", "status", "server_url", "source_host", "principal", "mailbox_id"],
    rest: "ids of ours, a refusal word, the provider's list token and the poll's stamps: none is a choice the person made",
  },
  cal_calendars: {
    carries: ["name", "color", "access", "shown", "time_zone"],
    rest: "the provider's id of the calendar (a shared one's is its owner's address, a CalDAV one a path with a user "
      + "name), its sync token and fetch tag, the window read and the poll's stamps",
  },
  cal_alarms: {
    carries: ["minutes_before", "method"],
    rest: "a calendar's own reminders only; an event's reminders go with the event, which the provider holds",
  },
  cal_events: { never: "the provider holds the events, as the mailbox holds the mail: counted, never carried" },
  cal_attendees: { never: "invitees belong to events, which are never carried" },
  cal_writes: { never: "a change owed to the provider, its payload included: counted, never carried" },
  cal_links: { never: "which letters speak of which event: the letters' own words" },
  cal_suggestions: { never: "what a letter seemed to propose, in the letter's words: counted, never carried" },
  cal_credentials: { never: "a sign-in, sealed: never leaves the server, in any form" },
};

export interface CalendarExport {
  enabled: boolean;
  secondZone: string | null;
  weekNumbers: boolean;
  dayFromMinute: number | null;
  dayToMinute: number | null;
  connections: Array<{
    provider: string;
    label: string;
    status: string;
    server: string | null;
    principal: string | null;
    mailbox: string | null;
    calendars: Array<{
      name: string; color: string | null; access: string; shown: boolean; timeZone: string | null;
      /** New events go to this calendar: the settings' one word for it (`cal_settings.new_events_calendar_id`). */
      newEvents: boolean; defaultAlerts: Array<{ minutesBefore: number; method: string }>;
    }>;
  }>;
  notCarried: { events: number; pendingWrites: number; suggestions: number };
}

const countOf = sql<number>`count(*)::int`;

/** The account's calendar as the export carries it, or `null` when it holds none. */
export async function calendarExport(db: Db, accountId: string): Promise<CalendarExport | null> {
  const [s] = await db.select({
    enabledAt: calSettings.enabledAt, secondZone: calSettings.secondZone, weekNumbers: calSettings.weekNumbers,
    dayFromMinute: calSettings.dayFromMinute, dayToMinute: calSettings.dayToMinute, newEventsCalendarId: calSettings.newEventsCalendarId,
  }).from(calSettings).where(eq(calSettings.accountId, accountId));
  const connections = await db.select({
    id: calConnections.id, provider: calConnections.provider, label: calConnections.label, status: calConnections.status,
    serverUrl: calConnections.serverUrl, sourceHost: calConnections.sourceHost, principal: calConnections.principal,
    mailboxId: calConnections.mailboxId,
  }).from(calConnections).where(eq(calConnections.accountId, accountId)).orderBy(asc(calConnections.createdAt), asc(calConnections.id));
  if (s === undefined && connections.length === 0) return null;

  const calendars = connections.length === 0 ? [] : await db.select({
    id: calCalendars.id, connectionId: calCalendars.connectionId, name: calCalendars.name, color: calCalendars.color,
    access: calCalendars.access, shown: calCalendars.shown, timeZone: calCalendars.timeZone,
  }).from(calCalendars).where(eq(calCalendars.accountId, accountId)).orderBy(asc(calCalendars.name), asc(calCalendars.id));
  const alerts = calendars.length === 0 ? [] : await db.select({
    calendarId: calAlarms.calendarId, minutesBefore: calAlarms.minutesBefore, method: calAlarms.method,
  }).from(calAlarms).where(and(eq(calAlarms.accountId, accountId), isNull(calAlarms.eventId)))
    .orderBy(asc(calAlarms.minutesBefore));
  const mailboxIds = connections.map((c) => c.mailboxId).filter((m): m is string => m !== null);
  const addresses = new Map((mailboxIds.length === 0 ? [] : await db.select({ id: mailboxes.id, address: mailboxes.address })
    .from(mailboxes).where(and(eq(mailboxes.accountId, accountId), inArray(mailboxes.id, mailboxIds))))
    .map((m) => [m.id, m.address] as const));
  const [events] = await db.select({ n: countOf }).from(calEvents).where(eq(calEvents.accountId, accountId));
  const [writes] = await db.select({ n: countOf }).from(calWrites)
    .where(and(eq(calWrites.accountId, accountId), eq(calWrites.state, "pending")));
  const [suggestions] = await db.select({ n: countOf }).from(calSuggestions)
    .where(and(eq(calSuggestions.accountId, accountId), eq(calSuggestions.state, "open")));

  return {
    enabled: (s?.enabledAt ?? null) !== null,
    secondZone: s?.secondZone ?? null,
    weekNumbers: s?.weekNumbers ?? false,
    dayFromMinute: s?.dayFromMinute ?? null,
    dayToMinute: s?.dayToMinute ?? null,
    connections: connections.map((c) => ({
      provider: c.provider,
      label: c.label,
      status: c.status,
      server: c.provider === "ics" ? c.sourceHost : c.serverUrl ?? c.sourceHost,
      principal: c.provider === "ics" ? null : c.principal,
      mailbox: c.mailboxId === null ? null : addresses.get(c.mailboxId) ?? null,
      calendars: calendars.filter((k) => k.connectionId === c.id).map((k) => ({
        name: k.name, color: k.color, access: k.access, shown: k.shown, timeZone: k.timeZone,
        newEvents: s?.newEventsCalendarId === k.id,
        defaultAlerts: alerts.filter((a) => a.calendarId === k.id).map((a) => ({ minutesBefore: a.minutesBefore, method: a.method })),
      })),
    })),
    notCarried: { events: events?.n ?? 0, pendingWrites: writes?.n ?? 0, suggestions: suggestions?.n ?? 0 },
  };
}
