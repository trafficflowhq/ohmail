/**
 * THE ROSTER: which connections are due. The reads the calendar's passes make before an account
 * is bound, of the one table the store lets the worker read so (`cal_connections`), and of nothing
 * but the ids, the provider's word and the status. Plain statements, never a lock.
 *
 * A connection is due when it is `active` or `failing` and its `next_poll_at` has passed or was
 * never set. A stopped connection is held by its status, never by an empty time, so NULL means
 * "due now" and nothing else. A calendar-only account is found like any other: no mailbox is read.
 */
import { and, asc, inArray, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { calConnections } from "@trafficflow/db";
import { unboundPool, type CalendarPool } from "./connection.js";
import type { DueConnection } from "./types.js";
import { ROSTER_EXCEPT_MAX } from "./words.js";

/** This process's share of the accounts, as the worker's own roster rule writes it for a column. */
export type ShardRule = (accountId: typeof calConnections.accountId) => SQL | undefined;

/** A connection a pass works for, whose time has come. */
const dueAt = (now: Date): SQL | undefined => and(
  inArray(calConnections.status, ["active", "failing"]),
  or(isNull(calConnections.nextPollAt), lte(calConnections.nextPollAt, now)),
);

/**
 * `except`: connections the caller will not run now whatever the row says (queued or running
 * already, or waiting in its memory because their row could not be moved). They are passed over
 * before the cut, so rows that cannot run never fill a read and hide the ones that can.
 */
export async function loadDueConnections(
  pool: CalendarPool, now: Date, limit: number, shard: ShardRule, except: readonly string[] = [],
): Promise<DueConnection[]> {
  const db = unboundPool(pool);
  const rows = await db.select({
    id: calConnections.id, accountId: calConnections.accountId,
    provider: calConnections.provider, status: calConnections.status,
  }).from(calConnections)
    .where(and(
      dueAt(now),
      shard(calConnections.accountId),
      except.length === 0 ? undefined : notInArray(calConnections.id, except.slice(0, ROSTER_EXCEPT_MAX)),
    ))
    .orderBy(sql`${calConnections.nextPollAt} asc nulls first`, asc(calConnections.id))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, accountId: r.accountId, provider: r.provider, status: r.status as DueConnection["status"] }));
}

/**
 * Of these connections, the ones that are still due: what the roster would hand over again. It
 * answers one question, for the memory of open readings: is anybody still reading this connection?
 * A connection with a reading open is due until that reading ends, since a turn with more to read
 * leaves it due at once. One that was removed, stopped for the person, parked or made to wait is
 * not, and nothing else tells a process that it will not be turned again. `ids` are the caller's
 * own few (the connections that hold a place); only ids are read.
 */
export async function dueAmong(pool: CalendarPool, now: Date, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await unboundPool(pool).select({ id: calConnections.id }).from(calConnections)
    .where(and(inArray(calConnections.id, [...ids]), dueAt(now)));
  return new Set(rows.map((r) => r.id));
}
