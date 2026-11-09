/**
 * THE SCREENER'S IMPERSONATION LINE, decided apart from the drawing: which filings it counts (an
 * `impersonation` filing newer than this phone's mark, ISO instants compared as text), the mark an
 * OK records, and the claim's own sentence for each letter.
 */
import { isSharedProviderDomain } from "../state/live";
import { Copy } from "../copy";
import type { AutoFiledItem } from "../net/auto-filed";

export function unseenImpersonations(items: readonly AutoFiledItem[], seen: string): AutoFiledItem[] {
  return items.filter((i) => i.why === "impersonation" && i.filedAt !== null && i.filedAt > seen);
}

/** The mark an OK records: the newest filing on the line, or the old mark when nothing is newer. */
export function newestSeen(items: readonly AutoFiledItem[], seen: string): string {
  return items.reduce((m, i) => (i.filedAt !== null && i.filedAt > m ? i.filedAt : m), seen);
}

/** Why a letter went: the claim's sentence, the shared-provider form where anyone can register the domain. */
export function impersonationWhy(i: AutoFiledItem): string {
  const from = i.from ?? "";
  const at = from.lastIndexOf("@");
  const domain = at < 0 ? "" : from.slice(at + 1).toLowerCase();
  const brand = i.brand ?? "";
  return isSharedProviderDomain(domain)
    ? Copy.senderCheckImpersonationShared(brand, domain)
    : Copy.senderCheckImpersonation(brand, domain);
}
