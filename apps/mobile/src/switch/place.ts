/**
 * WHERE THE OTHER APP OPENS: a closed set. From a letter with an invitation, the calendar opens at that event; from an
 * event that came from mail, the mail opens at that letter; otherwise each app opens where it was left (`last`). The
 * direction is fixed: ohmail names an event, ohcal names a message, and a place that points the other way is
 * malformed. An id is a uuid's shape, read inside the receiver's own account, never trusted beyond that.
 *
 * Imports nothing: the bridge's guard, the native payload and the page all read it.
 */

export type SwitchPlace =
  | { readonly to: "last" }
  | { readonly to: "event"; readonly id: string }
  | { readonly to: "message"; readonly id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A place this app may hand to its sibling: `from` is the sending app. */
export function isSwitchPlace(v: unknown, from: "ohmail" | "ohcal"): v is SwitchPlace {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  const keys = Object.keys(p);
  if (p.to === "last") return keys.length === 1;
  const named = from === "ohmail" ? "event" : "message";
  return p.to === named && keys.length === 2 && typeof p.id === "string" && UUID.test(p.id);
}

/** The place as one word for a native extra or a link's fragment: `last`, `event:<id>`, `message:<id>`. */
export function encodePlace(p: SwitchPlace): string {
  return p.to === "last" ? "last" : `${p.to}:${p.id}`;
}

/** The word back to a place, judged as `from` sent it; anything else is null. */
export function decodePlace(word: unknown, from: "ohmail" | "ohcal"): SwitchPlace | null {
  if (typeof word !== "string" || word.length > 64) return null;
  if (word === "last") return { to: "last" };
  const at = word.indexOf(":");
  if (at < 0) return null;
  const place = { to: word.slice(0, at), id: word.slice(at + 1) };
  return isSwitchPlace(place, from) ? place : null;
}
