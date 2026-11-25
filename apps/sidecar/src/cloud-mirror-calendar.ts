/**
 * THE DESKTOP'S COPY OF A CLOUD ACCOUNT'S CALENDAR: one storing case and one removal per record
 * kind, a mapped type over the kinds, so a kind the feed carries without its case here does not
 * compile. `cloud-mirror.ts`'s two default arms hand every calendar change to this file.
 *
 * The copy holds what the record carries and nothing more: no sign-in, no token, no principal, no
 * provider's ids (`provider_id` takes the hosted row's own id), and no links. The writes an event's
 * record carries (owed to the provider, or refused by it) are kept as the record says them, so the
 * copy serves them again; nothing here drains them. A
 * removal takes what hangs on the row first, so the copy's own keys never refuse a page. A child
 * whose parent the copy does not hold is skipped, never a key violation that wedges the page. The
 * account's erasure stamp is read first, as for every row the account owns.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Dialect } from "@trafficflow/db/dialect";
import {
  AccountErasedError, MailboxErasedError, calendarDelta, fenceErased, isCalendarRecordKind, readAccountErasedAt, recordChanges,
  type ChangeInput,
} from "@trafficflow/db";
import {
  CALENDAR_ADDRESS_MAX_BYTES, CALENDAR_OCCURRENCE_KEY_MAX_BYTES, CALENDAR_PROVIDER_ID_MAX_BYTES, CALENDAR_UID_MAX_BYTES,
  fitsCalendarBytes, isWriteUuid, writePayloadOf,
} from "@trafficflow/db/calendar";
import {
  calAlarms, calAttendees, calCalendars, calConnections, calEvents, calSettings, calSuggestions, calWrites,
} from "@trafficflow/db/mail";
import type {
  CalendarConnectionRecord, CalendarEventAct, CalendarEventRecord, CalendarRecord, CalendarRecordKind, CalendarRecords,
  CalendarSuggestionRecord, CalendarWriteMark, SyncChange,
} from "@ohmail/wire";
import type { LocalWorld } from "./identity.js";

type Tx = any;

interface KindStore<K extends CalendarRecordKind> {
  /**
   * `false`: skipped (its parent is not held here), nothing written. Behind the account's erasure
   * stamp, read first: an erased account's copy stores nothing.
   */
  upsert(tx: Tx, dia: Dialect, world: LocalWorld, record: CalendarRecords[K], now: Date): Promise<boolean>;
  remove(tx: Tx, world: LocalWorld, id: string): Promise<boolean>;
}

type CalendarCopy = { [K in CalendarRecordKind]: KindStore<K> };

const asDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

async function held(tx: Tx, table: typeof calConnections | typeof calCalendars, world: LocalWorld, id: string): Promise<boolean> {
  const rows = await tx.select({ id: table.id }).from(table)
    .where(and(eq(table.id, id), eq(table.accountId, world.accountId))).limit(1);
  return rows.length > 0;
}

/** What a write is, by the act its mark carries; a mark cut to fit carries none. */
function opOf(act: CalendarEventAct | null): string {
  switch (act?.kind) {
    case "calendar_event_create": return "create";
    case "calendar_event_delete": return "delete";
    case "calendar_event_move": return "move";
    case "calendar_event_answer": return "answer";
    default: return "update";
  }
}

/** An event's writes as its record says them, as the copy's rows. A mark the copy could not keep as it is (an id no row takes, a key past its length) is left out: never a page wedged for it. */
function marksOf(world: LocalWorld, r: CalendarEventRecord) {
  return r.writes.filter((m: CalendarWriteMark) => isWriteUuid(m.id) && /^[\x21-\x7e]{1,64}$/.test(m.key)).map((m: CalendarWriteMark) => ({
    id: m.id, accountId: world.accountId, calendarId: r.calendarId, eventId: r.id, op: opOf(m.act),
    payload: m.act === null ? {} : writePayloadOf(m.act, null, m.part === null ? null : { of: m.key.replace(/:2$/, ""), n: m.part }),
    idempotencyKey: m.key, state: m.state, refusal: m.reason, createdAt: asDate(m.at) ?? new Date(0), updatedAt: asDate(m.at) ?? new Date(0),
  }));
}

