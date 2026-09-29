/**
 * THE WHOLE-MAILBOX COUNT LINE — the webapp's `search.scopeWhole*` rule over the one walker's
 * reading: the exact count, else the estimate's "about N" until the exact count replaces it,
 * else the first page's lower bound. Over a store still taking the mailbox in, the same three
 * say "the mail synced so far" (`search.scopeSynced*`).
 */
import { substringOpen } from "@ohmail/client-engine";
import { Copy } from "../copy";

export function searchCountLine(s: { total: number; totalExact: boolean; about: number | null; importing?: boolean }): string {
  if (s.importing === true) {
    if (s.totalExact) return Copy.searchSynced(s.total);
    return s.about !== null ? Copy.searchSyncedAbout(s.about) : Copy.searchSyncedAtLeast(s.total);
  }
  if (s.totalExact) return Copy.searchWhole(s.total);
  return s.about !== null ? Copy.searchWholeAbout(s.about) : Copy.searchWholeAtLeast(s.total);
}

/**
 * WHERE A PART INSIDE A WORD IS LOOKED FOR — the webapp's `partsSaid`: said on the store's empty or
 * closest-words answer, never on an exact answer with rows, never while the store is still indexing
 * (its older rows are read by subject and sender alone), and only for a query that opens the stores'
 * substring arm (`substringOpen`, the one function the service opens it with).
 */
export function partReachSaid(q: string, s: { ready: boolean; indexedPercent: number | null; tier: "exact" | "similar"; length: number }): boolean {
  return s.ready && s.indexedPercent === null && (s.tier === "similar" || s.length === 0) && substringOpen(q.trim());
}
