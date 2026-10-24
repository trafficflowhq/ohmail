/**
 * THE TEST FILES THAT READ PRODUCT SOURCE AS TEXT, and the freeze over them (test/source-text-freeze.test.ts).
 *
 * A test file reads source when it imports with `?raw`, or when a product path reaches a read: a
 * readFileSync or readFile (or an alias of one, or a helper that calls one) takes it as an argument,
 * directly or through a name, a loop over a list, or a callback over one. A product path is a code file
 * (.ts .tsx .js .jsx .mjs .cjs .mts .cts .css .rs .kt .swift) or a `src`, `app` or `src-tauri` directory,
 * outside a test tree, a scripts directory, `public/`, `dist/`, and the root's workflows, deploy recipes
 * and docs; a script named by its file name alone is not one. A path handed to a bundler or a runner and
 * never read is not a read. Comments and import specifiers are not reads. Migrations (.sql), catalogues
 * and other .json are data the tests feed to code, not source.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { bracketSpan, withoutComments, withoutCommentsAndLiterals } from "../../scripts/lib/source-scan.mjs";
import { testFiles } from "./ci-shards.mjs";

/** Today's readers with how many reads each makes; a file may not read more, and the list only shrinks. */
export const BASELINE = "test/support/source-text-baseline.txt";
/** The guards that may read source for good: `<path>\t<why>`. */
export const GUARDS = "test/support/source-text-guards.tsv";
/** A test this table names holds a declared promise, and may read source. */
export const INVARIANTS = "docs/INVARIANTS.tsv";
/** The baseline's size; a retirement lowers both numbers, nothing raises them. */
export const FROZEN = { files: 787, reads: 4774 };

const IMPORT = /(?:\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+[\w*{}\s,$]+\s+from\s+|\bimport\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const IDENT = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
const CODE = /\.(?:[cm]?[jt]sx?|css|rs|kt|swift)$/;
const SOURCE_DIR = /(?:^|\/)(?:src|app|src-tauri)(?:\/|$)/;
const NOT_PRODUCT = /(?:^|\/)(?:test|tests|__tests__|fixtures|rigs|scripts|node_modules|dist|public)(?:\/|$)/;
/** A script or a build output named by its file name alone (a bundle in a scratch directory). */
const BARE_SCRIPT = /^(?:X\/)?[^/]+\.[cm]?jsx?$/;
const NOT_PRODUCT_TOP = /^(?:scripts|\.github|\.gate|deploy|docs|patches|test)(?:\/|$)/;
const FS_READS = ["readFileSync", "readFile"];
/** Calls that build or run the product rather than read it. */
const RUNNERS = new Set(["build", "buildSync", "context", "spawn", "spawnSync", "execFile", "execFileSync", "execSync", "fork", "execa", "Worker"]);

/** The product path a literal in `file` names, or null. */
function productPath(file, literal) {
  const l = literal.replace(/\$\{[^}]*\}/g, "X").split("?")[0];
  if (/\s|:\/\//.test(l) || l.startsWith("/") || /\.test\.[cm]?[jt]sx?$/.test(l)) return null;
  if ((!CODE.test(l) && !SOURCE_DIR.test(l)) || BARE_SCRIPT.test(l)) return null;
  const p = l.startsWith("./") || l.startsWith("../") ? posix.normalize(posix.join(posix.dirname(file), l)) : l;
  return NOT_PRODUCT.test(p) || NOT_PRODUCT_TOP.test(p) ? null : p;
}

/** Where an initializer or an arrow body that starts at `i` ends: a `;` or `,` at its depth, or a line that does not go on. */
function exprEnd(bare, i) {
  let depth = 0;
  for (let j = i; j < bare.length; j++) {
    const c = bare[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return j; depth--; }
    else if (depth === 0 && (c === ";" || c === ",")) return j;
    else if (depth === 0 && c === "\n" && /\S/.test(bare.slice(i, j))
      && !/^\s*(?:[.?:+\-*/|&]|=>)/.test(bare.slice(j + 1, j + 120)) && !/(?:[=+\-*/|&?:(]|=>)\s*$/.test(bare.slice(i, j))) return j;
  }
  return bare.length;
}

/** Where the expression that ends just before `dot` (a call's receiver) starts. */
function receiverStart(bare, dot) {
  let i = dot - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(bare[i])) i--;
    if (bare[i] === ")" || bare[i] === "]") {
      const [o, c] = bare[i] === ")" ? ["(", ")"] : ["[", "]"];
      for (let depth = 0; i >= 0; i--) {
        if (bare[i] === c) depth++;
        else if (bare[i] === o && --depth === 0) break;
      }
      i--;
    }
    while (i >= 0 && /[\w$]/.test(bare[i])) i--;
    let k = i;
    while (k >= 0 && /\s/.test(bare[k])) k--;
    if (bare[k] !== ".") return i + 1;
    i = bare[k - 1] === "?" ? k - 2 : k - 1;
  }
}

