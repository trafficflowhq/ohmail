/**
 * The SETTINGS half of the ohmarchy mapping — the system's own font, size, gaps and border
 * weight, read into the token slots the ohmarchy token law assigns them. Same contract as
 * color — the mapping layer is settings→token-slots — kept beside `mapping.js` rather than
 * inside it so the palette law stays byte-identical to its design-phase original and the
 * gallery still runs.
 *
 * ── RAW TEXT IN, TOKENS OUT — THE PARSING LIVES HERE, NOT IN THE SHELL ──────────────────────
 *
 * The desktop shell (Rust) gathers these as the UNPARSED stdout/file text and ships them to
 * the window, because text is the honest boundary: every rule that turns a system fact into a
 * token value then lives in one testable place, and a format surprise degrades to "that slot
 * keeps its static default" instead of to a shell-side parse error nobody can see. Every
 * shape below was read off the running Omarchy 4.0.2 VM, not from documentation:
 *
 *   fc-match -f '%{family}' monospace   →  "JetBrainsMono Nerd Font,JetBrainsMono NF"
 *   hyprctl getoption general:gaps_out -j  →  {"option": "…", "css": "10 10 10 10", "set": true }
 *   hyprctl getoption general:border_size -j  →  {"option": "…", "int": 2, "set": true }
 *   shell.toml  →  [font] … base-size = 12   (Omarchy's own generated surface config)
 *
 * ── WHAT IS DELIBERATELY NOT MAPPED ─────────────────────────────────────────────────────────
 *
 * `decoration:rounding` — measured 0 on a stock install, and the law says it "confirms the
 * radius ruling rather than feeding a token": the ohmarchy radius slots are 0 by design, not
 * by inheritance. And the terminal's font size (9) — terminal-private, never the UI's; the
 * shell scale roots at shell.toml's base-size 12 (system.json's provenance names both).
 */

/** The raw system facts the desktop shell gathers. Every field optional — each one the shell
 *  could not read simply leaves its slots at their static ohmarchy defaults. */
export interface OmarchySystemRaw {
  /** stdout of `fc-match -f '%{family}' monospace` — fontconfig is the family authority. */
  fcMono?: string | null;
  /** `~/.local/state/omarchy/current/theme/shell.toml`, whole file. */
  shellToml?: string | null;
  /** stdout of `hyprctl getoption general:gaps_in -j`. */
  hyprGapsIn?: string | null;
  /** stdout of `hyprctl getoption general:gaps_out -j`. */
  hyprGapsOut?: string | null;
  /** stdout of `hyprctl getoption general:border_size -j`. */
  hyprBorderSize?: string | null;
}

/** The parsed settings. `null`/`[]` mean "not known" — never a guessed value. */
export interface OmarchySettings {
  fontFamilies: string[];
  fontSizePx: number | null;
  gapsInPx: number | null;
  gapsOutPx: number | null;
  borderPx: number | null;
}

/** The tail of the ohmarchy `--font-ui` stack after the live families — the same fallbacks
 *  `mapping.js` writes statically, so the live and static stacks degrade identically. */
const FONT_TAIL = "ui-monospace,'Cascadia Mono',Menlo,Consolas,monospace";

/** A bound nothing real approaches: fc-match answers a handful of families, base-size is a
 *  screen font size, gaps and borders are window-manager pixels. Values past these are a
 *  corrupt read, and a corrupt read keeps the static default. */
const MAX_FAMILIES = 8;
const MAX_FONT_PX = 200;
const MAX_GAP_PX = 200;
const MAX_BORDER_PX = 32;

/** One CSS-safe family name: quotes and control characters stripped, whitespace collapsed —
 *  and a name carrying stylesheet-structural punctuation is REFUSED, not repaired. The live
 *  token set crosses a fence in the window that bans those characters from whole values
 *  (comment-openers and hanging brackets can eat the entire rule); quoted, `'Mono/Code'`
 *  would be legal CSS, but teaching the fence quote-awareness widens the one boundary that
 *  must stay simple. Refusing HERE keeps the degradation per-ingredient: this family drops,
 *  the rest of the stack and every other slot survive. Parens are the one exception, matching
 *  the fence exactly: BALANCED parens pass (real families carry qualifiers like `Mono (TTF)`,
 *  and a balanced pair cannot restructure a rule), a hanging one refuses the family. */
function familyName(raw: string): string | null {
  const name = raw
    .replace(/["'\\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/[{}<>;@/[\]]/.test(name)) return null;
  let depth = 0;
  for (const ch of name) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return null;
  }
  if (depth !== 0) return null;
  return name.length > 0 && name.length <= 64 ? name : null;
}

/** A positive integer out of a numeric-looking string, bounded, or null. */
function bounded(value: unknown, max: number): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= 0 && rounded <= max ? rounded : null;
}

/** The value of one `hyprctl getoption -j` answer: `int` when present, else the narrowest side
 *  of the `css`/`custom` form (`"10 10 10 10"`, CSS order, one to four sides). One malformed
 *  side refuses the whole read. */
