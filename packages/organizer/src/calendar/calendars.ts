/**
 * A CONNECTION'S CALENDARS, as its provider lists them and its rows keep them. A listing is asked
 * at most hourly; a new calendar is kept at once and read in the same turn; one the listing no
 * longer names goes only when the next listing does not name it either, so a provider that answers
 * a short list once costs nobody their calendar. Sync never sets which calendar is shown or the
 * default: those are the person's.
 *
 * A calendar is found again by its key (the providers' `calendarKey`): for CalDAV the place of the
 * collection whichever of the server's hosts lists it. A row keeps the id it was stored under. Two
 * rows of one key (stored before calendars were known so) are one calendar: the listing keeps the
 * one that holds the person's choices and copy, and the others go once the writes owed have had
 * their turn.
 */
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { CalendarInfo } from "@ohmail/cal-providers";
import {
  CALENDAR_CHANGES_PER_TRANSACTION, calAlarms, calAttendees, calCalendars, calEvents, calSettings, calWrites, recordCalendarChanges,
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
  readonly autoSchedule: boolean;
  readonly timeZone: string | null;
  readonly syncToken: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly nextPollAt: Date | null;
  readonly errorCode: string | null;
  /** When a reading of it last wrote; null until its first reading has ended. */
  readonly lastSyncedAt: Date | null;
}

