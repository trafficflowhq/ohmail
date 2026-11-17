/**
 * WHERE A CONNECTION'S AND A CALENDAR'S SYNC STANDS, as the rows keep it: `status` and `error_code`
 * (a word of the store's closed lists, or nothing), `next_poll_at` (when it is asked again), and
 * `last_synced_at`. A word or a status that changed is a change of the record, recorded with its
 * delta and its `updated_at` from the database's clock; the time of the next ask is bookkeeping and
 * moves neither.
 */
import { and, eq, sql } from "drizzle-orm";
import { calCalendars, calConnections, calSettings, recordCalendarChanges, type LedgerTx, type Tx } from "@trafficflow/db";
import type { ConnectionKey } from "./connection.js";
import type { CalendarSyncFault } from "./words.js";

/** When the account switched its calendar on, or `null`: off, and no row is off too. */
export async function calendarEnabledAt(tx: Tx, accountId: string): Promise<Date | null> {
  const [row] = await tx.select({ enabledAt: calSettings.enabledAt }).from(calSettings)
    .where(eq(calSettings.accountId, accountId)).limit(1);
  return row?.enabledAt ?? null;
}

/** The connection is asked again at `at`; nothing a person sees moves. */
export async function holdConnectionUntil(tx: Tx, key: ConnectionKey, at: Date): Promise<void> {
  await tx.update(calConnections).set({ nextPollAt: at })
    .where(and(eq(calConnections.id, key.id), eq(calConnections.accountId, key.accountId)));
}

/** A calendar is asked again at `at`; nothing a person sees moves. */
export async function holdCalendarUntil(tx: Tx, key: ConnectionKey, calendarId: string, at: Date): Promise<void> {
  await tx.update(calCalendars).set({ nextPollAt: at })
    .where(and(eq(calCalendars.id, calendarId), eq(calCalendars.accountId, key.accountId), eq(calCalendars.connectionId, key.id)));
}

/**
 * The connection's status and word, with the change a device learns them by. Written only where
 * one of them moved; `synced` also stamps `last_synced_at`. The caller's transaction holds the
 * connection row and commits this as its last statement.
 */
export async function setConnectionState(
  tx: Tx, key: ConnectionKey,
  was: { readonly status: string; readonly errorCode: string | null },
  now: { readonly status: "active" | "failing" | "reconnect"; readonly errorCode: CalendarSyncFault | null; readonly synced: boolean },
): Promise<boolean> {
  if (was.status === now.status && was.errorCode === now.errorCode && !now.synced) return false;
  await tx.update(calConnections).set({
    status: now.status,
    errorCode: now.errorCode,
    ...(now.synced ? { lastSyncedAt: sql`now()` } : {}),
    updatedAt: sql`now()`,
  }).where(and(eq(calConnections.id, key.id), eq(calConnections.accountId, key.accountId)));
  await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, [{ kind: "calendar_connection", id: key.id, op: "update" }]);
  return true;
}
