/**
 * HOW LIGHT IS THIS LETTER, AT THE WIDTH IT IS DRAWN? The one gate every reader runs (web, desktop,
 * phone). A dark reader shows a letter through one filter, `invert(1) hue-rotate(180deg)`; applied to a
 * letter that is already dark it draws it light, so the filter is gated on the letter's own paper:
 * invert what is light, leave alone what is not. A letter that declares nothing reads as light.
 *
 * The sender's conditions are decided here, for the frame, never by the frame: every `@media` and
 * `@supports` block is unwrapped (it matches the frame) or dropped (it does not), `<style media>` is
 * read by the same rule, and the page is then read from the sheets as the frame draws them, so painting
 * and reading agree at every width. The frame's width is an input; a letter is resolved again when the
 * width crosses one of its own thresholds ({@link letterBand}).
 *
 * Mail is hostile input: every pass is one loop over its text or tree, bounded and counted by a
 * {@link Meter}, never by a clock. Pure: no DOM, no React, no Node built-in, no Intl.
 */

import { MAIL_ALLOWED_TAGS, drawsNoWords, hiddenByOwnStyle } from "./mail-render-rules.js";
import type { QuotedTree } from "./quoted-history.js";

/** Counts the characters and nodes a reading visits: counted work, never time. */
export interface Meter { visited: number }

export interface Rgb { r: number; g: number; b: number; a: number }

// ── colours ─────────────────────────────────────────────────────────────────────────────────────

/** The colour keywords bulk mail is written with; an absent name has no opinion. */
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

/**
 * A CSS colour as numbers, or `null` for no opinion (`transparent`, a gradient, nonsense). The alpha
 * is kept: `rgba(0,0,0,0)` is spelled like a colour and paints nothing.
 */
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
  // `rgb(1,2,3)`, `rgba(1,2,3,.5)` and the space-separated `rgb(1 2 3 / 50%)`.
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

/** WCAG 2.x relative luminance (the channels linearised before they are weighted). */
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

/** Where black and white ink have equal contrast: above it a designer writes dark ink. */
export const LIGHT_LUMINANCE = 0.179;

/** How far from grey (the channel spread, 0–255) a light paper may drift and still be the template's habit. */
export const NEUTRAL_CHROMA = 12;

/** How many drawn elements the wrapper is looked for in. */
export const BG_SCAN_LIMIT = 40;

/** Is this letter worth inverting? `null` (nothing declared) is light: every renderer draws it on white. */
export function mailIsLight(bg: Rgb | null): boolean {
  return bg === null || relativeLuminance(bg) > LIGHT_LUMINANCE;
}

/**
 * The paper to paint: a dark page or a deliberate tint keeps its ground; a near-white grey is the
 * frame's own white (`null`), as is a letter that set no page.
 */
export function paintedPaper(page: Rgb | null): Rgb | null {
  if (page === null) return null;
  if (!mailIsLight(page)) return page;
  const chroma = Math.max(page.r, page.g, page.b) - Math.min(page.r, page.g, page.b);
  return chroma <= NEUTRAL_CHROMA ? null : page;
}