/** An event's own children, then the event. */
async function removeEvents(tx: Tx, world: LocalWorld, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.delete(calWrites).where(and(eq(calWrites.accountId, world.accountId), inArray(calWrites.eventId, [...ids])));
  await tx.delete(calAttendees).where(and(eq(calAttendees.accountId, world.accountId), inArray(calAttendees.eventId, [...ids])));
  await tx.delete(calAlarms).where(and(eq(calAlarms.accountId, world.accountId), inArray(calAlarms.eventId, [...ids])));
  await tx.update(calSuggestions).set({ eventId: null })
    .where(and(eq(calSuggestions.accountId, world.accountId), inArray(calSuggestions.eventId, [...ids])));
  await tx.delete(calEvents).where(and(eq(calEvents.accountId, world.accountId), inArray(calEvents.id, [...ids])));
}

/** A calendar's events and reminders, then the calendar. */
async function removeCalendars(tx: Tx, world: LocalWorld, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const events = await tx.select({ id: calEvents.id }).from(calEvents)
    .where(and(eq(calEvents.accountId, world.accountId), inArray(calEvents.calendarId, [...ids])));
  await removeEvents(tx, world, events.map((e: { id: string }) => e.id));
  await tx.delete(calWrites).where(and(eq(calWrites.accountId, world.accountId), inArray(calWrites.calendarId, [...ids])));
  await tx.delete(calAlarms).where(and(eq(calAlarms.accountId, world.accountId), inArray(calAlarms.calendarId, [...ids])));
  await tx.delete(calCalendars).where(and(eq(calCalendars.accountId, world.accountId), inArray(calCalendars.id, [...ids])));
}

const connection: KindStore<"calendar_connection"> = {
  async upsert(tx, dia, world, r: CalendarConnectionRecord, now): Promise<boolean> {
    // One that rides an erased mailbox went with it, whatever a late page still says.
    try {
      await fenceErased(tx, dia, { accountId: world.accountId, mailboxId: r.grantMailboxId ?? undefined });
    } catch (err) {
      if (err instanceof AccountErasedError || err instanceof MailboxErasedError) return false;
      throw err;
    }
    const body = {
      provider: r.provider, label: r.label, status: r.status, errorCode: r.errorCode,
      mailboxId: r.grantMailboxId, sourceHost: r.serverHost,
      consentedAt: asDate(r.consentedAt), lastSyncedAt: asDate(r.lastSyncedAt),
      createdAt: asDate(r.createdAt) ?? now, updatedAt: asDate(r.updatedAt) ?? now,
    };
    await tx.insert(calConnections).values({ id: r.id, accountId: world.accountId, ...body })
      .onConflictDoUpdate({ target: calConnections.id, set: body });
    return true;
  },
  async remove(tx, world, id) {
    const calendars = await tx.select({ id: calCalendars.id }).from(calCalendars)
      .where(and(eq(calCalendars.accountId, world.accountId), eq(calCalendars.connectionId, id)));
    await removeCalendars(tx, world, calendars.map((c: { id: string }) => c.id));
    await tx.delete(calConnections).where(and(eq(calConnections.accountId, world.accountId), eq(calConnections.id, id)));
    return true;
  },
};

