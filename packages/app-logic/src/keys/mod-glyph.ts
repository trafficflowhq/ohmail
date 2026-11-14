"use client";

/**
 * The modifier's own name on this keyboard — the one answer, in a module small enough to import
 * from anywhere that prints a keycap. Not in `keymap.tsx`, where it was written: the LANDING PAGE
 * turned out to print a modifier cap too (`⌘K everything, by name` — hand-typed, wrong on Linux and
 * Windows exactly as the app's caps were), and the marketing tree deliberately imports only LEAF
 * modules out of `shell/` — pulling `keymap.tsx` in would put the whole registry, its dispatcher
 * and `touch-keys.css` into a page whose only keyboard is a picture of one. The two functions moved
 * here and `keymap.tsx` re-exports them: every importer unchanged, one implementation.
 */
import { useSyncExternalStore } from "react";

/**
 * `mod` is one binding token — `chordMatches` accepts ⌘ or Ctrl for it — but a cap has to read
 * the way the key on the desk does: a Linux or Windows keyboard has no ⌘, and "⌘K" on it
 * documents a key that does nothing (reported: every modifier cap said ⌘ on Linux while Ctrl+K
 * opened the palette and Super+K did nothing). Detected from the platform, never from the face;
 * an iPad reporting as a Mac is a Mac for this purpose.
 */
export function modGlyph(): string {
  if (typeof navigator === "undefined") return "⌘";
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Macintosh|iPhone|iPad/.test(ua) ? "⌘" : "Ctrl";
}

const subscribeNever = () => () => {};
const serverMod = () => "⌘";

/**
 * `modGlyph()` for a render — hydration-safe. The server has no keyboard and says ⌘; the client
 * snapshot is the platform's, and `useSyncExternalStore` swaps to it as hydration completes
 * rather than as a later effect, so a client-only mount (the desktop) never paints the wrong cap.
 *
 * The server's ⌘ is therefore a REAL frame that a Linux reader can be served, and the repaint is
 * the thing that makes it harmless. `keycap-platform.test.tsx` drives that sequence — server
 * string, then hydrate, then read the cap — rather than trusting the argument in this sentence.
 */
export function useModGlyph(): string {
  return useSyncExternalStore(subscribeNever, modGlyph, serverMod);
}
