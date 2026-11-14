/**
 * Content lines (RFC 5545 section 3.1): unfolding and folding, and one line taken apart into its
 * name, its parameters and its value, and put together again exactly as it was written.
 */
import { MAX_NAME_CHARS, MAX_PARAMS_PER_LINE, MAX_PARAM_VALUE_CHARS } from "../limits.js";
import type { Param, Property } from "./component.js";

/** Lines "SHOULD NOT be longer than 75 octets, excluding the line break" (RFC 5545 section 3.1). */
export const FOLD_OCTETS = 75;

/**
 * The logical lines of a text. CRLF, a bare LF and a bare CR all end a line; a line break followed
 * by one space or tab is a fold and is taken out. Empty lines are dropped, and a leading byte-order
 * mark with them.
 */
export function unfold(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * How many logical lines `unfold` would give, counted on the text itself and no further than one
 * past `stopAfter`: a text of nothing but line ends is not first cut into millions of strings to be
 * told it has too many.
 */
export function countLines(text: string, stopAfter: number): number {
  const [CR, LF, SPACE, TAB] = [0x0d, 0x0a, 0x20, 0x09];
  let lines = 0;
  let held = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== CR && c !== LF) {
      held = true;
      continue;
    }
    if (c === CR && text.charCodeAt(i + 1) === LF) i++;
    const next = text.charCodeAt(i + 1);
    if (next === SPACE || next === TAB) {
      // A fold: the line goes on after the one character that marks it.
      i++;
      continue;
    }
    if (held && ++lines > stopAfter) return lines;
    held = false;
  }
  return held ? lines + 1 : lines;
}

/**
 * The parts a text would be taken apart into, counted on the text itself: every logical line, and
 * for a content line every parameter and every further value a parameter lists (the semicolons and
 * commas before its colon and outside quotes, as `scanContentLine` counts them). A line counts for
 * no more than `maxParams` of those: past that it is refused whole and nothing is made of it.
 * Counted no further than `stopAfter`: a text past it answers `stopAfter + 1`.
 */
export function countParts(text: string, maxParams: number, stopAfter: number): number {
  const [CR, LF, SPACE, TAB, QUOTE, SEMICOLON, COMMA, COLON] = [0x0d, 0x0a, 0x20, 0x09, 0x22, 0x3b, 0x2c, 0x3a];
  let parts = 0;
  // Of the line being read: has it a character yet, is its colon still to come, is a quote open, and what was listed so far.
  let [held, head, quoted, listed] = [false, true, false, 0];
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== CR && c !== LF) {
      held = true;
      if (!head) continue;
      if (c === QUOTE) quoted = !quoted;
      else if (quoted) continue;
      else if (c === SEMICOLON || c === COMMA) listed++;
      else if (c === COLON) {
        // Only now is it a content line: without a colon its semicolons are the text of a line that is kept as it stands.
        head = false;
        parts += Math.min(listed, maxParams);
        if (parts > stopAfter) return stopAfter + 1;
      }
      continue;
    }
    if (c === CR && text.charCodeAt(i + 1) === LF) i++;
    const next = text.charCodeAt(i + 1);
    if (next === SPACE || next === TAB) {
      // A fold: the line goes on after the one character that marks it, wherever in the line it falls.
      i++;
      continue;
    }
    if (held && ++parts > stopAfter) return stopAfter + 1;
    [held, head, quoted, listed] = [false, true, false, 0];
  }
  return held ? Math.min(parts + 1, stopAfter + 1) : parts;
}

const octetsOf = (codePoint: number): number => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

/**
 * One logical line as physical lines of at most 75 octets, never cut inside a character. No final
 * line break. The line is cut where it folds and the pieces joined once: nothing is put together a
 * character at a time.
 */
export function fold(line: string): string {
  const pieces: string[] = [];
  let room = FOLD_OCTETS;
  let from = 0;
  for (let i = 0; i < line.length; ) {
    const point = line.codePointAt(i)!;
    const size = octetsOf(point);
    if (size > room) {
      pieces.push(line.slice(from, i));
      from = i;
      room = FOLD_OCTETS - 1;
    }
    room -= size;
    i += point > 0xffff ? 2 : 1;
  }
  if (from === 0) return line;
  pieces.push(line.slice(from));
  return pieces.join("\r\n ");
}

/** RFC 6868: `^^` is a caret, `^n` a line break, `^'` a double quote; any other pair stays as written. Whole slices between the pairs, joined once. */
export function decodeParamValue(raw: string): string {
  let at = raw.indexOf("^");
  if (at < 0) return raw;
  const pieces: string[] = [];
  let from = 0;
  while (at >= 0 && at + 1 < raw.length) {
    const next = raw.charCodeAt(at + 1);
    const meant = next === 0x5e ? "^" : next === 0x6e ? "\n" : next === 0x27 ? '"' : null;
    if (meant === null) at = raw.indexOf("^", at + 1);
    else {
      pieces.push(raw.slice(from, at), meant);
      from = at + 2;
      at = raw.indexOf("^", from);
    }
  }
  if (from === 0) return raw;
  pieces.push(raw.slice(from));
  return pieces.join("");
}

