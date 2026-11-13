#!/usr/bin/env node
/* Compares what this repository ships with a design sheet, value by value.

     node packages/tokens/scripts/compare-sheet.mjs --sheet <dir> [--product <dir>] [--out <file>]

   <dir> of --sheet holds four files of the sheet: its data (tokens.json, icons.json) and the two
   stylesheets it is authored in (tokens.css, motion.css). It has no default: the sheet is not
   part of this repository. --product is a checkout of this repository (default: the one this
   script is in); five files of it are read: packages/tokens/src/design/{tokens.json,tokens.css,
   motion.css}, packages/tokens/source/declared.tsv and packages/ui/src/icons/icons.json.

   Two passes. The data: every value each side resolves for a situation (a face, a scheme, a
   device). The stylesheets: every declaration of the generated rules against the sheet's rule at
   the same selector, which is where the values the sheet's data does not carry are held: reduced
   motion, and the blocks of a device or a product the data resolves no situation for.

   Writes one tab-separated row per finding (where, token, kind, product, sheet, declared).
   Exit 0: nothing differs that source/declared.tsv does not name. Exit 1: a difference, or a
   declared row that matched nothing. Exit 2: an input is missing or unreadable. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---- values ---- */

const lowerHex = (s) => s.replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => hex.toLowerCase());
const norm = (v) =>
  lowerHex(String(v).trim().replace(/\s+/g, " ")).replace(/\b0px\b/g, "0").replace(/(^|[^\d.])0\.(\d)/g, "$1.$2");

/** `calc(72px + 16px)` is 88px and `calc(260ms * 1)` is 260ms; anything else is left as it is. */
function calcValue(text) {
  const inner = /^calc\((.+)\)$/.exec(text)?.[1];
  if (!inner) return null;
  const term = (t) => /^(-?\d*\.?\d+)(px|ms)?$/.exec(t.trim());
  const product = inner.split(" * ").map(term);
  if (product.length === 2 && product.every(Boolean) && !product[1][2]) {
    return `${Number(product[0][1]) * Number(product[1][1])}${product[0][2] ?? ""}`;
  }
  const sum = inner.split(" + ").map(term);
  if (sum.length < 2 || !sum.every(Boolean) || new Set(sum.map((m) => m[2])).size !== 1) return null;
  return `${sum.reduce((n, m) => n + Number(m[1]), 0)}${sum[0][2] ?? ""}`;
}

