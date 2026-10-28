/* Generates src/theme/ohmarchy.ts — the ohmarchy face for React Native.

   ── WHY A SECOND GENERATOR AND NOT A SECOND MAPPING ──────────────────────────────────────
   The law is `packages/tokens/omarchy/mapping.js` and the SHIPPING output of it is
   `packages/tokens/src/ohmarchy.json`, written by `packages/tokens/scripts/generate-ohmarchy.mjs`
   over the two static-default fixtures (tokyo-night dark / flexoki-light light) and pinned
   against hand edits by the tokens package's regeneration test. This script reads
   THAT FILE and only that file. It does not re-run the mapping and it never picks a value: the
   phone's face is the web's face projected onto React Native's shapes, so the two cannot drift
   by construction. A colour that changes on the desktop changes here at the next regeneration,
   or the diff test goes red.

   ── THE FOUR PROJECTIONS, EACH ONE MECHANICAL ────────────────────────────────────────────
   1. COLOUR — slot for slot onto `Palette` (src/theme/palette.ts). Every ohmarchy value is
      already `#rrggbb` or `rgba(r,g,b,a)`, both of which React Native parses natively, so the
      OKLCH converter the paper palette needs has no work to do here.
      The ten tag hues are the tokens' wheel; three keep the prototype's slot names — moss /
      ochre / rosewood are `--tg-pottery` / `--tg-buch` / `--tg-privat` — and the other seven
      are `--tg-<hue>` (the paper side is pinned by `test/theme.test.ts` and
      `test/tags-shown.test.ts` against `color[scheme].tag`).
   2. RADIUS — through faces.css's OWN off-band ratio rule, verbatim: "Off-band literals keep
      their exact paper value through a ratio: `calc(var(--r-ctl) * 6 / 8)` is 6px under paper
      and 0 under ohmarchy — never snap a literal to the slot value." So every mobile radius is
      `paper[key] / PAPER_BAND[band] * faceBand[band]`, which reproduces the paper number
      exactly under paper and collapses to 0 under ohmarchy (whose whole radius ladder is 0).
      The bands are faces.css's: 4-10 → ctl · 12-16 → card · 18-22 → overlay · 99/999 → pill.
   3. LIFT — ohmarchy's `--lift-0…3` / `--bar-edge` are single flat RINGS, not the layered warm
      shadows paper is built from; parsed here into the same `{offsetX, offsetY, blurRadius,
      spreadDistance, color}` layer list `lift.ts` hands React Native. `sheetEdge` has no slot
      of its own in the generated set (paper authors one because the prototype does): under
      ohmarchy it is `--bar-edge` with its offset flipped, which is the mirror operation
      `liftUp()` already performs on that same token for the same reason (an edge that occludes
      upward instead of downward). Named as a derivation rather than as a value.
   4. MOTION — the two easing curves, which ohmarchy really does move (`--spring`
      cubic-bezier(0.23,1,0.32,1) against paper's 0.22,1,0.3,1).

   ── WHAT IS DELIBERATELY NOT PROJECTED, AND WHY (each a named judgment) ──────────────────
   · `--font-ui` — the chain is 'JetBrainsMono Nerd Font','JetBrains Mono',ui-monospace,
     'Cascadia Mono',Menlo,Consolas,monospace: every entry is a DESKTOP font. Android would
     resolve the generic tail to its own mono and iOS would resolve nothing (React Native needs
     an exact family name there; `monospace` is not one), so carrying the token literally would
     make the two platforms different faces — which the platform-parity rule forbids. Shipping a
     bundled mono is a real design decision (which mono, at what size, paid for with a font load
     on every launch) and the spec has not made it for the phone.
   · `--font-size-base: 12px` — Omarchy's SHELL base-size, measured off `shell.toml` on a
     desktop. Mobile's type ladder is authored in RN points against the HIG/Material minimums,
     and scaling it by 12/14 puts labels under those floors.
   · `--gap-tile` / `--gap-edge`, `--focus-w` / `--focus-offset` — layout, and keyboard-focus
     loudness. The packages/tokens generator's own banner keeps layout slots out of the face
     ("layer order and column math are not appearance"), §3b owns layout, and a phone draws no
     focus ring.
   · `--danger`, `--focus`, `--accent-wash` — no slot on `Palette` consumes them, and a
     generated constant nothing reads is a claim with no test.

   The output is DETERMINISTIC and committed: test/ohmarchy-face.test.ts re-runs this generation
   in-process and fails if src/theme/ohmarchy.ts differs, so a hand edit cannot survive a test
   run. Never hand-pick a value — change mapping.js (spec first) and regenerate both sides. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** THE one source: the shipping web face, already generated from mapping.js. */
