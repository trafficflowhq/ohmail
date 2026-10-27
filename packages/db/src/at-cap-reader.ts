import { desc, gt, sql } from "drizzle-orm";
import { accountStorage } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import {
  inPlaneRounds, isMetered, parkedAccountsOf, PARKED_READ_CONCURRENCY, UNMETERED_ACCESS,
  type AccountsAtCapReader, type AtCapAccount, type EntitlementsComposition,
  type ParkedAccountsReader, type PlaneOpsReader, type PlaneReadBound,
} from "./entitlements-port.js";
import { planeOpsReaderOf } from "./plane-ops.js";
import { storageHoldsOf, storageLimitFrom } from "./storage-hold.js";

/**
 * How many accounts one reading asks about, largest stored bytes first. A bound on the pass, and a
 * STATED one: past it the reading is partial and the storage rule says "N of M accounts read".
 */
export const AT_CAP_READ_LIMIT = 500;

/**
 * The storage rule's own bound in time and in faulted dials: past it the reading is partial,
 * so a program that hangs never holds the rules after it (`worker_down` among them), and one
 * that fails fast writes at most a round of fault rows per pass rather than one per account.
 */
export const AT_CAP_READ_BOUND: PlaneReadBound = { boundMs: 4_000, faultCeiling: PARKED_READ_CONCURRENCY };

/** The same bound for the alert reads of who is parked, on a host that is not the roster. */
export const ALERT_PARKED_READ_BOUND: PlaneReadBound = { boundMs: 3_000, faultCeiling: PARKED_READ_CONCURRENCY };

/**
 * WHO IS AT THEIR STORAGE CAP — the bytes this database counts (`account_storage`) against the cap
 * the entitlements program states (or a lower one's hold), asked through the host's cached `access`. `null` on an unmetered
 * host: nobody is capped there, and the caller says so. An account whose ask fell to the client's
 * fault arm with nothing held (`UNMETERED_ACCESS` itself) is not read, so an outage reads partial.
 */
export function accountsAtCapOf(
  entitlements: EntitlementsComposition, bound: PlaneReadBound = AT_CAP_READ_BOUND,
): AccountsAtCapReader | null {
  if (!isMetered(entitlements)) return null;
  return async (db: Tx, now: Date) => {
    const [counted] = await db.select({ n: sql<number>`count(*)::int` })
      .from(accountStorage).where(gt(accountStorage.bytes, 0));
    const rows = await db.select({ accountId: accountStorage.accountId, bytes: accountStorage.bytes })
      .from(accountStorage).where(gt(accountStorage.bytes, 0))
      .orderBy(desc(accountStorage.bytes)).limit(AT_CAP_READ_LIMIT);
    const atCap: AtCapAccount[] = [];
    let read = 0;
    // A round the bound stopped leaves its accounts unread, so the reading says partial.
    const { answered } = await inPlaneRounds(entitlements, rows, (r) => entitlements.access(r.accountId), bound);
    // A held drop (cloud 0055) is the cap the trim keeps under, read only: one read for the batch.
    const holds = await storageHoldsOf(db, answered.filter(([, v]) => v.ok).map(([r]) => r.accountId));
    for (const [r, v] of answered) {
      if (v === UNMETERED_ACCESS) continue;
      read++;
      const limit = v.ok ? v.limits.storageBytes : null;
      const cap = limit === null || !v.ok
        ? null : storageLimitFrom(limit, v.trialStorage ?? null, holds.get(r.accountId) ?? null, now).capBytes;
      const bytes = Number(r.bytes);
      if (cap !== null && bytes >= cap) atCap.push({ accountId: r.accountId, bytes, storageBytesLimit: cap });
    }
    return { atCap, read, total: Math.max(Number(counted?.n ?? 0), rows.length) };
  };
}

/** The inputs the alert rules cannot read from this database, composed ONCE per host. */
export interface AlertReaders {
  parkedAccounts: ParkedAccountsReader | null;
  accountsAtCap: AccountsAtCapReader | null;
  /** The program's own failures (`/v1/ops`): `null` where nothing meters or the port cannot ask. */
  planeOps: PlaneOpsReader | null;
}

/** One bag per host, from the host's one entitlements composition, for both alert drivers. */
export function alertReadersOf(entitlements: EntitlementsComposition): AlertReaders {
  return {
    parkedAccounts: parkedAccountsOf(entitlements),
    accountsAtCap: accountsAtCapOf(entitlements),
    planeOps: planeOpsReaderOf(entitlements),
  };
}
