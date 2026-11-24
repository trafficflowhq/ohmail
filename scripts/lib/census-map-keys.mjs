/**
 * DUPLICATE KEYS IN A CENSUS MAP, WHEREVER THE TYPECHECK DOES NOT REACH.
 *
 * A repeated property in an object literal is TS1117, and TypeScript catches it — in the programs
 * the typecheck compiles. The census maps that pin what a guard expects live in `test/` directories,
 * and `scripts/typecheck-test-dirs.mjs` pins fourteen of those as UNREACHED (AGENTS.md): there, a
 * second `foo:` silently overwrites the first and the census counts one fewer sink than it lists.
 * Measured 2026-09-12 on `IN_SINKS` in `packages/api/test/input-bounds-census.test.ts`.
 *
 * So the duplicate is found by PARSING, not by compiling, and reported as `file:line`.
 *
 * WHAT COUNTS AS A CENSUS MAP: an object literal bound to a `const` whose name is SCREAMING_SNAKE.
 * That is the shape every one of them has, and it is the shape a pin has — a lower-case local is a
 * value, not a register. Only the literal's OWN top level is read; a nested object is its own
 * literal and is reached when it is one of these in its own right.
 *
 * Keys are compared as WRITTEN-OUT NAMES: `"a"` and `a` are the same property and both are read.
 * A computed key (`[EXPR]:`) is skipped — two computed keys can be the same property or not, and
 * this cannot tell, so it says nothing rather than guessing.
 */
import { withoutComments, withoutCommentsAndLiterals, bracketSpan, lineOf } from "./source-scan.mjs";

/* ONE SCAN PER FILE, not one per literal. A file with forty census maps was scanned eighty times;
 * the readings are pure functions of the source, so the last file's pair is kept and reused. */
let memoSrc = null, memoPair = null;
function scans(src) {
  if (memoSrc !== src) { memoSrc = src; memoPair = [withoutCommentsAndLiterals(src), withoutComments(src)]; }
  return memoPair;
}

/** `const NAME` — the binding. What follows it is walked, not matched. */
const BIND = /(?:^|[\s;{}()])(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*[A-Z0-9])\b/g;

/**
 * Every census map literal in `src`: `{ name, open, line }`, `open` at its `{`.
 *
 * The `= {` is found by WALKING from the name, not by a regex, because the type annotation between
 * them contains both braces and semicolons —
 * `const IN_SINKS: Readonly<Record<string, { origin: ArrayOrigin; count: number }>> = {` — and the
 * first regex here, which stopped at a `;`, silently skipped exactly the declaration the row was
 * measured on. A `;` at annotation depth 0 ENDS the statement and is still a refusal.
 */
export function censusMapLiterals(src) {
  // The declaration is found in the LITERALS-BLANKED text so a `const FOO = {` inside a string or a
  // comment is not a declaration; the offsets are the same in both readings.
  const [blanked] = scans(src);
  const out = [];
  BIND.lastIndex = 0;
  let m;
  while ((m = BIND.exec(blanked)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let open = -1;
    for (; i < blanked.length; i++) {
      const c = blanked[i];
      if (c === "<" || c === "{" || c === "[" || c === "(") { depth++; continue; }
      if (c === ">" || c === "}" || c === "]" || c === ")") { depth--; continue; }
      if (depth > 0) continue;
      if (c === ";" || c === "\n" && /[;,]/.test(blanked.slice(m.index, i).trimEnd().slice(-1))) break;
      if (c === "=") {
        if (blanked[i + 1] === "=" || blanked[i + 1] === ">") break;   // a comparison, not a binding
        let j = i + 1;
        while (j < blanked.length && /\s/.test(blanked[j])) j++;
        if (blanked[j] === "{") open = j;
        break;
      }
      if (!/[\s:.|&?'"`\w-]/.test(c)) break;
    }
    if (open >= 0) {
      out.push({ name: m[1], open, line: lineOf(src, open) });
      BIND.lastIndex = open + 1;
    }
  }
  return out;
}

const IDENT = /[A-Za-z0-9_$]/;

/**
 * The top-level keys of the object literal whose `{` is at `open`, in order, as
 * `{ key, index, line }`. Values are SKIPPED WHOLE — without that, the `c` in `a: b ? c : d` reads
 * as a key, which is the mistake a regex over this makes.
 */
export function topLevelKeys(src, open) {
  const [blanked, names] = scans(src);
  const { end, closed } = bracketSpan(blanked, open, "{", "}");
  if (!closed) return { keys: [], closed: false };

  const keys = [];
  let i = open + 1;
  const skipSpace = () => { while (i < end && /\s/.test(blanked[i])) i++; };
  const depthSkip = (o, c) => { const s = bracketSpan(blanked, i, o, c); i = s.closed ? s.end + 1 : end; };

  while (i < end) {
    skipSpace();
    if (i >= end) break;
    if (blanked[i] === ",") { i++; continue; }
    const at = i;
    let key = null;
    const ch = blanked[i];
    if (ch === '"' || ch === "'") {
      // The quotes survive the blanking; the body does not, so the NAME is read from the other copy.
      const q = ch;
      let j = i + 1;
      while (j < end && blanked[j] !== q) j++;
      key = names.slice(i + 1, j);
      i = j + 1;
    } else if (ch === "[") {
      depthSkip("[", "]");            // computed — unknowable, and said so rather than guessed
    } else if (ch === "." || ch === "`") {
      // A spread (`...x`) or a template key: neither is a comparable name.
      while (i < end && !/[,\n]/.test(blanked[i])) i++;
    } else if (IDENT.test(ch)) {
      let j = i;
      while (j < end && IDENT.test(blanked[j])) j++;
      key = names.slice(i, j);
      i = j;
    } else {
      i++;
      continue;
    }
    skipSpace();
    if (key !== null) {
      // `key:` is a property; `key,` and `key}` are shorthand, which is one too. `key(` is a method.
      if (blanked[i] === ":" || blanked[i] === "(") keys.push({ key, index: at, line: lineOf(src, at) });
      else if (blanked[i] === "," || i >= end || blanked[i] === "}") { keys.push({ key, index: at, line: lineOf(src, at) }); continue; }
      else key = null;
    }
    // Skip the VALUE whole, to the next comma at this level.
    while (i < end) {
      const c = blanked[i];
      if (c === ",") { i++; break; }
      if (c === "{") { depthSkip("{", "}"); continue; }
      if (c === "[") { depthSkip("[", "]"); continue; }
      if (c === "(") { depthSkip("(", ")"); continue; }
      i++;
    }
  }
  return { keys, closed: true };
}

/**
 * Every duplicate key in every census map in `src`, as
 * `{ map, key, line, firstLine }` — `line` is the repeat, `firstLine` the one it overwrites.
 */
export function duplicateCensusKeys(src) {
  const out = [];
  for (const lit of censusMapLiterals(src)) {
    const { keys, closed } = topLevelKeys(src, lit.open);
    if (!closed) continue;
    const seen = new Map();
    for (const k of keys) {
      if (seen.has(k.key)) out.push({ map: lit.name, key: k.key, line: k.line, firstLine: seen.get(k.key) });
      else seen.set(k.key, k.line);
    }
  }
  return out;
}