export const FACE_JSON = here("../../../packages/tokens/src/ohmarchy.json");
/** Where the projection lands. */
export const FACE_MODULE = here("../src/theme/ohmarchy.ts");

/** Colour slot → mobile `Palette` key. Slot-for-slot; nothing is computed. */
const COLOURS = [
  ["canvas", "--canvas"],
  ["panel", "--panel"],
  ["float", "--float"],
  ["ink", "--ink"],
  ["ink2", "--ink2"],
  ["ink3", "--ink3"],
  ["hair", "--hair"],
  ["hairSoft", "--hair-soft"],
  ["tint", "--tint"],
  ["tint2", "--tint2"],
  ["accent", "--accent"],
  ["accentInk", "--accent-ink"],
  ["accentSoft", "--accent-soft"],
  ["accentHair", "--accent-hair"],
  ["onAccent", "--on-accent"],
  ["scrim", "--scrim"],
];

/** Number slot → mobile `Palette` key: the thread-read squares' opacities. */
const NUMBERS = [
  ["markRead", "--mark-read"],
  ["markMine", "--mark-mine"],
];

/** The ten hues, in the palette's wheel order, and their CSS slots. See projection 1. */
const TAGS = [
  ["rosewood", "privat"],
  ["ochre", "buch"],
  ["olive", "olive"],
  ["moss", "pottery"],
  ["verdigris", "verdigris"],
  ["denim", "denim"],
  ["indigo", "indigo"],
  ["iris", "iris"],
  ["mulberry", "mulberry"],
  ["heather", "heather"],
];

/** The two schemes, in the order the generated module declares them. */
const SCHEMES = ["light", "dark"];

/** The lift levels the generated set names a slot for, and which slot. */
const LIFT_SLOTS = [
  ["l0", "--lift-0"],
  ["l1", "--lift-1"],
  ["l2", "--lift-2"],
  ["l3", "--lift-3"],
  ["barEdge", "--bar-edge"],
];

/**
 * faces.css's radius bands, and the PAPER value of each — the denominator of the ratio rule.
 * `--r-avatar` is 50% in CSS and has no mobile twin (the RN ladder carries no percentage), so
 * no mobile key maps to it.
 */
const PAPER_BAND = { ctl: 8, card: 14, overlay: 20, pill: 99 };

/** Mobile radius key → band, by faces.css's own bands; off-band keys ride the ratio. */
const RADIUS_BAND = {
  dot: "ctl", // 3 — under the 4-10 band's floor; ctl is the smallest band there is
  keycap: "ctl", // 6
  focus: "ctl", // 8 — the band's own value
  item: "ctl", // 10
  menuItem: "card", // 11 — between bands; nearest by value
  paletteItem: "card", // 13
  rowDense: "card", // 14 — the band's own value
  row: "card", // 16
  input: "overlay", // 18
  panel: "overlay", // 20 — the band's own value
  card: "overlay", // 22
  overlay: "overlay", // 24 — one over the ceiling; the slot this key IS
  reader: "overlay", // 28 — over the band's ceiling; overlay is the largest non-pill band
  pill: "pill", // 999
};

/** The paper ladder this projects, transcribed from src/theme/tokens.ts (the ratio's numerator). */
const PAPER_RADIUS = {
  dot: 3, keycap: 6, focus: 8, item: 10, menuItem: 11, paletteItem: 13, rowDense: 14,
  row: 16, input: 18, panel: 20, card: 22, overlay: 24, reader: 28, pill: 999,
};

/** `--r-ctl: 0` → 0. A bare number or `Npx`. */
function pxOf(value, slot) {
  const m = /^(-?[\d.]+)(px)?$/.exec(value.trim());
  if (!m) throw new Error(`${slot}: not a length this projection can read: ${value}`);
  return Number(m[1]);
}

/**
 * One CSS box-shadow stack → the RN layer list. ohmarchy's are single flat rings, but the
 * parser is the general one, so a future palette that grows a blur is carried rather than
 * silently flattened.
 */
