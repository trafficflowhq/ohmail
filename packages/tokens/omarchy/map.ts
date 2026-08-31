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
import { parseColorsToml } from "./colors-toml.js";
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
function clearsFloors(map: OhmarchyMap, t: Record<string, string>): boolean {
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
