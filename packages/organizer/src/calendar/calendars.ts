/**
 * A CONNECTION'S CALENDARS, as its provider lists them and its rows keep them. A listing is asked
 * at most hourly; a new calendar is kept at once and read in the same turn; one the listing no
 * longer names goes only when the next listing does not name it either, so a provider that answers
 * a short list once costs nobody their calendar. Sync never sets which calendar is shown or the
 * default: those are the person's.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { CalendarInfo } from "@ohmail/cal-providers";
import {
  CALENDAR_CHANGES_PER_TRANSACTION, calAlarms, calAttendees, calCalendars, calEvents, calWrites, recordCalendarChanges,
  type CalendarChange, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { CALENDAR_PROVIDER_ID_MAX_BYTES, fitsCalendarBytes } from "@trafficflow/db/calendar";
import { inConnection, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { remember } from "./memory.js";
import { storableKey, storedText } from "./storable.js";
import type { CalendarSyncMemory } from "./types.js";

/** A calendar row as a turn reads it. */
export interface StoredCalendar {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly color: string | null;
  readonly access: string;
  readonly nativeMove: boolean;
  readonly timeZone: string | null;
  readonly syncToken: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly nextPollAt: Date | null;
  readonly errorCode: string | null;
}

export async function storedCalendars(tx: Tx, key: ConnectionKey): Promise<StoredCalendar[]> {
  const rows = await tx.select({
    id: calCalendars.id, providerId: calCalendars.providerId, name: calCalendars.name, color: calCalendars.color,
    access: calCalendars.access, nativeMove: calCalendars.nativeMove, timeZone: calCalendars.timeZone, syncToken: calCalendars.syncToken,
    windowStart: calCalendars.windowStart, windowEnd: calCalendars.windowEnd, nextPollAt: calCalendars.nextPollAt,
    errorCode: calCalendars.errorCode,
  }).from(calCalendars)
    .where(and(eq(calCalendars.accountId, key.accountId), eq(calCalendars.connectionId, key.id)))
    .orderBy(asc(calCalendars.createdAt), asc(calCalendars.id));
  return rows.map((r) => ({
    ...r,
    windowStart: r.windowStart === null ? null : String(r.windowStart),
    windowEnd: r.windowEnd === null ? null : String(r.windowEnd),
  }));
}

/** A text a listing shows, as the store keeps it; none where nothing of it is left. */
const shown = (text: string | null): string | null => (text === null ? null : storedText(text) || null);

/**
 * What a listing names of a calendar, as its row keeps it: the name, the colour and the zone as the
 * store would hand them back, so that the next listing finds them equal and writes nothing.
 */
function rowOf(info: CalendarInfo) {
  return { name: shown(info.name) ?? "", color: shown(info.color), access: info.writable ? (info.owned ? "owner" : "writer") : "reader", nativeMove: info.nativeMove === true, timeZone: shown(info.zone) };
}

export interface ListingContext {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly memory: CalendarSyncMemory;
  readonly halted: () => boolean;
}

/** Keep new and changed calendars. Defer removals until queued writes have had their turn. */
export async function applyListing(
  ctx: ListingContext, listed: readonly CalendarInfo[], stored: readonly StoredCalendar[],
): Promise<{ readonly ok: true; readonly changed: number; readonly missing: readonly string[] } | { readonly ok: false; readonly why: "gone" | "halted" }> {
  // A calendar is found again by its provider's id: one the store cannot hold, for its length or for what is in it, is not kept.
  const usable = listed.filter((c) => fitsCalendarBytes(c.id, CALENDAR_PROVIDER_ID_MAX_BYTES) && storableKey(c.id));
  const named = new Set(usable.map((c) => c.id));
  const byProvider = new Map(stored.map((s) => [s.providerId, s]));
  // A listing that names no calendar at all decides nothing: an empty answer is likelier a provider's fault than a person's wish.
  const missing = usable.length === 0 ? [] : stored.filter((s) => !named.has(s.providerId)).map((s) => s.id);
  let changed = 0;

  for (let at = 0; at < usable.length; at += CALENDAR_CHANGES_PER_TRANSACTION) {
    if (ctx.halted()) return { ok: false, why: "halted" };
    const slice = usable.slice(at, at + CALENDAR_CHANGES_PER_TRANSACTION);
    const kept = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
      const changes: CalendarChange[] = [];
      for (const info of slice) {
        const was = byProvider.get(info.id);
        const now = rowOf(info);
        if (was === undefined) {
          const [made] = await tx.insert(calCalendars).values({
            // No time yet: a calendar nobody has read is due at once, by the same rule as a connection.
            accountId: ctx.key.accountId, connectionId: ctx.key.id, providerId: info.id, ...now, nextPollAt: null,
          }).onConflictDoNothing().returning({ id: calCalendars.id });
          if (made !== undefined) changes.push({ kind: "calendar", id: made.id, op: "create" });
        } else if (was.name !== now.name || was.color !== now.color || was.access !== now.access || was.nativeMove !== now.nativeMove || was.timeZone !== now.timeZone) {
          await tx.update(calCalendars).set({ ...now, updatedAt: sql`now()` })
            .where(and(eq(calCalendars.id, was.id), eq(calCalendars.accountId, ctx.key.accountId)));
          changes.push({ kind: "calendar", id: was.id, op: "update" });
          if (was.access !== now.access) {
            // The feed derives series deletion details from current access. Leaving busy access also restores event details.
            const events = await tx.select({ id: calEvents.id }).from(calEvents).where(and(
              eq(calEvents.accountId, ctx.key.accountId), eq(calEvents.calendarId, was.id),
              was.access === "busy" ? undefined : and(eq(calEvents.recurrenceId, ""), isNotNull(calEvents.repeatRule)),
            ));
            for (const event of events) changes.push({ kind: "calendar_event", id: event.id, op: "update" });
          }
        }
      }
      // Publish access and its event changes together so readers cannot materialize the old scopes.
      for (let i = 0; i < changes.length; i += CALENDAR_CHANGES_PER_TRANSACTION) {
        await recordCalendarChanges(tx as unknown as LedgerTx, ctx.key.accountId, changes.slice(i, i + CALENDAR_CHANGES_PER_TRANSACTION));
      }
      return changes.length;
    });
    if (kept === "gone") return { ok: false, why: "gone" };
    changed += kept;
  }

  return { ok: true, changed, missing };
}