/** A computed colour as `#rrggbb` (alpha dropped: only opaque grounds and inks are ever written). */
export function cssHex(c: Rgb): string {
  const hex = (v: number): string => Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/** The most of one background value read: a real colour sits well within it. */
export const BACKGROUND_VALUE_MAX = 4096;

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * A background value's words, a function's parentheses kept whole (`rgb(18, 18, 18)` is one): one pass
 * over its first {@link BACKGROUND_VALUE_MAX} characters, split on spaces outside parentheses.
 */
export function backgroundTokens(value: string, meter?: Meter): string[] {
  const end = Math.min(value.length, BACKGROUND_VALUE_MAX);
  const out: string[] = [];
  let depth = 0;
  let from = -1;
  for (let i = 0; i < end; i++) {
    if (meter) meter.visited++;
    const c = value[i]!;
    if (depth === 0 && isSpace(c)) {
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

/** What one background declaration does to the background colour: a colour, transparent, or nothing readable. */
type BgEffect = { colour: Rgb } | "clear" | null;

/** Values computed only later (a variable, the environment): what they paint cannot be read here. */
const DEFERRED_VALUE = /\b(?:var|env|attr)\(/i;
/** Colour functions this reading does not compute, and images that paint over the colour. */
const UNREAD_FUNCTION = /^(?:hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|[a-z-]*gradient)\(/i;
/** The words a background shorthand is written with that name no colour. */
const BACKGROUND_WORDS = new Set([
  "none", "no-repeat", "repeat", "repeat-x", "repeat-y", "space", "round", "top", "bottom", "left", "right", "center",
  "cover", "contain", "auto", "fixed", "scroll", "local", "border-box", "padding-box", "content-box", "text", "/",
]);

/** `background-color: V`: a colour (opaque, else clear), `transparent`/`initial` clear, anything else unread. */
function backgroundColorEffect(value: string, meter?: Meter): BgEffect {
  if (meter) meter.visited += Math.min(value.length, BACKGROUND_VALUE_MAX);
  if (value.length > BACKGROUND_VALUE_MAX || DEFERRED_VALUE.test(value)) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent" || v === "initial") return "clear";
  const c = parseCssColor(v);
  if (c === null) return null;
  return c.a >= 0.5 ? { colour: c } : "clear";
}

/** `background: V`: its colour token; a shorthand that names no colour clears it; a gradient or an unread colour is unread. */
function backgroundEffect(value: string, meter?: Meter): BgEffect {
  if (value.length > BACKGROUND_VALUE_MAX || DEFERRED_VALUE.test(value)) return null;
  let unread = false;
  for (const raw of backgroundTokens(value, meter)) {
    // The final layer holds the colour: a comma ends a layer.
    let end = raw.length;
    while (end > 0 && raw[end - 1] === ",") end--;
    const token = raw.slice(0, end);
    if (meter) meter.visited += raw.length;
    if (token.length === 0) continue;
    const c = parseCssColor(token);
    if (c !== null) return c.a >= 0.5 ? { colour: c } : "clear";
    const lower = token.toLowerCase();
    if (lower === "transparent") return "clear";
    if (UNREAD_FUNCTION.test(lower)) unread = true;
    else if (/^(?:url|image-set|-webkit-image-set)\(/.test(lower) || /^[-+.\d]/.test(lower) || BACKGROUND_WORDS.has(lower)) continue;
    else unread = true;
  }
  return unread ? null : "clear";
}

// ── the frame's media ───────────────────────────────────────────────────────────────────────────

/** The frame a letter is drawn in, as its own viewport sees it. */
export interface LetterFrame {
  /** The frame's viewport width, CSS px. */
  readonly width: number;
}

/** The frame's height as a sender's condition reads it: fixed, so no block depends on a measured height. */
export const LETTER_MEDIA_HEIGHT_PX = 600;

/** A width threshold a letter's conditions compare against: passed when `w > px` (strict) or `w >= px`. */
export interface LetterBreak {
  readonly px: number;
  readonly strict: boolean;
}

/** The most distinct thresholds one pass records; past it a size comparison is false. */
export const LETTER_BREAKS_MAX = 64;

/** The longest condition read; a longer one never matches. */
export const LETTER_PRELUDE_MAX = 1000;

/** The deepest block kept, in the frame and in the reading alike; a deeper one is dropped. */
export const LETTER_BLOCK_DEPTH = 32;

/** The deepest brackets a condition is read through; a deeper one never matches. */
const CONDITION_DEPTH = 32;

/** One sanitize pass's media: the sheets resolved for one frame, and the thresholds they compared against. */
export interface LetterMedia {
  /**
   * The sheet as the frame draws it at this width, with no condition left in it, or `null` when the
   * element is not drawn at all (its `media` never matches, or its `type` is not CSS).
   */
  sheet(css: string, attrs?: { media?: string | null; type?: string | null }): string | null;
  /** Every threshold compared so far, deduplicated and sorted (at most {@link LETTER_BREAKS_MAX}). */
  readonly breaks: readonly LetterBreak[];
}

/** Which band of `breaks` a width falls in: two widths in the same band resolve every condition alike. */
export function letterBand(width: number, breaks: readonly LetterBreak[]): number {
  let n = 0;
  for (const b of breaks) if (b.strict ? width > b.px : width >= b.px) n++;
  return n;
}

const PX_PER: Record<string, number> = {
  px: 1, em: 16, rem: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16,
};

const MEDIA_TYPES = new Set(["all", "screen", "print", "speech", "tv", "handheld", "projection", "tty", "braille", "embossed", "aural"]);
const NOT_A_TYPE = new Set(["and", "or", "not", "only", "layer"]);

type Tok =
  | { t: "ident"; v: string }
  | { t: "num"; v: number; unit: string }
  | { t: "open"; fn: string | null; close: number }
  | { t: "close" | "comma" | "colon" | "slash" | "other" }
  | { t: "op"; v: "<" | "<=" | ">" | ">=" | "=" };

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isNameStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c > "\x7f";
const isName = (c: string): boolean => isNameStart(c) || isDigit(c) || c === "-";

/** A condition's tokens, brackets matched; `null` when it never matches (an escape, unbalanced or too deep). */
function conditionTokens(s: string, meter?: Meter): Tok[] | null {
  const out: Tok[] = [];
  const opens: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (meter) meter.visited++;
    const c = s[i]!;
    if (isSpace(c)) { i++; continue; }
    if (c === "\\") return null;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j++;
      out.push({ t: "other" });
      i = j + 1;
      continue;
    }
    if (c === "(") {
      if (opens.length >= CONDITION_DEPTH) return null;
      opens.push(out.length);
      out.push({ t: "open", fn: null, close: -1 });
      i++;
      continue;
    }
    if (c === ")") {
      const at = opens.pop();
      if (at === undefined) return null;
      (out[at] as { close: number }).close = out.length;
      out.push({ t: "close" });
      i++;
      continue;
    }
    if (c === ",") { out.push({ t: "comma" }); i++; continue; }
    if (c === ":") { out.push({ t: "colon" }); i++; continue; }
    if (c === "/") { out.push({ t: "slash" }); i++; continue; }
    if (c === "<" || c === ">") {
      const eq = s[i + 1] === "=";
      out.push({ t: "op", v: eq ? (c === "<" ? "<=" : ">=") : c });
      i += eq ? 2 : 1;
      continue;
    }
    if (c === "=") { out.push({ t: "op", v: "=" }); i++; continue; }
    const signed = (c === "+" || c === "-") && (isDigit(s[i + 1] ?? "") || (s[i + 1] === "." && isDigit(s[i + 2] ?? "")));
    if (isDigit(c) || (c === "." && isDigit(s[i + 1] ?? "")) || signed) {
      let j = signed ? i + 1 : i;
      while (j < s.length && isDigit(s[j]!)) j++;
      if (s[j] === "." && isDigit(s[j + 1] ?? "")) { j++; while (j < s.length && isDigit(s[j]!)) j++; }
      if ((s[j] === "e" || s[j] === "E") && (isDigit(s[j + 1] ?? "") || ((s[j + 1] === "+" || s[j + 1] === "-") && isDigit(s[j + 2] ?? "")))) {
        j += 2;
        while (j < s.length && isDigit(s[j]!)) j++;
      }
      const v = Number(s.slice(i, j));
      let k = j;
      if (s[k] === "%") k++;
      else while (k < s.length && isName(s[k]!)) k++;
      if (meter) meter.visited += k - i;
      out.push({ t: "num", v, unit: s.slice(j, k).toLowerCase() });
      i = k;
      continue;
    }
    if (isNameStart(c) || (c === "-" && (isNameStart(s[i + 1] ?? "") || s[i + 1] === "-"))) {
      let j = i + 1;
      while (j < s.length && isName(s[j]!)) j++;
      if (meter) meter.visited += j - i;
      const name = s.slice(i, j).toLowerCase();
      if (s[j] === "(") {
        if (opens.length >= CONDITION_DEPTH) return null;
        opens.push(out.length);
        out.push({ t: "open", fn: name, close: -1 });
        i = j + 1;
        continue;
      }
      out.push({ t: "ident", v: name });
      i = j;
      continue;
    }
    out.push({ t: "other" });
    i++;
  }
  return opens.length === 0 ? out : null;
}

type Value = { kind: "len"; px: number } | { kind: "ratio"; r: number } | { kind: "num"; n: number } | { kind: "ident"; v: string };

/**
 * The evaluator for one frame. A query that names anything this file does not know never matches,
 * even under `not` (`bad`); each width comparison records its threshold.
 */
class Conditions {
  bad = false;
  private readonly seen = new Map<string, LetterBreak>();

  constructor(private readonly width: number, private readonly meter?: Meter) {}

  get breaks(): LetterBreak[] {
    return [...this.seen.values()].sort((a, b) => a.px - b.px || Number(a.strict) - Number(b.strict));
  }

  /** `w > px` (strict) or `w >= px`, recorded; `null` past {@link LETTER_BREAKS_MAX}. */
  private passes(px: number, strict: boolean): boolean | null {
    const key = `${px}|${strict ? 1 : 0}`;
    if (!this.seen.has(key)) {
      if (this.seen.size >= LETTER_BREAKS_MAX) return null;
      this.seen.set(key, { px, strict });
    }
    return strict ? this.width > px : this.width >= px;
  }

  /** `W op px`, the frame's width against a threshold. */
  private widthIs(op: string, px: number): boolean {
    const ge = op === ">=" || op === "<" || op === "=" ? this.passes(px, false) : true;
    const gt = op === ">" || op === "<=" || op === "=" ? this.passes(px, true) : false;
    if (ge === null || gt === null) return false;
    switch (op) {
      case ">=": return ge;
      case ">": return gt;
      case "<": return !ge;
      case "<=": return !gt;
      default: return ge && !gt;
    }
  }

  private static fixed(op: string, a: number, b: number): boolean {
    switch (op) {
      case ">=": return a >= b;
      case ">": return a > b;
      case "<": return a < b;
      case "<=": return a <= b;
      default: return a === b;
    }
  }

  /** The value at `toks[i]`, and the index after it. */
  private value(toks: Tok[], i: number, end: number): { v: Value; next: number } | null {
    const t = toks[i];
    if (!t || i >= end) return null;
    if (t.t === "ident") return { v: { kind: "ident", v: t.v }, next: i + 1 };
    if (t.t !== "num") return null;
    const slash = toks[i + 1];
    const den = toks[i + 2];
    if (t.unit === "" && slash?.t === "slash" && i + 2 < end && den?.t === "num" && den.unit === "") {
      if (!(den.v > 0) || t.v < 0) return null;
      return { v: { kind: "ratio", r: t.v / den.v }, next: i + 3 };
    }
    if (t.unit === "") return { v: { kind: "num", n: t.v }, next: i + 1 };
    const per = PX_PER[t.unit];
    return per === undefined ? null : { v: { kind: "len", px: t.v * per }, next: i + 1 };
  }

  /** One feature compared: `name op value`, or `null` when it is not one this file knows. */
  private compare(name: string, op: string, v: Value): boolean | null {
    const length = v.kind === "len" ? v.px : v.kind === "num" && v.n === 0 ? 0 : null;
    const ratio = v.kind === "ratio" ? v.r : v.kind === "num" && v.n >= 0 ? v.n : null;
    switch (name) {
      case "width":
      case "device-width":
        return length === null ? null : this.widthIs(op, length);
      case "height":
      case "device-height":
        return length === null ? null : Conditions.fixed(op, LETTER_MEDIA_HEIGHT_PX, length);
      case "aspect-ratio":
      case "device-aspect-ratio":
        return ratio === null ? null : this.widthIs(op, ratio * LETTER_MEDIA_HEIGHT_PX);
      default:
        return null;
    }
  }

  /** `( feature )`'s inside: boolean, plain, `min-`/`max-`, or a range. */
  private feature(toks: Tok[], a: number, b: number): boolean {
    const first = toks[a];
    if (b - a === 1 && first?.t === "ident") {
      // A boolean feature holds when its value is not zero or `none`: every known one does.
      if (["width", "height", "device-width", "device-height", "aspect-ratio", "device-aspect-ratio", "orientation", "prefers-color-scheme"].includes(first.v)) return true;
      this.bad = true;
      return false;
    }
    if (first?.t === "ident" && toks[a + 1]?.t === "colon") {
      const name = first.v;
      if (name === "orientation" || name === "prefers-color-scheme") {
        const v = toks[a + 2];
        if (b - a !== 3 || v?.t !== "ident") { this.bad = true; return false; }
        if (name === "prefers-color-scheme") {
          if (v.v === "light") return true;
          if (v.v === "dark") return false;
          this.bad = true;
          return false;
        }
        if (v.v === "portrait") return this.widthIs("<=", LETTER_MEDIA_HEIGHT_PX);
        if (v.v === "landscape") return this.widthIs(">", LETTER_MEDIA_HEIGHT_PX);
        this.bad = true;
        return false;
      }
      const prefix = name.startsWith("min-") ? ">=" : name.startsWith("max-") ? "<=" : "=";
      const val = this.value(toks, a + 2, b);
      const got = val !== null && val.next === b ? this.compare(prefix === "=" ? name : name.slice(4), prefix, val.v) : null;
      if (got === null) { this.bad = true; return false; }
      return got;
    }
    // Ranges: `name op v`, `v op name`, `v op name op v`.
    const flip: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };
    if (first?.t === "ident" && toks[a + 1]?.t === "op") {
      const op = (toks[a + 1] as { v: string }).v;
      const val = this.value(toks, a + 2, b);
      const got = val !== null && val.next === b ? this.compare(first.v, op, val.v) : null;
      if (got === null) { this.bad = true; return false; }
      return got;
    }
    const left = this.value(toks, a, b);
    const op1 = left === null ? undefined : toks[left.next];
    const name = left === null ? undefined : toks[left.next + 1];
    if (left === null || op1?.t !== "op" || name?.t !== "ident") { this.bad = true; return false; }
    const one = this.compare(name.v, flip[op1.v]!, left.v);
    let next = left.next + 2;
    let two: boolean | null = true;
    if (next < b) {
      const op2 = toks[next];
      const right = this.value(toks, next + 1, b);
      const sameWay = op2?.t === "op" && op2.v !== "=" && op1.v !== "=" && (op1.v[0] === op2.v[0]);
      if (!sameWay || right === null || right.next !== b) { this.bad = true; return false; }
      two = this.compare(name.v, op2.v, right.v);
      next = b;
    }
    if (one === null || two === null || next !== b) { this.bad = true; return false; }
    return one && two;
  }

  /** `( … )` at `open`: a nested condition, a feature, or (anything else) unknown. */
  private inParens(toks: Tok[], open: number): boolean {
    const t = toks[open] as Extract<Tok, { t: "open" }>;
    if (t.fn !== null || t.close === open + 1) { this.bad = true; return false; }
    const a = open + 1, b = t.close;
    const first = toks[a]!;
    if (first.t === "open" || (first.t === "ident" && first.v === "not" && toks[a + 1]?.t === "open")) return this.condition(toks, a, b, true);
    return this.feature(toks, a, b);
  }

  /** `not ( … )`, or `( … )` joined by one of `and` / `or` (`or` only where the grammar allows it). */
  condition(toks: Tok[], a: number, b: number, orAllowed: boolean): boolean {
    const first = toks[a];
    if (first?.t === "ident" && first.v === "not") {
      const g = toks[a + 1];
      if (g?.t !== "open" || g.close !== b - 1) { this.bad = true; return false; }
      return !this.inParens(toks, a + 1);
    }
    if (first?.t !== "open") { this.bad = true; return false; }
    let v = this.inParens(toks, a);
    let i = first.close + 1;
    let op: string | null = null;
    while (i < b) {
      if (this.meter) this.meter.visited++;
      const w = toks[i];
      if (w?.t !== "ident" || (w.v !== "and" && w.v !== "or") || (op !== null && w.v !== op) || (w.v === "or" && !orAllowed)) { this.bad = true; return false; }
      op = w.v;
      const g = toks[i + 1];
      if (g?.t !== "open") { this.bad = true; return false; }
      const x = this.inParens(toks, i + 1);
      v = op === "and" ? v && x : v || x;
      i = g.close + 1;
    }
    return v;
  }

  /** One media query of a list. */
  query(toks: Tok[], a: number, b: number): boolean {
    this.bad = false;
    if (a >= b) return false;
    const first = toks[a]!;
    let v: boolean;
    if (first.t === "open" || (first.t === "ident" && first.v === "not" && toks[a + 1]?.t === "open")) {
      v = this.condition(toks, a, b, true);
    } else {
      let i = a;
      const modifier = first.t === "ident" && (first.v === "not" || first.v === "only") ? first.v : null;
      if (modifier !== null) i++;
      const type = toks[i];
      if (type?.t !== "ident" || NOT_A_TYPE.has(type.v) || !MEDIA_TYPES.has(type.v)) return false;
      v = type.v === "all" || type.v === "screen";
      i++;
      if (i < b) {
        const and = toks[i];
        if (and?.t !== "ident" || and.v !== "and") return false;
        const c = this.condition(toks, i + 1, b, false);
        v = v && c;
      }
      if (modifier === "not") v = !v;
    }
    return this.bad ? false : v;
  }

  /** A media query list: any query matching; empty matches; too long or unreadable never does. */
  mediaList(prelude: string): boolean {
    if (this.meter) this.meter.visited += prelude.length;
    if (prelude.length > LETTER_PRELUDE_MAX) return false;
    const toks = conditionTokens(prelude, this.meter);
    if (toks === null) return false;
    if (toks.length === 0) return true;
    let matched = false;
    let from = 0;
    for (let i = 0; i <= toks.length; i++) {
      const t = toks[i];
      if (t?.t === "open") { i = t.close; continue; }
      if (i < toks.length && t?.t !== "comma") continue;
      if (this.query(toks, from, i)) matched = true;
      from = i + 1;
    }
    return matched;
  }

  /** `@supports C`: a declaration test (not on a vendor-prefixed property), `selector()`, `font-tech()`/`font-format()` hold; anything else is false. */
  supports(prelude: string): boolean {
    if (this.meter) this.meter.visited += prelude.length;
    if (prelude.length > LETTER_PRELUDE_MAX) return false;
    const toks = conditionTokens(prelude, this.meter);
    if (toks === null || toks.length === 0) return false;
    this.bad = false;
    const v = this.supportsCondition(toks, 0, toks.length);
    return this.bad ? false : v;
  }

  private supportsCondition(toks: Tok[], a: number, b: number): boolean {
    const first = toks[a];
    if (first?.t === "ident" && first.v === "not") {
      const g = toks[a + 1];
      if (g?.t !== "open" || g.close !== b - 1) { this.bad = true; return false; }
      return !this.supportsInParens(toks, a + 1);
    }
    if (first?.t !== "open") { this.bad = true; return false; }
    let v = this.supportsInParens(toks, a);
    let i = first.close + 1;
    let op: string | null = null;
    while (i < b) {
      const w = toks[i];
      if (w?.t !== "ident" || (w.v !== "and" && w.v !== "or") || (op !== null && w.v !== op)) { this.bad = true; return false; }
      op = w.v;
      const g = toks[i + 1];
      if (g?.t !== "open") { this.bad = true; return false; }
      const x = this.supportsInParens(toks, i + 1);
      v = op === "and" ? v && x : v || x;
      i = g.close + 1;
    }
    return v;
  }

  private supportsInParens(toks: Tok[], open: number): boolean {
    const t = toks[open] as Extract<Tok, { t: "open" }>;
    if (t.fn !== null) return t.fn === "selector" || t.fn === "font-tech" || t.fn === "font-format";
    const a = open + 1, b = t.close;
    if (a >= b) return false;
    const first = toks[a]!;
    if (first.t === "open" || (first.t === "ident" && first.v === "not")) return this.supportsCondition(toks, a, b);
    // A vendor-prefixed property targets one engine: false, so the letter's fallback stays.
    const vendor = first.t === "ident" && first.v.startsWith("-") && !first.v.startsWith("--");
    return first.t === "ident" && !vendor && toks[a + 1]?.t === "colon";
  }
}

// ── one pass over a sheet ─────────────────────────────────────────────────────────────────────────

/** The index just past the comment, string, escape or unquoted `url(…)` that starts at `i`, or `i` when none does. */
function pastToken(css: string, i: number): number {
  const c = css[i];
  if (c === "\\") return Math.min(i + 2, css.length);
  if (c === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < css.length) {
      const d = css[j];
      if (d === c) return j + 1;
      // A string a line ends is over; the newline is the sheet's again.
      if (d === "\n") return j;
      j += d === "\\" ? 2 : 1;
    }
    return css.length;
  }
  if ((c === "u" || c === "U") && css.slice(i, i + 4).toLowerCase() === "url(" && (i === 0 || !isName(css[i - 1]!))) {
    let j = i + 4;
    while (j < css.length && isSpace(css[j]!)) j++;
    if (css[j] === '"' || css[j] === "'") return i;
    while (j < css.length && css[j] !== ")") j += css[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, css.length);
  }
  return i;
}

/** The at-rule name at the start of `prelude` (`@media …` → `media`), or `null` when it holds an escape. */
function atName(prelude: string): string | null {
  const at = prelude.indexOf("@");
  let j = at + 1;
  while (j < prelude.length && isName(prelude[j]!)) j++;
  if (prelude[j] === "\\") return null;
  return prelude.slice(at + 1, j).toLowerCase();
}

/** Kept with their blocks, any group rule inside them resolved. */
const KEPT_BLOCKS = new Set([
  "layer", "font-face", "keyframes", "-webkit-keyframes", "page", "property", "counter-style", "font-feature-values", "font-palette-values",
]);
/** Kept as written, without a block. */
const KEPT_STATEMENTS = new Set(["import", "charset", "namespace", "layer"]);

/**
 * The levels an `@layer` adds inside `base` levels of layers: a block's name counts its parts (`a.b` is
 * two, an anonymous block one), a statement adds none; `null` when a name would pass
 * {@link LETTER_BLOCK_DEPTH} levels, the names pass {@link LETTER_PRELUDE_MAX}, or a block names more
 * than one layer (invalid, and the engines drop it): the rule goes.
 */
function layerLevels(names: string, base: number, block: boolean, meter?: Meter): number | null {
  if (meter) meter.visited += names.length;
  if (names.length > LETTER_PRELUDE_MAX) return null;
  let deepest = 0, parts = 1;
  for (let i = 0; i <= names.length; i++) {
    const c = names[i];
    if (c === ".") parts++;
    else if (c === "," && block) return null;
    else if (c === "," || c === undefined) {
      deepest = Math.max(deepest, parts);
      parts = 1;
    }
  }
  return base + deepest > LETTER_BLOCK_DEPTH ? null : block ? deepest : 0;
}

/** What follows an at-rule's name (`@layer a, b;` → ` a, b`), its closing `;` left off. */
function atCondition(text: string, name: string): string {
  const rest = text.slice(text.indexOf("@") + 1 + name.length);
  return rest.endsWith(";") ? rest.slice(0, -1) : rest;
}

const leadsWithAt = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (!isSpace(s[i]!)) return s[i] === "@";
  }
  return false;
};

/**
 * The sheet with every `@media` and `@supports` decided for this frame: a block that matches is
 * unwrapped, one that does not is dropped with its rules, `@container` and unknown at-rules go, and a
 * block deeper than {@link LETTER_BLOCK_DEPTH} goes. One pass, an explicit stack; every removal leaves
 * one space, so no two sender tokens can join. Comments go too.
 */
function resolveSheet(css: string, cond: Conditions, meter?: Meter): string {
  const out: string[] = [];
  // The statement read since the last `;`, `{` or `}`: decided once its end is seen.
  let buf = "";
  // `levels`: the layer levels this block sits in, each part of a layer's name one.
  const stack: Array<{ keep: boolean; inAt: boolean; levels: number }> = [];
  const inAt = (): boolean => stack.length > 0 && stack[stack.length - 1]!.inAt;
  const levels = (): number => (stack.length > 0 ? stack[stack.length - 1]!.levels : 0);
  /** A statement with no block (`@import …;`, a declaration): kept, or a statement at-rule dropped. */
  const statement = (text: string): void => {
    if (!leadsWithAt(text)) { out.push(text); return; }
    const name = atName(text);
    const kept = name !== null && (KEPT_STATEMENTS.has(name) || inAt())
      && (name !== "layer" || layerLevels(atCondition(text, name).trim(), levels(), false, meter) !== null);
    out.push(kept ? text : " ");
  };
  /** Skips the block whose `{` is at `i`, to its matching `}`; returns the index past it. */
  const skipBlock = (from: number): number => {
    let depth = 0;
    let j = from;
    while (j < css.length) {
      const past = pastToken(css, j);
      if (meter) meter.visited += Math.max(past - j, 1);
      if (past > j) { j = past; continue; }
      const c = css[j++];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    return j;
  };
  let i = 0;
  while (i < css.length) {
    const past = pastToken(css, i);
    if (meter) meter.visited += Math.max(past - i, 1);
    if (past > i) {
      buf += css[i] === "/" && css[i + 1] === "*" ? " " : css.slice(i, past);
      i = past;
      continue;
    }
    const ch = css[i]!;
    if (ch === ";") {
      statement(`${buf};`);
      buf = "";
      i++;
      continue;
    }
    if (ch === "}") {
      if (buf.trim().length > 0) statement(buf);
      else out.push(buf);
      buf = "";
      const frame = stack.pop();
      // A stray `}` would join the next rule's selector and void it: it goes.
      out.push(frame?.keep === true ? "}" : " ");
      i++;
      continue;
    }
    if (ch !== "{") {
      buf += ch;
      i++;
      continue;
    }
    const prelude = buf;
    buf = "";
    let keep: { keep: boolean; inAt: boolean; levels: number } | null = null;
    if (stack.length < LETTER_BLOCK_DEPTH) {
      const at = levels();
      if (!leadsWithAt(prelude)) keep = { keep: true, inAt: inAt(), levels: at };
      else {
        const name = atName(prelude);
        const condition = name === null ? "" : prelude.slice(prelude.indexOf("@") + 1 + name.length);
        if (name === null || name === "container") keep = null;
        else if (name === "media") keep = cond.mediaList(condition.trim()) ? { keep: false, inAt: inAt(), levels: at } : null;
        else if (name === "supports") keep = cond.supports(condition.trim()) ? { keep: false, inAt: inAt(), levels: at } : null;
        else if (name === "layer") {
          const n = layerLevels(condition.trim(), at, true, meter);
          keep = n === null ? null : { keep: true, inAt: inAt(), levels: at + n };
        } else if (KEPT_BLOCKS.has(name)) keep = { keep: true, inAt: true, levels: at };
        else if (inAt()) keep = { keep: true, inAt: true, levels: at };
      }
    }
    if (keep === null) {
      out.push(" ");
      i = skipBlock(i);
      continue;
    }
    stack.push(keep);
    out.push(keep.keep ? `${prelude}{` : " ");
    i++;
  }
  if (buf.length > 0) statement(buf);
  return out.join("");
}

/** The media of one sanitize pass, for a frame of `frame.width`. */
export function letterMediaAt(frame: LetterFrame, meter?: Meter): LetterMedia {
  const cond = new Conditions(frame.width, meter);
  return {
    sheet(css, attrs) {
      const type = attrs?.type?.trim().toLowerCase() ?? "";
      if (type !== "" && type !== "text/css") return null;
      if (attrs?.media != null && !cond.mediaList(attrs.media.trim())) return null;
      return resolveSheet(css, cond, meter);
    },
    get breaks() {
      return cond.breaks;
    },
  };
}

// ── the page, read from the sheets the frame draws ───────────────────────────────────────────────

/** A page declaration's place in the cascade. */
interface PageDecl {
  effect: Exclude<BgEffect, null>;
  important: boolean;
  /** The layer's rank node; unlayered is `-1`. */
  layer: number;
  specificity: number;
  order: number;
}

/** The page selectors, as `html`, `body` or both, with their specificity. */
const PAGE_SELECTORS = new Map<string, { html: boolean; body: boolean; specificity: number }>([
  ["html", { html: true, body: false, specificity: 1 }],
  [":root", { html: true, body: false, specificity: 100 }],
  ["body", { html: false, body: true, specificity: 1 }],
  ["html body", { html: false, body: true, specificity: 2 }],
  ["html>body", { html: false, body: true, specificity: 2 }],
  [":root body", { html: false, body: true, specificity: 101 }],
  [":root>body", { html: false, body: true, specificity: 101 }],
  ["*", { html: true, body: true, specificity: 0 }],
]);
/** The longest page selector (`:root body`): a longer part names no page. */
const PAGE_SELECTOR_MAX = 10;

/**
 * The page targets of a selector list, at the highest specificity each is matched with, and whether
 * any part of it names something other than the page. Each part is read once, lower-cased, its
 * whitespace collapsed and dropped around `>`; a part longer than every page selector is no page selector.
 */
function pageTargets(selector: string, meter?: Meter): { html: number | null; body: number | null; other: boolean } {
  let html: number | null = null, body: number | null = null, other = false;
  let key = "", space = false, over = false;
  for (let i = 0; i <= selector.length; i++) {
    if (meter) meter.visited++;
    const c = selector[i];
    if (c === undefined || c === ",") {
      const hit = over ? undefined : PAGE_SELECTORS.get(key);
      if (hit?.html) html = Math.max(html ?? -1, hit.specificity);
      if (hit?.body) body = Math.max(body ?? -1, hit.specificity);
      if (hit === undefined) other = true;
      key = ""; space = false; over = false;
      continue;
    }
    if (over) continue;
    if (isSpace(c)) { space = key.length > 0; continue; }
    if (c !== ">" && space && !key.endsWith(">")) key += " ";
    space = false;
    key += c.toLowerCase();
    if (key.length > PAGE_SELECTOR_MAX) over = true;
  }
  return { html, body, other };
}

/** The longest property name read; a longer one is no property this reading asks about. */
const PROPERTY_NAME_MAX = 32;

/**
 * Does `text` (an inline style, or with `one` a single declaration of a sheet, read to its colon)
 * declare a property `named` accepts? Presence only: no value is read. One counted pass; comments,
 * strings and `url()` are text, and a name spelled with an escape counts, since it may spell any property.
 */
function declares(text: string, named: (name: string) => boolean, meter?: Meter, one = false): boolean {
  let name = "", gap = false, bad = false, inName = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ";") {
      name = ""; gap = false; bad = false; inName = true;
      i++;
      if (meter) meter.visited++;
      continue;
    }
    const past = pastToken(text, i);
    if (meter) meter.visited += Math.max(past - i, 1);
    if (!inName) {
      i = Math.max(past, i + 1);
      continue;
    }
    if (c === "\\") return true;
    if (past > i || isSpace(c)) {
      // A comment or a space ends the name; a word after it makes the name no property.
      if (name.length > 0) gap = true;
      i = Math.max(past, i + 1);
      continue;
    }
    if (c === ":") {
      if (!bad && named(name)) return true;
      if (one) return false;
      inName = false;
    } else if (gap || name.length >= PROPERTY_NAME_MAX) bad = true;
    else name += c.toLowerCase();
    i++;
  }
  return false;
}

