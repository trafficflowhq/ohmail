import { sql } from "drizzle-orm";
import {
  effectiveSubscriptionOf, entitlementsFor, LIVE_SUBSCRIPTION_STATUSES, ADDON_STORAGE_UNIT_BYTES,
} from "./billing.js";
import type { Tx } from "./change-log.js";

/**
 * THE MANAGED STORAGE CAP'S CLOUD HALF — what the cap IS for an account, and who is at it.
 *
 * On the `/cloud` entry point because both reads name `billing_subscriptions`; the mail half
 * (the counter, the reserve, the byte definition) is `storage.ts` on the root barrel, inside
 * the desktop engine's closure. The WORKER (core + db only, by its dependency test) reaches
 * this through `@trafficflow/db/cloud`, exactly as it reaches the spend gate.
 */

/**
 * The account's storage cap in bytes, or `null` for NO SUBSCRIPTION ROW AT ALL.
 *
 * `null` is the roster's own fail-open, inherited deliberately: `accountsWithSyncDisabled`
 * keeps a row-less account SYNCING ("when the data is ambiguous, sync, and keep watching"),
 * so the same account must keep STORING — a 0-byte cap here would withhold every body of every
 * pre-billing account the moment this deploys, which is a destroyed product for the accounts
 * least able to see why. The worker maps `null` to `UNMETERED_STORAGE_CAP`; the at-cap alert's
 * INNER JOIN on `billing_subscriptions` makes the same account invisible to the pager, so the
 * two surfaces agree.
 *
 * For an account WITH a row, the answer is `entitlementsFor(...).storageBytesLimit` — composed,
 * never re-derived, so grace/export-window/paused semantics keep one definition. The zero-cap
 * states are exactly the states whose `syncEnabled` is false, so the roster has already parked
 * them and no ingest runs to consult the 0.
 *
 * No `forUpdate`: the cap is read once per account per worker cycle, staleness of one cycle is
 * acceptable (the counter, not the cap, is what the reserve serializes on), and a write lock
 * per ingest batch would contend with Checkout's allocation lock for nothing.
 */
export async function storageCapOf(tx: Tx, accountId: string, now: Date): Promise<number | null> {
  const sub = await effectiveSubscriptionOf(tx, accountId);
  if (!sub) return null;
  // `suspended: false` and `balance: 0` because only `storageBytesLimit` is read and it
  // depends on neither: a suspended account's roster parking already stops its ingest.
  return entitlementsFor({ sub, balance: 0, suspended: false, now }).storageBytesLimit;
}

/** One at-cap account, as the alert rule reads it: counted bytes ≥ the effective row's cap. */
export interface AtCapAccount {
  accountId: string;
  bytes: number;
  storageBytesLimit: number;
}

/**
 * Every account whose counted stored-body bytes have reached its EFFECTIVE subscription's cap —
 * the population of the `storage_at_cap` alert.
 *
 * The effective row is resolved FIRST (the same `DISTINCT ON` live-preferred ordering as
 * `accountsWithSyncDisabled`, generated from the same const), and only then compared: filtering
 * before the DISTINCT ON would let a dead row over ITS old cap page about an account whose live
 * subscription has headroom. INNER JOIN on `account_storage` — an account that stored nothing
 * is at no cap — and INNER on `billing_subscriptions`, which is where `storageCapOf`'s
 * fail-open (`null` for row-less accounts) is mirrored: no row, no cap, no page.
 *
 * Bounded by the subscription count and content-free (an id, two numbers), like every alert
 * read.
 */
export async function accountsAtStorageCap(tx: Tx): Promise<AtCapAccount[]> {
  // Generated FROM the const, like `liveSubscriptionOf`'s WHERE, so the two SQL forms of
  // "live" cannot disagree.
  const live = sql.join([...LIVE_SUBSCRIPTION_STATUSES].map((s) => sql`${s}`), sql`, `);
  // THE EFFECTIVE CAP, the same composition `entitlementsFor` makes: base + add-on units.
  // Comparing against the base column alone paged forever about every customer whose add-on
  // bought them the headroom the worker correctly honours (review finding).
  const rows = await tx.execute<{ account_id: string; bytes: number; storage_bytes_limit: number }>(sql`
    with eff as (
      select distinct on (bs.account_id)
             bs.account_id,
             (bs.storage_bytes_limit
               + bs.addon_storage_units * ${sql.raw(String(ADDON_STORAGE_UNIT_BYTES))}) as storage_bytes_limit
        from billing_subscriptions bs
       order by bs.account_id,
                (bs.status in (${live})) desc,
                bs.stripe_event_ts desc,
                bs.created_at desc
    )
    select eff.account_id            as account_id,
           s.bytes                   as bytes,
           eff.storage_bytes_limit   as storage_bytes_limit
      from eff
      join account_storage s on s.account_id = eff.account_id
     where s.bytes >= eff.storage_bytes_limit`);
  // Driver split, the credits precedent: postgres-js answers the array, PGlite `{ rows }`.
  const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: typeof rows }).rows;
  return (list as unknown as Array<{ account_id: string; bytes: number; storage_bytes_limit: number }>)
    .map((r) => ({
      accountId: r.account_id,
      bytes: Number(r.bytes),
      storageBytesLimit: Number(r.storage_bytes_limit),
    }));
}
