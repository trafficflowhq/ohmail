/**
 * THE TEST FILES THAT READ PRODUCT SOURCE AS TEXT, and the freeze over them (test/source-text-freeze.test.ts).
 *
 * A test file reads source when it calls readFileSync or readFile, or imports with `?raw`, and names a
 * product path: a code file (.ts .tsx .js .jsx .mjs .cjs .mts .cts .css .rs .kt .swift) or a `src`, `app`
 * or `src-tauri` directory, outside a test tree, a scripts directory, `public/`, `dist/`, and the root's
 * workflows, deploy recipes and docs; a script named by its file name alone is not one. Comments and
 * import specifiers are not reads. Migrations (.sql), catalogues and other .json are data the tests feed
 * to code, not source.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { withoutComments } from "../../scripts/lib/source-scan.mjs";
import { testFiles } from "./ci-shards.mjs";

/** Today's readers; the list may only shrink. */
export const BASELINE = "test/support/source-text-baseline.txt";
/** The guards that may read source for good: `<path>\t<why>`. */
export const GUARDS = "test/support/source-text-guards.tsv";
/** A test this table names holds a declared promise, and may read source. */
export const INVARIANTS = "docs/INVARIANTS.tsv";

const READ = /\b(?:readFileSync|readFile)\s*\(/;
const IMPORT = /(?:\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+[\w*{}\s,$]+\s+from\s+|\bimport\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const CODE = /\.(?:[cm]?[jt]sx?|css|rs|kt|swift)$/;
const SOURCE_DIR = /(?:^|\/)(?:src|app|src-tauri)(?:\/|$)/;
const NOT_PRODUCT = /(?:^|\/)(?:test|tests|__tests__|fixtures|rigs|scripts|node_modules|dist|public)(?:\/|$)/;
/** A script or a build output named by its file name alone (a bundle in a scratch directory). */
const BARE_SCRIPT = /^(?:X\/)?[^/]+\.[cm]?jsx?$/;
const NOT_PRODUCT_TOP = /^(?:scripts|\.github|\.gate|deploy|docs|patches|test)(?:\/|$)/;

/** The product path a literal in `file` names, or null. */
function productPath(file, literal) {
  const l = literal.replace(/\$\{[^}]*\}/g, "X").split("?")[0];
  if (/\s|:\/\//.test(l) || l.startsWith("/") || /\.test\.[cm]?[jt]sx?$/.test(l)) return null;
  if ((!CODE.test(l) && !SOURCE_DIR.test(l)) || BARE_SCRIPT.test(l)) return null;
  const p = l.startsWith("./") || l.startsWith("../") ? posix.normalize(posix.join(posix.dirname(file), l)) : l;
  return NOT_PRODUCT.test(p) || NOT_PRODUCT_TOP.test(p) ? null : p;
}

/** What `file` reads of the product as text ("?raw <path>" for an import), or null. */
export function readsSource(file, text) {
  const code = withoutComments(text);
  for (const m of code.matchAll(IMPORT)) {
    if (m[2].includes("?raw")) {
      const p = productPath(file, m[2]);
      if (p) return `?raw ${p}`;
    }
  }
  if (!READ.test(code)) return null;
  for (const m of code.replace(IMPORT, "").matchAll(LITERAL)) {
    const p = productPath(file, m[2]);
    if (p) return p;
  }
  return null;
}

/** Every test file under `root` that reads product source, with the first path it names. */
export function sourceReaders(root) {
  const out = new Map();
  for (const f of testFiles(root)) {
    const why = readsSource(f, readFileSync(join(root, f), "utf8"));
    if (why) out.set(f, why);
  }
  return out;
}

/** A list file's lines, blank lines and `#` comments left out. */
const lines = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "")
  .split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !l.trimStart().startsWith("#"));

/** The tests the invariant table names. */
function invariantTests(root) {
  const rows = lines(root, INVARIANTS).slice(1).map((l) => l.split("\t")[3] ?? "");
  return new Set(rows.flatMap((t) => t.split(" ")).filter((t) => t && t !== "-"));
}

/** What the freeze refuses, one sorted line each; empty when it holds. */
export function freezeProblems(root, readers = sourceReaders(root)) {
  const problems = [];
  const baseline = lines(root, BASELINE);
  const guards = new Map(lines(root, GUARDS).map((l) => [l.split("\t")[0], (l.split("\t")[1] ?? "").trim()]));
  const promises = invariantTests(root);
  const present = new Set(testFiles(root));
  const seen = new Set();
  for (const f of baseline) {
    if (seen.has(f)) problems.push(`TWICE ${f} is on the baseline twice`);
    seen.add(f);
    if (guards.has(f)) problems.push(`BOTH ${f} is on the baseline and the guard list: remove its baseline line`);
    else if (!present.has(f)) problems.push(`STALE ${f} is on the baseline and is not in the tree: remove its line`);
    else if (!readers.has(f)) problems.push(`STALE ${f} is on the baseline and reads no product source now: remove its line`);
  }
  for (const [f, why] of guards) {
    if (!why) problems.push(`GUARD ${f} has no reason: write why after a tab`);
    if (!readers.has(f)) problems.push(`GUARD ${f} is on the guard list and reads no product source: remove its line`);
  }
  for (const [f, what] of readers) {
    if (seen.has(f) || guards.has(f) || promises.has(f)) continue;
    problems.push(`NEW ${f} reads ${what} as text. Source-text tests are frozen: `
      + "write a behaviour test (render, call, assert what comes out) instead");
  }
  return [...new Set(problems)].sort();
}