/** A background property: the shorthand or any longhand. */
const isBackground = (name: string): boolean => name === "background" || name.startsWith("background-");
const isColor = (name: string): boolean => name === "color";

/** One declaration's background effect, `!important` read off its end. */
function declarationOf(text: string, meter?: Meter): { effect: BgEffect; important: boolean } | null {
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  const prop = text.slice(0, colon).trim().toLowerCase();
  if (prop !== "background" && prop !== "background-color") return null;
  let value = text.slice(colon + 1);
  const bang = /!\s*important\s*$/i.exec(value);
  if (bang) value = value.slice(0, bang.index);
  const effect = prop === "background" ? backgroundEffect(value.trim(), meter) : backgroundColorEffect(value, meter);
  return { effect, important: bang !== null };
}

/** A pair of layer nodes as one number (each node costs a sheet at least a character, so mail has far fewer). */
const PAIR_KEY = 2 ** 26;

/** The page's body and html winners over every sheet, in document order. */
class PageCascade {
  body: PageDecl | null = null;
  html: PageDecl | null = null;
  /** A rule that is not a page rule (or a block inside one) declares a background: presence only. */
  elementBackground = false;
  private order = 0;
  /** One rank node per layer: its parent (`-1` at the top), its rank among its siblings, its levels. */
  private readonly nodes: Array<{ parent: number; rank: number; levels: number }> = [];
  /** `parent.part` → node; `parent` is a node number, so the key is unambiguous. */
  private readonly named = new Map<string, number>();
  private readonly children = new Map<number, number>();
  /** Each compared pair's order, keyed by {@link PAIR_KEY}. */
  private readonly orders = new Map<number, number>();
  private anonymous = 0;

