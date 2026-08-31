/**
 * The reader for an Omarchy theme's `colors.toml` — the single file that defines an
 * Omarchy 4 theme's palette (`~/.local/state/omarchy/current/theme/colors.toml`).
 *
 * ── WHY A READER OF OUR OWN AND NOT A TOML LIBRARY ──────────────────────────────────────────
 *
 * The file's whole grammar, measured over every one of the 22 themes a real Omarchy 4.0.2
 * install ships (the raw files were pulled off a stock install, never off documentation), is one
 * line shape: `key = "value"` — flat, no sections, no arrays, no escapes, every value
 * double-quoted. The monorepo's mapping suite holds this reader byte-for-byte against the
 * committed JSON parses of all 22, so the day Omarchy's own format grows past this grammar, the
 * fixture refresh fails the suite instead of the reader silently mis-reading a live theme. A TOML
 * dependency would be a parser for a grammar the file does not use, in the desktop window's
 * bundle, for zero lines saved here.
 *
 * ── WHAT A LINE THIS READER DOES NOT RECOGNISE MEANS ────────────────────────────────────────
 *
 * Nothing. It is skipped, deliberately: a comment, a blank, a future `[section]` — none of
 * them can make the palette WRONG, only smaller, and the mapping's own floors and fallbacks
 * (`mapping.js`) are the layer that decides whether a smaller palette is still usable. The one
 * hard refusal is a file with no `background` or no `foreground`, because a palette without
 * its two poles is not a palette and mapping it would throw somewhere less explicable.
 */

export interface OmarchyPalette {
  /** "light" | "dark" — colors.toml's own `mode` key is authoritative (5 of 22 are light). */
  mode: "light" | "dark";
  /** Every `key = "value"` pair except `mode`, exactly as written — hex colors, and for the
   *  border-override keys possibly Hyprland's `rgba(RRGGBBAA) …` syntax, which `mapping.js`
   *  reads with its own `hyprColor`. */
  colors: Record<string, string>;
}

/** The two keys a palette cannot be a palette without. */
const REQUIRED = ["background", "foreground"] as const;

/** One `key = "value"` line; anything else is not part of the measured grammar. */
const LINE = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*$/;

/** sRGB relative luminance of a 6-digit hex color, for the mode fallback below. */
function luminance(hex: string): number | null {
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

/**
 * Read a colors.toml text into the shape `mapping.js` maps — or `null` for a text that is not
 * one, which the caller treats as "keep the last good theme" (never as "map it anyway").
 *
 * `mode` when the file omits it falls back to background luminance — the same chain Omarchy's
 * own `omarchy-theme-color` uses for user themes. All 22 shipped themes carry the key; the
 * fallback exists for the user-authored theme this process will meet in the field.
 */
export function parseColorsToml(text: string): OmarchyPalette | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const colors: Record<string, string> = {};
  let mode: string | null = null;
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    if (m[1] === "mode") mode = m[2];
    else colors[m[1]] = m[2];
  }
  for (const key of REQUIRED) {
    if (typeof colors[key] !== "string" || colors[key].length === 0) return null;
  }
  if (mode === "light" || mode === "dark") return { mode, colors };
  const lum = luminance(colors.background);
  if (lum === null) return null; // a background that is not a color is not a theme
  return { mode: lum > 0.5 ? "light" : "dark", colors };
}