const calendar: KindStore<"calendar"> = {
  async upsert(tx, dia, world, r: CalendarRecord, now): Promise<boolean> {
    if (await readAccountErasedAt(tx, dia, world.accountId) != null) return false;
    if (!fitsCalendarBytes(r.id, CALENDAR_PROVIDER_ID_MAX_BYTES)) return false;
    if (!await held(tx, calConnections, world, r.connectionId)) return false;
    const body = {
      connectionId: r.connectionId, providerId: r.id, name: r.name, color: r.color, access: r.access,
      autoSchedule: r.autoSchedule === true, nativeMove: r.nativeMove === true,
      shown: r.shown, timeZone: r.timeZone,
      windowStart: r.window?.from ?? null, windowEnd: r.window?.to ?? null,
      lastSyncedAt: asDate(r.lastSyncedAt), errorCode: r.errorCode, updatedAt: asDate(r.updatedAt) ?? now,
    };
    await tx.insert(calCalendars).values({ id: r.id, accountId: world.accountId, ...body })
      .onConflictDoUpdate({ target: calCalendars.id, set: body });
    await tx.delete(calAlarms).where(and(
      eq(calAlarms.accountId, world.accountId), eq(calAlarms.calendarId, r.id), isNull(calAlarms.eventId),
    ));
    if (r.defaultAlarms.length > 0) {
      await tx.insert(calAlarms).values(r.defaultAlarms.map((a) => ({
        accountId: world.accountId, calendarId: r.id, minutesBefore: a.minutesBefore, method: a.method,
      })));
    }
    return true;
  },
  async remove(tx, world, id) {
    await removeCalendars(tx, world, [id]);
    return true;
  },
};

const event: KindStore<"calendar_event"> = {
  async upsert(tx, dia, world, r: CalendarEventRecord, now): Promise<boolean> {
    if (await readAccountErasedAt(tx, dia, world.accountId) != null) return false;
    // Another party's text, each a key of an index: past its bound the event is not stored.
    if (!fitsCalendarBytes(r.uid, CALENDAR_UID_MAX_BYTES)) return false;
    if (!fitsCalendarBytes(r.recurrenceId, CALENDAR_OCCURRENCE_KEY_MAX_BYTES)) return false;
    if (!fitsCalendarBytes(r.id, CALENDAR_PROVIDER_ID_MAX_BYTES)) return false;
    if (!await held(tx, calCalendars, world, r.calendarId)) return false;
    const body = {
      calendarId: r.calendarId, providerId: r.id, uid: r.uid, recurrenceId: r.recurrenceId,
      thisAndFuture: r.thisAndFuture, sequence: r.sequence, status: r.status, title: r.title, notes: r.notes,
      place: r.place, callLink: r.callLink,
      startKind: r.start.kind, startLocal: r.start.value, startZone: r.start.zone ?? null,
      endKind: r.end?.kind ?? null, endLocal: r.end?.value ?? null, endZone: r.end?.zone ?? null,
      duration: r.duration,
      startsAt: new Date(r.startsAt), endsAt: asDate(r.endsAt), occurrenceAt: asDate(r.occurrenceAt),
      repeatRule: r.repeat !== null && r.repeat.rules.length > 0 ? r.repeat.rules.join("\n") : null,
      excludedDates: r.repeat !== null && r.repeat.excluded.length > 0 ? r.repeat.excluded : null,
      addedDates: r.repeat !== null && r.repeat.added.length > 0 ? r.repeat.added : null,
      busy: r.busy, private: r.private,
      organizer: r.organizer?.address ?? null, organizerName: r.organizer?.name ?? null,
      myAnswer: r.myAnswer, mailAnswer: r.mailAnswer ?? null, heldBack: r.heldBack, partial: r.cut,
      googleDefaultEvent: r.googleDefaultEvent === true, updatedAt: asDate(r.updatedAt) ?? now,
    };
    await tx.insert(calEvents).values({ id: r.id, accountId: world.accountId, ...body })
      .onConflictDoUpdate({ target: calEvents.id, set: body });
    await tx.delete(calAttendees).where(and(eq(calAttendees.accountId, world.accountId), eq(calAttendees.eventId, r.id)));
    const invitees = r.invitees.filter((p) => fitsCalendarBytes(p.address, CALENDAR_ADDRESS_MAX_BYTES));
    if (invitees.length > 0) {
      await tx.insert(calAttendees).values(invitees.map((p) => ({
        accountId: world.accountId, eventId: r.id, address: p.address, name: p.name, role: p.role, answer: p.answer,
      }))).onConflictDoNothing();
    }
    await tx.delete(calAlarms).where(and(eq(calAlarms.accountId, world.accountId), eq(calAlarms.eventId, r.id)));
    if (r.alarms.length > 0) {
      await tx.insert(calAlarms).values(r.alarms.map((a) => ({
        accountId: world.accountId, eventId: r.id, minutesBefore: a.minutesBefore, method: a.method,
      })));
    }
    // The event's writes in place of what the copy held; a record from a server that carries none (an older one) says nothing of them.
    if (Array.isArray(r.writes)) {
      await tx.delete(calWrites).where(and(eq(calWrites.accountId, world.accountId), eq(calWrites.eventId, r.id)));
      const marks = marksOf(world, r);
      if (marks.length > 0) await tx.insert(calWrites).values(marks).onConflictDoNothing();
    }
    return true;
  },
  async remove(tx, world, id) {
    await removeEvents(tx, world, [id]);
    return true;
  },
};