  constructor(private readonly meter?: Meter) {}

  private levels(node: number): number {
    return node < 0 ? 0 : this.nodes[node]!.levels;
  }

  /** The node of layer `name` inside `parent`, its parts registered on first sight; `null` past the bound. */
  private layer(parent: number, name: string): number | null {
    if (layerLevels(name, this.levels(parent), true, this.meter) === null) return null;
    let at = parent;
    for (const part of name.split(".")) {
      if (this.meter) this.meter.visited += part.length + 1;
      const key = `${at}.${part}`;
      let node = this.named.get(key);
      if (node === undefined) {
        const rank = this.children.get(at) ?? 0;
        this.children.set(at, rank + 1);
        node = this.nodes.length;
        this.nodes.push({ parent: at, rank, levels: this.levels(at) + 1 });
        this.named.set(key, node);
      }
      at = node;
    }
    return at;
  }

  /**
   * Layer `a` against `b` (`-1` unlayered): negative when `a` ranks below. Two layers' order never
   * changes once both exist, so each pair is walked once, over at most the bounded levels, every step counted.
   */
  private layerOrder(a: number, b: number): number {
    if (this.meter) this.meter.visited++;
    if (a === b) return 0;
    if (this.nodes.length >= PAIR_KEY - 1) return this.walkOrder(a, b);
    const key = (a + 1) * PAIR_KEY + (b + 1);
    const known = this.orders.get(key);
    if (known !== undefined) return known;
    const order = this.walkOrder(a, b);
    this.orders.set(key, order);
    return order;
  }

