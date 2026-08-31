/**
 * The SETTINGS half of the ohmarchy mapping — the system's own font, size, gaps and border
 * weight, read into the token slots `OHMARCHY-TOKENS.md` §5 assigns them. Same contract as
 * color (OHMARCHY-PLAN.md §3c: "the mapping layer is settings→token-slots"), kept beside
 * `mapping.js` rather than inside it so the palette law stays byte-identical to the file
 * Phase 3-zero authored and the gallery still runs.
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

/** One CSS-safe family name: quotes and control characters stripped, whitespace collapsed. */
function familyName(raw: string): string | null {
  const name = raw
    .replace(/["'\\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

/** The value of one `hyprctl getoption -j` answer: `int` when present, else the first number
 *  of the `css`/`custom` string form (`"10 10 10 10"` — gaps are four-sided; ohmail's gap
 *  rhythm takes the first, which is Omarchy's own uniform default). */
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
  return bounded(s.trim().split(/\s+/)[0], max);
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

/** The width `mapping.js` writes into the three tile rings, named so the rewrite below is a
 *  stated contract with that file rather than a magic string. */
const MAPPED_RING = "0 0 0 2px ";

/**
 * Lay the known settings over a mapped token set (OHMARCHY-TOKENS.md §5's table):
 *
 *   --font-ui         the live fc-match families, then the same static tail
 *   --font-size-base  shell.toml base-size
 *   --gap-tile        gaps_in × 2   (5 between two tiles is 10 of rhythm)
 *   --gap-edge        gaps_out
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
  if (settings.gapsInPx !== null) out["--gap-tile"] = `${settings.gapsInPx * 2}px`;
  if (settings.gapsOutPx !== null) out["--gap-edge"] = `${settings.gapsOutPx}px`;
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
