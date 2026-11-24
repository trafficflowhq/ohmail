/**
 * THE CALENDAR'S BUILDERS FOR THE SYNC FEED, one per record kind (`port.ts` hands them to the
 * feed's reader). `BUILDERS` is a mapped type over `CalendarRecordKind`: a kind without its
 * builder does not compile. Every read names the account in the same statement; a record carries
 * no sign-in, token, provider id, version tag or original text, by construction of the selects.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { calAlarms, calAttendees, calCalendars, calConnections, calEvents, calSettings, calSuggestions } from "@trafficflow/db/mail";
import { asCalendarSyncFault, isCalendarConnectionStatus } from "@trafficflow/db/calendar";
import type {
  CalendarAccess, CalendarAlarm, CalendarAlarmMethod, CalendarAnswer, CalendarConnectionRecord, CalendarEventRecord,
  CalendarEventStatus, CalendarInvitee, CalendarInviteeRole, CalendarProvider, CalendarRecord, CalendarRecordKind,
  CalendarRecords, CalendarSuggestionRecord, CalendarTime,
} from "@ohmail/wire";
import type { Db } from "../context.js";
import { CALENDAR_EVENT_MAX_BYTES } from "../sync-page-byte-budget.js";
import { changedSeriesAudience } from "@trafficflow/db/calendar";
import { proofPlaceOf, PROVEN_REPEATS, repeatDeleteScopes, repeatShapesForDraft, type RepeatShape } from "@ohmail/cal-providers/repeat-shapes";
import { eventTimeOf, parseRRule } from "@ohmail/cal-core";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { personalSeriesOf, cloudDeleteMembers, seriesDeleteMembers, storedObjectFacts } from "@ohmail/cal-providers/series";
import { availabilityOf, zoneForAvailability } from "./availability.js";
import { writeMarksOf } from "./write-marks.js";

type Builders = {
  [K in CalendarRecordKind]: (db: Db, accountId: string, ids: readonly string[]) => Promise<Map<string, CalendarRecords[K]>>;
};

const ZONES = intlZones();

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const word = <T extends string>(allowed: readonly T[], fallback: T) => (v: string | null): T =>
  (v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);

const accessOf = word<CalendarAccess>(["owner", "writer", "reader", "busy"], "reader");
const statusOf = word<CalendarEventStatus>(["confirmed", "tentative", "cancelled"], "confirmed");
const answerOf = word<CalendarAnswer>(["none", "accepted", "declined", "tentative", "delegated"], "none");
const roleOf = word<CalendarInviteeRole>(["chair", "required", "optional", "info"], "required");
const methodOf = word<CalendarAlarmMethod>(["notice", "mail"], "notice");

/** The host of a CalDAV server's address, lower case; nothing of its path. */
function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function time(kind: string, value: string, zone: string | null): CalendarTime {
  return zone === null ? { kind: kind as CalendarTime["kind"], value } : { kind: kind as CalendarTime["kind"], value, zone };
}

const times = (v: unknown): CalendarTime[] => (Array.isArray(v) ? (v as CalendarTime[]) : []);

const PERSONAL_SERIES_SHAPES: readonly RepeatShape[] = [
  "daily/never", "daily/until", "daily/count", "weekly/never", "weekly/until", "weekly/count",
];

function canEditPersonalSeries(provider: string, serverUrl: string | null): boolean {
  if (provider !== "caldav") return false;
  const place = proofPlaceOf(provider, serverUrl);
  const proven = place && PROVEN_REPEATS[place];
  return !!proven && PERSONAL_SERIES_SHAPES.every((shape) => proven.includes(shape));
}

function repeatCapability(provider: CalendarProvider, serverUrl: string | null, sourceHost: string | null) {
  // The managed desktop copy carries the host, while the connection URL stays on its server.
  const place = proofPlaceOf(provider, serverUrl) ?? (sourceHost ? `caldav:${sourceHost}` : null);
  const shapes = repeatShapesForDraft(place);
  return shapes.length ? { repeatShapes: shapes } : {};
}