  private walkOrder(a: number, b: number): number {
    let x = a, y = b;
    const dx = this.levels(x), dy = this.levels(y);
    let steps = 1;
    // Bring both to one level; a layer's own rules rank above its sublayers', unlayered (-1) above every layer.
    let up = 0;
    while (this.levels(x) > dy) { x = this.nodes[x]!.parent; up = 1; steps++; }
    while (this.levels(y) > dx) { y = this.nodes[y]!.parent; up = -1; steps++; }
    // Two layers on one level: up to the siblings, ranked in the order their names first appeared.
    while (x !== y && this.nodes[x]!.parent !== this.nodes[y]!.parent) { x = this.nodes[x]!.parent; y = this.nodes[y]!.parent; steps += 2; }
    if (this.meter) this.meter.visited += steps;
    if (x === y) return up === 0 ? 0 : -up;
    return this.nodes[x]!.rank < this.nodes[y]!.rank ? -1 : 1;
  }

  /** Does `a` win the cascade over `b`? */
  private wins(a: PageDecl, b: PageDecl): boolean {
    if (a.important !== b.important) return a.important;
    const l = this.layerOrder(a.layer, b.layer);
    if (l !== 0) return a.important ? l < 0 : l > 0;
    if (a.specificity !== b.specificity) return a.specificity > b.specificity;
    return a.order > b.order;
  }

