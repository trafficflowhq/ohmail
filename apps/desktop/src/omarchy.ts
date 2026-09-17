/**
 * THE OMARCHY THEME FEED, from the window's side: raw theme material in, ohmail token values
 * out. PULL is the `omarchy_theme` command asked once at start (an event emitted before this
 * bundle runs is an event nobody hears); PUSH is the `omarchy:theme` event over the receive-only
 * listen grant. Raw text down, nothing up.
 *
 * This is the half that reaches the mapping law, so it is the half that may NOT be
 * paint-blocking: `omarchy-paint.ts` holds the fence, the forms and the cached palette, and its
 * names are re-exported here so the split is a fact about the bundle, not about the callers.
 */

/*
 * The fallback is "keep what you have", never "render what you got": a payload that fails
 * validation leaves the last good set (or the static defaults) standing — broken chrome is the
 * one forbidden output. Values are fenced before they become CSS — a theme file is
 * USER-AUTHORED, `}` could write arbitrary rules — so names must match the token grammar; a
 * failing pair is dropped. The fence and the cascade argument live with the rule builder.
 */

import { mapOmarchyThemePair, type OmarchyThemeRaw } from "../../../packages/tokens/omarchy/map.js";
import {
  applyOmarchyTokens,
  cacheOmarchyPalette,
  OMARCHY_PALETTE_VERSION,
  resetOmarchyPaintForTests,
} from "./omarchy-paint.js";

export {
  applyOmarchyTokens,
  cacheOmarchyPalette,
  fencedTokens,
  omarchyRuleText,
  paintCachedOmarchyPalette,
  OMARCHY_FACE_ATTRIBUTE,
  OMARCHY_FACE_VALUE,
  OMARCHY_LIVE_ATTRIBUTE,
  OMARCHY_PALETTE_KEY,
} from "./omarchy-paint.js";

/** The event the shell emits when the desktop theme changed and went quiet. */
export const OMARCHY_THEME_EVENT = "omarchy:theme";

/** The command that answers the active theme's raw material, or null off-Omarchy. */
const OMARCHY_THEME_COMMAND = "omarchy_theme";

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>, options?: unknown): Promise<unknown>;
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
}

function internals(): TauriInternals | null {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const found = host.__TAURI_INTERNALS__;
  if (typeof found?.invoke !== "function" || typeof found?.transformCallback !== "function") {
    return null;
  }
  return found as TauriInternals;
}

/** One optional field: a string within its bound, or null for everything else — a shell one
 *  version ahead sending a shape this bundle does not know degrades that INGREDIENT, never
 *  the feed. */
function stringOrNull(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * The raw theme material a payload carried, or null when it carried none worth mapping.
 * Accepts the value itself or the event envelope (`{ payload }`), `native.ts`'s rule.
 */
export function themeRawOfPayload(payload: unknown): OmarchyThemeRaw | null {
  let raw = payload as Record<string, unknown> | null;
  if (raw !== null && typeof raw === "object" && typeof raw.colorsToml !== "string") {
    raw = (raw as { payload?: unknown }).payload as Record<string, unknown> | null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const colorsToml = stringOrNull(raw.colorsToml, 256 * 1024);
  if (colorsToml === null) return null;
  return {
    colorsToml,
    shellToml: stringOrNull(raw.shellToml, 256 * 1024),
    fcMono: stringOrNull(raw.fcMono, 4096),
    hyprGapsIn: stringOrNull(raw.hyprGapsIn, 4096),
    hyprGapsOut: stringOrNull(raw.hyprGapsOut, 4096),
    hyprBorderSize: stringOrNull(raw.hyprBorderSize, 4096),
  };
}

/* The feed's whole state: whether it started, so two mounts cannot double-listen. The last
   good set needs no variable — it IS the standing style element, which a failed update
   simply does not touch. */
let feedStarted = false;

/**
 * WHAT "THE SYSTEM" IS ON THIS DESKTOP — the last mapped theme's own mode, or null before the
 * first payload and on every system that is not an Omarchy one, where `prefers-color-scheme`
 * answers instead. The PAINT never reads this: under the auto state the face's
 * no-explicit-theme rule already carries the live set. It exists so the scheme control's
 * sentence is true and so a press knows what a hand-back to auto would render.
 */
let liveMode: "light" | "dark" | null = null;
const modeWatchers = new Set<() => void>();

/** `SystemSchemeSource` for `ThemeProvider` — declared in @ohmail/ui, implemented here. */
export const omarchySchemeSource = {
  get: (): "light" | "dark" | null => liveMode,
  subscribe: (onChange: () => void): (() => void) => {
    modeWatchers.add(onChange);
    return () => modeWatchers.delete(onChange);
  },
};

/** Handle one payload — from the pull or the push. Every failure keeps the standing set. */
function handlePayload(payload: unknown): void {
  const raw = themeRawOfPayload(payload);
  if (raw === null) return;
  const mapped = mapOmarchyThemePair(raw);
  if (mapped === null) return;
  applyOmarchyTokens(mapped.native.tokens, mapped.mode, mapped.counterpart?.tokens ?? null);
  cacheOmarchyPalette({
    v: OMARCHY_PALETTE_VERSION,
    mode: mapped.mode,
    native: mapped.native.tokens,
    counterpart: mapped.counterpart?.tokens ?? null,
  });
  liveMode = mapped.mode;
  for (const watcher of modeWatchers) watcher();
}

/**
 * Start following the desktop theme. Silent outside the shell (a development server, the
 * render check) and on every system that is not an Omarchy one — the command answers null
 * there and nothing is applied, listened for, or retried.
 *
 * Listen FIRST, then pull: a restage that goes quiet between the two is then heard through
 * the listener instead of falling between them.
 */
export async function startOmarchyFeed(): Promise<void> {
  const shell = internals();
  if (!shell || feedStarted) return;
  feedStarted = true;
  try {
    const handler = shell.transformCallback((payload: unknown) => handlePayload(payload));
    await shell.invoke("plugin:event|listen", {
      event: OMARCHY_THEME_EVENT,
      target: { kind: "Any" },
      handler,
    });
    handlePayload(await shell.invoke(OMARCHY_THEME_COMMAND));
  } catch {
    /* An older shell without the command, or a grant that dropped it: no feed, and the
       static ohmarchy defaults stand — which is exactly what off-Omarchy looks like. */
  }
}

/** Tests only: forget the started flag so each test drives a fresh feed. */
export function resetOmarchyFeedForTests(): void {
  feedStarted = false;
  liveMode = null;
  modeWatchers.clear();
  resetOmarchyPaintForTests();
}
