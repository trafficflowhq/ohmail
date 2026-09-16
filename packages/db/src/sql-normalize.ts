/**
 * EXECUTABLE SQL, with comments and layout removed — the comparison a migration's identity is
 * decided by once its bytes have already been shown to differ.
 *
 * ONE left-to-right pass, not a comment regex followed by a whitespace regex: two passes read a
 * block-comment opener quoted inside a line comment as real and delete to the next terminator.
 * Literal spans are copied VERBATIM — whitespace inside a string or a dollar-quoted body is data,
 * and collapsing it would make two different programs compare equal.
 */

const IDENT_START = /[A-Za-z_-￿]/;
const IDENT_CHAR = /[A-Za-z0-9_$-￿]/;

/**
 * drizzle's statement separator. It LOOKS like a comment and is not one: the migrator splits a
 * file on it, so adding or removing it changes which statements share a batch. It survives
 * normalization as a token of its own, which makes that change executable drift rather than a
 * comment rewrite.
 */
const BREAKPOINT = "--> statement-breakpoint";

/** The dollar-quote tag opening at `i`, or null when `$` is not opening one. */
function dollarTagAt(src: string, i: number): string | null {
  if (src[i] !== "$") return null;
  let j = i + 1;
  while (j < src.length && src[j] !== "$") {
    const c = src[j]!;
    const ok = j === i + 1 ? IDENT_START.test(c) : IDENT_CHAR.test(c) && c !== "$";
    if (!ok) return null;
    j++;
  }
  return j < src.length ? src.slice(i, j + 1) : null;
}

/** Is the `'` at `i` the body of an `E'...'` string, where a backslash escapes the next character? */
function isEscapeString(src: string, i: number): boolean {
  const prev = src[i - 1];
  if (prev !== "E" && prev !== "e") return false;
  const before = src[i - 2];
  return before === undefined || !IDENT_CHAR.test(before);
}

/**
 * Postgres block comments NEST, so the terminator is a depth counter and not the first close.
 */
function skipBlockComment(src: string, from: number): number {
  let i = from;
  let depth = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) { depth++; i += 2; continue; }
    if (src.startsWith("*/", i)) { depth--; i += 2; if (depth === 0) break; continue; }
    i++;
  }
  return i;
}

export function normalizeSql(src: string): string {
  const out: string[] = [];
  let i = 0;
  const pushGap = (): void => { if (out.length > 0 && out[out.length - 1] !== " ") out.push(" "); };

  while (i < src.length) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);

    if (two === "--") {
      if (src.startsWith(BREAKPOINT, i)) {
        pushGap();
        out.push(BREAKPOINT);
        pushGap();
        i += BREAKPOINT.length;
        continue;
      }
      while (i < src.length && src[i] !== "\n") i++;
      pushGap();
      continue;
    }
    if (two === "/*") {
      i = skipBlockComment(src, i);
      pushGap();
      continue;
    }
    if (c === "'") {
      const escapes = isEscapeString(src, i);
      const start = i;
      i++;
      while (i < src.length) {
        if (escapes && src[i] === "\\") { i += 2; continue; }
        if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      out.push(src.slice(start, i));
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < src.length) {
        if (src[i] === '"') { if (src[i + 1] === '"') { i += 2; continue; } i++; break; }
        i++;
      }
      out.push(src.slice(start, i));
      continue;
    }
    const tag = dollarTagAt(src, i);
    if (tag) {
      const end = src.indexOf(tag, i + tag.length);
      const stop = end === -1 ? src.length : end + tag.length;
      out.push(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") {
      pushGap();
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("").trim();
}