  private take(target: "html" | "body", d: PageDecl): void {
    const was = this[target];
    if (was === null || this.wins(d, was)) this[target] = d;
  }

  /**
   * One resolved sheet: style rules at its top level or inside `@layer`, their own declarations only;
   * and, in the same pass, whether any other block declares a background.
   */
  read(css: string): void {
    const meter = this.meter;
    type Frame =
      | { kind: "group"; layer: number }
      | { kind: "rule"; targets: { html: number | null; body: number | null }; layer: number; other: boolean }
      | { kind: "other" };
    const stack: Frame[] = [];
    let buf = "";
    const top = (): Frame | undefined => stack[stack.length - 1];
    const groupLayer = (): number | null => {
      const t = top();
      return t === undefined ? -1 : t.kind === "group" ? t.layer : null;
    };
    const declare = (frame: Extract<Frame, { kind: "rule" }>, text: string): void => {
      const d = declarationOf(text, meter);
      if (d === null || d.effect === null) return;
      const order = this.order++;
      const layer = frame.layer;
      if (frame.targets.html !== null) this.take("html", { effect: d.effect, important: d.important, layer, specificity: frame.targets.html, order });
      if (frame.targets.body !== null) this.take("body", { effect: d.effect, important: d.important, layer, specificity: frame.targets.body, order });
    };
    /** A background declared in any block but a page rule's own: presence only, read to its colon. */
    const notePresence = (frame: Frame | undefined, text: string): void => {
      if (this.elementBackground || frame === undefined || frame.kind === "group" || (frame.kind === "rule" && !frame.other)) return;
      if (declares(text, isBackground, meter, true)) this.elementBackground = true;
    };
    let i = 0;
    while (i < css.length) {
      const past = pastToken(css, i);
      if (meter) meter.visited += Math.max(past - i, 1);
      if (past > i) {
        buf += css[i] === "/" && css[i + 1] === "*" ? " " : css.slice(i, past);
        i = past;
        continue;
      }
      const ch = css[i]!;
      const t = top();
      if (ch === ";" || ch === "}") {
        notePresence(t, buf);
        if (t?.kind === "rule") declare(t, buf);
        else if (ch === ";" && leadsWithAt(buf) && atName(buf) === "layer") {
          // `@layer a, b;` sets the order the named layers rank in.
          const parent = groupLayer();
          const names = atCondition(buf, "layer").trim();
          if (parent !== null && layerLevels(names, this.levels(parent), false, meter) !== null) {
            for (const name of names.split(",")) if (name.trim() !== "") this.layer(parent, name.trim());
          }
        }
        buf = "";
        if (ch === "}") stack.pop();
        i++;
        continue;
      }
      if (ch !== "{") {
        buf += ch;
        i++;
        continue;
      }
      const parent = groupLayer();
      if (parent === null) stack.push({ kind: "other" });
      else if (leadsWithAt(buf)) {
        const name = atName(buf);
        if (name === "layer") {
          const named = atCondition(buf, "layer").trim();
          const layer = this.layer(parent, named === "" ? `\u0000${this.anonymous++}` : named);
          stack.push(layer === null ? { kind: "other" } : { kind: "group", layer });
        } else stack.push({ kind: "other" });
      } else {
        const targets = pageTargets(buf, meter);
        stack.push(targets.html === null && targets.body === null ? { kind: "other" } : { kind: "rule", targets, layer: parent, other: targets.other });
      }
      buf = "";
      i++;
    }
    const t = top();
    notePresence(t, buf);
    if (t?.kind === "rule" && buf.trim() !== "") declare(t, buf);
  }
}

