/**
 * THE FIRST LOAD'S CALENDAR PHASE: one page of the calendar as it stands, read for a device that
 * holds none of it, by the same builders the feed sends a change with.
 *
 * A calendar's first read is every event it ever held, so a first load serves a span: the window
 * around today ({@link CALENDAR_WINDOW}), or a span the device names to load earlier days. An event
 * is in a span by the device's own cases (`client-engine`'s `calendar-span.ts`), written once more
 * here in SQL over the derived columns ({@link heldBySpanSql}); a test holds the two to one table.
 * A changed occurrence also carries the same calendar’s series when it is outside the span.
 * Past the window's row ceiling the events farthest from today are left out first: the first page
 * narrows the window to the distance of its last kept event, and the walk keeps that span.
 */
import { and, asc, desc, eq, exists, gt, gte, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
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

const exception = alias(calEvents, "held_exception");

function exceptionInSpan(span: CalendarSpanMs): SQL {
  return and(
    eq(calEvents.recurrenceId, ""), isNotNull(calEvents.repeatRule),
    eq(exception.accountId, calEvents.accountId), eq(exception.calendarId, calEvents.calendarId),
    eq(exception.uid, calEvents.uid), ne(exception.recurrenceId, ""), heldBySpanSql(span, exception),
  )!;
}

function heldCalendarRows(db: Db, span: CalendarSpanMs): SQL {
  const children = db.select({ id: exception.id }).from(exception).where(exceptionInSpan(span));
  return or(heldBySpanSql(span), exists(children))!;
}

function distanceFrom(at: SQL, e: RangeColumns): SQL<string> {
  return sql<string>`(case
    when ${e.startsAt} > ${at} then extract(epoch from (${e.startsAt} - ${at}))
    when ${e.endsAt} is null or ${e.endsAt} >= ${at} then 0
    else extract(epoch from (${at} - ${e.endsAt})) end)`;
}

/**
 * The window, narrowed to its row ceiling: when more events than `maxRows` can touch it, the span
 * around `now` out to the distance of the `maxRows`-th nearest one (zero while it is on, else its
 * nearer end's distance, as the device measures it).
 */
async function narrowToCeiling(db: Db, accountId: string, span: CalendarSpanMs, now: Date, maxRows: number): Promise<CalendarSpanMs> {
  const at = sql`${now.toISOString()}::timestamptz`;
  // A series served only for a changed occurrence belongs at that occurrence's distance.
  const nearest = db.select({ distance: sql`min(${distanceFrom(at, exception)})` }).from(exception).where(exceptionInSpan(span));
  const distance = sql<string>`least(${distanceFrom(at, calEvents)}, (${nearest}))`;
  const [row] = await db.select({ seconds: distance }).from(calEvents)
    .where(and(eq(calEvents.accountId, accountId), heldCalendarRows(db, span)))
    .orderBy(distance, asc(calEvents.id))
    .limit(1).offset(maxRows - 1);
  if (row === undefined) return span;
  const reach = Math.ceil(Number(row.seconds) * 1000);
  return { fromMs: Math.max(span.fromMs, now.getTime() - reach), toMs: Math.min(span.toMs, now.getTime() + reach) };
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
async function leadRecords(db: Db, accountId: string): Promise<CalendarSnapshotRecord[]> {
  const connections = await db.select({ id: calConnections.id }).from(calConnections)
    .where(eq(calConnections.accountId, accountId)).orderBy(asc(calConnections.createdAt), asc(calConnections.id));
  const calendars = await db.select({ id: calCalendars.id }).from(calCalendars)
    .where(eq(calCalendars.accountId, accountId)).orderBy(asc(calCalendars.connectionId), asc(calCalendars.id));
  const suggestions = await db.select({ id: calSuggestions.id }).from(calSuggestions)
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
  const span = q.span ?? await narrowToCeiling(db, accountId, windowSpan(q.now, q.window), q.now, q.window.maxRows);
  const after = q.after;
  const firstChild = db.select({ start: sql`min(${exception.startsAt})` }).from(exception).where(exceptionInSpan(span));
  // A series fetched only for a moved exception follows that exception in the snapshot walk.
  // An earlier page can then prune without losing the series before its child is present.
  const start = sql<Date>`case when ${heldBySpanSql(span)} then ${calEvents.startsAt}
    else greatest(${calEvents.startsAt}, (${firstChild}) + interval '1 millisecond') end`.mapWith(calEvents.startsAt);
  const keyset = after === null ? undefined : or(
    gt(start, new Date(after.startsAtMs)),
    and(eq(start, new Date(after.startsAtMs)), gt(calEvents.id, after.id)),
  );
  // scoped-by: leads with eq(calEvents.accountId, accountId)
  const rows = await db.select({ id: calEvents.id, startsAt: start }).from(calEvents)
    .where(and(eq(calEvents.accountId, accountId), heldCalendarRows(db, span), keyset))
    .orderBy(asc(start), asc(calEvents.id))
    .limit(q.limit);
  const keysetOf = (r: { id: string; startsAt: Date }): CalendarKeyset => ({ startsAtMs: r.startsAt.getTime(), id: r.id });
  const keys = new Map(rows.map((r) => [r.id, keysetOf(r)]));
  const events = (await built(db, accountId, "calendar_event", rows.map((r) => r.id)))
    .map((r) => ({ ...r, keyset: keys.get(r.id)! }));
  const lastRow = rows[rows.length - 1];
  return {
    span,
    lead: after === null ? await leadRecords(db, accountId) : [],
    events,
    full: rows.length === q.limit,
    readTo: lastRow === undefined ? null : keysetOf(lastRow),
  };
}
