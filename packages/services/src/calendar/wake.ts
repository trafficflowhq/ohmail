/**
 * A CONNECTION PULLED DUE: its next turn moved forward, never for a connection that waits for a
 * word, a provider's wish or the person. One guard for the two callers there are. A press asks at
 * once (`wakeCalendarConnection`). A provider's notice is spaced: it never asks sooner after the
 * last reading than {@link NOTICE_SPACING_SECONDS}, and it moves a row only forward, so a storm of
 * notices is one reading and a replayed notice is the same one.
 *
 * The pull records "due" and nothing else: no change record, no `updated_at`, no event, no dial.
 * The worker's own turn is what reads the provider.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { calCalendars, calConnections } from "@trafficflow/db/mail";
import { rowsAffected, type Tx } from "@trafficflow/db";
import { bridgeTx, runInTransaction, type BoundDb } from "../context.js";

/** The least time between a calendar's last reading and the next one a notice may cause. */
export const NOTICE_SPACING_SECONDS = 30;

/**
 * A notice's pull waits this long for a row another transaction holds (a turn's own write, a
 * removal), then gives up: the notice is dropped and the poll remains.
 */
export const NOTICE_LOCK_TIMEOUT_MS = 500;

export interface ConnectionScope {
  readonly accountId: string;
  readonly connectionId: string;
}

/** When a row is due: now, or for a spaced pull not before its last reading plus the spacing. */
const dueAt = (lastSyncedAt: AnyPgColumn, spacingSeconds: number | null): SQL =>
  spacingSeconds === null
    ? sql`now()`
    : sql`greatest(now(), coalesce(${lastSyncedAt}, '-infinity'::timestamptz) + make_interval(secs => ${spacingSeconds}))`;

/**
 * The connection's next turn, pulled to when it is due. Only an active connection that waits for
 * no word. `spacingSeconds` null is a press: due now. With a spacing the row moves only where it
 * waits longer than that. Answers the rows moved.
 */
export async function pullConnectionDue(tx: Tx, scope: ConnectionScope, spacingSeconds: number | null): Promise<number> {
  const due = dueAt(calConnections.lastSyncedAt, spacingSeconds);
  return rowsAffected(await tx.update(calConnections).set({ nextPollAt: due }).where(and(
    eq(calConnections.id, scope.connectionId), eq(calConnections.accountId, scope.accountId),
    eq(calConnections.status, "active"), sql`${calConnections.errorCode} is null`,
    ...(spacingSeconds === null ? [] : [sql`${calConnections.nextPollAt} > ${due}`]),
  )));
}

/**
 * One calendar of the connection pulled due, or every one where `calendarId` is null: only a
 * calendar that waits for no word, only forward, and spaced. Answers the rows moved.
 */
export async function pullCalendarsDue(
  tx: Tx, scope: ConnectionScope & { readonly calendarId: string | null }, spacingSeconds: number,
): Promise<number> {
  const due = dueAt(calCalendars.lastSyncedAt, spacingSeconds);
  return rowsAffected(await tx.update(calCalendars).set({ nextPollAt: due }).where(and(
    ...(scope.calendarId === null ? [] : [eq(calCalendars.id, scope.calendarId)]),
    eq(calCalendars.accountId, scope.accountId), eq(calCalendars.connectionId, scope.connectionId),
    sql`${calCalendars.errorCode} is null`, sql`${calCalendars.nextPollAt} > ${due}`,
  )));
}

/**
 * WHAT A PROVIDER'S NOTICE MAY DO, whole: in one short transaction on the handle bound to the
 * channel's own account, the channel's connection and its calendar are pulled due. The ids are the
 * channel row's; nothing a notice says names one. The connection goes first, then what hangs on it,
 * the order every calendar write takes its rows in.
 */
export async function pullForNotice(
  db: BoundDb, channel: ConnectionScope & { readonly calendarId: string | null },
): Promise<{ readonly connections: number; readonly calendars: number }> {
  const ctx = { db, accountId: channel.accountId, userId: null, now: () => new Date(), requestId: "" };
  return runInTransaction(ctx, async (txCtx) => {
    const tx = bridgeTx(txCtx.db);
    // scoped-by: a setting of this transaction alone, opened on the handle bound to the channel's account; no row is read or written
    await tx.execute(sql.raw(`set local lock_timeout = '${NOTICE_LOCK_TIMEOUT_MS}ms'`));
    const connections = await pullConnectionDue(tx, channel, NOTICE_SPACING_SECONDS);
    const calendars = await pullCalendarsDue(tx, channel, NOTICE_SPACING_SECONDS);
    return { connections, calendars };
  });
}