// ── the letter ───────────────────────────────────────────────────────────────────────────────────

/** The sender's own `<body>` attributes, read from the parse (no reader draws the element itself). */
export interface LetterBody {
  bgcolor: string | null;
  text: string | null;
  style: string | null;
}

export interface LetterPaperInput<N> {
  /** The resolved sheets the frame draws, in document order, without the folded history's. */
  sheets: readonly string[];
  body: LetterBody | null;
  /** The drawn tree's root (its children are the letter). */
  root: N;
  tree: QuotedTree<N>;
  /** Subtrees not drawn (the folded history). */
  skip?: ReadonlySet<N>;
}

/** The reading of a letter's page. */
export interface LetterPaper {
  /** It may be inverted in a dark theme. */
  light: boolean;
  /** What {@link light} was read from: the page, else the first painting wrapper. */
  ground: Rgb | null;
  /** The page the letter sets (a sheet rule, the body's own, or a wrapper that is the page). */
  page: Rgb | null;
  /** The paper to paint the frame with, `null` for the frame's own light sheet. */
  paper: Rgb | null;
  /** The ink to set unstyled text in (the body's own, or ohmail's light ink on a dark page that names none), `null` for the frame's own. */
  ink: Rgb | null;
}

/** The tags a page is painted with; a highlighted word is not the paper. */
const PAINTS_THE_PAGE = new Set([
  "table", "tbody", "tr", "td", "th", "div", "center", "section", "article", "main", "body",
]);

const ALLOWED_TAGS = new Set(MAIL_ALLOWED_TAGS);

const solid = (c: Rgb | null): Rgb | null => (c && c.a >= 0.5 ? c : null);

