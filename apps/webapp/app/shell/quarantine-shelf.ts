/**
 * The Quarantine shelf: with "Use folders" on, the Screener's Junk segment lists the provider's
 * Junk live, and the mirror's Spam pile also holds letters the verdict filed there. The server
 * names which pile letters actually sit in ohmail/Quarantine (`JunkSweepWire.held`); the shelf is
 * the mirror's spam rows cut down to those letters, so a release moves only what is listed.
 */

import type { SpamRow } from "./screener-state";

/** Each row restricted to its held letters; rows left empty are dropped. Order and `pinned` kept. */
export function quarantineShelf(spam: readonly SpamRow[], held: ReadonlySet<string>): SpamRow[] {
  const out: SpamRow[] = [];
  for (const row of spam) {
    const kept = row.sender.held.filter((m) => held.has(m.id));
    if (kept.length === 0) continue;
    out.push(kept.length === row.sender.held.length ? row : { ...row, sender: { ...row.sender, held: kept } });
  }
  return out;
}

/** The Junk window's filter rule (`junkRowMatches`) over a shelf row: name, address, held subjects. */
export function shelfRowMatches(row: SpamRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const { from, held } = row.sender;
  return from.address.toLowerCase().includes(q)
    || (from.name?.toLowerCase().includes(q) ?? false)
    || held.some((m) => m.subject.toLowerCase().includes(q));
}
