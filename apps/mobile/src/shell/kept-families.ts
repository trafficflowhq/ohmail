/**
 * WHICH OF THE PAGE'S STORAGE KEYS HOLD A PERSON'S WORDS OR INTENT: those are written natively before
 * the page's own write, and the native copy wins where the two differ, because a web view's storage
 * can be emptied by the system and its process ended while the app lives. Every `localStorage` row
 * of the stored-key registry is classed here, kept or device; `test/shell-keeper.test.ts` holds the
 * classing total, so a row added to the registry without a class here is a red test. The native
 * keeper is handed {@link KEPT_FAMILIES} and refuses any key outside them.
 */
import { SCOPE_SHAPE } from "./scope";

/** Unsent letters and replies, the send's lock and note, and the three intent journals. */
export const KEPT_FAMILIES = [
  "ohmail.ui.compose.", "ohmail.compose.session.", "ohmail.compose.row.", "ohmail.ui.reply:", "ohmail.ui.replymeta:",
  "ohmail.ui.reply.", "ohmail.ui.replymeta.", "ohmail.send.locks.", "ohmail.send.notes.", "ohmail.screener.intents.",
  "ohmail.delete.intents.", "ohmail.routing.intents.",
] as const;

/**
 * Keys a kept family's prefix would reach that are a device's choice, not a person's words: the
 * composer's picture settings.
 */
export const DEVICE_UNDER_KEPT = ["ohmail.ui.compose.imageQuality", "ohmail.ui.compose.imageShrink"] as const;

/* Every other `localStorage` name of the registry is a device's: the look, the layout, the session's own
   state. Their classing is held by the test, name by name, so a new row must be classed there. */

const DEVICE_EXACT: ReadonlySet<string> = new Set(DEVICE_UNDER_KEPT);

/** Does this key hold a person's words or intent? */
export function isKept(key: string): boolean {
  if (DEVICE_EXACT.has(key)) return false;
  return KEPT_FAMILIES.some((family) => key.startsWith(family));
}

/** The two families whose keys name no owner: a reply begun where no storage owner was known. */
const UNOWNED_FAMILIES: ReadonlySet<string> = new Set(["ohmail.ui.reply:", "ohmail.ui.replymeta:"]);

/**
 * The scope a kept key names, or null. Every other family spells its owner right after its prefix, up to the key's
 * end, a `.` or a `:`; an owner of the scope's shape names that scope.
 */
export function scopeNamedBy(key: string): string | null {
  const family = isKept(key) ? KEPT_FAMILIES.find((f) => key.startsWith(f)) : undefined;
  if (family === undefined || UNOWNED_FAMILIES.has(family)) return null;
  const owner = key.slice(family.length).split(/[.:]/, 1)[0] ?? "";
  return SCOPE_SHAPE.test(owner) ? owner : null;
}