/** `text` split at its commas outside brackets. */
function topLevel(text, sep = ",") {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if ("([{<".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) || (text[i] === ">" && text[i - 1] !== "=")) depth--;
    else if (depth === 0 && text[i] === sep && !(sep === "=" && text[i + 1] === ">")) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  return [...parts, text.slice(from)];
}

/** The names a binding pattern (`x`, `{ a, b: c }`, `[a, b]`) or a parameter list binds; types and defaults left out. */
function bound(pattern) {
  return topLevel(pattern).flatMap((part) => {
    const p = topLevel(part, "=")[0].trim().replace(/^\.\.\./, "");
    if (p.startsWith("{")) {
      return topLevel(p.slice(1, bracketSpan(p, 0, "{", "}").end)).flatMap((e) => {
        const [key, value] = topLevel(e, ":");
        return bound(value ?? key);
      });
    }
    if (p.startsWith("[")) return bound(p.slice(1, bracketSpan(p, 0, "[", "]").end));
    return p.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? [];
  });
}

/** Where a function's body opens, past a return type that may hold braces of its own. */
function bodyOpen(bare, from) {
  for (let i = from; i < bare.length; i++) {
    if (bare[i] !== "{") continue;
    if (!/[:|&<,(]\s*$/.test(bare.slice(Math.max(from, i - 40), i))) return i;
    i = bracketSpan(bare, i, "{", "}").end;
  }
  return -1;
}

/** The call sites of `name` in `bare`; a method call (`fs.readFileSync(`) counts for the named callees. */
const calls = (bare, name, dotted) => bare.matchAll(new RegExp(
  `(?<![\\w$${dotted ? "" : "."}]|function\\s{1,9})${name.replace(/\$/g, "\\$")}\\s*\\(`, "g"));

/** The places a value is given or passed on, found once per file. */
function flowGraph(bare) {
  const defs = [];
  for (const m of bare.matchAll(/\bfunction\s*\*?\s*([\w$]+)\s*(?:<[^(]*>)?\s*\(/g)) {
    const params = bracketSpan(bare, m.index + m[0].length - 1);
    const body = bodyOpen(bare, params.end + 1);
    if (body !== -1) defs.push({ name: m[1], params: bound(bare.slice(params.start, params.end)), start: m.index, end: bracketSpan(bare, body, "{", "}").end });
  }
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(\([^()]*(?:\([^()]*\)[^()]*)*\)|[\w$]+)\s*(?::[^=]+)?=>\s*/g)) {
    const at = m.index + m[0].length;
    defs.push({ name: m[1], params: bound(m[2].replace(/^\(|\)$/g, "")), start: m.index, end: bare[at] === "{" ? bracketSpan(bare, at, "{", "}").end : exprEnd(bare, at) });
  }
  const decls = [...bare.matchAll(/\b(?:const|let|var)\s+([\w$]+|\{[^}]*\}|\[[^\]]*\])\s*(?::[^=;]+)?=(?![=>])\s*/g)]
    .map((m) => ({ bind: bound(m[1]), start: m.index + m[0].length, end: exprEnd(bare, m.index + m[0].length) }));
  const loops = [...bare.matchAll(/\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+(.+?)\s+(?:of|in)\s+/g)].map((m) => {
    const open = bare.lastIndexOf("(", m.index + m[0].length);
    return { bind: bound(m[1]), start: m.index + m[0].length, end: bracketSpan(bare, open).end };
  });
  const each = [...bare.matchAll(/\.\s*(?:map|flatMap|forEach|filter|some|every|find|reduce)\s*\(\s*(?:async\s+)?(\([^()]*\)|[\w$]+)\s*(?::[^=]*)?=>/g)]
    .map((m) => ({ bind: bound(m[1].replace(/^\(|\)$/g, "")), start: receiverStart(bare, m.index), end: m.index }));
  for (const m of bare.matchAll(/\.\s*each\s*\(/g)) {
    const table = bracketSpan(bare, m.index + m[0].length - 1);
    const next = bare.slice(table.end + 1).match(/^\s*\(/);
    if (!next) continue;
    const call = bracketSpan(bare, table.end + next[0].length);
    const fn = bare.slice(call.start, call.end).match(/(?:async\s+)?(?:\(([^()]*)\)|([\w$]+))\s*(?::[^=]*)?=>/);
    if (fn) each.push({ bind: bound(fn[1] ?? fn[2]), start: table.start, end: table.end });
  }
  // What goes into a collection is given to whatever draws on the collection.
  const fills = [...bare.matchAll(/\b([\w$]+)\s*\.\s*(?:push|unshift|add|set|concat)\s*\(/g)]
    .map((m) => ({ bind: [m[1]], ...bracketSpan(bare, m.index + m[0].length - 1) }));
  const sources = [...decls, ...loops, ...each, ...fills];
  const locals = new Set([...sources.flatMap((s) => s.bind), ...defs.flatMap((d) => d.params)]);
  return { defs, sources, locals };
}

/**
 * The literal positions whose value reaches a call of one of `seed` (or of a function that makes one):
 * in its arguments, or given to a name, a loop, a callback, a collection or a function that reaches it.
 * `called` says whether any such call is made at all.
 */
function reach(code, bare, graph, seed) {
  const callees = new Set(seed);
  const dotted = (c) => seed.has(c);
  for (let grew = true; grew;) {
    grew = false;
    for (const d of graph.defs) {
      if (callees.has(d.name)) continue;
      const body = bare.slice(d.start, d.end);
      if ([...callees].some((c) => !calls(body, c, dotted(c)).next().done)) { callees.add(d.name); grew = true; }
    }
  }
  const counted = new Set();
  const names = new Set();
  let called = false;
  const take = (start, end) => {
    for (const m of code.slice(start, end).matchAll(LITERAL)) counted.add(start + m.index);
    for (const m of bare.slice(start, end).matchAll(IDENT)) names.add(m[0]);
  };
  const takeCalls = (name) => {
    for (const m of calls(bare, name, dotted(name))) {
      called = true;
      const s = bracketSpan(bare, m.index + m[0].length - 1);
      take(s.start, s.end);
    }
  };
  for (const c of seed) takeCalls(c);
  const feeds = (d) => d.params.some((b) => names.has(b))
    || [...bare.slice(d.start, d.end).matchAll(IDENT)].some((m) => names.has(m[0]) && !d.params.includes(m[0]) && graph.locals.has(m[0]));
  const done = new Set();
  for (let size = -1; size !== names.size + counted.size;) {
    size = names.size + counted.size;
    for (const s of graph.sources) if (!done.has(s) && s.bind.some((b) => names.has(b))) { done.add(s); take(s.start, s.end); }
    for (const d of graph.defs) {
      if (!done.has(d) && (callees.has(d.name) || feeds(d))) { done.add(d); takeCalls(d.name); }
      // A function whose result is drawn on gives what it returns.
      if (!done.has(d.name) && names.has(d.name)) { done.add(d.name); take(d.start, d.end); }
    }
  }
  return { counted, called };
}

/**
 * Every product path `file` reads as text, one entry per read ("?raw <path>" for an import), sorted.
 * A file that reads anything counts each product literal it holds (a scanner it imports may do the read);
 * a file that also builds or runs the product counts only the literals that reach a read of its own.
 */
export function sourceReads(file, text) {
  const code = withoutComments(text);
  const bare = withoutCommentsAndLiterals(text);
  const out = [];
  const specifiers = new Set();
  for (const m of code.matchAll(IMPORT)) {
    specifiers.add(m.index + m[0].length - m[2].length - 2);
    if (!m[2].includes("?raw")) continue;
    const p = productPath(file, m[2]);
    if (p) out.push(`?raw ${p}`);
  }
  const reads = new Set(FS_READS);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*(?:from\s*["'](?:node:)?fs(?:\/promises)?["']|=\s*(?:await\s+)?(?:require\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)|[\w$.]+))/g)) {
    for (const a of m[1].matchAll(/\b(?:readFileSync|readFile)\s*(?:as|:)\s*([\w$]+)/g)) reads.add(a[1]);
  }
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*\.\s*)*(?:readFileSync|readFile)\b(?!\s*\()/g)) reads.add(m[1]);
  const graph = flowGraph(bare);
  const read = reach(code, bare, graph, reads);
  if (!read.called) return out.sort();
  // A file that builds or runs the product names its paths for that: only what reaches a read counts there.
  const runs = reach(code, bare, graph, RUNNERS).called;
  for (const m of code.matchAll(LITERAL)) {
    if (specifiers.has(m.index) || (runs && !read.counted.has(m.index))) continue;
    const p = productPath(file, m[2]);
    if (p) out.push(p);
  }
  return out.sort();
}

/** Every test file under `root` that reads product source, with what it reads (one entry per read). */
export function sourceReaders(root) {
  const out = new Map();
  for (const f of testFiles(root)) {
    const reads = sourceReads(f, readFileSync(join(root, f), "utf8"));
    if (reads.length) out.set(f, reads);
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

const FROZEN_SAYS = "Source-text tests are frozen: write a behaviour test (render, call, assert what comes out) instead";

/** What the freeze refuses, one sorted line each; empty when it holds. */
export function freezeProblems(root, readers = sourceReaders(root), frozen = FROZEN) {
  const problems = [];
  const rows = lines(root, BASELINE).map((l) => l.split("\t"));
  const guards = new Map(lines(root, GUARDS).map((l) => [l.split("\t")[0], (l.split("\t")[1] ?? "").trim()]));
  const promises = invariantTests(root);
  const present = new Set(testFiles(root));
  const seen = new Set();
  let total = 0;
  rows.forEach(([f, n], i) => {
    const allowed = Number(n);
    total += Number.isInteger(allowed) ? allowed : 0;
    if (i > 0 && rows[i - 1][0] > f) problems.push(`UNSORTED ${BASELINE} is not sorted: keep its lines in order`);
    if (seen.has(f)) problems.push(`TWICE ${f} is on the baseline twice`);
    seen.add(f);
    const now = readers.get(f)?.length ?? 0;
    if (guards.has(f)) problems.push(`BOTH ${f} is on the baseline and the guard list: remove its baseline line`);
    else if (!present.has(f)) problems.push(`STALE ${f} is on the baseline and is not in the tree: remove its line`);
    else if (!now) problems.push(`STALE ${f} is on the baseline and reads no product source now: remove its line`);
    else if (!Number.isInteger(allowed) || allowed < 1) problems.push(`COUNT ${f} has no count: write how many reads it makes after a tab`);
    else if (now > allowed) problems.push(`GREW ${f} reads product source ${now} times, the baseline allows ${allowed}. ${FROZEN_SAYS}`);
    else if (now < allowed) problems.push(`SHRANK ${f} reads product source ${now} time${now === 1 ? "" : "s"} now, the baseline says ${allowed}: write ${now}`);
  });
  if (rows.length !== frozen.files || total !== frozen.reads) {
    problems.push(`SIZE ${BASELINE} holds ${rows.length} files and ${total} reads, frozen at ${frozen.files} and ${frozen.reads}: `
      + "a retirement lowers both in test/support/source-text.mjs, nothing raises them");
  }
  for (const [f, why] of guards) {
    if (!why) problems.push(`GUARD ${f} has no reason: write why after a tab`);
    if (!readers.has(f)) problems.push(`GUARD ${f} is on the guard list and reads no product source: remove its line`);
  }
  for (const [f, what] of readers) {
    if (seen.has(f) || guards.has(f) || promises.has(f)) continue;
    problems.push(`NEW ${f} reads ${what[0]} as text. ${FROZEN_SAYS}`);
  }
  return [...new Set(problems)].sort();
}