const encodeParamValue = (value: string): string => value.replace(/\^/g, "^^").replace(/\r\n?|\n/g, "^n").replace(/"/g, "^'");

/** A parameter written new: each value escaped, and quoted when it holds a colon, a semicolon or a comma. */
export function makeParam(name: string, values: readonly string[]): Param {
  const raw = values
    .map((v) => {
      const encoded = encodeParamValue(v);
      return /[:;,]/.test(encoded) ? `"${encoded}"` : encoded;
    })
    .join(",");
  return { name, values: [...values], raw };
}

/** The one list every parameter that is read as nothing shares: one with no `=`, and one whose text is past its ceiling. */
const NO_VALUES: readonly string[] = Object.freeze([]);

/**
 * The values of a parameter's text: cut at commas outside quotes, the quotes taken off, carets
 * decoded. Each value is a slice of the text, or where a quote stands inside it the slices either
 * side joined once.
 */
function paramValues(raw: string): string[] {
  // Most parameters are one word.
  if (raw.indexOf('"') < 0 && raw.indexOf(",") < 0) return [decodeParamValue(raw)];
  const values: string[] = [];
  let quoted = false;
  let from = 0;
  /** The pieces of the value being read that a quote has already cut off; `null` while it is one slice. */
  let pieces: string[] | null = null;
  const value = (to: number): string => {
    const tail = raw.slice(from, to);
    const whole = pieces === null ? tail : (pieces.push(tail), pieces.join(""));
    pieces = null;
    return decodeParamValue(whole);
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x22) {
      quoted = !quoted;
      (pieces ??= []).push(raw.slice(from, i));
      from = i + 1;
    } else if (c === 0x2c && !quoted) {
      values.push(value(i));
      from = i + 1;
    }
  }
  values.push(value(raw.length));
  return values;
}

/**
 * `NAME;PARAM=value;PARAM="quoted:value":value` taken apart. Scanned, never split: a colon or a
 * semicolon inside a quoted parameter ends nothing. `null` when the line has no colon outside
 * quotes: it is not a content line. The parameters and the values they list are counted as the
 * scan meets them, and a content line with more than `maxParams` of them is refused by word before
 * any of them is made.
 *
 * A name has a ceiling (`MAX_NAME_CHARS`), the line's own and each parameter's: a line with a
 * longer one is no content line either (`null`), and is kept as it stands by whoever reads the
 * text. Nothing has a word for such a name, so nothing is lost with it; and a line of prose with
 * its colon far in, as a description cut by a raw line break leaves it, is no property. A
 * parameter's text has one too (`MAX_PARAM_VALUE_CHARS`): past it the parameter is kept as it was
 * written and no value is made of it, so it is read as nothing and written back whole.
 */
export function scanContentLine(line: string, maxParams: number): Property | null | "too_many_parameters" {
  let quoted = false;
  let colon = -1;
  let listed = 0;
  const cuts: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 0x22) quoted = !quoted;
    else if (quoted) continue;
    else if (c === 0x3b || c === 0x2c) {
      // A semicolon begins a parameter, a comma another value of one: each would be an object or a string of its own.
      listed++;
      if (c === 0x3b && listed <= maxParams) cuts.push(i);
    } else if (c === 0x3a) {
      colon = i;
      break;
    }
  }
  // A line with no colon is no content line, however many semicolons it has: it is kept as it stands and made nothing of.
  if (colon < 0) return null;
  if (listed > maxParams) return "too_many_parameters";
  if ((cuts[0] ?? colon) > MAX_NAME_CHARS) return null;
  const name = line.slice(0, cuts[0] ?? colon);
  if (name.trim() === "") return null;
  const params: Param[] = [];
  for (let n = 0; n < cuts.length; n++) {
    const segment = line.slice(cuts[n]! + 1, cuts[n + 1] ?? colon);
    const eq = segment.indexOf("=");
    if ((eq < 0 ? segment.length : eq) > MAX_NAME_CHARS) return null;
    if (eq < 0) params.push({ name: segment, values: NO_VALUES, raw: "", bare: true });
    else {
      const raw = segment.slice(eq + 1);
      params.push({ name: segment.slice(0, eq), values: raw.length > MAX_PARAM_VALUE_CHARS ? NO_VALUES : paramValues(raw), raw });
    }
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** One line taken apart under the package's own ceiling of parameters; a line past it is not taken apart (`null`). */
export function parseContentLine(line: string): Property | null {
  const scanned = scanContentLine(line, MAX_PARAMS_PER_LINE);
  return scanned === "too_many_parameters" ? null : scanned;
}

/** A property as its one logical line. What was read comes back as it was written; a line that never was a content line is itself. */
export function formatContentLine(p: Property): string {
  if (p.name === "") return p.value;
  if (p.params.length === 0) return `${p.name}:${p.value}`;
  const pieces = [p.name];
  for (const param of p.params) pieces.push(param.bare ? `;${param.name}` : `;${param.name}=${param.raw}`);
  pieces.push(":", p.value);
  return pieces.join("");
}

/** Names are compared without regard to case (RFC 5545 section 3.1), and kept as written. */
export const sameName = (a: string, b: string): boolean => a === b || a.toUpperCase() === b.toUpperCase();

/** The first value of a property's parameter, or `null`. */
export function paramOf(p: Property, name: string): string | null {
  for (const param of p.params) if (sameName(param.name.trim(), name)) return param.values[0] ?? null;
  return null;
}
