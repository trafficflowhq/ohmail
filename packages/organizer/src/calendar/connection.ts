/**
 * ONE ACCOUNT'S CONNECTION, BY CONSTRUCTION. A pass is handed the pool opaque, turns it into a
 * handle for one account with {@link passDb} (which binds the account),
 * and opens every transaction of its turn through {@link inConnection}, which takes the store's
 * calendar writer's fence before the caller's statements run. Nothing else here can reach the pool:
 * a statement written outside these doors does not compile.
 *
 * The reads made before an account is bound are the roster's (`roster.ts`), of `cal_connections`.
 */
import { and, eq } from "drizzle-orm";
import { AccountErasedError, MailboxErasedError, bindDb, calConnections, type Tx } from "@trafficflow/db";
import { CalendarConnectionGone, fencedConnectionWrite } from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";

const POOL: unique symbol = Symbol("calendar pool");
const BOUND: unique symbol = Symbol("calendar connection handle");

/** The worker's pool as the calendar's passes are handed it: no query can be written on it. */
export interface CalendarPool { readonly [POOL]: Tx }

/** One account's handle for one turn. Only {@link inConnection} opens a transaction on it. */
export interface ConnectionDb {
  readonly [BOUND]: Tx;
  readonly accountId: string;
}

/** A connection by both of its ids, which always come from one row. */
export interface ConnectionKey {
  readonly accountId: string;
  readonly id: string;
}

/** The statuses a pass works for. Any other (`reconnect`, `removing`, a newer word) is not dialled. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "failing"]);

/** The connection row as one transaction found it, under its lock. */
export interface HeldConnection {
  readonly provider: string;
  readonly status: "active" | "failing";
  readonly errorCode: string | null;
  readonly mailboxId: string | null;
  readonly serverUrl: string | null;
  readonly principal: string | null;
  readonly organizerAddresses: readonly string[] | null;
  readonly listToken: string | null;
  readonly lastSyncedAt: Date | null;
  readonly nextPollAt: Date | null;
}

/** The pool, made opaque. The worker's start file is its one maker. */
export function calendarPool(db: Tx): CalendarPool {
  return { [POOL]: db };
}

/** The roster's reads of `cal_connections`, and nothing else, take the pool itself. */
export function unboundPool(pool: CalendarPool): Tx {
  return pool[POOL];
}

/**
 * THE BINDER'S LINE. Every pass reaches the database for an account through this function and no
 * other: over the worker's pool, which is handed here as its view that names no account, the
 * handle it answers is bound to `accountId`, so every transaction of the turn names that account
 * first. `accountId` is a connection's own, from one roster row (`ConnectionKey`): never an id a
 * provider answered or a push carried. An id that is no account id is refused.
 *
 * Whatever store the pool is: the binder is asked every time, so no turn runs on a handle that
 * does not name its connection's account, and the writer's fence finds the account it is asked for.
 */
export function passDb(pool: CalendarPool, accountId: string): ConnectionDb {
  return { [BOUND]: bindDb(pool[POOL], { account: accountId }), accountId };
}

/** A transaction of one turn, with the connection row it holds. */
export interface ConnectionTx {
  readonly tx: Tx;
  readonly held: HeldConnection;
}

/**
 * One transaction for one connection, inside the store's writer fence (`fencedConnectionWrite`:
 * the account's row, the mailbox the connection rides, the connection row by BOTH ids, each FOR
 * SHARE), then the row as it stands, then `fn`. A connection that is not there for this account,
 * being removed or no longer `active`/`failing`, or an erased account or mailbox, is `"gone"`:
 * nothing is written. The key decides the ids every write takes; nothing a provider answered ever
 * names one.
 *
 * `lock: "no key update"` is for a transaction that writes the connection row itself: it takes the
 * row for that before `fn`, over the fence's share. Two such at once on one connection (two workers
 * in a deploy's overlap) can each wait on the other's share; the database then ends one, whose turn
 * throws and is written `unknown`.
 */
export async function inConnection<T>(
  db: ConnectionDb, key: ConnectionKey, fn: (c: ConnectionTx) => Promise<T>,
  opts: { readonly lock?: "share" | "no key update" } = {},
): Promise<T | "gone"> {
  // A handle bound for one account is never used for another's connection: a fault of this program.
  if (key.accountId !== db.accountId) throw new Error("a calendar turn's handle was asked for another account's connection");
  try {
    return await fencedConnectionWrite(db[BOUND], { accountId: key.accountId, connectionId: key.id }, async (tx) => {
      const read = tx.select({
        provider: calConnections.provider, status: calConnections.status, errorCode: calConnections.errorCode,
        mailboxId: calConnections.mailboxId, serverUrl: calConnections.serverUrl, principal: calConnections.principal, organizerAddresses: calConnections.organizerAddresses,
        listToken: calConnections.listToken, lastSyncedAt: calConnections.lastSyncedAt, nextPollAt: calConnections.nextPollAt,
      }).from(calConnections).where(and(eq(calConnections.id, key.id), eq(calConnections.accountId, key.accountId))).limit(1);
      const [row] = opts.lock === "no key update" ? await dialect(tx).forUpdate(read, { mode: "no key update" }) : await read;
      if (row === undefined || !LIVE_STATUSES.has(row.status)) return "gone" as const;
      return fn({ tx, held: { ...row, status: row.status as HeldConnection["status"] } });
    });
  } catch (err) {
    if (err instanceof AccountErasedError || err instanceof MailboxErasedError || err instanceof CalendarConnectionGone) return "gone";
    throw err;
  }
}
