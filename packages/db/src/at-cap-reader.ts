import { desc, gt, sql } from "drizzle-orm";
import { accountStorage } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import {
  isMetered, parkedAccountsOf, PARKED_READ_CONCURRENCY, UNMETERED_ACCESS,
  type AccountsAtCapReader, type AtCapAccount, type EntitlementsComposition,
  type ParkedAccountsReader,
} from "./entitlements-port.js";

/**
 * How many accounts one reading asks about, largest stored bytes first. A bound on the pass, and a
 * STATED one: past it the reading is partial and the storage rule says "N of M accounts read".
 */
export const AT_CAP_READ_LIMIT = 500;

/**
 * WHO IS AT THEIR STORAGE CAP — the bytes this database counts (`account_storage`) against the cap
 * the entitlements program states, asked through the host's cached `access`. `null` on an unmetered
 * host: nobody is capped there, and the caller says so. An account whose ask fell to the client's
 * fault arm with nothing held (`UNMETERED_ACCESS` itself) is not read, so an outage reads partial.
 */
export function accountsAtCapOf(entitlements: EntitlementsComposition): AccountsAtCapReader | null {
  if (!isMetered(entitlements)) return null;
  return async (db: Tx) => {
    const [counted] = await db.select({ n: sql<number>`count(*)::int` })
      .from(accountStorage).where(gt(accountStorage.bytes, 0));
    const rows = await db.select({ accountId: accountStorage.accountId, bytes: accountStorage.bytes })
      .from(accountStorage).where(gt(accountStorage.bytes, 0))
      .orderBy(desc(accountStorage.bytes)).limit(AT_CAP_READ_LIMIT);
    const atCap: AtCapAccount[] = [];
    let read = 0;
    for (let i = 0; i < rows.length; i += PARKED_READ_CONCURRENCY) {
      const chunk = rows.slice(i, i + PARKED_READ_CONCURRENCY);
      const verdicts = await Promise.all(chunk.map((r) => entitlements.access(r.accountId)));
      chunk.forEach((r, j) => {
        const v = verdicts[j]!;
        if (v === UNMETERED_ACCESS) return;
        read++;
        const cap = v.ok ? v.limits.storageBytes : null;
        const bytes = Number(r.bytes);
        if (cap !== null && bytes >= cap) atCap.push({ accountId: r.accountId, bytes, storageBytesLimit: cap });
      });
    }
    return { atCap, read, total: Math.max(Number(counted?.n ?? 0), rows.length) };
  };
}

/** The inputs the alert rules cannot read from this database, composed ONCE per host. */
export interface AlertReaders {
  parkedAccounts: ParkedAccountsReader | null;
  accountsAtCap: AccountsAtCapReader | null;
}

/** One bag per host, from the host's one entitlements composition, for both alert drivers. */
export function alertReadersOf(entitlements: EntitlementsComposition): AlertReaders {
  return { parkedAccounts: parkedAccountsOf(entitlements), accountsAtCap: accountsAtCapOf(entitlements) };
}
