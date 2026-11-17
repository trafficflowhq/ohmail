/**
 * A PROVIDER'S TEXT, AS THE STORE CAN HOLD IT. One rule for every text a provider wrote that this
 * pass hands to the database: no text or JSON column takes U+0000, and half a pair of code units
 * is written as another character (U+FFFD), so neither comes back as it went in.
 *
 * A KEY is a text a row is found again by, or handed back to its provider letter for letter. A
 * key the store cannot hold as it is names nothing in it. Where a row is found by it (an object's
 * id, a UID, an occurrence's key, a calendar's id), what it names is left out: never asked for,
 * never written, and never the reason a turn fails. Where it is only handed back (an object's
 * version, a reading's token), it is kept as none: the object is then written at every reading and
 * the calendar read whole each round, which is slow and never wrong. A text that is only shown (a
 * calendar's name) is kept as the store would keep it.
 *
 * The doors: the mapper (an object's id, UID, occurrence, version and texts), the read of a page's
 * stored rows (ids and UIDs), a page's removals and cancelled days, a reading's token, a listed
 * calendar (its id, name, colour and zone).
 */
const NUL = "\u0000";
const REPLACED = "\ufffd";

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Is every code unit of `s` a character, or half of a whole pair? */
export function wholePairs(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (isLow(unit)) return false;
    if (!isHigh(unit)) continue;
    if (!isLow(s.charCodeAt(i + 1))) return false;
    i++;
  }
  return true;
}

/** Does the store hold this text as it is, and find a row by it again? */
export function storableKey(s: string): boolean {
  return !s.includes(NUL) && wholePairs(s);
}

/** A text that is only shown, as the store keeps it: U+0000 taken out, U+FFFD where half a pair stood. */
export function storedText(s: string): string {
  if (storableKey(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit === 0) continue;
    if (isHigh(unit) && isLow(s.charCodeAt(i + 1))) {
      out += s.slice(i, i + 2);
      i++;
    } else {
      out += isHigh(unit) || isLow(unit) ? REPLACED : s[i]!;
    }
  }
  return out;
}