export async function storedCalendars(tx: Tx, key: ConnectionKey): Promise<StoredCalendar[]> {
  const rows = await tx.select({
    id: calCalendars.id, providerId: calCalendars.providerId, name: calCalendars.name, color: calCalendars.color,
    access: calCalendars.access, nativeMove: calCalendars.nativeMove, autoSchedule: calCalendars.autoSchedule, timeZone: calCalendars.timeZone, syncToken: calCalendars.syncToken,
    windowStart: calCalendars.windowStart, windowEnd: calCalendars.windowEnd, nextPollAt: calCalendars.nextPollAt,
    errorCode: calCalendars.errorCode, lastSyncedAt: calCalendars.lastSyncedAt,
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
  return {
    name: shown(info.name) ?? "", color: shown(info.color),
    access: info.writable ? (info.owned ? "owner" : "writer") : "reader",
    nativeMove: info.nativeMove === null ? undefined : info.nativeMove === true,
    autoSchedule: info.autoSchedule === null ? undefined : info.autoSchedule === true,
    timeZone: shown(info.zone),
  };
}

export interface ListingContext {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly memory: CalendarSyncMemory;
  readonly halted: () => boolean;
}

/** Writes a calendar still owes: waiting to be sent, or refused and shown to the person. Applied ones are history. */
const OWED_STATES = ["pending", "refused"];

/** A row that is a second one of a calendar kept under `keeper`. */
export interface DuplicateCalendar {
  readonly id: string;
  readonly keeper: string;
}

/**
 * Of rows that are one calendar, the one that stays: the account's calendar for new events, then
 * one with writes owed, then the one holding the most events, then the oldest.
 */
async function keepersOf(
  ctx: ListingContext, groups: readonly (readonly StoredCalendar[])[],
): Promise<"gone" | readonly StoredCalendar[]> {
  const ids = groups.flat().map((s) => s.id);
  return inConnection(ctx.db, ctx.key, async ({ tx }) => {
    const events = new Map((await tx.select({ id: calEvents.calendarId, n: sql<number>`count(*)::int` }).from(calEvents)
      .where(and(eq(calEvents.accountId, ctx.key.accountId), inArray(calEvents.calendarId, ids))).groupBy(calEvents.calendarId))
      .map((r) => [r.id, Number(r.n)]));
    const owed = new Set((await tx.selectDistinct({ id: calWrites.calendarId }).from(calWrites)
      .where(and(eq(calWrites.accountId, ctx.key.accountId), inArray(calWrites.calendarId, ids), inArray(calWrites.state, OWED_STATES)))).map((r) => r.id));
    const [settings] = await tx.select({ id: calSettings.newEventsCalendarId }).from(calSettings)
      .where(eq(calSettings.accountId, ctx.key.accountId)).limit(1);
    const weight = (s: StoredCalendar): readonly number[] => [s.id === settings?.id ? 1 : 0, owed.has(s.id) ? 1 : 0, events.get(s.id) ?? 0];
    // Each group is in the stored order (oldest first): the first of the heaviest stays.
    return groups.map((group) => group.reduce((best, s) => {
      const [a, b] = [weight(s), weight(best)];
      const i = a.findIndex((v, n) => v !== b[n]);
      return i !== -1 && a[i]! > b[i]! ? s : best;
    }));
  });
}

/**
 * Keep new and changed calendars. Defer removals until queued writes have had their turn: the rows
 * no longer listed (`missing`) and the second rows of one calendar (`duplicates`).
 */
export async function applyListing(
  ctx: ListingContext, listed: readonly CalendarInfo[], stored: readonly StoredCalendar[],
  keyOf: (providerId: string) => string = (id) => id,
): Promise<
  { readonly ok: true; readonly changed: number; readonly missing: readonly string[]; readonly duplicates: readonly DuplicateCalendar[] }
  | { readonly ok: false; readonly why: "gone" | "halted" }
> {
  // A calendar is found again by its key: one the store cannot hold, for its length or for what is in it, is not kept.
  const byKey = new Map<string, CalendarInfo>();
  for (const c of listed) {
    if (!fitsCalendarBytes(c.id, CALENDAR_PROVIDER_ID_MAX_BYTES) || !storableKey(c.id)) continue;
    // Named twice (at two hosts of one server): one calendar, as it was named first.
    const key = keyOf(c.id);
    if (!byKey.has(key)) byKey.set(key, c);
  }
  const usable = [...byKey.values()];
  const groups = new Map<string, StoredCalendar[]>();
  for (const s of stored) {
    const key = keyOf(s.providerId);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const kept = new Map<string, StoredCalendar>();
  const duplicates: DuplicateCalendar[] = [];
  const twice = [...groups.values()].filter((group) => group.length > 1);
  const keepers = twice.length === 0 ? [] : await keepersOf(ctx, twice);
  if (keepers === "gone") return { ok: false, why: "gone" };
  for (const [key, group] of groups) kept.set(key, group[0]!);
  twice.forEach((group, i) => {
    const keeper = keepers[i]!;
    kept.set(keyOf(keeper.providerId), keeper);
    for (const s of group) if (s.id !== keeper.id) duplicates.push({ id: s.id, keeper: keeper.id });
  });
  // A listing that names no calendar at all decides nothing: an empty answer is likelier a provider's fault than a person's wish.
  const missing = usable.length === 0 ? [] : [...kept].filter(([key]) => !byKey.has(key)).map(([, s]) => s.id);
  let changed = 0;

  for (let at = 0; at < usable.length; at += CALENDAR_CHANGES_PER_TRANSACTION) {
    if (ctx.halted()) return { ok: false, why: "halted" };
    const slice = usable.slice(at, at + CALENDAR_CHANGES_PER_TRANSACTION);
    const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
      const changes: CalendarChange[] = [];
      for (const info of slice) {
        const was = kept.get(keyOf(info.id));
        const now = rowOf(info);
        if (was === undefined) {
          const [made] = await tx.insert(calCalendars).values({
            // No time yet: a calendar nobody has read is due at once, by the same rule as a connection.
            accountId: ctx.key.accountId, connectionId: ctx.key.id, providerId: info.id, ...now, nextPollAt: null,
          }).onConflictDoNothing().returning({ id: calCalendars.id });
          if (made !== undefined) changes.push({ kind: "calendar", id: made.id, op: "create" });
        } else if (was.name !== now.name || was.color !== now.color || was.access !== now.access ||
          (now.nativeMove !== undefined && was.nativeMove !== now.nativeMove) ||
          (now.autoSchedule !== undefined && was.autoSchedule !== now.autoSchedule) || was.timeZone !== now.timeZone) {
          await tx.update(calCalendars).set({ ...now, updatedAt: sql`now()` })
            .where(and(eq(calCalendars.id, was.id), eq(calCalendars.accountId, ctx.key.accountId)));
          changes.push({ kind: "calendar", id: was.id, op: "update" });
          if (was.access !== now.access) {
            // The feed derives Hide and series deletion details from access. Leaving busy restores event details.
            const events = await tx.select({ id: calEvents.id }).from(calEvents).where(and(
              eq(calEvents.accountId, ctx.key.accountId), eq(calEvents.calendarId, was.id),
              was.access === "busy" || was.access === "owner" || now.access === "owner" ? undefined : and(eq(calEvents.recurrenceId, ""), isNotNull(calEvents.repeatRule)),
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
    if (done === "gone") return { ok: false, why: "gone" };
    changed += done;
  }

  return { ok: true, changed, missing, duplicates };
}

/** Does the calendar owe a write: one of its own, or a move to it? */
async function owesWrites(tx: Tx, accountId: string, calendarId: string): Promise<boolean> {
  const [owed] = await tx.select({ id: calWrites.id }).from(calWrites).where(and(
    eq(calWrites.accountId, accountId), inArray(calWrites.state, OWED_STATES),
    or(eq(calWrites.calendarId, calendarId), sql`${calWrites.payload}->'act'->>'toCalendarId' = ${calendarId}`),
  )).limit(1);
  return owed !== undefined;
}

/**
 * Must a second row of a calendar stay: the account's calendar for new events, or one that owes a
 * write? The row is held for the rest of the transaction and the settings are read shared, so
 * that neither a write nor the person's choice comes to it while it is being removed.
 */
async function staysWhileOwed(tx: Tx, accountId: string, calendarId: string): Promise<boolean> {
  await tx.select({ id: calCalendars.id }).from(calCalendars)
    .where(and(eq(calCalendars.id, calendarId), eq(calCalendars.accountId, accountId))).for("update");
  const [settings] = await tx.select({ id: calSettings.newEventsCalendarId }).from(calSettings)
    .where(eq(calSettings.accountId, accountId)).for("share");
  return settings?.id === calendarId || await owesWrites(tx, accountId, calendarId);
}

/**
 * The second rows of one calendar removed with what hangs on them; the calendar's events come back
 * on its kept row's reading. A row that owes a write is left for a later listing, once the write
 * has had its turn. The kept row keeps its own choice of being shown.
 */
export async function mergeDuplicateCalendars(
  ctx: ListingContext, duplicates: readonly DuplicateCalendar[],
): Promise<{ readonly ok: true; readonly changed: number } | { readonly ok: false; readonly why: "gone" | "halted" }> {
  let changed = 0;
  for (const { id } of duplicates) {
    const removed = await removeCalendar(ctx, id, { unlessOwed: true });
    if (!removed.ok) return removed;
    changed += removed.changed;
  }
  return { ok: true, changed };
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
  ctx: ListingContext, calendarId: string, opts: { readonly unlessOwed?: boolean } = {},
): Promise<{ readonly ok: true; readonly changed: number; readonly whole: boolean } | { readonly ok: false; readonly why: "gone" | "halted" }> {
  let changed = 0;
  const mine = (t: { accountId: typeof calEvents.accountId; calendarId: typeof calEvents.calendarId }) =>
    and(eq(t.accountId, ctx.key.accountId), eq(t.calendarId, calendarId));
  const rounds = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
    // A second row that must stay keeps its reading and its events.
    if (opts.unlessOwed === true && await staysWhileOwed(tx, ctx.key.accountId, calendarId)) return "stays";
    await tx.update(calCalendars).set({ syncToken: null, readCheckpoint: null, readOwner: null, nextPollAt: null })
      .where(and(eq(calCalendars.id, calendarId), eq(calCalendars.accountId, ctx.key.accountId), eq(calCalendars.connectionId, ctx.key.id)));
    const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(calEvents).where(mine(calEvents));
    return Math.ceil(Number(held?.n ?? 0) / CALENDAR_CHANGES_PER_TRANSACTION) + 1;
  });
  if (rounds === "gone") return { ok: false, why: "gone" };
  if (rounds === "stays") return { ok: true, changed: 0, whole: false };
  ctx.memory.readings.delete(calendarId);
  for (let round = 0; round < rounds; round++) {
    if (ctx.halted()) return { ok: false, why: "halted" };
    const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
      // Asked again before each part goes: a write or a choice that came since stops the removal, the row held from here on.
      if (opts.unlessOwed === true && await staysWhileOwed(tx, ctx.key.accountId, calendarId)) return { last: true, count: 0, kept: true };
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
      return { last: rows.length === 0, count: changes.length, kept: false };
    });
    if (done === "gone") return { ok: false, why: "gone" };
    changed += done.count;
    if (done.last) return { ok: true, changed, whole: !done.kept };
  }
  return { ok: true, changed, whole: false };
}
