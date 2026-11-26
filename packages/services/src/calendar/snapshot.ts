/**
 * THE FIRST LOAD'S CALENDAR PHASE: one page of the calendar as it stands, read for a device that
 * holds none of it, by the same builders the feed sends a change with.
 *
 * A calendar's first read is every event it ever held, so a first load serves a span: the window
 * around today ({@link CALENDAR_WINDOW}), or a span the device names to load earlier days. An event
 * is in a span by the device's own cases (`client-engine`'s `calendar-span.ts`), written once more
 * here in SQL over the derived columns ({@link heldBySpanSql}); a test holds the two to one table.
 * A changed occurrence also carries the same calendar’s series when it is outside the span.
 * Past the default window's row ceiling the events farthest from its starting time are left out first.
 */
import { and, asc, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { calCalendars, calConnections, calEvents, calSuggestions } from "@trafficflow/db/mail";
import type { CalendarRecordKind, CalendarWindow } from "@ohmail/wire";
import type { Db } from "../context.js";
import type {
  CalendarKeyset, CalendarSnapshotQuery, CalendarSnapshotRecord, CalendarSnapshotSlice, CalendarSpanMs,
} from "../calendar-port.js";
import { CALENDAR_RANGE_SLACK_MS } from "./event-range.js";
import { DAY_MS } from "./time.js";
import { CALENDAR_BUILDERS } from "./feed.js";

/** What a first load serves and a device keeps: a year back, two ahead, at most ten thousand events. */
export const CALENDAR_WINDOW: CalendarWindow = { daysBack: 366, daysAhead: 731, maxRows: 10_000 };

/** How many open suggestions the phase's first page carries, the newest first. */
export const CALENDAR_SNAPSHOT_SUGGESTIONS = 200;

/** The span the window states around `now`. */
export function windowSpan(now: Date, w: CalendarWindow = CALENDAR_WINDOW): CalendarSpanMs {
  return { fromMs: now.getTime() - w.daysBack * DAY_MS, toMs: now.getTime() + w.daysAhead * DAY_MS };
}

type RangeColumns = {
  readonly startsAt: AnyPgColumn<{ data: Date }>;
  readonly endsAt: AnyPgColumn<{ data: Date }>;
  readonly occurrenceAt: AnyPgColumn<{ data: Date }>;
  readonly thisAndFuture: AnyPgColumn<{ data: boolean }>;
};

/**
 * THE DEVICE'S CASES, IN SQL, each widened by the slack a time read as UTC can be off: the event's
 * own range meets the span; or the occurrence it replaces lies in it; or it changes this occurrence
 * and every later one from before the span's end.
 */
export function heldBySpanSql(span: CalendarSpanMs, e: RangeColumns = calEvents): SQL {
  const from = new Date(span.fromMs - CALENDAR_RANGE_SLACK_MS);
  const to = new Date(span.toMs + CALENDAR_RANGE_SLACK_MS);
  return or(
    and(lte(e.startsAt, to), or(isNull(e.endsAt), gte(e.endsAt, from))),
    and(isNotNull(e.occurrenceAt), gte(e.occurrenceAt, from), lte(e.occurrenceAt, to)),
    and(eq(e.thisAndFuture, true), isNotNull(e.occurrenceAt), lte(e.occurrenceAt, to)),
  )!;
}

function calendarSpanQueries(db: Db, span: CalendarSpanMs) {
  // Create the Postgres alias only when a calendar snapshot queries it.
  const exception = alias(calEvents, "held_exception");
  const exceptionInSpan = and(
    eq(calEvents.recurrenceId, ""), isNotNull(calEvents.repeatRule),
    eq(exception.accountId, calEvents.accountId), eq(exception.calendarId, calEvents.calendarId),
    eq(exception.uid, calEvents.uid), ne(exception.recurrenceId, ""), heldBySpanSql(span, exception),
  );
  // scoped-by: exceptionInSpan matches the enclosing event’s account, calendar and series.
  const children = db.select({ id: exception.id }).from(exception).where(exceptionInSpan);
  return { exception, exceptionInSpan, heldRows: or(heldBySpanSql(span), exists(children))! };
}

function distanceFrom(at: SQL, e: RangeColumns): SQL<string> {
  return sql<string>`(case
    when ${e.startsAt} > ${at} then extract(epoch from (${e.startsAt} - ${at}))
    when ${e.endsAt} is null or ${e.endsAt} >= ${at} then 0
    else extract(epoch from (${at} - ${e.endsAt})) end)`;
}

/** Select the nearest rows. A master ranks no later than its first admitted exception. */
function nearestRows(db: Db, accountId: string, span: CalendarSpanMs, rankAt: number, maxRows: number) {
  const at = sql`${new Date(rankAt).toISOString()}::timestamptz`;
  const { exception, exceptionInSpan, heldRows } = calendarSpanQueries(db, span);
  const master = alias(calEvents, "held_master");
  // scoped-by: exceptionInSpan matches the enclosing event’s account, calendar and series.
  const nearest = db.select({ distance: sql`min(${distanceFrom(at, exception)})` }).from(exception).where(exceptionInSpan);
  const distance = sql<string>`least(${distanceFrom(at, calEvents)}, (${nearest}))`;
  return db.select({ id: calEvents.id }).from(calEvents)
    .leftJoin(master, and(
      eq(master.accountId, calEvents.accountId), eq(master.calendarId, calEvents.calendarId),
      eq(master.uid, calEvents.uid), eq(master.recurrenceId, ""), isNotNull(master.repeatRule), ne(calEvents.recurrenceId, ""),
    ))
    .where(and(eq(calEvents.accountId, accountId), heldRows))
    .orderBy(distance, sql`coalesce(${master.id}, ${calEvents.id})`, sql`${master.id} is not null`, asc(calEvents.id))
    .limit(maxRows);
}

/** Built records of one kind, in the order of `ids`; an id gone by the build is left out. */
async function built<K extends CalendarRecordKind>(db: Db, accountId: string, kind: K, ids: readonly string[]): Promise<CalendarSnapshotRecord[]> {
  const records = await CALENDAR_BUILDERS[kind](db, accountId, ids);
  return ids.flatMap((id) => {
    const r = records.get(id);
    return r === undefined ? [] : [{ kind, id, entity: r, updatedAt: r.updatedAt }];
  });
}

/** The phase's first page leads with the account's small calendar state: connections, calendars, open suggestions. */
async function leadRecords(db: Db, accountId: string, excludeSuggestions: boolean): Promise<CalendarSnapshotRecord[]> {
  const connections = await db.select({ id: calConnections.id }).from(calConnections)
    .where(eq(calConnections.accountId, accountId)).orderBy(asc(calConnections.createdAt), asc(calConnections.id));
  const calendars = await db.select({ id: calCalendars.id }).from(calCalendars)
    .where(eq(calCalendars.accountId, accountId)).orderBy(asc(calCalendars.connectionId), asc(calCalendars.id));
  const suggestions = excludeSuggestions ? [] : await db.select({ id: calSuggestions.id }).from(calSuggestions)
    .where(and(eq(calSuggestions.accountId, accountId), eq(calSuggestions.state, "open")))
    .orderBy(desc(calSuggestions.createdAt), desc(calSuggestions.id)).limit(CALENDAR_SNAPSHOT_SUGGESTIONS);
  return [
    ...await built(db, accountId, "calendar_connection", connections.map((r) => r.id)),
    ...await built(db, accountId, "calendar", calendars.map((r) => r.id)),
    ...await built(db, accountId, "calendar_suggestion", suggestions.map((r) => r.id)),
  ];
}

/** One page of the calendar's phase; the reader charges it to the page and cuts the events. */
export async function calendarSnapshotPage(db: Db, accountId: string, q: CalendarSnapshotQuery): Promise<CalendarSnapshotSlice> {
  const span = q.span ?? windowSpan(q.now, q.window);
  const after = q.after;
  const { exception, exceptionInSpan, heldRows } = calendarSpanQueries(db, span);
  // scoped-by: exceptionInSpan matches the enclosing event’s account, calendar and series.
  const firstChild = db.select({ start: sql`min(${exception.startsAt})` }).from(exception).where(exceptionInSpan);
  // A series fetched only for a moved exception follows that exception in the snapshot walk.
  // An earlier page can then prune without losing the series before its child is present.
  const start = sql<Date>`case when ${heldBySpanSql(span)} then ${calEvents.startsAt}
    else greatest(${calEvents.startsAt}, (${firstChild}) + interval '1 millisecond') end`.mapWith(calEvents.startsAt);
  let keyset: SQL | undefined;
  if (after !== null) {
    // The computed start supplies only a result decoder, so bind the cursor as a timestamp explicitly.
    const afterStart = sql`${new Date(after.startsAtMs).toISOString()}::timestamptz`;
    keyset = or(gt(start, afterStart), and(eq(start, afterStart), gt(calEvents.id, after.id)));
  }
  // scoped-by: leads with eq(calEvents.accountId, accountId)
  const rows = await db.select({ id: calEvents.id, startsAt: start }).from(calEvents)
    .where(and(eq(calEvents.accountId, accountId), heldRows, keyset,
      q.rankAt === undefined ? undefined : inArray(calEvents.id, nearestRows(db, accountId, span, q.rankAt, q.window.maxRows))))
    .orderBy(asc(start), asc(calEvents.id))
    .limit(q.limit);
  const keysetOf = (r: { id: string; startsAt: Date }): CalendarKeyset => ({ startsAtMs: r.startsAt.getTime(), id: r.id });
  const keys = new Map(rows.map((r) => [r.id, keysetOf(r)]));
  const events = (await built(db, accountId, "calendar_event", rows.map((r) => r.id)))
    .map((r) => ({ ...r, keyset: keys.get(r.id)! }));
  const lastRow = rows[rows.length - 1];
  return {
    span,
    lead: after === null ? await leadRecords(db, accountId, q.excludeSuggestions === true) : [],
    events,
    full: rows.length === q.limit,
    readTo: lastRow === undefined ? null : keysetOf(lastRow),
  };
}
