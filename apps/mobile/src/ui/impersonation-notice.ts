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

/**
 * A mark of the letters on the Spam shelf, the fact its count follows: a filing changes it, so the
 * line asks again. Order-sensitive, which at worst asks once more than needed.
 */
export function spamLettersMark(rows: readonly { held: readonly { id: string }[] }[]): string {
  let n = 0;
  let h = 0x811c9dc5;
  for (const r of rows) {
    for (const m of r.held) {
      n++;
      for (let i = 0; i < m.id.length; i++) h = Math.imul(h ^ m.id.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 0x2c, 0x01000193);
    }
  }
  return `${n}:${(h >>> 0).toString(36)}`;
}
