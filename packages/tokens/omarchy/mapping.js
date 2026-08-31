/* ohmarchy — the palette/settings mapping, colors.toml → ohmail token slots.
   OHMARCHY-PLAN.md §3c's contract, authored by Phase 3-zero. This file IS the
   mapping table: OHMARCHY-TOKENS.md documents it, the gallery runs it live,
   validate-mapping.mjs proves it against all 22 real fixtures. One source.

   Works as a plain <script> (window.OHMARCHY_MAP) and under node
   (module.exports). No dependencies.

   Every rule below is mechanical: colors.toml key → slot, a derivation
   formula, and a contrast floor with a bounded fallback walk. An integration
   lane implements nothing here — it ports this file.

   The derivation constants (fill/border alphas, scrim alpha) are Omarchy's
   own, read from the generated shell.toml on a real 4.0.2 install
   (shell.example.toml): normal fill .04 / hover fill .08 / selected .18 /
   control border .40 / hover border .25 / scrim .50. */
(function (root, factory) {
  /* Set BOTH exports: the repo root's package.json says type:module, so node
     loads this file as ESM there (module undefined, the global carries it) —
     but a copy extracted OUTSIDE the repo loads as CJS (module.exports
     carries it). Only setting one broke the other context; measured via the
     clean-archive check before first push. */
  const api = factory();
  if (typeof module === "object" && module !== null && typeof module.exports === "object") module.exports = api;
  root.OHMARCHY_MAP = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /* ── color math (sRGB; WCAG 2.x contrast) ────────────────────────────── */
  function hex(c) {
    const m = String(c).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) throw new Error("not a 6-digit hex color: " + c);
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function toHex(rgb) {
    return "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  }
  function mix(a, b, t) {
    const A = hex(a), B = hex(b);
    return toHex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t));
  }
  function alpha(c, a) {
    const [r, g, b] = hex(c);
    return `rgba(${r},${g},${b},${a})`;
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const [r, g, b] = hex(c);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /* Walk `c` toward `target` in 5% steps until it clears `floor` against
     `against`. Bounded (20 steps → target itself), monotonic, mechanical.
     Returns { value, walked } so a validator can report which themes needed it. */
  function ensure(c, against, floor, target) {
    let t = 0, v = c;
    while (contrast(v, against) < floor && t < 1) { t = Math.min(1, t + 0.05); v = mix(c, target, t); }
    return { value: v, walked: t > 0 ? Math.round(t * 100) : 0 };
  }

  /* ── the tag ramp: nearest-hue assignment ────────────────────────────────
     ohmail carries ten tag hue pairs, named for paper's colors. ohmarchy
     assigns each pair the theme's chromatic color nearest its paper hue
     angle; reuse is allowed (a 6-color theme covers 10 slots honestly
     rather than inventing hues the theme does not have). */
  function hue(c) {
    const [r, g, b] = hex(c).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return null; // achromatic — no hue to speak of
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  }
  function sat(c) {
    const [r, g, b] = hex(c).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  }
  const TAG_HUES = [
    ["pottery", 150], ["buch", 78], ["privat", 25], ["olive", 112],
    ["verdigris", 182], ["denim", 214], ["indigo", 250], ["iris", 288],
    ["mulberry", 320], ["heather", 352],
  ];

  /* ── the mapping ─────────────────────────────────────────────────────── */
  /* fixture: a parsed omarchy-fixtures/<slug>.json (or any object with
     { mode, colors }). Returns { tokens, notes } — tokens keyed by ohmail
     custom-property name, notes listing every fallback that fired. */
  function mapTheme(fixture) {
    const c = fixture.colors;
    const mode = fixture.mode === "light" ? "light" : "dark";
    const notes = [];
    const note = (slot, msg) => notes.push({ slot, msg });

    const bg = c.background, fg = c.foreground;
    const dfg = c.dark_foreground || fg;
    const bfg = c.bright_foreground || fg;

    /* Structural accent: focus borders, active bars, the lift-3 ring.
       Floor 3:1 against the tile (WCAG non-text), walking toward fg.
       A theme's border override may use Hyprland syntax — `rgba(RRGGBBAA)`,
       possibly two stops + an angle (a gradient). Tokens need one color:
       take the FIRST stop and drop its alpha (measured on the four themes
       that override: hackerman, last-horizon, lumon, solitude). */
    const hyprColor = (v) => {
      const m = String(v).match(/(?:rgba?\()?#?([0-9a-f]{6})(?:[0-9a-f]{2})?\)?/i);
      return m ? "#" + m[1] : v;
    };
    const accSrc = hyprColor(c.hyprland_active_border || c.active_border_color || c.accent);
    const accStruct = ensure(accSrc, bg, 3, fg);
    if (accStruct.walked) note("--accent", `structural accent walked ${accStruct.walked}% toward foreground (was ${contrast(accSrc, bg).toFixed(2)}:1 vs panel)`);

    /* Text accent: links, active labels. Floor 4.5:1, same walk. */
    const accText = ensure(accSrc, bg, 4.5, fg);
    if (accText.walked) note("--accent-ink", `text accent walked ${accText.walked}% toward foreground`);

    /* Ink ramp: fg is the theme's designed body text (floor 4.5 anyway);
       ink2/ink3 are mechanical mixes toward dark_foreground, floored so
       meta text never sinks below 4.5:1 on weak ramps. */
    const ink = ensure(fg, bg, 4.5, mode === "dark" ? "#ffffff" : "#000000");
    if (ink.walked) note("--ink", `foreground walked ${ink.walked}% toward ${mode === "dark" ? "white" : "black"}`);
    const ink2 = ensure(mix(fg, dfg, 1 / 3), bg, 4.5, fg);
    if (ink2.walked) note("--ink2", `walked ${ink2.walked}% back toward foreground`);
    const ink3 = ensure(mix(fg, dfg, 2 / 3), bg, 4.5, fg);
    if (ink3.walked) note("--ink3", `walked ${ink3.walked}% back toward foreground`);

    /* On-accent: whichever of the theme's own poles reads better on the
       accent; below 4.5:1 both, fall to plain black/white by luminance. */
    let onAccent = contrast(bg, accStruct.value) >= contrast(bfg, accStruct.value) ? bg : bfg;
    if (contrast(onAccent, accStruct.value) < 4.5) {
      onAccent = contrast("#000000", accStruct.value) >= contrast("#ffffff", accStruct.value) ? "#000000" : "#ffffff";
      note("--on-accent", "neither background nor bright_foreground cleared 4.5:1 on the accent; using plain " + onAccent);
    }

    /* Danger: the theme's red as TEXT (4.5:1). Achromatic themes (White)
       collapse it to gray on purpose — their own terminals do the same;
       weight and wording carry the meaning there. */
    const danger = ensure(c.red, bg, 4.5, fg);
    if (danger.walked) note("--danger", `red walked ${danger.walked}% toward foreground`);

    /* Tag ramp: nearest hue per slot from the chromatic set; ink floored
       at 4.5:1 as text, bg at alpha .14 (Omarchy renders its own tags/
       badges as tinted text, never candy chips). Achromatic palettes get
       the ink ramp instead of fake hues. */
    const pool = ["red", "yellow", "orange", "green", "cyan", "blue", "magenta",
      "bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue", "bright_magenta"]
      .map((k) => c[k]).filter(Boolean)
      .map((col) => ({ col, h: hue(col), s: sat(col) }))
      .filter((x) => x.h !== null && x.s > 0.08);
    const tags = {};
    for (const [name, target] of TAG_HUES) {
      let pick = null;
      if (pool.length) {
        pick = pool.reduce((best, x) => {
          const d = Math.min(Math.abs(x.h - target), 360 - Math.abs(x.h - target));
          return !best || d < best.d ? { d, col: x.col } : best;
        }, null).col;
      } else {
        pick = mix(fg, dfg, 0.33); // achromatic theme: tags are quiet ink
      }
      const tink = ensure(pick, bg, 4.5, fg);
      tags[`--tg-${name}-ink`] = tink.value;
      tags[`--tg-${name}-bg`] = alpha(pick, 0.14);
      if (tink.walked) note(`--tg-${name}-ink`, `walked ${tink.walked}% toward foreground`);
    }
    if (!pool.length) note("--tg-*", "achromatic palette: tag hues collapse to the ink ramp (matches the theme's own terminal)");

    /* The ring ladder — ohmarchy's lifts are borders, not shadows.
       lift-0 control ring: fg @ .40 (shell.toml normal border);
       lift-1 resting tile: Hyprland's inactive border, verbatim;
       lift-2 raised object: the theme's own muted border color;
       lift-3 floating layer: the ACTIVE border — a floating surface is
       the focused window, which is exactly Omarchy's idiom. */
    const inactive = "rgba(89,89,89,0.67)"; // hyprland default, fixed across themes
    const tokens = {
      "--canvas": c.dark_background || bg,
      "--panel": bg,
      "--float": bg,
      "--ink": ink.value,
      "--ink2": ink2.value,
      "--ink3": ink3.value,
      "--hair": alpha(fg, 0.25),
      "--hair-soft": alpha(fg, 0.12),
      "--tint": alpha(fg, 0.04),
      "--tint2": alpha(fg, 0.08),
      "--accent": accStruct.value,
      "--accent-ink": accText.value,
      "--accent-soft": alpha(accSrc, 0.12),
      "--accent-hair": alpha(accSrc, 0.42),
      "--accent-wash": alpha(accSrc, 0.06),
      "--on-accent": onAccent,
      "--danger": danger.value,
      "--focus": accStruct.value,
      ...tags,
      "--lift-0": `0 0 0 1px ${alpha(fg, 0.40)}`,
      "--lift-1": `0 0 0 2px ${inactive}`,
      "--lift-2": `0 0 0 2px ${c.muted || alpha(fg, 0.40)}`,
      "--lift-3": `0 0 0 2px ${accStruct.value}`,
      "--bar-edge": `0 1px 0 0 ${alpha(fg, 0.25)}`,
      "--scrim": alpha(bg, 0.5),
      "--sc-fade": "linear-gradient(to bottom, transparent, var(--float))",
      /* motion — Omarchy's own curves (looknfeel.conf easeOutQuint; the
         site's 0.15s color ease), replacing paper's springs */
      "--spring": "cubic-bezier(0.23,1,0.32,1)",
      "--swift": "cubic-bezier(0.33,1,0.68,1)",
      /* the new slots (paper defaults live in ohmarchy.tokens.json) */
      "--r-ctl": "0", "--r-card": "0", "--r-overlay": "0", "--r-pill": "0", "--r-avatar": "0",
      "--focus-w": "2px", "--focus-offset": "0px",
      "--gap-tile": "10px", "--gap-edge": "10px",
      "--font-ui": "'JetBrainsMono Nerd Font','JetBrains Mono',ui-monospace,'Cascadia Mono',Menlo,Consolas,monospace",
      "--font-size-base": "12px",
      "color-scheme": mode,
    };
    return { tokens, notes, mode };
  }

  return { mapTheme, contrast, mix, alpha, hue, ensure, TAG_HUES };
});
