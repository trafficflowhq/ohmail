/**
 * A MAILBOX'S ERASURE, ITS CALENDAR PART: what rides the mailbox goes with it. A connection whose
 * sign-in is the mailbox's, with its calendars, events, invitees, reminders, queued writes and
 * sign-in; and the links and suggestions the mailbox's letters made. A connection that does not
 * ride the mailbox is untouched.
 *
 * One bounded step per call, in the mailbox sweep's transaction and order (`mailbox-erasure.ts`
 * runs it after the last page of letters and before the mailbox's own state, until it answers
 * done, so the finish stamp means the calendar too). Every record removed is sent as its own
 * deletion, children first, after the step's deletes: no device's removal rests on its cascade.
 * Reached on a server and a desktop's store; a phone's store has no calendar and its build puts
 * `apps/sidecar/src/phone/calendar-erasure.ts` in this file's place.
 *
 * A connection's own removal, by its person, is the same step for that one connection
 * (`sweepCalendarConnectionStep`): one order of deletes for every way a connection goes.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Dialect } from "../dialect/index.js";
import { calendarDelta, recordChanges, type ChangeInput, type LedgerTx } from "../change-log.js";
import { rowsAffected } from "../rows-affected.js";
import {
  calAlarms, calAttendees, calCalendars, calConnections, calCredentials, calEvents, calLinks, calSettings,
  calSuggestions, calWrites,
} from "../schema-mail.js";

/** Rows one step takes at most, of each kind it pages. */
export const CALENDAR_ERASE_BATCH = 2_000;

export interface CalendarErasureStep {
  readonly deleted: Readonly<Record<string, number>>;
  readonly done: boolean;
  readonly seq: bigint | null;
}

type Drop = (table: string, run: Promise<unknown>) => Promise<void>;

/** A step's own count of what it deleted, and the deletions it sends once its deletes are done. */
function stepOf(tx: LedgerTx): { deleted: Record<string, number>; drop: Drop; changes: ChangeInput[]; finish(done: boolean): Promise<CalendarErasureStep> } {
  const deleted: Record<string, number> = {};
  const changes: ChangeInput[] = [];
  return {
    deleted,
    changes,
    drop: async (table, run) => { deleted[table] = (deleted[table] ?? 0) + rowsAffected(await run); },
    finish: async (done) => {
      const seqs = changes.length === 0 ? [] : await recordChanges(tx, changes);
      return { deleted, done, seq: seqs[seqs.length - 1] ?? null };
    },
  };
}

/**
 * ONE BOUNDED STEP OF ONE CONNECTION'S REMOVAL, its row already held FOR UPDATE by the caller: a
 * batch of its events with what hangs on them, or, once none is left, its queued writes, its
 * calendars' own reminders, its calendars, its sign-in and the row itself. The one order every
 * removal of a connection takes: a mailbox's erasure for a connection that rides it, and a person's
 * own removal of one. Answers whether the connection's row went in this step.
 */