async function buildConnections(db: Db, accountId: string, ids: readonly string[]): Promise<Map<string, CalendarConnectionRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    id: calConnections.id, provider: calConnections.provider, label: calConnections.label, status: calConnections.status,
    errorCode: calConnections.errorCode, mailboxId: calConnections.mailboxId, serverUrl: calConnections.serverUrl,
    sourceHost: calConnections.sourceHost, consentedAt: calConnections.consentedAt, lastSyncedAt: calConnections.lastSyncedAt,
    nextPollAt: calConnections.nextPollAt, createdAt: calConnections.createdAt, updatedAt: calConnections.updatedAt,
  }).from(calConnections).where(and(eq(calConnections.accountId, accountId), inArray(calConnections.id, [...ids])));
  return new Map(rows.map((r) => [r.id, {
    id: r.id,
    provider: r.provider as CalendarProvider,
    label: r.label,
    status: isCalendarConnectionStatus(r.status) ? r.status : "failing",
    errorCode: r.errorCode === null ? null : asCalendarSyncFault(r.errorCode),
    grantMailboxId: r.mailboxId,
    ...repeatCapability(r.provider as CalendarProvider, r.serverUrl, r.sourceHost),
    // A subscription's host is kept apart from its sealed address; a CalDAV server's is read off its
    // address, or kept beside it where only the host is held (a desktop's copy).
    serverHost: r.provider === "ics" || r.provider === "caldav" ? (r.sourceHost ?? hostOf(r.serverUrl)) : null,
    consentedAt: iso(r.consentedAt),
    lastSyncedAt: iso(r.lastSyncedAt),
    nextPollAt: iso(r.nextPollAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }]));
}

async function alarmsBy(db: Db, accountId: string, column: "eventId" | "calendarId", ids: readonly string[]): Promise<Map<string, CalendarAlarm[]>> {
  const out = new Map<string, CalendarAlarm[]>();
  if (ids.length === 0) return out;
  const owner = column === "eventId" ? calAlarms.eventId : calAlarms.calendarId;
  const rows = await db.select({ owner, minutesBefore: calAlarms.minutesBefore, method: calAlarms.method })
    .from(calAlarms)
    .where(and(
      eq(calAlarms.accountId, accountId), inArray(owner, [...ids]),
      // A calendar's own reminders name no event.
      ...(column === "calendarId" ? [isNull(calAlarms.eventId)] : []),
    ))
    .orderBy(calAlarms.minutesBefore, calAlarms.id);
  for (const r of rows) {
    if (r.owner === null) continue;
    const list = out.get(r.owner) ?? [];
    list.push({ minutesBefore: r.minutesBefore, method: methodOf(r.method) });
    out.set(r.owner, list);
  }
  return out;
}

async function buildCalendars(db: Db, accountId: string, ids: readonly string[]): Promise<Map<string, CalendarRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    id: calCalendars.id, connectionId: calCalendars.connectionId, name: calCalendars.name, color: calCalendars.color,
    access: calCalendars.access, nativeMove: calCalendars.nativeMove, shown: calCalendars.shown, timeZone: calCalendars.timeZone, availabilityKey: calCalendars.availabilityKey,
    windowStart: calCalendars.windowStart, windowEnd: calCalendars.windowEnd, lastSyncedAt: calCalendars.lastSyncedAt,
    errorCode: calCalendars.errorCode, updatedAt: calCalendars.updatedAt,
  }).from(calCalendars).where(and(eq(calCalendars.accountId, accountId), inArray(calCalendars.id, [...ids])));
  const alarms = await alarmsBy(db, accountId, "calendarId", rows.map((r) => r.id));
  return new Map(rows.map((r) => [r.id, {
    id: r.id,
    connectionId: r.connectionId,
    name: r.name,
    color: r.color,
    access: accessOf(r.access),
    ...(r.nativeMove && { nativeMove: true as const }),
    shown: r.shown,
    timeZone: r.access === "busy" && r.timeZone !== null ? zoneForAvailability(r.timeZone, r.availabilityKey) : r.timeZone,
    window: r.windowStart !== null && r.windowEnd !== null ? { from: String(r.windowStart), to: String(r.windowEnd) } : null,
    defaultAlarms: alarms.get(r.id) ?? [],
    lastSyncedAt: iso(r.lastSyncedAt),
    errorCode: r.errorCode === null ? null : asCalendarSyncFault(r.errorCode),
    updatedAt: r.updatedAt.toISOString(),
  }]));
}