const LAYER =
  /(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?\s+(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g;
function layersOf(css, slot) {
  const out = [];
  for (const m of css.matchAll(LAYER)) {
    out.push({
      offsetX: Number(m[1]),
      offsetY: Number(m[2]),
      blurRadius: Number(m[3]),
      spreadDistance: m[4] === undefined ? 0 : Number(m[4]),
      color: m[5],
    });
  }
  if (out.length === 0) throw new Error(`${slot}: no shadow layer parsed from: ${css}`);
  return out;
}

/** `cubic-bezier(0.23,1,0.32,1)` → the four control points RN's `Easing.bezier` takes. */
function bezierOf(css, slot) {
  const m = /^cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/.exec(
    css.trim(),
  );
  if (!m) throw new Error(`${slot}: not a cubic-bezier: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** One layer object as a source line. */
const layerLine = (l, indent) =>
  `${indent}{ offsetX: ${l.offsetX}, offsetY: ${l.offsetY}, blurRadius: ${l.blurRadius}, ` +
  `spreadDistance: ${l.spreadDistance}, color: ${JSON.stringify(l.color)} },`;

/**
 * The generated module's TEXT — pure, so the diff test can render it in-process and compare
 * against the committed file without writing anything.
 */
/* The emitted module's imports, as strings rather than at a line start of the template: they are
   the generated module's, resolved from src/theme, and an import scan of this script must not read
   them as its own. */
const MODULE_IMPORTS = [
  'import type { LiftLevel } from "./lift-level";',
  'import type { Palette, SchemeName } from "./palette";',
  'import type { radius as paperRadius } from "./tokens";',
].join("\n");

export function renderOhmarchyModule(face) {
  const need = (scheme, slot) => {
    const v = face[`ohmarchy-${scheme}`]?.[slot];
    if (typeof v !== "string") {
      throw new Error(`ohmarchy-${scheme} has no ${slot} — the web face and this projection disagree`);
    }
    return v;
  };

  /* ── colour ─────────────────────────────────────────────────────────────────────────── */
  /**
   * The glass pair is DERIVED, not a slot: the web face carries no `--glass`, and the rule is
   * paper's (`palette.ts#glassAuthored`) — the material keeps paper's alphas (surface 0.80
   * light / 0.78 dark, border 0.10, the unblurred Android surface 0.94), the hue is this face's own `--float` and `--ink`. A face
   * slot that is not plain hex refuses here rather than shipping a colour RN cannot read.
   */
  const hexRgb = (v, what) => {
    const m = /^#([0-9a-fA-F]{6})$/.exec(v.trim());
    if (!m) throw new Error(`${what} is ${v} — the glass derivation needs #rrggbb`);
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgba = (v, a, what) => `rgba(${hexRgb(v, what).join(",")},${a})`;
  const glassOf = (scheme) => [
    `    glass: ${JSON.stringify(rgba(need(scheme, "--float"), scheme === "light" ? 0.8 : 0.78, `${scheme} --float`))},`,
    `    glassBrd: ${JSON.stringify(rgba(need(scheme, "--ink"), 0.1, `${scheme} --ink`))},`,
    `    glassFlat: ${JSON.stringify(rgba(need(scheme, "--float"), 0.94, `${scheme} --float`))},`,
  ];
  const palette = (scheme) =>
    [
      `  ${scheme}: {`,
      `    scheme: ${JSON.stringify(scheme)},`,
      ...COLOURS.map(([key, slot]) => `    ${key}: ${JSON.stringify(need(scheme, slot))},`),
      ...NUMBERS.map(([key, slot]) => `    ${key}: ${Number(need(scheme, slot))},`),
      ...glassOf(scheme),
      `    tag: {`,
      ...TAGS.map(
        ([hue, css]) =>
          `      ${hue}: { ink: ${JSON.stringify(need(scheme, `--tg-${css}-ink`))}, ` +
          `bg: ${JSON.stringify(need(scheme, `--tg-${css}-bg`))} },`,
      ),
      `    },`,
      `  },`,
    ].join("\n");

  /* ── radius: the ratio rule, per key ────────────────────────────────────────────────── */
  const bandValue = {};
  for (const band of Object.keys(PAPER_BAND)) {
    const slot = `--r-${band}`;
    const [light, dark] = SCHEMES.map((s) => pxOf(need(s, slot), `${s} ${slot}`));
    /* A palette does not move a corner: both schemes must state the same ladder, or the
       projection would have to pick one and the face would be two faces. */
    if (light !== dark) throw new Error(`${slot}: light and dark disagree (${light} vs ${dark})`);
    bandValue[band] = dark;
  }
  const radiusRows = Object.entries(RADIUS_BAND).map(([key, band]) => {
    const value = (PAPER_RADIUS[key] / PAPER_BAND[band]) * bandValue[band];
    return (
      `  /** paper ${PAPER_RADIUS[key]} · ${band} band ${PAPER_BAND[band]} → ${bandValue[band]} */\n` +
      `  ${key}: ${Math.round(value * 100) / 100},`
    );
  });

  /* ── lift: the named slots, plus the derived sheet edge ─────────────────────────────── */
  const ladder = (scheme) => {
    const rows = [];
    let barEdge = null;
    for (const [level, slot] of LIFT_SLOTS) {
      const layers = layersOf(need(scheme, slot), `${scheme} ${slot}`);
      if (level === "barEdge") barEdge = layers;
      rows.push(`    ${level}: [`);
      for (const l of layers) rows.push(layerLine(l, "      "));
      rows.push(`    ],`);
    }
    rows.push(`    sheetEdge: [`);
    // `--bar-edge` mirrored — the operation `liftUp()` performs on the same token.
    for (const l of barEdge) rows.push(layerLine({ ...l, offsetY: -l.offsetY }, "      "));
    rows.push(`    ],`);
    return [`  ${scheme}: {`, ...rows, `  },`].join("\n");
  };

  /* ── motion ─────────────────────────────────────────────────────────────────────────── */
  const curves = {};
  for (const name of ["spring", "swift"]) {
    const [light, dark] = SCHEMES.map((s) => bezierOf(need(s, `--${name}`), `${s} --${name}`));
    /* Motion is not a palette: a face that eased differently in light and dark would be two
       faces, and RN's `Easing.bezier` is bound once per animation, not per scheme. */
    if (light.join() !== dark.join()) {
      throw new Error(`--${name}: light and dark disagree (${light.join()} vs ${dark.join()})`);
    }
    curves[name] = dark;
  }

  const prov = face._provenance ?? {};
  return `/**
 * THE OHMARCHY FACE FOR REACT NATIVE — GENERATED, never hand-edited. Written by
 * \`scripts/generate-ohmarchy.mjs\` from the tokens package's generated ohmarchy set — the same face
 * the browser and the desktop wear, which \`packages/tokens/omarchy/mapping.js\` derives from
 * ${prov.dark_source} (dark) and ${prov.light_source} (light) and ships to the web as
 * \`packages/tokens/src/ohmarchy.css\`. \`test/ohmarchy-face.test.ts\` re-runs that generation and
 * fails if this file differs, so a hand edit cannot survive and the phone's face cannot drift from
 * the desktop's. The generator's header has the four projections and the four groups not projected.
 * Paper is the ABSENT face: nothing here is consulted unless \`Theme.face === "ohmarchy"\`.
 */
${MODULE_IMPORTS}

/** One React Native \`boxShadow\` layer — the CSS box-shadow model, which RN adopted verbatim. */
export interface FaceShadowLayer {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blurRadius: number;
  readonly spreadDistance: number;
  /** Already an RN-parseable colour: the mapping emits \`#rrggbb\` and \`rgba()\` only. */
  readonly color: string;
}

/** The palette per scheme — the same 16 slots + 10 tag hues the paper palette carries. */
export const ohmarchyPalettes: Record<SchemeName, Palette> = {
${palette("light")}
${palette("dark")}
};

/**
 * The radius ladder under ohmarchy, through faces.css's off-band ratio rule (generator
 * projection 2). Every value is 0 because ohmarchy's whole radius ladder is 0 — the ratio is
 * what makes that a DERIVATION of the face's own slots rather than a table of zeros somebody
 * typed, and it is why a face declaring \`--r-card: 4px\` would land \`menuItem\` at 11 × 4/14.
 */
export const ohmarchyRadius: Record<keyof typeof paperRadius, number> = {
${radiusRows.join("\n")}
};

/**
 * The lift ladder per scheme. ohmarchy reads its structure from flat hairline RINGS, which is
 * why these are single-layer where paper stacks four warm shadows. \`sheetEdge\` is \`--bar-edge\`
 * with its offset flipped — the mirror \`liftUp()\` performs on that same token.
 */
export const ohmarchyLift: Record<SchemeName, Record<LiftLevel, readonly FaceShadowLayer[]>> = {
${ladder("light")}
${ladder("dark")}
};

/** The easing pair ohmarchy really does move, as \`Easing.bezier\` control points. */
export const ohmarchyEasing = {
  spring: [${curves.spring.join(", ")}] as const,
  swift: [${curves.swift.join(", ")}] as const,
} as const;
`;
}

/** Read the web face as this projection's single source. */
export function readWebFace() {
  return JSON.parse(readFileSync(FACE_JSON, "utf8"));
}

/* Side effects ONLY when run as a script — the diff test imports `renderOhmarchyModule`, and a
   generator that rewrote the file on import could never observe a hand edit. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const face = readWebFace();
  writeFileSync(FACE_MODULE, renderOhmarchyModule(face));
  console.log(
    `src/theme/ohmarchy.ts written: ${COLOURS.length} colour slots + ${TAGS.length} tag hues × 2 ` +
      `schemes, ${Object.keys(RADIUS_BAND).length} radii, 6 lift levels × 2 schemes, 2 easing ` +
      `curves (from ${face._provenance?.dark_source} / ${face._provenance?.light_source})`,
  );
}
