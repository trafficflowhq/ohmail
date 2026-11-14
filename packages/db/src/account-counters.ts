import { and, eq, sql, type SQL } from "drizzle-orm";
import { accountCounters, authThrottle } from "./schema-cloud.js";
import { carriesAnAddress, familyOf, parentIdOf, type CounterKeyFamily } from "./counter-keys.js";
import type { Tx } from "./change-log.js";

/**
 * THE ONE DOOR TO A COUNTER'S HOME (cloud 0101). A counter is a row of one of two tables with the
 * same four columns (`failures`, `locked_until`, `window_started_at`, `updated_at`):
 *
 *   `account_counters`  keyed `(account_id, key)`: the key names a user, a mailbox or an account,
 *                       and the row carries that row's account, so it is isolated and erased with it
 *   `auth_throttle`     keyed `key`: a keyed hash, a fixed word or a number, which names nobody
 *
 * Which one is not a caller's choice: the key's family decides (`counter-keys.ts`). A statement
 * asks {@link counterHome} for the table, the values a new row needs, the conflict target and the
 * predicate that finds the row, and writes its own arithmetic over `home.table`'s columns, which
 * carry the same names on both. A key of no family, one that does not fit its family's shape and
 * one that carries an address are refused before any statement.
 */
export class CounterKeyRefused extends Error {
  readonly code = "counter_key_refused";
  /** The family is the registry's own word; the key itself is never in the message. */
  constructor(readonly reason: "no_family" | "shape" | "address" | "no_account", readonly family: string | null) {
    super(
      reason === "no_family" ? "a counter key of no registered family"
        : reason === "address" ? "a counter key that carries an address"
          : reason === "shape" ? `a counter key that does not fit the shape of ${family}`
            : `a counter key of ${family} names a row and was given no account`,
    );
    this.name = "CounterKeyRefused";
  }
}

export type CounterTable = typeof authThrottle | typeof accountCounters;

interface HomeOf<T extends CounterTable, V> {
  readonly table: T;
  /** The identifying values of a new row; the caller adds the counter's own. */
  readonly values: V;
  /** `onConflictDoUpdate`'s target. */
  readonly target: T extends typeof accountCounters
    ? [typeof accountCounters.accountId, typeof accountCounters.key] : typeof authThrottle.key;
  /** The one row. */
  readonly where: SQL;
  readonly family: CounterKeyFamily;
}
export type CounterHome =
  | HomeOf<typeof authThrottle, { key: string }>
  | HomeOf<typeof accountCounters, { accountId: string; key: string }>;

function classed(key: string): CounterKeyFamily {
  if (carriesAnAddress(key)) throw new CounterKeyRefused("address", null);
  const family = familyOf(key);
  if (family === null) throw new CounterKeyRefused("no_family", null);
  if (!family.shape.test(key)) throw new CounterKeyRefused("shape", family.prefix);
  return family;
}

/** Does `key` live in `account_counters`? Throws {@link CounterKeyRefused} as {@link counterHome} does. */
export function namesARow(key: string): boolean {
  return classed(key).class === "moves";
}

/**
 * Where the counter under `key` lives. A key that names a row needs that row's account: the
 * caller's own (it holds the user, the mailbox or the account), or {@link counterAccount}'s read.
 */
export function counterHome(key: string, accountId?: string | null): CounterHome {
  const family = classed(key);
  if (family.class !== "moves") {
    return { table: authThrottle, values: { key }, target: authThrottle.key, where: eq(authThrottle.key, key), family };
  }
  if (!accountId) throw new CounterKeyRefused("no_account", family.prefix);
  return {
    table: accountCounters,
    values: { accountId, key },
    target: [accountCounters.accountId, accountCounters.key],
    where: and(eq(accountCounters.accountId, accountId), eq(accountCounters.key, key))!,
    family,
  };
}

/**
 * The account of the row a moving key names, read from that row: `null` when the row is gone, and
 * then there is no counter to keep (cloud 0101 left such rows behind for the same reason).
 */
export async function counterAccount(db: Tx, key: string): Promise<string | null> {
  const family = classed(key);
  const id = parentIdOf(key);
  if (family.class !== "moves" || id === null) return null;
  const from = family.parent === "user" ? sql`select account_id as a from users where id = ${id}::uuid`
    : family.parent === "mailbox" ? sql`select account_id as a from mailboxes where id = ${id}::uuid`
      : sql`select id as a from accounts where id = ${id}::uuid`;
  const res = await db.execute(from) as unknown;
  const rows = Array.isArray(res) ? res as { a: string }[] : ((res as { rows?: { a: string }[] }).rows ?? []);
  return rows[0]?.a ?? null;
}
