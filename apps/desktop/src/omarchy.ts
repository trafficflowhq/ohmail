/**
 * THE OMARCHY THEME FEED, from the window's side. On an Omarchy system the shell detects the
 * desktop theme, reads its raw material and watches it; this module turns that material into
 * ohmail token values for the ohmarchy face. PULL is the `omarchy_theme` command, asked once
 * at start (an event emitted before this bundle's scripts run is an event nobody hears); PUSH
 * is the `omarchy:theme` event over the one receive-only `core:event:allow-listen` grant
 * (`native.ts` carries the asymmetry's reasoning). Raw text down, nothing up. The mapped
 * values land in ONE <style> rule scoped to `:root[data-face="ohmarchy"]` — inline properties
 * on <html> would repaint every face; the attribute's name is this module's exported constant.
 */

/*
 * Every declaration carries `!important` — a cascade decision: the static follow-the-system
 * dark block's selector has specificity (0,3,0), outranking this rule's (0,2,0), so on a dark
 * desktop the static values would silently win; the live theme is BY DESIGN the top of the
 * token cascade, and no token stylesheet declares importance of its own. The fallback is
 * "keep what you have", never "render what you got": a payload that fails validation leaves
 * the last good set (or the static defaults) standing — broken chrome is the one forbidden
 * output. Values are fenced before they become CSS — a theme file is USER-AUTHORED, `}` could
 * write arbitrary rules — so names must match the token grammar; a failing pair is dropped.
 */

import { mapOmarchyTheme, type OmarchyThemeRaw } from "../../../packages/tokens/omarchy/map.js";

/** The event the shell emits when the desktop theme changed and went quiet. */
export const OMARCHY_THEME_EVENT = "omarchy:theme";

/** The command that answers the active theme's raw material, or null off-Omarchy. */
const OMARCHY_THEME_COMMAND = "omarchy_theme";

/**
 * The appearance attribute the live rule is scoped under. The theme machinery (3a) stamps
 * `data-face="ohmarchy"` when the ohmarchy face is chosen; until it does, the feed's rule
 * matches nothing and the window renders exactly as before this module existed.
 */
export const OMARCHY_FACE_ATTRIBUTE = "data-face";
export const OMARCHY_FACE_VALUE = "ohmarchy";

/** The marker the feed sets on <html> once a live token set is standing. Signal, not style. */
export const OMARCHY_LIVE_ATTRIBUTE = "data-omarchy";

/** The one style element the feed owns. */
const STYLE_ID = "ohmail-omarchy-live";

/** A token name: a custom property, or the one standard property the mapping emits. */
const TOKEN_NAME = /^(--[a-z0-9-]{1,64}|color-scheme)$/;
/** Characters that could restructure a stylesheet - close the block, open a rule, start
 *  an at-rule, escape, open a comment, or leave a bracket hanging - banned from values
 *  wholesale, control characters included. `/` goes as a CHARACTER because no real token
 *  value carries one and an embedded comment-opener would swallow every later declaration
 *  in the rule; square brackets likewise. */
// eslint-disable-next-line no-control-regex
const VALUE_BANNED = /[{}<>;@\\/[\]\u0000-\u001f\u007f]/;
const VALUE_MAX = 512;
const TOKENS_MAX = 200;

/** Parens must pair and nest: CSS error recovery inside an unmatched opening paren ignores
 *  semicolons, so a value ending rgba( would eat the rest of the rule — the whole theme,
 *  not one slot. Parens are not simply banned because they are real: the tag washes are
 *  rgba(...) values. */
function parensBalanced(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

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

/** The fence: names to the token grammar, values free of structural characters, the set
 *  bounded. Dropping is correct — the mapping's real outputs never trip this, so anything
 *  that does was never a token value. */
export function fencedTokens(tokens: Record<string, string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (out.length >= TOKENS_MAX) break;
    if (!TOKEN_NAME.test(name)) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > VALUE_MAX) continue;
    if (VALUE_BANNED.test(value) || !parensBalanced(value)) continue;
    out.push([name, value]);
  }
  return out;
}

/** Write the token set as the one scoped rule. Exported for the feed and the tests; the
 *  style element is created on first use and reused for the window's life. */
export function applyOmarchyTokens(tokens: Record<string, string>): void {
  const doc = typeof document === "undefined" ? null : document;
  if (!doc) return;
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  // `!important` per declaration — the module header carries the cascade argument.
  const lines = fencedTokens(tokens).map(([name, value]) => `  ${name}: ${value} !important;`);
  style.textContent =
    `:root[${OMARCHY_FACE_ATTRIBUTE}="${OMARCHY_FACE_VALUE}"] {\n${lines.join("\n")}\n}`;
  doc.documentElement.setAttribute(OMARCHY_LIVE_ATTRIBUTE, "live");
}

/* The feed's whole state: whether it started, so two mounts cannot double-listen. The last
   good set needs no variable — it IS the standing style element, which a failed update
   simply does not touch. */
let feedStarted = false;

/** Handle one payload — from the pull or the push. Every failure keeps the standing set. */
function handlePayload(payload: unknown): void {
  const raw = themeRawOfPayload(payload);
  if (raw === null) return;
  const mapped = mapOmarchyTheme(raw);
  if (mapped === null) return;
  applyOmarchyTokens(mapped.tokens);
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
  const style = typeof document === "undefined" ? null : document.getElementById(STYLE_ID);
  style?.remove();
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute(OMARCHY_LIVE_ATTRIBUTE);
  }
}
