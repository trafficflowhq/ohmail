/**
 * HOW LIGHT IS THIS MAIL? The web reader's gate (`MessageBody.tsx`, "how light is this mail?"),
 * ported over the htmlparser2 tree the phone's sanitizer already holds. A dark reader shows a
 * letter through one filter, `invert(1) hue-rotate(180deg)`; applied to a mail that is already
 * dark it would draw it light, so the filter is gated on the mail's own paper: invert what is
 * light, leave alone what is not. A mail that declares nothing reads as light (every renderer
 * draws it on white), which is the overwhelming majority.
 */

import { Element, type AnyNode } from "domhandler";

/** The colour keywords bulk mail is written with, as 0xRRGGBB; an absent name has no opinion (reads light). */
const NAMED_COLORS: Record<string, number> = {
  white: 0xffffff, snow: 0xfffafa, ivory: 0xfffff0, floralwhite: 0xfffaf0,
  ghostwhite: 0xf8f8ff, whitesmoke: 0xf5f5f5, seashell: 0xfff5ee, beige: 0xf5f5dc,
  oldlace: 0xfdf5e6, linen: 0xfaf0e6, antiquewhite: 0xfaebd7, aliceblue: 0xf0f8ff,
  azure: 0xf0ffff, mintcream: 0xf5fffa, honeydew: 0xf0fff0, lavender: 0xe6e6fa,
  gainsboro: 0xdcdcdc, lightgray: 0xd3d3d3, lightgrey: 0xd3d3d3, silver: 0xc0c0c0,
  darkgray: 0xa9a9a9, darkgrey: 0xa9a9a9, gray: 0x808080, grey: 0x808080,
  dimgray: 0x696969, dimgrey: 0x696969, black: 0x000000,
  navy: 0x000080, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, midnightblue: 0x191970,
};

export interface Rgb { r: number; g: number; b: number; a: number }

/** A CSS colour as numbers, or `null` for no opinion (`transparent`, a gradient, nonsense). */
export function parseCssColor(input: string): Rgb | null {
  const v = input.trim().toLowerCase();
  if (v.length === 0) return null;
  const named = NAMED_COLORS[v];
  if (named !== undefined) return { r: named >> 16, g: (named >> 8) & 0xff, b: named & 0xff, a: 1 };
  if (v.startsWith("#")) {
    const d = v.slice(1);
    const ok = /^[0-9a-f]+$/.test(d);
    if (ok && (d.length === 3 || d.length === 4)) {
      const p = (i: number): number => Number.parseInt(d[i]! + d[i]!, 16);
      return { r: p(0), g: p(1), b: p(2), a: d.length === 4 ? p(3) / 255 : 1 };
    }
    if (ok && (d.length === 6 || d.length === 8)) {
      const p = (i: number): number => Number.parseInt(d.slice(i, i + 2), 16);
      return { r: p(0), g: p(2), b: p(4), a: d.length === 8 ? p(6) / 255 : 1 };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[1]!.split(/[,/\s]+/).filter((s) => s.length > 0);
  if (parts.length < 3) return null;
  const chan = (s: string): number => {
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n)) return Number.NaN;
    return s.endsWith("%") ? (n / 100) * 255 : n;
  };
  const r = chan(parts[0]!), g = chan(parts[1]!), b = chan(parts[2]!);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  let a = 1;
  if (parts.length >= 4) {
    const raw = parts[3]!;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    a = raw.endsWith("%") ? n / 100 : n;
  }
  return { r, g, b, a };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number): number => {
    const s = Math.min(Math.max(c, 0), 255) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio of two colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const x = relativeLuminance(a), y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Body text's contrast floor (WCAG AA). */
export const READABLE_CONTRAST = 4.5;

/** Where black and white text have equal contrast: above it a designer writes dark ink. */
export const LIGHT_LUMINANCE = 0.179;

/** Is this mail worth inverting? `null` (nothing declared) is light. */
export function mailIsLight(bg: Rgb | null): boolean {
  return bg === null || relativeLuminance(bg) > LIGHT_LUMINANCE;
}

/** How far from grey a light paper may drift and still be the template's habit, not a colour. */
export const NEUTRAL_CHROMA = 12;

/**
 * The paper to paint, as the web paints it: a dark canvas or a deliberate tint keeps its ground,
 * a near-white grey is the sheet's own white (`null`), as is a mail that declared nothing.
 */
export function paintedPaper(bg: Rgb | null): string | null {
  if (bg === null) return null;
  const chroma = Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b);
  if (mailIsLight(bg) && chroma <= NEUTRAL_CHROMA) return null;
  return hexOf(bg);
}