/** An opaque-enough background on one element (`bgcolor` or an inline `background`), or `null`. */
function declaredBackground(bgcolor: string | null, style: string | null, meter?: Meter): Rgb | null {
  const fromAttr = bgcolor ? solid(parseCssColor(bgcolor)) : null;
  if (fromAttr) return fromAttr;
  if (!style) return null;
  if (meter) meter.visited += style.length;
  const decl = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i.exec(style);
  if (!decl) return null;
  for (const token of backgroundTokens(decl[1]!, meter)) {
    const c = solid(parseCssColor(token));
    if (c) return c;
  }
  return null;
}

/** The body's own ink: its `text` attribute, else its inline `color`. */
function bodyInk(body: LetterBody | null): Rgb | null {
  if (body === null) return null;
  const attr = body.text ? solid(parseCssColor(body.text)) : null;
  if (attr) return attr;
  const decl = body.style ? /(?:^|;)\s*color\s*:\s*([^;!]+)/i.exec(body.style) : null;
  return decl ? solid(parseCssColor(decl[1]!)) : null;
}

/** Elements of the drawn tree in document order: the history skipped, and (when asked) hidden subtrees. */
function* drawnElements<N>(input: LetterPaperInput<N>, hidden: boolean, meter?: Meter): Generator<N> {
  const { tree, skip } = input;
  const stack: Array<{ nodes: readonly N[]; at: number }> = [{ nodes: tree.children(input.root), at: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.at === top.nodes.length) {
      stack.pop();
      continue;
    }
    const n = top.nodes[top.at++]!;
    if (meter) meter.visited++;
    if (tree.kind(n) !== "element" || skip?.has(n)) continue;
    if (hidden && hiddenByOwnStyle(tree.attr(n, "style"))) continue;
    yield n;
    stack.push({ nodes: tree.children(n), at: 0 });
  }
}

/** Every drawn word lies inside `wrapper`: no run outside it draws a word (hidden subtrees, sheets and the history aside). */
function holdsEveryWord<N>(input: LetterPaperInput<N>, wrapper: N, meter?: Meter): boolean {
  const { tree, skip } = input;
  const stack: Array<{ nodes: readonly N[]; at: number }> = [{ nodes: tree.children(input.root), at: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.at === top.nodes.length) {
      stack.pop();
      continue;
    }
    const n = top.nodes[top.at++]!;
    if (meter) meter.visited++;
    if (n === wrapper || skip?.has(n)) continue;
    const kind = tree.kind(n);
    if (kind === "text") {
      const text = tree.text(n);
      if (meter) meter.visited += text.length;
      if (!drawsNoWords(text)) return false;
      continue;
    }
    if (kind !== "element" || tree.tag(n) === "style" || hiddenByOwnStyle(tree.attr(n, "style"))) continue;
    stack.push({ nodes: tree.children(n), at: 0 });
  }
  return true;
}

/** ohmail's own light ink, for a dark page that names none: the frame's dark ink (`#1b1b1b`) inverted. */
const LETTER_LIGHT_INK: Rgb = { r: 0xe4, g: 0xe4, b: 0xe4, a: 1 };
const WHITE: Rgb = { r: 0xff, g: 0xff, b: 0xff, a: 1 };

/** Does a drawn element other than html and body declare a background, as a `bgcolor` or in its style? Presence only. */
function elementDeclaresBackground<N>(input: LetterPaperInput<N>, meter?: Meter): boolean {
  for (const el of drawnElements(input, false, meter)) {
    // html and body are the page; a tag no reader draws paints nothing.
    if (!ALLOWED_TAGS.has(input.tree.tag(el))) continue;
    if (input.tree.attr(el, "bgcolor") !== null) return true;
    const style = input.tree.attr(el, "style");
    if (style !== null && declares(style, isBackground, meter)) return true;
  }
  return false;
}

/** The letter names its own ink: the body's `text`, or a colour in its own style. Presence only. */
function namesInk(body: LetterBody | null, meter?: Meter): boolean {
  return body !== null && (body.text !== null || (body.style !== null && declares(body.style, isColor, meter)));
}

/**
 * The letter's page, read as the frame paints it: the winning `body` sheet rule (or the body's own
 * background when no sheet rule targets the body), else the winning `html` rule, else the first
 * painting wrapper when every drawn word lies in it or the body's own ink reads on it. Its ink is the
 * body's own only on a dark page it reads on. A dark page that names no ink, where no element other
 * than html and body declares any background (presence only, never its colour), gets ohmail's light
 * ink, or white where that reads under 4.5:1; otherwise the letter is drawn as written.
 */
export function letterPaperOf<N>(input: LetterPaperInput<N>, meter?: Meter): LetterPaper {
  const cascade = new PageCascade(meter);
  for (const sheet of input.sheets) cascade.read(sheet);
  const own = bodyInk(input.body);
  let bodyLayer: Rgb | null;
  if (cascade.body !== null) bodyLayer = cascade.body.effect === "clear" ? null : cascade.body.effect.colour;
  else bodyLayer = input.body === null ? null : declaredBackground(input.body.bgcolor, input.body.style, meter);
  const htmlLayer = cascade.html !== null && cascade.html.effect !== "clear" ? cascade.html.effect.colour : null;
  let page = bodyLayer ?? htmlLayer;
  let wrapper: Rgb | null = null;
  if (page === null) {
    let seen = 0;
    for (const el of drawnElements(input, true, meter)) {
      const tag = input.tree.tag(el);
      if (!ALLOWED_TAGS.has(tag)) continue;
      if (++seen > BG_SCAN_LIMIT) break;
      if (!PAINTS_THE_PAGE.has(tag)) continue;
      const c = declaredBackground(input.tree.attr(el, "bgcolor"), input.tree.attr(el, "style"), meter);
      if (c === null) continue;
      wrapper = c;
      if ((own !== null && contrastRatio(own, c) >= READABLE_CONTRAST) || holdsEveryWord(input, el, meter)) page = c;
      break;
    }
  }
  const ground = page ?? wrapper;
  const paper = paintedPaper(page);
  let ink: Rgb | null = null;
  if (page !== null && !mailIsLight(page)) {
    const on = paper ?? page;
    if (own !== null) ink = contrastRatio(own, on) >= READABLE_CONTRAST ? own : null;
    else if (!namesInk(input.body, meter) && !cascade.elementBackground && !elementDeclaresBackground(input, meter)) {
      ink = contrastRatio(LETTER_LIGHT_INK, on) >= READABLE_CONTRAST ? LETTER_LIGHT_INK : WHITE;
    }
  }
  return { light: mailIsLight(ground), ground, page, paper, ink };
}