/**
 * An event record past {@link CALENDAR_EVENT_MAX_BYTES}: times, repeat and title whole, the
 * stranger's text left out, and each waiting write's act with it (the mark stays: what waits and why).
 */
export function cutToFit(record: CalendarEventRecord): CalendarEventRecord {
  if (Buffer.byteLength(JSON.stringify(record), "utf8") <= CALENDAR_EVENT_MAX_BYTES) return record;
  const details = { ...record };
  delete details.deleteMembers;
  delete details.deleteScopes;
  if (
    (record.deleteMembers !== undefined || record.deleteScopes !== undefined) &&
    Buffer.byteLength(JSON.stringify(details), "utf8") <= CALENDAR_EVENT_MAX_BYTES
  ) return details;
  return { ...details, notes: null, invitees: [], writes: details.writes.map((w) => ({ ...w, act: null })), cut: true };
}

async function buildEvents(db: Db, accountId: string, ids: readonly string[]): Promise<Map<string, CalendarEventRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    access: calCalendars.access, availabilityKey: calCalendars.availabilityKey, id: calEvents.id, calendarId: calEvents.calendarId, uid: calEvents.uid, recurrenceId: calEvents.recurrenceId,
    thisAndFuture: calEvents.thisAndFuture, sequence: calEvents.sequence, status: calEvents.status, title: calEvents.title,
    notes: calEvents.notes, place: calEvents.place, callLink: calEvents.callLink,
    startKind: calEvents.startKind, startLocal: calEvents.startLocal, startZone: calEvents.startZone,
    endKind: calEvents.endKind, endLocal: calEvents.endLocal, endZone: calEvents.endZone, duration: calEvents.duration,
    startsAt: calEvents.startsAt, endsAt: calEvents.endsAt, occurrenceAt: calEvents.occurrenceAt,
    repeatRule: calEvents.repeatRule, excludedDates: calEvents.excludedDates, addedDates: calEvents.addedDates,
    busy: calEvents.busy, private: calEvents.private, organizer: calEvents.organizer, organizerName: calEvents.organizerName,
    myAnswer: calEvents.myAnswer, portableCopy: calEvents.portableCopy, removedOccurrences: calEvents.removedOccurrences, heldBack: calEvents.heldBack, updatedAt: calEvents.updatedAt,
  }).from(calEvents)
    .innerJoin(calCalendars, and(eq(calCalendars.id, calEvents.calendarId), eq(calCalendars.accountId, accountId)))
    .where(and(eq(calEvents.accountId, accountId), inArray(calEvents.id, [...ids])));
  const detailed = rows.filter((r) => r.access !== "busy");
  const candidates = detailed.filter((r) => (r.access === "owner" || r.access === "writer") && !r.heldBack && r.recurrenceId === "" && r.repeatRule).map((r) => r.id);
  const sources = candidates.length === 0 ? [] : await db.select({
    id: calEvents.id, original: calEvents.original, provider: calConnections.provider, partial: calEvents.partial,
    hasOverrides: sql<boolean>`exists (
      select 1 from cal_events as changed
      where changed.account_id = ${calEvents.accountId} and changed.calendar_id = ${calEvents.calendarId}
        and changed.uid = ${calEvents.uid} and changed.recurrence_id <> ''
    )`,
    serverUrl: calConnections.serverUrl, principal: calConnections.principal, organizer: calEvents.organizer,
  }).from(calEvents)
    .innerJoin(calCalendars, and(eq(calEvents.calendarId, calCalendars.id), eq(calCalendars.accountId, accountId)))
    .innerJoin(calConnections, and(eq(calCalendars.connectionId, calConnections.id), eq(calConnections.accountId, accountId)))
    .where(and(eq(calEvents.accountId, accountId), inArray(calEvents.id, candidates)));
  const editable = new Set(sources.filter((r) => canEditPersonalSeries(r.provider, r.serverUrl) && personalSeriesOf(r.original)).map((r) => r.id));
  const organized = new Set(sources.filter((r) =>
    (r.provider === "caldav" || r.provider === "google" || r.provider === "microsoft") &&
    r.organizer?.trim() && r.organizer.trim().toLowerCase() === r.principal?.trim().toLowerCase().replace(/^mailto:/, ""),
  ).map((r) => r.id));
  const mayDeleteCloudSeries = (row: (typeof rows)[number]) =>
    organized.has(row.id) || (row.access === "writer" && row.myAnswer === null);
  const deletion = new Map(sources.flatMap((source) => {
    if (source.provider !== "caldav") return [];
    const members = seriesDeleteMembers(source.original, ZONES);
    return members && !storedObjectFacts(source.original, null).excludesByRule
      ? [[source.id, { members, place: proofPlaceOf("caldav", source.serverUrl) }] as const] : [];
  }));
  const found = detailed.map((r) => r.id);
  const alarms = await alarmsBy(db, accountId, "eventId", found);
  const marks = await writeMarksOf(db, accountId, found);
  const invitees = new Map<string, CalendarInvitee[]>();
  if (found.length > 0) {
    const people = await db.select({
      eventId: calAttendees.eventId, address: calAttendees.address, name: calAttendees.name,
      role: calAttendees.role, answer: calAttendees.answer,
    }).from(calAttendees)
      .where(and(eq(calAttendees.accountId, accountId), inArray(calAttendees.eventId, found)))
      .orderBy(calAttendees.address);
    for (const p of people) {
      const list = invitees.get(p.eventId) ?? [];
      list.push({ address: p.address, name: p.name, role: roleOf(p.role), answer: answerOf(p.answer) });
      invitees.set(p.eventId, list);
    }
  }
  const sourcesById = new Map(sources.map((item) => [item.id, item] as const));
  const records = new Map<string, CalendarEventRecord>();
  const changed = new Map<string, Awaited<ReturnType<typeof changedSeriesAudience>>>();
  for (const row of detailed) {
    const source = sourcesById.get(row.id);
    if (source?.hasOverrides && !source.partial && mayDeleteCloudSeries(row) && (source.provider === "google" || source.provider === "microsoft")) {
      changed.set(row.id, await changedSeriesAudience(db, accountId, row));
    }
  }
  for (const r of rows) {
    const rules = r.repeatRule === null ? [] : r.repeatRule.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const excluded = times(r.excludedDates);
    const added = times(r.addedDates);
    const provider = sourcesById.get(r.id);
    const cloud = provider && (provider.provider === "google" || provider.provider === "microsoft") ? provider.provider : null;
    const unchangedCloudSeries = cloud && provider && mayDeleteCloudSeries(r) && !provider.partial && !provider.hasOverrides && !excluded.length
      ? cloudDeleteMembers(cloud, {
        organizer: r.organizer, deleteGuests: invitees.get(r.id) ?? [], unchangedSeries: true,
      }, true, { kind: "record" }) : null;
    const changedDays = changed.get(r.id);
    const cloudMaster = cloud && changedDays && cloudDeleteMembers(cloud, {
      organizer: r.organizer, deleteGuests: invitees.get(r.id) ?? [], unchangedSeries: true,
    }, true, { kind: "record" });
    const source = deletion.get(r.id) ?? (unchangedCloudSeries && cloud
      ? { members: unchangedCloudSeries, place: cloud }
      : cloudMaster && changedDays && cloud
        ? { members: [...cloudMaster, ...changedDays.members], place: cloud }
        : null);
    const start = time(r.startKind, r.startLocal, r.startZone);
    const first = eventTimeOf(start);
    const rule = rules.length === 1 && !added.length ? parseRRule(rules[0]!) : null;
    const deleteScopes = source && rule && first
      ? repeatDeleteScopes(source.place, rule, first, ZONES, Date.now()).filter((scope) => !changedDays || scope === "record") : [];
    const record: CalendarEventRecord = {
      id: r.id,
      calendarId: r.calendarId,
      uid: r.uid,
      recurrenceId: r.recurrenceId,
      thisAndFuture: r.thisAndFuture,
      sequence: r.sequence,
      status: statusOf(r.status),
      title: r.title,
      notes: r.notes,
      place: r.place,
      callLink: r.callLink,
      start,
      end: r.endKind === null || r.endLocal === null ? null : time(r.endKind, r.endLocal, r.endZone),
      duration: r.duration,
      startsAt: r.startsAt.toISOString(),
      endsAt: iso(r.endsAt),
      occurrenceAt: iso(r.occurrenceAt),
      repeat: rules.length > 0 || excluded.length > 0 || added.length > 0 ? { rules, excluded, added } : null,
      ...((organized.has(r.id) || (editable.has(r.id) && !invitees.has(r.id) && r.myAnswer === null)) &&
        { personalSeries: true as const }),
      ...(source && { deleteMembers: source.members, ...(deleteScopes.length > 0 && { deleteScopes }) }),
      busy: r.busy,
      private: r.private,
      organizer: r.organizer === null ? null : { address: r.organizer, name: r.organizerName },
      myAnswer: r.myAnswer === null ? null : answerOf(r.myAnswer),
      ...(r.removedOccurrences?.length && { removedOccurrences: r.removedOccurrences }),
      heldBack: r.heldBack,
      invitees: invitees.get(r.id) ?? [],
      alarms: alarms.get(r.id) ?? [],
      cut: false,
      ...(r.portableCopy && { portableCopy: true as const }),
      writes: marks.get(r.id) ?? [],
      updatedAt: r.updatedAt.toISOString(),
    };
    const visible = r.access === "busy" ? availabilityOf(record, r.availabilityKey) : record;
    if (visible) records.set(r.id, cutToFit(visible));
  }
  return records;
}