/** Counts the characters a reading visits: counted work, never time. */
export interface Meter { visited: number }

/** The most of a background value read: a real colour sits well within it. */
export const BACKGROUND_VALUE_MAX = 4096;

/**
 * A background value's words, a function's parentheses kept whole (`rgb(18, 18, 18)` is one): one
 * pass over its first {@link BACKGROUND_VALUE_MAX} characters, split on spaces outside parentheses.
 * `meter` counts the characters visited.
 */
export function backgroundTokens(value: string, meter?: Meter): string[] {
  const end = Math.min(value.length, BACKGROUND_VALUE_MAX);
  const out: string[] = [];
  let depth = 0;
  let from = -1;
  for (let i = 0; i < end; i++) {
    if (meter) meter.visited++;
    const c = value[i]!;
    if (depth === 0 && (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f")) {
      if (from >= 0) out.push(value.slice(from, i));
      from = -1;
      continue;
    }
    if (from < 0) from = i;
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
  }
  if (from >= 0) out.push(value.slice(from, end));
  return out;
}

function hexOf(c: Rgb): string {
  const hex = (v: number): string => Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/** The body's own ink (`text` or an inline `color`); the sanitizer keeps only the body's children. */
function declaredInk(el: Element): Rgb | null {
  const solid = (c: Rgb | null): Rgb | null => (c && c.a >= 0.5 ? c : null);
  const attr = el.attribs.text ? solid(parseCssColor(el.attribs.text)) : null;
  if (attr) return attr;
  const decl = el.attribs.style ? /(?:^|;)\s*color\s*:\s*([^;!]+)/i.exec(el.attribs.style) : null;
  return decl ? solid(parseCssColor(decl[1]!)) : null;
}

/** An opaque-enough background on one element (`bgcolor` or an inline `background`), or `null`. */
function declaredBackground(el: Element): Rgb | null {
  const opaque = (c: Rgb | null): Rgb | null => (c && c.a >= 0.5 ? c : null);
  const attr = el.attribs.bgcolor;
  const fromAttr = attr ? opaque(parseCssColor(attr)) : null;
  if (fromAttr) return fromAttr;
  const style = el.attribs.style;
  if (!style) return null;
  const decl = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i.exec(style);
  if (!decl) return null;
  for (const token of backgroundTokens(decl[1]!)) {
    const c = opaque(parseCssColor(token));
    if (c) return c;
  }
  return null;
}

/** Every `html{…}` / `body{…}` rule's selector and background in a stylesheet's text. */
const SHEET_PAGE_BG =
  /(?:^|[};])\s*((?:html|body)\s*(?:,\s*(?:html|body)\s*)*)\{[^{}]*?background(?:-color)?\s*:\s*([^;!}]+)/gi;

/** The index just past the comment, string or escape that starts at `i`, or `i` when none does. */
function pastCssToken(css: string, i: number): number {
  const c = css[i];
  if (c === "\\") return Math.min(i + 2, css.length);
  if (c === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if (c !== '"' && c !== "'") return i;
  let j = i + 1;
  while (j < css.length && css[j] !== c && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
  return Math.min(css[j] === c ? j + 1 : j, css.length);
}

type MediaToken = { word: string } | { group: string } | { comma: true };

/** A media query list's tokens (comments already gone), or `null` when it is not one. */
function mediaTokens(text: string, meter?: Meter): MediaToken[] | null {
  const out: MediaToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (meter) meter.visited++;
    const c = text[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === ",") { out.push({ comma: true }); i++; continue; }
    if (c === "(") {
      let depth = 0, j = i;
      for (; j < text.length; j++) {
        if (meter) meter.visited++;
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      if (j >= text.length) return null;
      out.push({ group: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const w = /^[a-z-][a-z0-9-]*/i.exec(text.slice(i));
    if (!w) return null;
    out.push({ word: w[0].toLowerCase() });
    if (meter) meter.visited += w[0].length;
    i += w[0].length;
  }
  return out;
}

/** The longest scheme-naming media query list read. */
export const MEDIA_QUERY_MAX = 1000;

/** The deepest brackets a scheme-naming list is read through; the reading recurses once per bracket. */
export const MEDIA_DEPTH_MAX = 32;

/** A condition's value: always true, never true, or what is left of it for the device to decide. */
type Cond = boolean | string;

const not = (c: Cond): Cond => (typeof c === "boolean" ? !c : `not ${c}`);

function inParens(group: string, meter?: Meter): Cond | null {
  if (meter) meter.visited += group.length;
  const scheme = /^\s*prefers-color-scheme\s*(?::\s*([a-z-]+)\s*)?$/i.exec(group);
  if (scheme) return scheme[1] === undefined || scheme[1].toLowerCase() === "light";
  if (!/prefers-color-scheme/i.test(group)) return `(${group.trim()})`;
  const toks = mediaTokens(group, meter);
  const c = toks === null ? null : condition(toks, true, meter);
  return typeof c === "string" ? `(${c})` : c;
}

/** `not (…)`, or `(…)` joined by one of `and` / `or` (`or` only where the grammar allows it). */
function condition(toks: MediaToken[], orAllowed: boolean, meter?: Meter): Cond | null {
  const first = toks[0];
  if (first && "word" in first && first.word === "not") {
    const g = toks[1];
    if (toks.length !== 2 || !g || !("group" in g)) return null;
    const c = inParens(g.group, meter);
    return c === null ? null : not(c);
  }
  const parts: Cond[] = [];
  let op: string | null = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (i % 2 === 1) {
      if (!("word" in t) || (t.word !== "and" && t.word !== "or") || (op !== null && t.word !== op)) return null;
      op = t.word;
      continue;
    }
    if (!("group" in t)) return null;
    const c = inParens(t.group, meter);
    if (c === null) return null;
    parts.push(c);
  }
  if (parts.length === 0 || toks.length % 2 === 0 || (op === "or" && !orAllowed)) return null;
  const decisive = op === "or";
  if (parts.includes(decisive)) return decisive;
  const left = parts.filter((c): c is string => typeof c === "string");
  return left.length === 0 ? !decisive : left.join(` ${op ?? "and"} `);
}

function mediaQuery(toks: MediaToken[], meter?: Meter): Cond | null {
  const [a, b] = toks;
  if (!a || !("word" in a) || (a.word === "not" && b && "group" in b)) return toks.length > 0 ? condition(toks, true, meter) : null;
  const modifier = (a.word === "not" || a.word === "only") && b && "word" in b ? a.word : null;
  const typeTok = modifier === null ? a : b;
  if (!typeTok || !("word" in typeTok) || ["and", "or", "not", "only"].includes(typeTok.word)) return null;
  const rest = toks.slice(modifier === null ? 1 : 2);
  let c: Cond | null = true;
  if (rest.length > 0) {
    const and = rest[0]!;
    c = "word" in and && and.word === "and" ? condition(rest.slice(1), false, meter) : null;
  }
  if (c === null) return null;
  const type = `${modifier === "only" ? "only " : ""}${typeTok.word}`;
  if (modifier === "not") return c === false ? true : [`not ${type}`, ...(c === true ? [] : [c])].join(" and ");
  return c === false ? false : c === true ? type : `${type} and ${c}`;
}

/**
 * A media query list that never depends on the device's own colour scheme: a
 * `(prefers-color-scheme: dark)` condition never matches and a `light` one always does, so what
 * the frame paints is what the gate reads, and ohmail's own dark viewer is the only dark
 * adaptation. A list that names no scheme is returned as it is; `null` when it never matches (also
 * when it names one but cannot be read), so its block is dropped.
 */
export function schemeFreeMedia(query: string, meter?: Meter): string | null {
  if (meter) meter.visited += query.length;
  if (!/prefers-color-scheme|\\/i.test(query)) return query;
  // A real list is a line; a longer one (or one nested past reading) never matches, in bounded time.
  if (query.length > MEDIA_QUERY_MAX) return null;
  // An escape could spell the feature in a way this reading does not: such a list never matches.
  let text = "";
  let depth = 0;
  let i = 0;
  while (i < query.length) {
    if (query[i] === "\\") return null;
    const past = pastCssToken(query, i);
    if (meter) meter.visited += Math.max(past - i, 1);
    if (past > i) { text += query[i] === "/" ? " " : query.slice(i, past); i = past; continue; }
    if (query[i] === "(" && ++depth > MEDIA_DEPTH_MAX) return null;
    if (query[i] === ")") depth--;
    text += query[i++];
  }
  const toks = mediaTokens(text, meter);
  if (toks === null) return null;
  const kept: string[] = [];
  let from = 0;
  for (let i = 0; i <= toks.length; i++) {
    if (i < toks.length && !("comma" in toks[i]!)) continue;
    const c = mediaQuery(toks.slice(from, i), meter);
    if (c !== null && c !== false) kept.push(c === true ? "all" : c);
    from = i + 1;
  }
  return kept.length === 0 ? null : kept.join(", ");
}

/** A stylesheet with every `@media` prelude made {@link schemeFreeMedia} (a block that never matches dropped), nested ones included. */
export function schemeFreeCss(css: string, meter?: Meter): string {
  if (meter) meter.visited += css.length;
  if (!/prefers-color-scheme|\\/i.test(css)) return css;
  let out = "";
  let atStatement = true;
  let i = 0;
  while (i < css.length) {
    const past = pastCssToken(css, i);
    if (meter) meter.visited += Math.max(past - i, 1);
    if (past > i) {
      out += css.slice(i, past);
      if (css[i] !== "/") atStatement = false;
      i = past;
      continue;
    }
    const ch = css[i]!;
    const media = ch === "@" && atStatement ? /^@media(?![\w-])/i.exec(css.slice(i, i + 7)) : null;
    if (media === null) {
      out += ch;
      if (!/\s/.test(ch)) atStatement = ch === "{" || ch === "}" || ch === ";";
      i++;
      continue;
    }
    // The prelude runs to the block's `{` (or a stray `;`), past strings and comments.
    let j = i + 6;
    while (j < css.length && css[j] !== "{" && css[j] !== ";") {
      const to = Math.max(pastCssToken(css, j), j + 1);
      if (meter) meter.visited += to - j;
      j = to;
    }
    const kept = css[j] === "{" ? schemeFreeMedia(css.slice(i + 6, j).trim(), meter) : css.slice(i, j);
    if (kept === null) {
      // Never matches: the whole block goes, to its closing brace.
      let depth = 0;
      while (j < css.length) {
        const skip = pastCssToken(css, j);
        if (meter) meter.visited += Math.max(skip - j, 1);
        if (skip > j) { j = skip; continue; }
        const c = css[j++];
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) break;
      }
    } else out += css[j] === "{" ? `@media ${kept}` : kept;
    i = j;
  }
  return out;
}

/**
 * A `<style>` element's sheet as the frame applies it: its `media` attribute read by the same rule
 * (the sanitizer keeps no attribute on a sheet), so a dark-only sheet is `null`, every other whole.
 */
export function schemeFreeSheet(css: string, media: string | undefined): string | null {
  if (media !== undefined && schemeFreeMedia(media) === null) return null;
  return schemeFreeCss(css);
}

/** A condition that holds at some widths only, or on a reader preference. */
const SOME_SCREENS = /width|height|aspect-ratio|orientation|prefers-/i;

/** A media query that holds on every screen: `all`, `screen` (or `only` either, `not print`, `not speech`) with no {@link SOME_SCREENS} condition. */
const EVERY_SCREEN = /^(?:$|\(|(?:(?:only\s+)?(?:all|screen)|not\s+(?:print|speech))(?:$|\s+and\s*\())/i;

/**
 * A block whose rules hold on the page at every width: `@supports`, `@layer`, and an `@media`
 * whose list has a query holding on every screen. A width, height, aspect-ratio or orientation
 * block, `@container`, print, speech and a reader preference are left to the web view.
 */
function everyWidthBlock(prelude: string): boolean {
  const at = /^@(media|supports|layer)(?![\w-])/i.exec(prelude);
  if (!at) return false;
  if (at[1]!.toLowerCase() !== "media") return true;
  return prelude.slice(at[0].length).split(",").some((q) => !SOME_SCREENS.test(q) && EVERY_SCREEN.test(q.trim()));
}

/**
 * A sheet's rules that hold on the page at every width, without comments: those at its top level
 * and those in an {@link everyWidthBlock} (a dark-scheme block is already gone after
 * {@link schemeFreeCss}). Every other at-rule (`@import`, `@font-face`, `@keyframes`) is left out.
 * Strings and escapes are text, so a quoted brace never ends a block.
 */
function topLevelCss(css: string, meter?: Meter): string {
  let out = "";
  // An at-rule starts a statement: after nothing, `{`, `}` or `;` (not `url(logo@2x.png)`).
  let atStatement = true;
  let rules = 0;
  let screens = 0;
  let i = 0;
  while (i < css.length) {
    const past = pastCssToken(css, i);
    if (meter) meter.visited += Math.max(past - i, 1);
    if (past > i) {
      if (css[i] === "/") out += " ";
      else { out += css.slice(i, past); atStatement = false; }
      i = past;
      continue;
    }
    const ch = css[i]!;
    if (ch !== "@" || !atStatement) {
      if (ch === "{") rules++;
      if (ch === "}" && rules === 0 && screens > 0) { screens--; out += ";"; }
      else {
        if (ch === "}" && rules > 0) rules--;
        out += ch;
      }
      if (!/\s/.test(ch)) atStatement = ch === "{" || ch === "}" || ch === ";";
      i++;
      continue;
    }
    // The prelude runs to the block's `{` (or a `;` or `}` that ends the statement), comments as spaces.
    let prelude = "";
    let j = i;
    while (j < css.length && css[j] !== "{" && css[j] !== ";" && css[j] !== "}") {
      const skip = pastCssToken(css, j);
      if (meter) meter.visited += Math.max(skip - j, 1);
      if (skip > j) { prelude += css[j] === "/" ? " " : css.slice(j, skip); j = skip; }
      else prelude += css[j++];
    }
    if (meter) meter.visited += prelude.length;
    if (rules === 0 && css[j] === "{" && everyWidthBlock(prelude)) {
      screens++;
      out += ";";
      i = j + 1;
      continue;
    }
    let depth = 0;
    while (i < css.length) {
      const skip = pastCssToken(css, i);
      if (meter) meter.visited += Math.max(skip - i, 1);
      if (skip > i) { i = skip; continue; }
      const c = css[i++];
      if (c === "{") depth++;
      else if (c === "}" && --depth <= 0) break;
      else if (c === ";" && depth === 0) break;
    }
    out += ";";
    atStatement = true;
  }
  return out;
}

/**
 * The background the page's own rules paint: the last body rule's, else the last html rule's. One
 * pass over the sheet whatever its nesting (no step recurses), `meter` counting what it visits.
 */
export function sheetPageBackground(css: string, meter?: Meter): Rgb | null {
  let body: Rgb | null = null, html: Rgb | null = null;
  const rules = topLevelCss(css, meter);
  if (meter) meter.visited += rules.length;
  for (const m of rules.matchAll(SHEET_PAGE_BG)) {
    for (const token of backgroundTokens(m[2]!, meter)) {
      const c = parseCssColor(token);
      if (!c || c.a < 0.5) continue;
      if (/body/i.test(m[1]!)) body = c;
      else html = c;
      break;
    }
  }
  return body ?? html;
}

/** The tags a page is painted with; a highlighted word is not the paper. */
const PAINTS_THE_PAGE = new Set([
  "table", "tbody", "tr", "td", "th", "div", "center", "section", "article", "main", "body",
]);

/** How far into the document the wrapper chain is followed. */
const BG_SCAN_LIMIT = 40;

/** Every element of `nodes`, depth first in document order, `head` included, `skip`'s subtrees not. */
function* elementsOf(nodes: readonly AnyNode[], skip: ReadonlySet<AnyNode>): Generator<Element> {
  const stack: Array<{ nodes: readonly AnyNode[]; at: number }> = [{ nodes, at: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.at === top.nodes.length) {
      stack.pop();
      continue;
    }
    const n = top.nodes[top.at++]!;
    if (!(n instanceof Element) || skip.has(n)) continue;
    yield n;
    stack.push({ nodes: n.children, at: 0 });
  }
}

/** What a mail declares about its page: the ground the light gate reads, and what the page itself sets. */
export interface MailPaper {
  /** In the order the frame paints it: an `html`/`body` sheet rule, the body's own, then the outermost painting wrapper. */
  ground: Rgb | null;
  /** The ground when a page rule or the body declared it, not a wrapper. */
  page: Rgb | null;
  /** The body's own ink, which the sanitizer drops with the body element. */
  ink: Rgb | null;
}

/**
 * The mail's declared paper, in the order the frame paints it: an `html`/`body` rule in `sheets`
 * (the sheets the frame draws, scheme-free), else the body element's own `bgcolor` or style (the
 * sanitizer drops the body element, so a page rule paints over it), then the outermost painting
 * wrapper within the first {@link BG_SCAN_LIMIT} elements. Only what is drawn is read: `skip` is
 * the folded history, whose wrappers are not in the document.
 */
export function mailPaperOf(doc: readonly AnyNode[], sheets: readonly string[], skip: ReadonlySet<AnyNode> = new Set()): MailPaper {
  let body: Element | null = null;
  for (const el of elementsOf(doc, skip)) {
    if (el.tagName === "body") { body = el; break; }
  }
  const ink = body === null ? null : declaredInk(body);
  const sheet = sheetPageBackground(sheets.join("\n"));
  if (sheet) return { ground: sheet, page: sheet, ink };
  const own = body === null ? null : declaredBackground(body);
  if (own) return { ground: own, page: own, ink };
  let seen = 0;
  for (const el of elementsOf(body === null ? doc : body.children, skip)) {
    if (++seen > BG_SCAN_LIMIT) break;
    if (!PAINTS_THE_PAGE.has(el.tagName)) continue;
    const c = declaredBackground(el);
    // A wrapper paints its own ground; it is the page's only when the body's ink was written for it.
    if (c) return { ground: c, page: ink !== null && contrastRatio(ink, c) >= READABLE_CONTRAST ? c : null, ink };
  }
  return { ground: null, page: null, ink };
}

/** The sanitizer's reading of a mail's page: may it be inverted, and the paper and ink it set. */
export function letterPaperOf(doc: readonly AnyNode[], sheets: readonly string[], skip?: ReadonlySet<AnyNode>): { light: boolean; paper: string | null; ink: string | null } {
  const { ground, page, ink } = mailPaperOf(doc, sheets, skip);
  return { light: mailIsLight(ground), paper: paintedPaper(page), ink: ink === null ? null : hexOf(ink) };
}

/**
 * The ink a letter's unstyled text is set in on `paper` (the web's rule): the body's own when it reads
 * there at 4.5:1, otherwise the light sheet's `fallback`. A page that names no ink is never given a
 * guessed light one: a white card inside a dark body would then read light on white.
 */
export function letterInk(paper: string, own: string | null, fallback: string): string {
  const ground = parseCssColor(paper);
  const ink = own === null ? null : parseCssColor(own);
  return ground !== null && ink !== null && contrastRatio(ground, ink) >= READABLE_CONTRAST ? own! : fallback;
}
