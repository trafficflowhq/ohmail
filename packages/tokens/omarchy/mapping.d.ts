/**
 * Types for `mapping.js` — THE palette/settings mapping (colors.toml → ohmail token slots),
 * authored in the design phase and carried here VERBATIM (one source; the monorepo holds this
 * copy byte-identical to its design-phase original by test).
 *
 * The file is a UMD body with no ESM exports: loaded under `type: "module"` it registers
 * itself on the global as `OHMARCHY_MAP`. Import it for its side effect and read the global —
 * exactly what `validate-mapping.mjs` in the prototype does. `loadMapping()` in `map.ts` wraps
 * that one step so consumers get a typed handle instead of each re-declaring the global.
 */

export interface OhmarchyMapNote {
  slot: string;
  msg: string;
}

export interface OhmarchyMapResult {
  /** ohmail custom-property name → value, e.g. `"--panel": "#1a1b26"`. */
  tokens: Record<string, string>;
  /** Every contrast-floor fallback that fired, named per slot. */
  notes: OhmarchyMapNote[];
  mode: "light" | "dark";
}

export interface OhmarchyMap {
  mapTheme(fixture: { mode: string; colors: Record<string, string> }): OhmarchyMapResult;
  contrast(a: string, b: string): number;
  mix(a: string, b: string, t: number): string;
  alpha(c: string, a: number): string;
  hue(c: string): number | null;
  ensure(
    c: string,
    against: string,
    floor: number,
    target: string,
  ): { value: string; walked: number };
  TAG_HUES: [string, number][];
}

declare global {
  // eslint-disable-next-line no-var
  var OHMARCHY_MAP: OhmarchyMap;
}

export {};
