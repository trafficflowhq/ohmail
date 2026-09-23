/**
 * THE WHOLE-MAILBOX COUNT LINE — the webapp's `search.scopeWhole*` rule over the one walker's
 * reading: the exact count, else the estimate's "about N" until the exact count replaces it,
 * else the first page's lower bound.
 */
import { Copy } from "../copy";

export function searchCountLine(s: { total: number; totalExact: boolean; about: number | null }): string {
  if (s.totalExact) return Copy.searchWhole(s.total);
  return s.about !== null ? Copy.searchWholeAbout(s.about) : Copy.searchWholeAtLeast(s.total);
}