/** `color-mix(in srgb,#205ea6 12%,#fffcf0)` as the one colour it is; any other mix is left as it is. */
function mixValue(text) {
  const m = /^color-mix\(in srgb, ?#([0-9a-f]{6}) (\d+)%, ?#([0-9a-f]{6})\)$/.exec(text);
  if (!m) return null;
  const share = Number(m[2]) / 100;
  const channel = (i) => {
    const [a, b] = [m[1], m[3]].map((hex) => parseInt(hex.slice(i, i + 2), 16));
    return Math.round(a * share + b * (1 - share)).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

/** A sheet entry is a value, or `{ value, as }` where `as` is the form it was written in. */
export function same(product, sheet) {
  const theirs = (typeof sheet === "object" && sheet !== null ? [sheet.value, sheet.as] : [sheet]).filter((v) => v != null).map(norm);
  const mine = [norm(product), calcValue(norm(product)), mixValue(norm(product))].filter((v) => v != null);
  return mine.some((v) => theirs.includes(v));
}
const shown = (v) => (v == null ? "" : typeof v === "object" ? String(v.as ?? v.value ?? JSON.stringify(v)) : String(v));

/* ---- rows ---- */

/** `authored`: the tokens the sheet's stylesheets declare. Its data carries no value for some of them. */
function comparer(authored) {
  const rows = [];
  let compared = 0;
  const add = (where, token, kind, product, sheet) => rows.push({ where, token, kind, product: shown(product), sheet: shown(sheet) });
  const count = (n) => (compared += n);
  /** Two flat maps, every token of either. One the sheet has only on its stylesheets is the other pass's. */
  const maps = (where, product, sheet) => {
    for (const token of new Set([...Object.keys(sheet), ...Object.keys(product)])) {
      if (!(token in sheet) && authored.has(token)) continue;
      compared += 1;
      if (!(token in product)) add(where, token, "sheet-only", "", sheet[token]);
      else if (!(token in sheet)) add(where, token, "product-only", product[token], "");
      else if (!same(product[token], sheet[token])) add(where, token, "differs", product[token], sheet[token]);
    }
  };
  /** Two plain values (a number, a list, a record), whole. */
  const whole = (where, token, product, sheet) => {
    compared += 1;
    if (JSON.stringify(product) !== JSON.stringify(sheet)) add(where, token, "differs", JSON.stringify(product), JSON.stringify(sheet));
  };
  return { rows, add, maps, whole, count, compared: () => compared };
}

/* The sheet writes a situation as what differs from the one before it; the product writes each whole. */
const FACE_SITUATIONS = [
  ["light", ["light"]],
  ["dark", ["light", "dark"]],
  ["phone", ["light", "touch"]],
  ["fold", ["light", "touch", "unfolded"]],
  ["foldWords", ["light", "touch", "unfolded", "unfoldedWords"]],
];
const SHEET_PARTS = ["name", "what", "takenFrom", "taken", "defaults", "faces", "accents", "motion", "avatarHues", "tagHues", "calendar"];
const SHEET_CALENDAR_PARTS = ["name", "what", "takenFrom", "defaults", "root", "tokens", "motion", "ring", "ringRule", "pairings", "calendars", "accounts", "accents"];
const ACCENT_TOKENS = ["hot", "hot-ink", "on-hot", "wash", "sheet-new"];
const CALENDAR_ACCENT_FIELDS = ["resolvesTo", "cal-mark", "cal-tint", "turn", "hues"];
const FACES = ["paper", "ohmarchy"];
const SCHEMES = ["light", "dark"];

const pick = (obj, names) => Object.fromEntries(names.filter((n) => obj?.[n] !== undefined).map((n) => [n, obj[n]]));

/* A situation the sheet's data does not resolve (a finger without a phone, a calendar alone) has nothing to
   be read against here: its values come from blocks, and every block is read against the sheet's stylesheet. */
function situations(c, prefix, product, sheet) {
  const layersOf = Object.fromEntries(FACE_SITUATIONS);
  for (const face of FACES) {
    for (const [mine, values] of Object.entries(product?.[face] ?? {})) {
      const layers = layersOf[mine];
      if (!layers || (mine !== "light" && !sheet?.[face]?.[layers[layers.length - 1]])) continue;
      c.maps(`${prefix}.${face}.${mine}`, values, Object.assign({}, ...layers.map((l) => sheet?.[face]?.[l] ?? {})));
    }
  }
}

function accents(c, prefix, product, sheet, fields, asMaps) {
  for (const name of new Set([...Object.keys(sheet ?? {}), ...Object.keys(product ?? {})])) {
    if (!product?.[name]) c.add(`${prefix}.${name}`, "*", "sheet-only", "", "");
    else if (!sheet?.[name]) c.add(`${prefix}.${name}`, "*", "product-only", "", "");
    else {
      for (const face of FACES) for (const scheme of SCHEMES) {
        const where = `${prefix}.${name}.${face}.${scheme}`;
        const [mine, theirs] = [pick(product[name][face]?.[scheme], fields), pick(sheet[name][face]?.[scheme], fields)];
        if (asMaps) c.maps(where, mine, theirs);
        else for (const field of fields) c.whole(where, field, mine[field], theirs[field]);
      }
    }
  }
}

/** Which tone a read square takes under an accent: the sheet names it beside the accent's colours. */
function readSquares(c, product, sheet) {
  for (const name of new Set([...Object.keys(sheet ?? {}), ...Object.keys(product ?? {})])) {
    if (!product?.[name]) c.add(`readSquare.${name}`, "*", "sheet-only", "", "");
    else for (const face of FACES) for (const scheme of SCHEMES) {
      c.whole(`readSquare.${name}`, `${face}.${scheme}`, product[name][face]?.[scheme], sheet?.[name]?.[face]?.[scheme]?.readSquare);
    }
  }
}

function motion(c, product, sheet, sheetCalendar) {
  const styles = new Set([...Object.keys(sheet ?? {}), ...Object.keys(sheetCalendar ?? {})]);
  for (const style of styles) {
    if (style !== "slick") {
      if (sheet?.[style]) c.add(`motion.${style}`, "*", "sheet-only", "", "");
      if (sheetCalendar?.[style]) c.add(`motion.calendar.${style}`, "*", "sheet-only", "", "");
    }
  }
  c.maps("motion.slick", { "m-time": product["m-time"], ...product.slick }, sheet?.slick?.tokens ?? {});
  c.maps("motion.calendar.slick", product.calendar.slick, sheetCalendar?.slick ?? {});
}

/** A drawing as its shapes: no class, and path data with nothing between a command letter and its first number. */
const drawing = (svg) =>
  String(svg).replace(/ class="[^"]*"/g, "").replace(/ d="([^"]*)"/g, (_, d) => ` d="${d.replace(/([a-zA-Z]) +(?=[-.\d])/g, "$1")}"`);

function icons(c, design, product, sheet) {
  const theirs = Object.fromEntries((sheet.icons ?? []).map((i) => [i.name, drawing(i.svg)]));
  c.maps("icons", Object.fromEntries(Object.entries(product.icons ?? {}).map(([n, i]) => [n, drawing(i.svg)])), theirs);
  c.whole("icons", "grid", product.grid, sheet.grid);
  c.whole("icons", "sizes", product.sizes, sheet.sizes);
  for (const face of FACES) {
    const stroke = sheet.stroke?.[face] ?? {};
    const light = design.faces[face].light;
    c.maps(`icons.stroke.${face}`, pick(light, ["ico-w", "ico-cap", "ico-join"]), { "ico-w": stroke.width, "ico-cap": stroke.cap, "ico-join": stroke.join });
  }
}

/* ---- the stylesheets ---- */

/** `a, b` at the top level of a selector list or a rule's body, split on `mark`. */
function split(text, mark) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(" || text[i] === "[") depth += 1;
    else if (text[i] === ")" || text[i] === "]") depth -= 1;
    else if (text[i] === mark && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  return [...parts, text.slice(from)].map((part) => part.trim()).filter(Boolean);
}

/* The sheet's motion stylesheet hangs its rules on a root class of its own (`.fs`), and both of its sheets write
   "anything under the root" where the generated ones write the attribute alone: the same rule. */
const selectorOf = (text) => text.replace(/\s+/g, " ").replace(/^\.fs(?![\w-])/, ":root").replace(/^:root (?=\[)/, "");

/** Every custom property a stylesheet declares, one entry per selector of its rule: `{ media, selector, token, value }`. */
export function declarations(css) {
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const rules = (from, to, media) => {
    let i = from;
    while (i < to) {
      const open = text.indexOf("{", i);
      if (open === -1 || open >= to) return;
      let close = open + 1;
      for (let depth = 1; close < to && depth > 0; close += 1) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
      const head = text.slice(i, open).trim().replace(/\s+/g, " ");
      i = close;
      if (head.startsWith("@media")) rules(open + 1, close - 1, head);
      if (head.startsWith("@")) continue;
      for (const decl of split(text.slice(open + 1, close - 1), ";")) {
        const colon = decl.indexOf(":");
        if (!decl.startsWith("--") || colon === -1) continue;
        const [token, value] = [decl.slice(2, colon).trim(), decl.slice(colon + 1).trim()];
        for (const selector of split(head, ",")) out.push({ media, selector: selectorOf(selector), token, value });
      }
    }
  };
  rules(0, text.length, "");
  return out;
}

/* The generator writes two kinds of block a second time, for a document that stamps nothing and whose system
   asks for dark or for less motion. Each is read here as the stamped block it repeats. */
const TWINS = [
  ["prefers-color-scheme: dark", (selector) => selector.replace(":not([data-scheme])", '[data-scheme="dark"]')],
  ["prefers-reduced-motion: reduce", (selector) => (selector === ":root" ? ':root[data-rm="1"]' : selector)],
];
function ruleOf({ media, selector }, twins) {
  if (media === "") return selector;
  const twin = twins && TWINS.find(([condition]) => media.includes(condition));
  return twin ? twin[1](selector) : `${media} ${selector}`;
}

const inCss = (value) => String(value).replace(/\s*,\s*/g, ",");

/**
 * Every declaration of the product's stylesheets against the sheet's rule at the same selector, and every
 * declaration of the sheet's at a selector the product has. `sheets` is `{ name: declarations }`: where two
 * of the sheet's files write one token at one selector, the product's value is asked of both.
 */
function stylesheets(c, product, sheets) {
  const theirs = new Map();
  for (const [file, list] of Object.entries(sheets)) {
    for (const d of list) {
      const tokens = theirs.get(ruleOf(d)) ?? theirs.set(ruleOf(d), new Map()).get(ruleOf(d));
      (tokens.get(d.token) ?? tokens.set(d.token, new Map()).get(d.token)).set(file, d.value);
    }
  }
  const mine = new Map();
  for (const d of product) {
    const rule = ruleOf(d, true);
    (mine.get(rule) ?? mine.set(rule, new Set()).get(rule)).add(d.token);
    const values = theirs.get(rule)?.get(d.token);
    if (!theirs.has(rule)) continue;
    c.count(1);
    if (!values) c.add(`css ${rule}`, d.token, "product-only", d.value, "");
    else {
      for (const [file, value] of values) {
        if (!same(inCss(d.value), inCss(value))) c.add(`css ${rule}`, d.token, "differs", d.value, `${value} (${file})`);
      }
    }
  }
  for (const rule of mine.keys()) if (!theirs.has(rule)) c.add(`css ${rule}`, "*", "product-only", "", "");
  for (const [rule, tokens] of theirs) {
    if (!mine.has(rule)) c.add(`css ${rule}`, "*", "sheet-only", "", "");
    else {
      for (const [token, values] of tokens) {
        if (!mine.get(rule).has(token)) c.add(`css ${rule}`, token, "sheet-only", "", [...values.values()][0]);
      }
    }
  }
}

/** Every finding, before source/declared.tsv is read. */
function findings({ design, motion: moves }, productIcons, productCss, sheet, sheetIcons, sheetCss) {
  const c = comparer(new Set(Object.values(sheetCss).flatMap((list) => list.map((d) => d.token))));
  for (const part of Object.keys(sheet)) if (!SHEET_PARTS.includes(part)) c.add("sheet", part, "sheet-only", "", "a part this script does not read");
  for (const part of Object.keys(sheet.calendar ?? {})) {
    if (!SHEET_CALENDAR_PARTS.includes(part)) c.add("sheet.calendar", part, "sheet-only", "", "a part this script does not read");
  }
  situations(c, "faces", design.faces, sheet.faces);
  situations(c, "calendar", design.calendar, sheet.calendar?.tokens);
  accents(c, "accents", design.accents, sheet.accents, ACCENT_TOKENS, true);
  readSquares(c, design.readSquare, sheet.accents);
  accents(c, "calendar.accents", design.calendar.accents, sheet.calendar?.accents, CALENDAR_ACCENT_FIELDS, false);
  c.whole("calendar", "ring", design.calendar.ring, sheet.calendar?.ring);
  c.whole("hues", "avatarHues", design.avatarHues, sheet.avatarHues);
  c.whole("hues", "tagHues", design.tagHues, sheet.tagHues);
  motion(c, moves, sheet.motion, sheet.calendar?.motion);
  icons(c, design, productIcons, sheetIcons);
  stylesheets(c, productCss, sheetCss);
  return { rows: c.rows, compared: c.compared() };
}

/* ---- the declared list ---- */

/**
 * source/declared.tsv: where, token, kind, reason. `where` may end in `*`. A token `*` is a whole part or
 * rule that one side lacks, as this script reports it; it does not stand for the tokens of a part both have.
 */
export function readDeclared(text) {
  return text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#")).map((line, i) => {
    const [where, token, kind, reason] = line.split("\t");
    if (!where || !token || !kind || !reason?.trim()) throw new Error(`declared.tsv row ${i + 1}: where, token, kind and a reason`);
    return { where, token, kind, reason: reason.trim(), used: 0 };
  });
}
const covers = (d, row) =>
  d.kind === row.kind && d.token === row.token &&
  (d.where.endsWith("*") ? row.where.startsWith(d.where.slice(0, -1)) : d.where === row.where);

/**
 * The comparison of two sets of parsed inputs: `{ rows, open, compared }`. `open` is what fails it.
 * `productCss` is the declarations of the generated stylesheets, `sheetCss` the sheet's by file name.
 */
export function compare({ product, productIcons, productCss, declared, sheet, sheetIcons, sheetCss }) {
  const { rows, compared } = findings(product, productIcons, productCss, sheet, sheetIcons, sheetCss);
  for (const row of rows) {
    const by = declared.find((d) => covers(d, row));
    if (by) by.used += 1;
    row.declared = by ? by.reason : "";
  }
  for (const d of declared) {
    if (d.used === 0) rows.push({ where: d.where, token: d.token, kind: "stale-declared", product: "", sheet: "", declared: "" });
  }
  return { rows, compared, open: rows.filter((r) => r.declared === "") };
}

const TSV_HEAD = "where\ttoken\tkind\tproduct\tsheet\tdeclared\n";
export const toTsv = (rows) =>
  TSV_HEAD + rows.map((r) => [r.where, r.token, r.kind, r.product, r.sheet, r.declared].join("\t")).join("\n") + (rows.length ? "\n" : "");

/* ---- the command ---- */

class InputError extends Error {}
function readInput(path, parse) {
  if (!existsSync(path)) throw new InputError(`missing: ${path}`);
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InputError(`unreadable: ${path} (${error.message})`);
  }
}

/** Reads the nine files and compares them. Throws InputError on a missing or unreadable one. */
export function compareDirs({ sheetDir, productDir }) {
  if (!sheetDir) throw new InputError("--sheet <dir> is required: the sheet is not part of this repository");
  const design = `${productDir}/packages/tokens/src/design`;
  return compare({
    sheet: readInput(`${sheetDir}/tokens.json`, JSON.parse),
    sheetIcons: readInput(`${sheetDir}/icons.json`, JSON.parse),
    sheetCss: {
      "tokens.css": readInput(`${sheetDir}/tokens.css`, declarations),
      "motion.css": readInput(`${sheetDir}/motion.css`, declarations),
    },
    product: readInput(`${design}/tokens.json`, JSON.parse),
    productCss: [...readInput(`${design}/tokens.css`, declarations), ...readInput(`${design}/motion.css`, declarations)],
    productIcons: readInput(`${productDir}/packages/ui/src/icons/icons.json`, JSON.parse),
    declared: readInput(`${productDir}/packages/tokens/source/declared.tsv`, readDeclared),
  });
}

export function main(argv) {
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const productDir = arg("--product") ?? fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
  try {
    const { rows, compared, open } = compareDirs({ sheetDir: arg("--sheet"), productDir });
    const out = arg("--out");
    if (out) writeFileSync(out, toTsv(rows));
    else process.stdout.write(toTsv(rows));
    process.stderr.write(`compare-sheet: ${compared} values compared, ${rows.length - open.length} declared, ${open.length} open\n`);
    return open.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    process.stderr.write(`compare-sheet: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
