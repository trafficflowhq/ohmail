/**
 * THE PALETTE FOR THE SCHEME AN OMARCHY THEME DOES NOT HAVE.
 *
 * An Omarchy theme states ONE mode in its `colors.toml` (`mode = "dark"`), and the mapping law
 * produces one token set from it. The scheme control has three states, so the face owes a
 * second set: light for a dark theme, dark for a light one, in the theme's own colours.
 *
 * This file derives that second PALETTE and hands it to the UNCHANGED law — one law, two
 * inputs, so every contrast floor, walk and note in `mapping.js` applies to both schemes and
 * `clearsFloors` verifies both outputs. The rejected alternatives were Omarchy's own sibling
 * themes (only latte/mocha pair up — not a mechanism) and a per-token inversion table (a
 * second law, free to drift from the first).
 *
 * The swap is of ROLES, not of hues: the theme's ground becomes its ink, its ink tints the new
 * paper, and the accents and the chromatic pool cross verbatim — the law's walks then fix
 * their contrast against the new panel by walking toward the new foreground, so accents darken
 * for a light counterpart and lighten for a dark one. Hue identity survives in the `.14` tag
 * washes, which are never walked.
 *
 * A counterpart is NOT a sibling theme. catppuccin-latte's dark counterpart is latte's own
 * ink and paper swapped — it is not mocha, and no copy anywhere may call it the theme's dark
 * variant.
 */
import "./mapping.js";
import type { OmarchyPalette } from "./colors-toml.js";

/**
 * The two recipes, keyed by the SOURCE mode. `tint` is the theme's own colour that carries the
 * hue onto the new surfaces — the pole ALREADY on the counterpart's side of the scale: a dark
 * theme's foreground is light (tokyo-night's #a9b1d6), a light theme's paper is its background
 * (flexoki-light's #FFFCF0). `panel` mixes that tint toward the new pole; `canvas` then steps
 * the PANEL toward black, which is the only step that survives near a pole.
 *
 * Measured, 2026-09-14: deriving the canvas as a second mix of the same source toward the same
 * pole (0.84 / 0.86) compressed to nothing in WCAG terms — all 22 stock themes missed the
 * canvas/panel floor, three of them at exactly 1.00, because near white or black the +0.05
 * offset dominates the ratio. Sourcing a light theme's dark counterpart from its FOREGROUND
 * had the same shape: flexoki-light's ink is #100F0F, and 78 % of the way from there to black
 * is darker than any shipped dark theme's panel with no room left behind it.
 */
const RECIPE = {
  dark: { tint: "foreground", pole: "#ffffff", panel: 0.92, canvas: 0.07, mode: "light" },
  light: { tint: "background", pole: "#000000", panel: 0.89, canvas: 0.4, mode: "dark" },
} as const;

/**
 * The counterpart palette, or `null` for material the colour math cannot read — which the
 * caller treats as "this theme has no counterpart", never as "map it anyway": the static
 * `ohmarchy.css` block for that scheme then stands, readable and on-brand.
 */
export function counterpartPalette(palette: OmarchyPalette): OmarchyPalette | null {
  const map = globalThis.OHMARCHY_MAP;
  const recipe = RECIPE[palette.mode];
  try {
    const panel = map.mix(palette.colors[recipe.tint], recipe.pole, recipe.panel);
    const canvas = map.mix(panel, "#000000", recipe.canvas);
    /* The theme's ground becomes the ink. `dark_foreground` is the ramp the law walks ink2/ink3
       down; `muted` is the lift-2 ring, ~28 % ink over the panel (flexoki-light's own #B7B5AC). */
    const ink = palette.colors.background;
    return {
      mode: recipe.mode,
      colors: {
        ...palette.colors,
        background: panel,
        dark_background: canvas,
        foreground: ink,
        dark_foreground: map.mix(ink, panel, 0.6),
        bright_foreground: ink,
        muted: map.mix(panel, ink, 0.28),
      },
    };
  } catch {
    return null;
  }
}