/** A calendar goes only after two listings miss it. */
export async function pruneUnlistedCalendars(
  ctx: ListingContext, missing: readonly string[],
): Promise<{ readonly ok: true; readonly changed: number } | { readonly ok: false; readonly why: "gone" | "halted" }> {
  const missedBefore = ctx.memory.unlisted.get(ctx.key.id) ?? new Set<string>();
  const goes = missing.filter((id) => missedBefore.has(id));
  const missedNow = new Set(missing.filter((id) => !missedBefore.has(id)));
  remember(ctx.memory.unlisted, ctx.key.id, missedNow);
  let changed = 0;
  for (const calendarId of goes) {
    const removed = await removeCalendar(ctx, calendarId);
    if (!removed.ok) return removed;
    changed += removed.changed;
    if (!removed.whole) missedNow.add(calendarId);
  }
  return { ok: true, changed };
}

/**
 * A calendar removed with everything that hangs on it: its events a bound of changes at a time,
 * each with its change, then its owed writes and default reminders, then the row with its own.
 *
 * It takes as many transactions as the events it holds when it begins need, and one more for the
 * row. Events written to it meanwhile are not chased: `whole` is then false, the row stays, and
 * the next listing goes on.
 *
 * Before its first event goes, the calendar forgets where its reading stood: the token and the
 * time of its next reading on its row (bookkeeping, no change recorded), and the reading this
 * process keeps. From there its copy is no longer whole and its row says what a calendar nobody
 * has read says, so whatever cuts the removal short (the worker's stop, its own bound), a calendar
 * that is listed again is read at once from its first page and gets back what was taken.
 */
export async function removeCalendar(
  ctx: ListingContext, calendarId: string,
): Promise<{ readonly ok: true; readonly changed: number; readonly whole: boolean } | { readonly ok: false; readonly why: "gone" | "halted" }> {
  let changed = 0;
  const mine = (t: { accountId: typeof calEvents.accountId; calendarId: typeof calEvents.calendarId }) =>
    and(eq(t.accountId, ctx.key.accountId), eq(t.calendarId, calendarId));
  ctx.memory.readings.delete(calendarId);
  const rounds = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
    await tx.update(calCalendars).set({ syncToken: null, nextPollAt: null })
      .where(and(eq(calCalendars.id, calendarId), eq(calCalendars.accountId, ctx.key.accountId), eq(calCalendars.connectionId, ctx.key.id)));
    const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(calEvents).where(mine(calEvents));
    return Math.ceil(Number(held?.n ?? 0) / CALENDAR_CHANGES_PER_TRANSACTION) + 1;
  });
  if (rounds === "gone") return { ok: false, why: "gone" };
  for (let round = 0; round < rounds; round++) {
    if (ctx.halted()) return { ok: false, why: "halted" };
    const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
      const rows = await tx.select({ id: calEvents.id }).from(calEvents).where(mine(calEvents)).limit(CALENDAR_CHANGES_PER_TRANSACTION);
      const changes: CalendarChange[] = [];
      for (const r of rows) {
        await tx.delete(calAttendees).where(and(eq(calAttendees.accountId, ctx.key.accountId), eq(calAttendees.eventId, r.id)));
        await tx.delete(calAlarms).where(and(eq(calAlarms.accountId, ctx.key.accountId), eq(calAlarms.eventId, r.id)));
        await tx.delete(calEvents).where(and(eq(calEvents.id, r.id), eq(calEvents.accountId, ctx.key.accountId)));
        changes.push({ kind: "calendar_event", id: r.id, op: "delete" });
      }
      if (rows.length === 0) {
        await tx.delete(calWrites).where(and(eq(calWrites.accountId, ctx.key.accountId), eq(calWrites.calendarId, calendarId)));
        await tx.delete(calAlarms).where(and(eq(calAlarms.accountId, ctx.key.accountId), eq(calAlarms.calendarId, calendarId)));
        const gone = await tx.delete(calCalendars)
          .where(and(eq(calCalendars.id, calendarId), eq(calCalendars.accountId, ctx.key.accountId), eq(calCalendars.connectionId, ctx.key.id)))
          .returning({ id: calCalendars.id });
        if (gone.length > 0) changes.push({ kind: "calendar", id: calendarId, op: "delete" });
      }
      if (changes.length > 0) await recordCalendarChanges(tx as unknown as LedgerTx, ctx.key.accountId, changes);
      return { last: rows.length === 0, count: changes.length };
    });
    if (done === "gone") return { ok: false, why: "gone" };
    changed += done.count;
    if (done.last) return { ok: true, changed, whole: true };
  }
  return { ok: true, changed, whole: false };
}