async function connectionStep(
  tx: LedgerTx, accountId: string, connectionId: string, drop: Drop, changes: ChangeInput[],
): Promise<boolean> {
  const calendars = (await tx.select({ id: calCalendars.id }).from(calCalendars)
    .where(and(eq(calCalendars.accountId, accountId), eq(calCalendars.connectionId, connectionId))))
    .map((c) => c.id);
  if (calendars.length > 0) {
    const events = (await tx.select({ id: calEvents.id }).from(calEvents)
      .where(and(eq(calEvents.accountId, accountId), inArray(calEvents.calendarId, calendars)))
      .orderBy(asc(calEvents.id)).limit(CALENDAR_ERASE_BATCH))
      .map((e) => e.id);
    if (events.length > 0) {
      await drop("cal_attendees", tx.delete(calAttendees).where(and(eq(calAttendees.accountId, accountId), inArray(calAttendees.eventId, events))));
      await drop("cal_alarms", tx.delete(calAlarms).where(and(eq(calAlarms.accountId, accountId), inArray(calAlarms.eventId, events))));
      await tx.update(calSuggestions).set({ eventId: null })
        .where(and(eq(calSuggestions.accountId, accountId), inArray(calSuggestions.eventId, events)));
      await drop("cal_events", tx.delete(calEvents).where(and(eq(calEvents.accountId, accountId), inArray(calEvents.id, events))));
      for (const id of events) changes.push(calendarDelta(accountId, "calendar_event", id, "delete"));
      return false;
    }
  }
  // No event left under it: its queued writes, its calendars' own reminders, its calendars, its
  // sign-in, then the connection.
  if (calendars.length > 0) {
    await drop("cal_writes", tx.delete(calWrites).where(and(eq(calWrites.accountId, accountId), inArray(calWrites.calendarId, calendars))));
    await drop("cal_alarms", tx.delete(calAlarms).where(and(eq(calAlarms.accountId, accountId), inArray(calAlarms.calendarId, calendars), isNull(calAlarms.eventId))));
    await tx.update(calSettings).set({ newEventsCalendarId: null })
      .where(and(eq(calSettings.accountId, accountId), inArray(calSettings.newEventsCalendarId, calendars)));
    await drop("cal_calendars", tx.delete(calCalendars).where(and(eq(calCalendars.accountId, accountId), inArray(calCalendars.id, calendars))));
    for (const id of calendars) changes.push(calendarDelta(accountId, "calendar", id, "delete"));
  }
  await drop("cal_credentials", tx.delete(calCredentials).where(and(eq(calCredentials.accountId, accountId), eq(calCredentials.connectionId, connectionId))));
  await drop("cal_connections", tx.delete(calConnections).where(and(eq(calConnections.accountId, accountId), eq(calConnections.id, connectionId))));
  changes.push(calendarDelta(accountId, "calendar_connection", connectionId, "delete"));
  return true;
}

/**
 * A CONNECTION REMOVED BY ITS PERSON, one bounded step per call, each in a transaction of its
 * caller's that holds the account's fence. The row is taken FOR UPDATE by BOTH ids first, so a
 * page of its sync in flight commits before the step reads and a later one finds the row marked
 * or gone; another account's id finds no row. `done` once the connection's own row is gone, or
 * was not there for this account.
 */
export async function sweepCalendarConnectionStep(
  tx: LedgerTx, d: Dialect, args: { accountId: string; connectionId: string },
): Promise<CalendarErasureStep> {
  const { accountId, connectionId } = args;
  const step = stepOf(tx);
  const [held] = await d.forUpdate(
    tx.select({ status: calConnections.status }).from(calConnections)
      .where(and(eq(calConnections.accountId, accountId), eq(calConnections.id, connectionId))).limit(1),
    { mode: "update" },
  );
  if (held?.status !== "removing") return step.finish(true);
  return step.finish(await connectionStep(tx, accountId, connectionId, step.drop, step.changes));
}

export async function sweepMailboxCalendarStep(
  tx: LedgerTx, d: Dialect, args: { accountId: string; mailboxId: string },
): Promise<CalendarErasureStep> {
  const { accountId, mailboxId } = args;
  const { drop, changes, finish } = stepOf(tx);

  // FIRST: the connections that ride this mailbox, FOR UPDATE, so a page of their sync in flight
  // commits before this step reads them and a later one finds them gone.
  const riding = await d.forUpdate(
    tx.select({ id: calConnections.id }).from(calConnections)
      .where(and(eq(calConnections.accountId, accountId), eq(calConnections.mailboxId, mailboxId)))
      .orderBy(asc(calConnections.id)),
    { mode: "update" },
  );
  // One step of the first riding connection a call; the next call reads the list again.
  const first = riding[0];
  if (first !== undefined) {
    await connectionStep(tx, accountId, first.id, drop, changes);
    return finish(false);
  }

  // The letters' words: suggestions in pages, then links.
  const suggestions = (await tx.select({ id: calSuggestions.id }).from(calSuggestions)
    .where(and(eq(calSuggestions.accountId, accountId), eq(calSuggestions.mailboxId, mailboxId)))
    .orderBy(asc(calSuggestions.id)).limit(CALENDAR_ERASE_BATCH))
    .map((s) => s.id);
  if (suggestions.length > 0) {
    await drop("cal_suggestions", tx.delete(calSuggestions).where(and(eq(calSuggestions.accountId, accountId), inArray(calSuggestions.id, suggestions))));
    for (const id of suggestions) changes.push(calendarDelta(accountId, "calendar_suggestion", id, "delete"));
    return finish(false);
  }
  await drop("cal_links", tx.delete(calLinks).where(and(eq(calLinks.accountId, accountId), eq(calLinks.mailboxId, mailboxId))));
  return finish(true);
}
