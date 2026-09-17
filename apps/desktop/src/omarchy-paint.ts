/**
 * THE PAINT HALF OF THE OMARCHY FEED - the part that runs BEFORE THE FIRST FRAME.
 *
 * Apart from `omarchy.ts` because `boot-stamp.ts` is a blocking script and everything it reaches
 * is paint-blocking with it: the other half imports the mapping law, which no launch needs
 * before its first frame. Here it is the fence, the selector forms and one storage read. Values
 * land in ONE <style> scoped to `:root[data-face="ohmarchy"]` - inline properties on <html>
 * would repaint every face - and SCHEME x FACE STAYS ORTHOGONAL (OHMARCHY-CONTRACT.md): the
 * five selector forms `packages/tokens/src/ohmarchy.css` uses, written by one shared builder.
 */
import {
  fencedTokens,
  omarchyRuleText,
  OMARCHY_FACE_ATTRIBUTE,
  OMARCHY_FACE_VALUE,
} from "../../../packages/tokens/omarchy/rule.js";
/* The ONE scheme crossfade, shared with `ThemeProvider`'s stamp — a second animation of the
   same change would be two fades over one paint. Reached by path for the same reason the rule
   builder is: `@ohmail/ui` publishes one entry and this module wants one function from it. */
import { withSchemeTransition } from "../../../packages/ui/src/theme/scheme-transition.js";

export { fencedTokens, OMARCHY_FACE_ATTRIBUTE, OMARCHY_FACE_VALUE, omarchyRuleText };

/** The marker the feed sets on <html> once a live token set is standing. Signal, not style. */
export const OMARCHY_LIVE_ATTRIBUTE = "data-omarchy";

/** The one style element the feed owns. */
const STYLE_ID = "ohmail-omarchy-live";

/**
 * THE LAST GOOD PALETTE, KEPT FOR THE NEXT LAUNCH — beside `ohmail.face`, which is what the
 * pre-paint stamp already reads. The feed cannot answer before the window paints: the command
 * is a round trip to the shell, so the first frames wore the STATIC face block, whose light
 * side is flexoki-light's warm cream `#f2efe4`. On a dark desktop that is a pale flash before
 * the theme lands. Writing this row makes the theme's own canvas available BEFORE the first
 * paint; the pull then fades whatever changed.
 */
export const OMARCHY_PALETTE_KEY = "ohmail.omarchy.palette";
/** `v` is the record's shape, so a version this bundle does not know is ignored, not guessed. */
const PALETTE_VERSION = 1;

export interface CachedPalette {
  v: number;
  mode: "light" | "dark";
  native: Record<string, string>;
  counterpart: Record<string, string> | null;
}

const isTokenBag = (v: unknown): v is Record<string, string> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Write the token sets as the scoped rules. Exported for the feed and the tests; the style
 *  element is created on first use and reused for the window's life. */
export function applyOmarchyTokens(
  tokens: Record<string, string>,
  mode: "light" | "dark" = "dark",
  counterpart: Record<string, string> | null = null,
): void {
  const doc = typeof document === "undefined" ? null : document;
  if (!doc) return;
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  /* The style write goes INSIDE the transition: this is the other thing that repaints every
     token at once — the first pull re-skins from the static defaults to the live theme, and
     `omarchy theme set` restages the whole palette. Both were hard cuts. */
  const el = style;
  withSchemeTransition(() => {
    el.textContent = omarchyRuleText(tokens, mode, counterpart);
  });
  doc.documentElement.setAttribute(OMARCHY_LIVE_ATTRIBUTE, "live");
}

/**
 * Keep the mapped palette for the next launch. Best effort in both directions: a blocked jar
 * costs the next launch its pre-paint theme and nothing else, which is exactly the state every
 * launch was in before this row existed.
 */
export function cacheOmarchyPalette(payload: CachedPalette): void {
  try {
    localStorage.setItem(OMARCHY_PALETTE_KEY, JSON.stringify(payload));
  } catch {
    /* no jar — the next launch wears the static face for a frame, as it always did */
  }
}

/** The record version this bundle writes, so the feed and the cache cannot drift apart. */
export const OMARCHY_PALETTE_VERSION = PALETTE_VERSION;

/**
 * PAINT THE CACHED THEME BEFORE THE FIRST FRAME. Called by `boot-stamp.ts`, beside the face
 * stamp it depends on, and instant by construction: the crossfade is not armed until a frame
 * after the provider mounts. The cached values go through `applyOmarchyTokens`, so they meet
 * the SAME fence the live ones do — a row somebody edited in the jar cannot restructure the
 * stylesheet — and the selector forms have one writer.
 */
export function paintCachedOmarchyPalette(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(OMARCHY_PALETTE_KEY);
  } catch {
    return; // blocked jar: the static face stands, as before
  }
  if (raw === null) return;
  let cached: CachedPalette;
  try {
    cached = JSON.parse(raw) as CachedPalette;
  } catch {
    return;
  }
  if (cached?.v !== PALETTE_VERSION) return;
  if (cached.mode !== "light" && cached.mode !== "dark") return;
  if (!isTokenBag(cached.native)) return;
  const counterpart = isTokenBag(cached.counterpart) ? cached.counterpart : null;
  applyOmarchyTokens(cached.native, cached.mode, counterpart);
}

/** Tests only: drop the style element and the live marker this half owns. */
export function resetOmarchyPaintForTests(): void {
  const style = typeof document === "undefined" ? null : document.getElementById(STYLE_ID);
  style?.remove();
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute(OMARCHY_LIVE_ATTRIBUTE);
  }
}
