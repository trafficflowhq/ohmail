/**
 * THE PRODUCTION PATH: a live Omarchy theme's raw material → ohmail token values.
 *
 * One function assembles the three layers this directory holds:
 *
 *   colors-toml.ts   reads the theme's colors.toml text into the palette shape,
 *   mapping.js       — THE law (verbatim from Phase 3-zero) — maps palette → token slots
 *                    with every contrast floor and bounded fallback walk,
 *   settings.ts      lays the system's own font/size/gap/border over the slots §5 gives them.
 *
 * Everything that consumes the live feed — the desktop window, the tests, the VM harness —
 * goes through `mapOmarchyTheme`, so "all 22 themes clear every floor" is a property of the
 * path that ships, not of a validator beside it.
 */

import "./mapping.js";
import { parseColorsToml, type OmarchyPalette } from "./colors-toml.js";
import { counterpartPalette } from "./counterpart.js";
import { applySettings, parseSystem, type OmarchySystemRaw } from "./settings.js";
import type { OhmarchyMap, OhmarchyMapResult } from "./mapping.js";

/**
 * The mapping, off the global its UMD body registers (the file carries no ESM exports so it
 * can also run as a plain <script> in the gallery — its own header says why). The import
 * above is the side effect that defines it; this accessor is the one place the global is
 * named, typed by `mapping.d.ts`.
 */
export function omarchyMap(): OhmarchyMap {
  return globalThis.OHMARCHY_MAP;
}

/** What the desktop shell hands the window: the theme's own file, and the system facts. */
export interface OmarchyThemeRaw extends OmarchySystemRaw {
  /** `current/theme/colors.toml`, whole file. The one REQUIRED ingredient. */
  colorsToml: string;
}

/** The floors the law promises, verified on the OUTPUT rather than trusted to the walk:
 *  `ensure`'s walk mixes toward the palette's own foreground, so a palette whose foreground
 *  sits near its background can run the walk to the end and still land under the floor —
 *  every step "helped" and none sufficed. All 22 stock themes clear these; the palette that
 *  fails them is user-authored and unreadable-by-contrast, and the honest answer for it is
 *  the same as for one that does not parse: keep the last good theme. */
export function clearsFloors(map: OhmarchyMap, t: Record<string, string>): boolean {
  const panel = t["--panel"];
  const floors: [string, string, number][] = [
    ["--ink", panel, 4.5],
    ["--ink2", panel, 4.5],
    ["--ink3", panel, 4.5],
    ["--accent", panel, 3],
    ["--accent-ink", panel, 4.5],
    ["--on-accent", t["--accent"], 4.5],
    ["--danger", panel, 4.5],
    ...map.TAG_HUES.map(([name]): [string, string, number] => [`--tg-${name}-ink`, panel, 4.5]),
  ];
  try {
    return floors.every(([slot, against, floor]) => map.contrast(t[slot], against) >= floor);
  } catch {
    return false; // a slot the contrast math cannot read is a floor not cleared
  }
}

/**
 * Map one live theme, or answer `null` for material that is not one — and `null` means the
 * caller KEEPS what it has (the last good token set, or the static defaults), never that it
 * renders a half-mapped theme.
 *
 * A palette the floors have to fight is not a failure: the walks in `mapping.js` are the
 * designed response, and `notes` says which fired. Unreadable material answers `null` — and
 * so does a palette the walks could not save, because a floor is a promise about the OUTPUT.
 */
export function mapOmarchyTheme(raw: OmarchyThemeRaw): OhmarchyMapResult | null {
  const palette = parseColorsToml(raw.colorsToml);
  if (palette === null) return null;
  const map = omarchyMap();
  let mapped: OhmarchyMapResult;
  try {
    mapped = map.mapTheme(palette);
  } catch {
    /* A palette the law itself refuses (e.g. a required color that is not hex). The last
       good theme is the honest render; broken chrome is not. */
    return null;
  }
  if (!clearsFloors(map, mapped.tokens)) return null;
  return { ...mapped, tokens: applySettings(mapped.tokens, parseSystem(raw)) };
}

/**
 * The counterpart's one ADDED floor: a tile must read as a tile. The law's own floors are all
 * about text and accents on the panel and say nothing about the panel against the canvas —
 * true of every stock theme, which authors both, and NOT true by construction of a derived
 * pair whose two surfaces are mixes of one colour toward one pole.
 */
export function clearsCounterpartFloors(map: OhmarchyMap, t: Record<string, string>): boolean {
  if (!clearsFloors(map, t)) return false;
  try {
    return map.contrast(t["--canvas"], t["--panel"]) >= 1.06;
  } catch {
    return false;
  }
}

/** Both schemes of one live theme: the one it states, and the one it does not. */
export interface OmarchyThemeMapping {
  /** The theme's own scheme — exactly what `mapOmarchyTheme` answers. */
  native: OhmarchyMapResult;
  /**
   * The scheme the theme does not have, or `null` when the derivation missed a floor. Null is
   * "keep what you have" again: the caller emits nothing for that scheme and the static
   * `ohmarchy.css` block stands, which is readable and on-brand — never a half-mapped set.
   */
  counterpart: OhmarchyMapResult | null;
  /** The theme's own mode, so a caller knows which scheme `native` belongs to. */
  mode: "light" | "dark";
  /** The parsed palette, for a caller that wants the counterpart's own material. */
  palette: OmarchyPalette;
}

/**
 * Map one live theme into BOTH schemes. `null` has the same meaning as `mapOmarchyTheme`'s —
 * the material is not a theme, or the law could not save it — and a null `counterpart` inside
 * a non-null answer is the narrower refusal: this theme's own scheme maps, its other one does
 * not, and only the other one falls back.
 */
export function mapOmarchyThemePair(raw: OmarchyThemeRaw): OmarchyThemeMapping | null {
  const palette = parseColorsToml(raw.colorsToml);
  if (palette === null) return null;
  const native = mapOmarchyTheme(raw);
  if (native === null) return null;
  const map = omarchyMap();
  const other = counterpartPalette(palette);
  let counterpart: OhmarchyMapResult | null = null;
  if (other !== null) {
    try {
      const mapped = map.mapTheme(other);
      if (clearsCounterpartFloors(map, mapped.tokens)) {
        counterpart = { ...mapped, tokens: applySettings(mapped.tokens, parseSystem(raw)) };
      }
    } catch {
      counterpart = null;
    }
  }
  return { native, counterpart, mode: palette.mode, palette };
}
