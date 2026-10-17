/**
 * "DID YOU MEAN …?" FOR THE SIGNUP ADDRESS. A typo in the domain sends the confirmation mail nowhere,
 * and the browser's own check passes `mila@gmailcom` and `mila@gmial.com` alike. This names the common
 * mail domain an address was most likely meant to have, and only that: a domain the list does not know
 * is never second-guessed, a known domain is never "corrected", and the person decides (the hint is a
 * button that applies it). The cases: the dot left out (gmailcom), one letter swapped, missing, extra or
 * wrong (gmial.com, gmal.com, gmaill.com, gmail.con).
 */
const KNOWN: readonly string[] = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com",
  "yahoo.com", "gmx.de", "gmx.net", "gmx.ch", "gmx.at", "web.de", "t-online.de", "proton.me",
  "protonmail.com", "fastmail.com", "bluewin.ch",
];

/** Optimal string alignment distance (Levenshtein plus one adjacent swap), capped early. */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** The address with its domain corrected to a known one, or null when there is nothing to suggest. */
export function addressSuggestion(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).trim().toLowerCase();
  if (domain.length < 4 || KNOWN.includes(domain)) return null;
  const undotted = KNOWN.find((k) => k.replace(/\./g, "") === domain);
  if (undotted) return `${local}@${undotted}`;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const k of KNOWN) {
    const dist = distance(domain, k);
    if (dist < bestDistance) { best = k; bestDistance = dist; }
  }
  return best !== null && bestDistance === 1 ? `${local}@${best}` : null;
}