const suggestion: KindStore<"calendar_suggestion"> = {
  async upsert(tx, dia, world, r: CalendarSuggestionRecord, now): Promise<boolean> {
    try {
      await fenceErased(tx, dia, { accountId: world.accountId, mailboxId: r.mailboxId });
    } catch (err) {
      if (err instanceof AccountErasedError || err instanceof MailboxErasedError) return false;
      throw err;
    }
    const body = {
      messageId: r.messageId, mailboxId: r.mailboxId, evidence: r.evidence, proposed: r.proposed,
      sourceWords: r.sourceWords, state: "open", createdAt: asDate(r.createdAt) ?? now,
    };
    await tx.insert(calSuggestions).values({ id: r.id, accountId: world.accountId, ...body })
      .onConflictDoUpdate({ target: calSuggestions.id, set: body });
    return true;
  },
  async remove(tx, world, id) {
    await tx.delete(calSuggestions).where(and(eq(calSuggestions.accountId, world.accountId), eq(calSuggestions.id, id)));
    return true;
  },
};

/** Every calendar kind's storing case and removal: refused by the compiler while one is missing. */
export const CALENDAR_COPY: CalendarCopy = {
  calendar_connection: connection,
  calendar,
  calendar_event: event,
  calendar_suggestion: suggestion,
};

/** One calendar change stored, or `false` when it is no calendar change or the copy skipped it. */
export async function upsertCalendarChange(tx: Tx, dia: Dialect, world: LocalWorld, ch: SyncChange, now: Date): Promise<boolean> {
  if (!isCalendarRecordKind(ch.type) || ch.entity === undefined) return false;
  const store = CALENDAR_COPY[ch.type] as KindStore<CalendarRecordKind>;
  return store.upsert(tx, dia, world, ch.entity as CalendarRecords[CalendarRecordKind], now);
}

/**
 * THE ACCOUNT'S CALENDAR COPY, WHOLE, in the caller's transaction: at sign-out and when the hosted
 * account was erased. The calendar hangs on no mailbox, so the mailbox walk that removes the mail
 * never reaches it. Every record removed is written to the local feed as its own deletion, children
 * first, and the settings row as changed: with the switch's copy gone the feed serves no calendar
 * change, and a mounted window, re-reading its settings, lets the calendar's records go.
 */
export async function wipeCalendarCopy(tx: Tx, accountId: string): Promise<number> {
  const gone = await removeCalendarRows(tx, accountId);
  await tx.delete(calSettings).where(eq(calSettings.accountId, accountId));
  if (gone.length > 0) {
    await recordChanges(tx, [...gone, { accountId, entityType: "settings", entityId: accountId, op: "update", meta: null }]);
  }
  return gone.length;
}