async function buildSuggestions(db: Db, accountId: string, ids: readonly string[]): Promise<Map<string, CalendarSuggestionRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    id: calSuggestions.id, messageId: calSuggestions.messageId, mailboxId: calSuggestions.mailboxId,
    evidence: calSuggestions.evidence, proposed: calSuggestions.proposed, sourceWords: calSuggestions.sourceWords,
    createdAt: calSuggestions.createdAt,
  }).from(calSuggestions).where(and(
    eq(calSuggestions.accountId, accountId), inArray(calSuggestions.id, [...ids]),
    // A decided suggestion is no longer served: it drains as its own deletion.
    eq(calSuggestions.state, "open"),
  ));
  return new Map(rows.map((r) => [r.id, {
    id: r.id,
    messageId: r.messageId,
    mailboxId: r.mailboxId,
    evidence: r.evidence,
    proposed: r.proposed as CalendarSuggestionRecord["proposed"],
    sourceWords: r.sourceWords,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.createdAt.toISOString(),
  }]));
}

/** Every calendar kind's builder: refused by the compiler while one is missing. */
export const CALENDAR_BUILDERS: Builders = {
  calendar_connection: buildConnections,
  calendar: buildCalendars,
  calendar_event: buildEvents,
  calendar_suggestion: buildSuggestions,
};

/** When the account switched its calendar on, `null` while it is off or never was. */
export async function calendarEnabledAt(db: Db, accountId: string): Promise<Date | null> {
  const [row] = await db.select({ enabledAt: calSettings.enabledAt }).from(calSettings)
    .where(eq(calSettings.accountId, accountId)).limit(1);
  return row?.enabledAt ?? null;
}
