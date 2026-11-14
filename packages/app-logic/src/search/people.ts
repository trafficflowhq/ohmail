/**
 * THE PEOPLE A TEXT MEANS, from the address book: a name or an address that starts with it, nearest first (the name
 * starts with it, a later word of the name does, the address or its domain does), and from three letters on one that
 * holds it anywhere. Nothing typed: everybody, the most mail first. The book is the shell's, which leaves the account's
 * own addresses out.
 */
import type { AddressBookEntry } from "@ohmail/client-engine";

/** How near a person is to the text: 0 nearest; null not meant at all. */
function rankOf(p: AddressBookEntry, t: string): number | null {
  const name = p.name.toLowerCase();
  const address = p.address.toLowerCase();
  if (name.startsWith(t)) return 0;
  if (name.split(" ").some((w) => w.startsWith(t))) return 1;
  const domain = address.slice(address.indexOf("@") + 1);
  if (address.startsWith(t) || domain.startsWith(t)) return 2;
  if (t.length > 2 && (name.includes(t) || address.includes(t))) return 3;
  return null;
}

/**
 * THE ONE PERSON A FINISHED `from:` OR `to:` MEANS, or null where it is not exactly one: a whole address in the book,
 * else the one entry at the nearest rank, and only while no other entry carries that name.
 */
export function onePersonMeant(text: string, book: readonly AddressBookEntry[]): AddressBookEntry | null {
  const t = text.trim().toLowerCase();
  if (t === "") return null;
  let best: AddressBookEntry | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let atBest = 0;
  for (const p of book) {
    if (p.address.toLowerCase() === t) return p;
    const rank = rankOf(p, t);
    if (rank === null || rank > bestRank) continue;
    if (rank < bestRank) {
      best = p;
      bestRank = rank;
      atBest = 1;
    } else atBest++;
  }
  return best !== null && atBest === 1 && !sharesName(best, book) ? best : null;
}

/** Another entry of the book carries this one's name. */
export function sharesName(
  p: { readonly address: string; readonly name: string | null },
  book: readonly AddressBookEntry[],
): boolean {
  const name = (p.name ?? "").toLowerCase();
  if (name === "") return false;
  const address = p.address.toLowerCase();
  for (const other of book) {
    if (other.name.toLowerCase() === name && other.address.toLowerCase() !== address) return true;
  }
  return false;
}

export function peopleFor(text: string, book: readonly AddressBookEntry[]): AddressBookEntry[] {
  const t = text.trim().toLowerCase();
  const all = book;
  if (t === "") return [...all].sort((a, b) => b.count - a.count);
  const ranked: { p: AddressBookEntry; rank: number; i: number }[] = [];
  all.forEach((p, i) => {
    const rank = rankOf(p, t);
    if (rank !== null) ranked.push({ p, rank, i });
  });
  return ranked.sort((a, b) => a.rank - b.rank || b.p.count - a.p.count || a.i - b.i).map((x) => x.p);
}