/** Every calendar row of the copy but its settings, children first; answers one deletion per record. */
async function removeCalendarRows(tx: Tx, accountId: string): Promise<ChangeInput[]> {
  const ids = async (table: typeof calEvents | typeof calCalendars | typeof calConnections | typeof calSuggestions) =>
    (await tx.select({ id: table.id }).from(table).where(eq(table.accountId, accountId)) as Array<{ id: string }>).map((r) => r.id);
  const events = await ids(calEvents);
  const calendars = await ids(calCalendars);
  const connections = await ids(calConnections);
  const suggestions = await ids(calSuggestions);
  await tx.delete(calWrites).where(eq(calWrites.accountId, accountId));
  await tx.delete(calAttendees).where(eq(calAttendees.accountId, accountId));
  await tx.delete(calAlarms).where(eq(calAlarms.accountId, accountId));
  await tx.delete(calSuggestions).where(eq(calSuggestions.accountId, accountId));
  await tx.delete(calEvents).where(eq(calEvents.accountId, accountId));
  await tx.delete(calCalendars).where(eq(calCalendars.accountId, accountId));
  await tx.delete(calConnections).where(eq(calConnections.accountId, accountId));
  return [
    ...events.map((id) => calendarDelta(accountId, "calendar_event", id, "delete")),
    ...calendars.map((id) => calendarDelta(accountId, "calendar", id, "delete")),
    ...connections.map((id) => calendarDelta(accountId, "calendar_connection", id, "delete")),
    ...suggestions.map((id) => calendarDelta(accountId, "calendar_suggestion", id, "delete")),
  ];
}

/**
 * THE SWITCH, COPIED: the hosted settings record's `calendarEnabledAt` into this copy's
 * `cal_settings.enabled_at`, which the local feed's gate reads, in the page's transaction. Absent
 * from the record (a server that keeps no calendar) reads as off. Switched off, the copy lets its
 * calendar go, each record as its own deletion: the feed sends none of the changes made while it
 * is off, so what the copy held could only go stale. Switched on again, the pull's settle reads the
 * calendar as it stands (`reconcileCalendarCopy` in `cloud-mirror.ts`). Behind the account's
 * erasure stamp, read here first: an erased account's copy stores no switch, whoever calls.
 */
export async function storeCalendarSwitch(
  tx: Tx, dia: Dialect, accountId: string, enabledAt: string | null | undefined,
): Promise<void> {
  if (await readAccountErasedAt(tx, dia, accountId) != null) return;
  const at = typeof enabledAt === "string" ? new Date(enabledAt) : null;
  const next = at !== null && Number.isFinite(at.getTime()) ? at : null;
  const [row] = await tx.select({ at: calSettings.enabledAt }).from(calSettings)
    .where(eq(calSettings.accountId, accountId)).limit(1) as Array<{ at: Date | null }>;
  if (next !== null) {
    if (row?.at?.getTime() === next.getTime()) return;
    await tx.insert(calSettings).values({ accountId, enabledAt: next, updatedAt: next })
      .onConflictDoUpdate({ target: calSettings.accountId, set: { enabledAt: next } });
    return;
  }
  if (row === undefined || row.at === null) return;
  await tx.update(calSettings).set({ enabledAt: null }).where(eq(calSettings.accountId, accountId));
  const gone = await removeCalendarRows(tx, accountId);
  if (gone.length > 0) await recordChanges(tx, gone);
}

/** One calendar removal applied, or `false` when it is no calendar change. */
export async function removeCalendarChange(tx: Tx, world: LocalWorld, ch: SyncChange): Promise<boolean> {
  if (!isCalendarRecordKind(ch.type)) return false;
  return CALENDAR_COPY[ch.type].remove(tx, world, ch.id);
}