function hyprValue(raw: string | null | undefined, max: number): number | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { int?: unknown; css?: unknown; custom?: unknown };
  if (obj.int !== undefined) return bounded(obj.int, max);
  const s = typeof obj.css === "string" ? obj.css : typeof obj.custom === "string" ? obj.custom : null;
  if (s === null) return null;
  const sides = s.trim().split(/\s+/);
  if (sides.length > 4 || !sides.every((v) => /^[0-9]+$/.test(v))) return null;
  const values = sides.map((v) => bounded(v, max));
  return values.every((v): v is number => v !== null) ? Math.min(...values) : null;
}

/** `[font] base-size` out of shell.toml — the section header, then the key, comments skipped.
 *  The shell floors this at 1px and invites raising it; below 1 or past the bound is a
 *  corrupt read, not a preference. */
function shellBaseSize(text: string | null | undefined): number | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024) return null;
  let inFont = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inFont = trimmed === "[font]";
      continue;
    }
    if (!inFont || trimmed.startsWith("#")) continue;
    const m = /^base-size\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:#.*)?$/.exec(trimmed);
    if (m) {
      const n = bounded(m[1], MAX_FONT_PX);
      return n !== null && n >= 1 ? n : null;
    }
  }
  return null;
}

/** The raw facts, parsed. Anything unreadable is null — the token layer then leaves that slot
 *  at its static ohmarchy default rather than inventing a value. */
export function parseSystem(raw: OmarchySystemRaw | null | undefined): OmarchySettings {
  const none: OmarchySettings = {
    fontFamilies: [],
    fontSizePx: null,
    gapsInPx: null,
    gapsOutPx: null,
    borderPx: null,
  };
  if (raw === null || raw === undefined || typeof raw !== "object") return none;
  const families =
    typeof raw.fcMono === "string" && raw.fcMono.length <= 4096
      ? raw.fcMono
          .split(",")
          .map(familyName)
          .filter((f): f is string => f !== null)
          .slice(0, MAX_FAMILIES)
      : [];
  return {
    fontFamilies: families,
    fontSizePx: shellBaseSize(raw.shellToml),
    gapsInPx: hyprValue(raw.hyprGapsIn, MAX_GAP_PX),
    gapsOutPx: hyprValue(raw.hyprGapsOut, MAX_GAP_PX),
    borderPx: hyprValue(raw.hyprBorderSize, MAX_BORDER_PX),
  };
}

/** A `NNpx` token value as a number, or null. */
function px(value: string | undefined): number | null {
  const m = typeof value === "string" ? /^([0-9]+(?:\.[0-9]+)?)px$/.exec(value.trim()) : null;
  return m ? Number(m[1]) : null;
}

/** The width `mapping.js` writes into the three tile rings, named so the rewrite below is a
 *  stated contract with that file rather than a magic string. */
const MAPPED_RING = "0 0 0 2px ";
const MAPPED_RING_PX = 2;

/**
 * Lay the known settings over a mapped token set (the token law's settings table):
 *
 *   --font-ui         the live fc-match families, then the same static tail
 *   --font-size-base  shell.toml base-size
 *   --gap-tile        gaps_in × 2   (5 between two tiles is 10 of rhythm), never under the design gap
 *   --gap-edge        gaps_out, never narrower than the design edge, the tile gap nor the tile ring
 *   --focus-w         border_size   (the focus cursor is the active-window border)
 *   --lift-1/2/3      ring width rewritten to border_size (lift-0 stays 1px — that is
 *                     shell.toml's own control border, not the window border)
 *
 * Returns a NEW record; the input is not touched. Unknown settings change nothing, so
 * off-Omarchy (or under a hyprctl that would not answer) the static theme rides unmodified.
 */
export function applySettings(
  tokens: Record<string, string>,
  settings: OmarchySettings,
): Record<string, string> {
  const out: Record<string, string> = { ...tokens };
  if (settings.fontFamilies.length > 0) {
    out["--font-ui"] = settings.fontFamilies.map((f) => `'${f}'`).join(",") + "," + FONT_TAIL;
  }
  if (settings.fontSizePx !== null) out["--font-size-base"] = `${settings.fontSizePx}px`;
  if (settings.gapsOutPx !== null || settings.gapsInPx !== null) {
    /* The design gap is the floor: live gaps only widen it (Omarchy's no-gaps toggle reads 0).
       The edge never sits under the ring, which stands outside each tile's box. */
    const tile = Math.max(px(tokens["--gap-tile"]) ?? 0, (settings.gapsInPx ?? 0) * 2);
    const ring = settings.borderPx !== null && settings.borderPx >= 1 ? settings.borderPx : MAPPED_RING_PX;
    out["--gap-tile"] = `${tile}px`;
    out["--gap-edge"] = `${Math.max(px(tokens["--gap-edge"]) ?? 0, settings.gapsOutPx ?? 0, tile, ring)}px`;
  }
  if (settings.borderPx !== null && settings.borderPx >= 1) {
    out["--focus-w"] = `${settings.borderPx}px`;
    for (const slot of ["--lift-1", "--lift-2", "--lift-3"]) {
      const ring = out[slot];
      if (typeof ring === "string" && ring.startsWith(MAPPED_RING)) {
        out[slot] = `0 0 0 ${settings.borderPx}px ` + ring.slice(MAPPED_RING.length);
      }
    }
  }
  return out;
}
