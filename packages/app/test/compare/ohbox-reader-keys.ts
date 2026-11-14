/**
 * THE READER'S KEYS OF THE SCREEN `ohbox` (CHECK-JOIN-2 RULINGS (i) 2, 4 and 5), as functions over the manifest,
 * never as a list: which keys are the reader's, which of them are compared by its parts, and which are declared
 * `notDrawn: "state"`, with the task each class names. The comparison of the reader's parts registers its keys by
 * these and holds every declared row against them.
 */
import type { Manifest } from "../../../../test/compare/registry.d.mts";

/** A key's parameters, as the reference writes them (`a=1&b=2`). */
export const paramsOf = (key: string): Map<string, string> => new Map(new URLSearchParams(key).entries());

/** Parameters that make a key another task's: the writing's, the calendar's, the search's, the frame's notices. */
const OTHERS = [
  "reply",
  "draft",
  "note",
  "send",
  "kb",
  "cal",
  "ics",
  "org",
  "press",
  "over",
  "fx",
  "notice",
  "said",
  "told",
] as const;

/** The `show=` values that are the reader's on the Ohbox's screen. */
const SHOWS = [
  "card",
  "audit",
  "subject",
  "msgmenu",
  "details",
  "more",
  "move",
  "resurface",
  "pickday",
  "tag",
  "file",
  "allfiles",
] as const;

/** (i) 2: the reader's keys of the screen `ohbox`, in the manifest's order. */
export function ohboxReaderKeys(manifest: Manifest): string[] {
  return manifest.rows
    .filter((row) => row.shard === "ohbox")
    .map((row) => row.key)
    .filter((key) => {
      const p = paramsOf(key);
      const open = p.get("open");
      if (open === undefined || open === "none") return false;
      if (OTHERS.some((name) => p.has(name))) return false;
      const show = p.get("show");
      return show === undefined || (SHOWS as readonly string[]).includes(show);
    });
}

/** (i) 4: the parameters a key compared by parts may carry beside `open` and `screen`. */
const BY_PARTS = ["hold", "at", "hist", "gap", "copy", "device", "face", "scheme"] as const;
const SHOWN_BY_PARTS = [
  "card",
  "msgmenu",
  "details",
  "more",
  "move",
  "resurface",
  "pickday",
  "tag",
  "allfiles",
] as const;
/** The windows the states page stands (a posture of a folding phone is none of them). */
const DEVICES = ["desktop", "phone", "fold", "foldl"] as const;

/** (i) 4: a key of the rule that is compared by the reader's parts. */
export function comparedByParts(key: string): boolean {
  const p = paramsOf(key);
  for (const [name, value] of p) {
    if (name === "open" || name === "screen") continue;
    if (name === "show") {
      if (!(SHOWN_BY_PARTS as readonly string[]).includes(value)) return false;
      continue;
    }
    if (!(BY_PARTS as readonly string[]).includes(name)) return false;
    if (name === "device" && !(DEVICES as readonly string[]).includes(value)) return false;
  }
  return true;
}

/**
 * (i) 5: the task a declared key of the rule names, by the first class it meets, in the ruling's order; null where no
 * class of the ruling names the key (a key the comparison must then not leave undeclared: the case says which).
 */
export function declaredTask(key: string): { task: string; class: string } | null {
  const p = paramsOf(key);
  const show = p.get("show");
  if (p.has("posture") || p.has("turn") || p.has("make") || p.has("across"))
    return { task: "phone-touch", class: "posture" };
  if (show === "file" || p.has("look")) return { task: "write", class: "file" };
  if (show === "audit" || show === "subject" || p.has("subject") || p.has("ask") || p.has("term"))
    return { task: "screener", class: "screener" };
  if (p.has("zone")) return { task: "ohbox", class: "zone" };
  if (p.has("tagsopen")) return { task: "frame", class: "rail" };
  if (["panel", "rail", "edge", "accent", "titles", "title"].some((name) => p.has(name)))
    return { task: "settings", class: "settings" };
  if (p.has("mark")) return { task: "phone-touch", class: "mark" };
  return null;
}
