/**
 * THE WHOLE-MAILBOX COUNT LINE — the webapp's `search.scopeWhole*` rule over the one walker's
 * reading: the exact count, else the estimate's "about N" until the exact count replaces it,
 * else the first page's lower bound. Over a store still taking the mailbox in, the same three
 * say "the mail synced so far" (`search.scopeSynced*`).
 */
import { Copy } from "../copy";

export function searchCountLine(s: { total: number; totalExact: boolean; about: number | null; importing?: boolean }): string {
  if (s.importing === true) {
    if (s.totalExact) return Copy.searchSynced(s.total);
    return s.about !== null ? Copy.searchSyncedAbout(s.about) : Copy.searchSyncedAtLeast(s.total);
  }
  if (s.totalExact) return Copy.searchWhole(s.total);
  return s.about !== null ? Copy.searchWholeAbout(s.about) : Copy.searchWholeAtLeast(s.total);
}
