/**
 * WHAT A PULL REQUEST'S ci.yml RUN TESTS. A maintainer's pull request runs the files its diff can reach;
 * everything else runs the whole suite: the nightly, dispatch, a batch branch (pr/batch-*), a fork's or a
 * bot's pull request, and any diff that touches the harness. Verbs:
 *
 *   scope    whole or selected, from the event and the diff (git diff HEAD^1 HEAD on the merge commit).
 *            Node built-ins only: no module of the tree it judges is loaded before it decides.
 *   select   the selected files and their jobs (vitest's module graph, the readers' named paths, the
 *            measured costs in test/support/ci-costs.json), written to --out. Any failure leaves it whole.
 *   outputs  the plan job's outputs; whole unless a valid selected plan is handed to it.
 *
 * A test file is selected by a rule: changed (added or modified); graph (vitest relates it to a changed
 * path; a changed non-module file outside the test directories counts its sibling modules); root (it is
 * under root test/); named (it reads the tree and names a changed or deleted path or a directory above one,
 * scans the app or package the change is in, names a child script whose relative imports reach it, or
 * names a source module whose import closure, walked by vitest's own resolver, reaches it); tree (a change
 * outside apps/ and packages/ and it names something in that top-level directory); area (a changed
 * non-module file, or a JSON file other than a manifest, that no reader names and no module sits beside,
 * and it lives in or names that app or package); always (it spawns git, or names a bundle or a
 * workspace's dist/ while package source or a bundler changes); sweep (it walks a directory and holds apps
 * or packages as a bare name, and a path under either changes); dovecot (a test/dovecot change, and it
 * dials Dovecot). A deleted module is whole.
 *
 * Test hooks: --root, --event <json> (the github context: event_name, actor, triggering_actor,
 * repository, event), --files <name-status file>; select takes its graph as a parameter.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Seconds of measured file time one selected job is packed to. */
export const TARGET_S = 600;
/** A selection costing this share of the whole runs the whole suite instead. */
export const WHOLE_SHARE = 0.7;
export const UNMEASURED_MS = 5000;
export const MAX_SHARDS = 16;
export const MAX_SQLITE = 4;
export const COSTS = "test/support/ci-costs.json";
/** Every path a plan may hand on; all test paths fit it. */
export const PATH_OK = /^[A-Za-z0-9@._/+-]+$/;
const MAINTAINER = ["OWNER", "MEMBER", "COLLABORATOR"];

const oneLine = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, 400);

/** A source without its comments, its strings, template literals and regex literals kept. One pass, so
 *  a `/*` inside a line comment or a string opens nothing (scripts/lib/pg-url-own.mjs's code() does). */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let prev = "";
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end < 0 ? n : end + 2);
      out += body.includes("\n") ? "\n" : " ";
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(?:return|typeof|case|in|of)\s*$/.test(out.slice(-12)))) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n" && (cls || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/* ── SCOPE ───────────────────────────────────────────────────────────────────────────────────── */

/** The github context of this run, from the runner's environment. */
export function ciContext(env = process.env) {
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  return { event_name: env.GITHUB_EVENT_NAME ?? "", actor: env.GITHUB_ACTOR ?? "", triggering_actor: env.GITHUB_TRIGGERING_ACTOR ?? "", repository: env.GITHUB_REPOSITORY ?? "", event };
}

/** Why this event runs the whole suite, or null for a maintainer's pull request. */
export function eventWhole(ctx) {
  if (ctx.event_name !== "pull_request") return `a ${ctx.event_name || "unnamed"} run is whole`;
  const pr = ctx.event?.pull_request;
  if (!pr) return "the event carries no pull request";
  const head = String(pr.head?.ref ?? "");
  if (head.startsWith("pr/batch-")) return "a batch branch is whole";
  if (!pr.head?.repo || pr.head.repo.full_name !== ctx.repository) return "the head is not a branch of this repository";
  if (!head.startsWith("pr/")) return "the head is not a pr/ branch";
  if (pr.user?.type !== "User") return "the pull request was not opened by a person";
  if (!MAINTAINER.includes(pr.author_association)) return "the author is not an owner, member or collaborator";
  if (String(ctx.actor).endsWith("[bot]") || String(ctx.triggering_actor).endsWith("[bot]")) return "a bot started the run";
  if (pr.base?.ref !== "main") return "the base is not main";
  return null;
}

/** `git diff --name-status` output, plain or -z, as {s, p}. */
export function parseNameStatus(text) {
  const out = [];
  if (text.includes("\0")) {
    const parts = text.split("\0");
    for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) out.push({ s: parts[i], p: parts[i + 1] });
  } else {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const [s, ...rest] = line.split("\t");
      out.push({ s, p: rest.join("\t") });
    }
  }
  return out;
}

/** The pull request's changes: the merge commit against its first parent, its second parent the head. */
export function readDiff(root, ctx) {
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^2"]).trim();
  const want = ctx.event?.pull_request?.head?.sha;
  if (want && head !== want) throw new Error("the checkout is not the pull request's merge commit");
  return parseNameStatus(git(root, ["diff", "--name-status", "--no-renames", "-z", "HEAD^1", "HEAD"]));
}

const STATIC_IMPORT = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gm;

/** A relative specifier of `from`, resolved to a file of the tree, or null. */
function resolveRelative(root, from, spec) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.(?:m?js|jsx)$/, "");
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]
    .find((c) => /\.(?:[cm]?[jt]sx?)$/.test(c) && existsSync(join(root, c)) && statSync(join(root, c)).isFile()) ?? null;
}

/** What `starts` load by static relative import, followed through every file outside apps/ and packages/
 *  (a package source is a leaf: its importers are vitest's graph). The starts are in it. */
function relativeClosure(root, starts) {
  const queue = [...starts];
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (/^(apps|packages)\//.test(rel) || !/\.(?:[cm]?[jt]sx?)$/.test(rel) || !existsSync(join(root, rel))) continue;
    for (const m of stripComments(readFileSync(join(root, rel), "utf8")).matchAll(STATIC_IMPORT)) {
      const hit = resolveRelative(root, rel, m[1] ?? m[2]);
      if (hit) queue.push(hit);
    }
  }
  return seen;
}

/** What test/setup/** loads by static relative import, followed through every file outside apps/ and
 *  packages/. */
export function setupClosure(root) {
  const queue = [];
  const walk = (rel) => {
    if (!existsSync(join(root, rel))) return;
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else queue.push(`${rel}/${e.name}`);
    }
  };
  walk("test/setup");
  return [...relativeClosure(root, queue)].filter((p) => !p.startsWith("test/setup/")).sort();
}

/** The scripts that bundle the engine and the hosts (apps/mobile's phone bundler is package source). */
export const BUNDLERS = ["scripts/engine-bundle.mjs", "scripts/bundle-host.mjs"];
/** The bundlers and what they load by relative import: a change to any of them reaches every bundle reader. */
export const bundlerClosure = (root) => [...relativeClosure(root, BUNDLERS)].sort();

/** The manifests and lockfiles: a dependency change is whole, a version bump is not. */
const MANIFEST = /^(?:(?:apps|packages)\/[^/]+\/)?package(?:-lock)?\.json$/;
const TRIGGERS = [
  [/^patches\/.*\.patch$|^scripts\/apply-patches\.mjs$/, "a dependency patch"],
  [/(^|\/)tsconfig[^/]*\.json$/, "a tsconfig"],
  [/^vitest\.config\.ts$/, "the vitest config"],
  [/^test\/setup\//, "the test harness"],
  [/^test\/support\/ci-shards(?:-sqlite)?\.json$/, "the shard map"],
  [/^\.github\/workflows\/ci\.yml$|^\.github\/scripts\/ci-select\.mjs$/, "the suite workflow or its selector"],
  [/^scripts\/lane-db\.(?:sh|mjs)$/, "the lane database"],
  [/^packages\/(?:db|db-mail)\/drizzle[^/]*\//, "a migration"],
];
export const inTestDir = (p) => /(^|\/)test\//.test(p);
const MODULE = /\.(?:[cm]?[jt]sx?|json|css)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const under = (p, m) => p === m || p.startsWith(`${m}/`);

/** A manifest or lockfile whose only change is the root's and the workspaces' `version` fields. */
export function versionOnly(before, after) {
  const strip = (text) => {
    const j = JSON.parse(text);
    delete j.version;
    for (const [k, v] of Object.entries(j.packages ?? {})) if (!k.includes("node_modules/") && v && typeof v === "object") delete v.version;
    return canonical(j);
  };
  return strip(before) === strip(after);
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** The diff's whole-suite triggers, and the two narrower ones. */
export function pathTriggers(root, changes) {
  const whole = [];
  let sqliteWhole = false;
  let dovecotAll = false;
  const closure = new Set(setupClosure(root));
  for (const { s, p } of changes) {
    if (!PATH_OK.test(p)) { whole.push("a changed path outside [A-Za-z0-9@._/+-]"); continue; }
    const st = s.charAt(0);
    if (!["A", "M", "D"].includes(st)) { whole.push(`${p}: change kind ${oneLine(s)}`); continue; }
    // vitest cannot relate a deleted module to what still imports it; a deleted test file has no importer.
    if (st === "D" && ((/^(apps|packages)\//.test(p) && !inTestDir(p)) || (MODULE.test(p) && !TEST_FILE.test(p)))) whole.push(`${p}: deleted or renamed`);
    if (MANIFEST.test(p)) {
      let bump = false;
      if (st === "M") {
        try { bump = versionOnly(git(root, ["show", `HEAD^1:${p}`]), git(root, ["show", `HEAD:${p}`])); } catch { bump = false; }
      }
      if (!bump) whole.push(`${p}: a dependency change`);
    }
    for (const [re, what] of TRIGGERS) if (re.test(p)) whole.push(`${p}: ${what}`);
    if (closure.has(p)) whole.push(`${p}: the test harness`);
    if (p === "vitest.sqlite.config.ts") sqliteWhole = true;
    if (p.startsWith("test/dovecot/")) dovecotAll = true;
  }
  return { whole, sqliteWhole, dovecotAll };
}

/** Whole or selected, and why. `changes` overrides the diff (a test hook). */
export function decideScope({ root = ROOT, ctx, changes = null }) {
  const ev = eventWhole(ctx);
  if (ev) return { scope: "whole", why: ev };
  let list = changes;
  if (!list) {
    try { list = readDiff(root, ctx); } catch { return { scope: "whole", why: "the diff cannot be read" }; }
  }
  const t = pathTriggers(root, list);
  if (t.whole.length) return { scope: "whole", why: t.whole.length > 1 ? `${t.whole[0]} (and ${t.whole.length - 1} more)` : t.whole[0] };
  return { scope: "selected", why: `${list.length} changed path(s)`, changes: list, sqliteWhole: t.sqliteWhole, dovecotAll: t.dovecotAll };
}

/* ── THE READERS: test files that read the tree by path, not by import ─────────────────────────── */

const READ = /\b(?:readFileSync|readdirSync|readFile|readdir|opendirSync|opendir|globSync|glob|createReadStream)\s*\(/;
const SPAWN = /\b(?:execFileSync|execSync|spawnSync|spawn|execFile|fork)\s*\(|(?<![.\w])exec\s*\(|\b(?:child_process|childProcess|cp)\.exec\s*\(/;
const SCAN = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(/;
const ANCHOR = /import\.meta\.url|import\.meta\.dirname|__dirname|\bROOT\b|\bREPO\b|\brepoRoot\b|process\.cwd\(\)/;
const GIT = /\b(?:execFileSync|execSync|spawnSync|spawn|execFile|exec)\s*\(\s*["'`]git\b/;
const BUNDLE = /(?<=["'`}])(?:apps|packages)\/[\w-]+\/dist\/|["'`](?:\.\.\/)+(?:[\w-]+\/)?dist\/[\w./-]*\.m?js|build\/(?:engine|phone-engine|server|worker)\b|["'`]build["'`]\s*,\s*["'`](?:engine|phone-engine|server|worker)\b|engine-bundle\.mjs|bundle-engine\.mjs|bundle-host\.mjs|OHMAIL_ENGINE_OUT/;
const PATHCALL = /\b(?:join|resolve|URL|publicPath|publicRel|readFileSync|readdirSync|existsSync|statSync|readFile|readdir)\s*\(/g;
/** The top-level directories a census walks the whole tree from, held as a bare literal. */
const TREE_ROOTS = new Set(["apps", "packages"]);
const LIT = /(["'`])((?:\\.|(?!\1)[^\\\n])*?)\1/g;
/** An import or export specifier: vitest's graph follows it, so it names nothing. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(["'])[^"'\n]*\2/gm;
const JOINED = /\[([^[\]]*)\]\s*\.join\s*\(/g;
const CHILD = /\.[cm]?[jt]sx?$/;
export const areaOf = (p) => (/^(apps|packages)\/[^/]+/.exec(p) ?? [""])[0];
const dotsOnly = (v) => v.split("/").every((s) => s === "." || s === ".." || s === "");

/** A template literal's static part: a leading `${ROOT}` dropped, then the directory before the first
 *  substitution (the whole text when there is none). Null when nothing static is left. */
function templateStatic(v) {
  const rest = v.replace(/^\$\{[\w.]+\}\/?/, "");
  if (!rest.includes("${")) return rest;
  const pre = rest.slice(0, rest.indexOf("${"));
  const cut = pre.lastIndexOf("/");
  return cut > 0 ? pre.slice(0, cut) : null;
}

/** Each path call's own arguments, its nested calls left out: `join(dirname(fileURLToPath(import.meta.url)),
 *  "shapes")` reads `dirname, "shapes"`. A nested path call is a path call of its own. */
function pathCallArgs(text) {
  const out = [];
  for (const m of text.matchAll(PATHCALL)) {
    let depth = 0;
    let args = "";
    let closed = false;
    const end = Math.min(text.length, m.index + m[0].length + 4000);
    for (let i = m.index + m[0].length; i < end; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < end && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
        if (depth === 0) args += text.slice(i, j + 1);
        i = j;
      } else if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) { closed = true; break; }
        depth--;
      } else if (depth === 0) args += c;
    }
    if (closed) out.push(args);
  }
  return out;
}

/** Whether a holder's code holds apps or packages as a whole literal: the root of a walk over the tree. */
function holdsTreeRoot(src) {
  for (const m of src.replace(SPECIFIER, '$1""').matchAll(LIT)) {
    let v = m[2];
    if (v.includes("${")) {
      if (m[1] !== "`") continue;
      v = v.replace(/^\$\{[\w.]+\}\/?/, "");
      if (v.includes("${")) continue;
    }
    if (TREE_ROOTS.has(v.replace(/^\.\//, "").replace(/\/+$/, ""))) return true;
  }
  return false;
}

/** The tree paths a holder's code names: literals (a template's static directory), the literal arguments
 *  of one path call, and an array of literals joined into one. `deleted` are the diff's removed paths: a
 *  name equal to one, or a directory above one, still counts. */
export function namedPaths(root, holder, src, tops, deleted = []) {
  const out = new Set();
  const exists = (p) => !!p && p !== "." && !p.startsWith("..") && PATH_OK.test(p) && (existsSync(join(root, p)) || deleted.some((d) => under(d, p)));
  const isFile = (p) => deleted.includes(p) || (existsSync(join(root, p)) && statSync(join(root, p)).isFile());
  const text = src.replace(SPECIFIER, '$1""');
  for (const m of text.matchAll(LIT)) {
    let v = m[2];
    if (!v) continue;
    const tpl = v.includes("${");
    if (tpl) {
      if (m[1] !== "`") continue;
      const lead = v.startsWith("${");
      v = templateStatic(v);
      // After a leading substitution only a path from the root counts.
      if (!v || (lead && v.startsWith("."))) continue;
    }
    v = v.replace(/\\/g, "/").replace(/\/\*\*.*$/, "").replace(/\/+$/, "");
    if (v.startsWith("github/")) v = `.${v}`;
    if (v.startsWith("./") || v.startsWith("../")) {
      if (dotsOnly(v)) continue;
      const p = posix.normalize(posix.join(posix.dirname(holder), v));
      if (exists(p)) out.add(p);
    } else if (tops.has(v.split("/")[0]) && exists(v) && (v.includes("/") || isFile(v))) {
      out.add(v);
    }
  }
  const addSeq = (args, tpl) => {
    if (!args.length) return;
    let seq = args.join("/").replace(/\/+/g, "/").replace(/^\.\//, "");
    if (dotsOnly(seq)) return;
    if (seq.startsWith("github/")) seq = `.${seq}`;
    for (const b of [posix.dirname(holder), areaOf(holder), ""]) {
      const p = posix.normalize(b ? `${b}/${seq}` : seq).replace(/\/+$/, "");
      // A template's directory is never a bare top-level directory.
      if (tpl && !p.includes("/")) continue;
      if (exists(p)) out.add(p);
    }
  };
  for (const call of pathCallArgs(text)) {
    const args = [];
    let tpl = false;
    for (const x of call.matchAll(LIT)) {
      const a = x[2];
      if (!a) continue;
      if (a.includes("${")) {
        if (x[1] !== "`") continue;
        const pre = a.slice(0, a.indexOf("${"));
        const cut = pre.lastIndexOf("/");
        if (cut > 0 && !/\s/.test(pre)) args.push(pre.slice(0, cut));
        tpl = true;
        break;
      }
      if (!/\s/.test(a)) args.push(a);
    }
    addSeq(args, tpl);
  }
  for (const m of text.matchAll(JOINED)) {
    const parts = [...m[1].matchAll(LIT)];
    if (!parts.length || m[1].replace(LIT, "").replace(/[\s,]/g, "") !== "") continue;
    const args = parts.map((x) => x[2]);
    if (args.every((a) => a && !a.includes("${") && !/\s/.test(a))) addSeq(args, false);
  }
  return out;
}

const HELPER = /^(?:(?:apps|packages)\/[^/]+\/)?test\//;

/**
 * Every test file outside root test/ that reads the tree or spawns, with the paths it names. Its own
 * code and the test helpers it imports by relative path count; only its own code anchors it or scans.
 * `code` strips comments, `relativeImports` follows helpers (service-needs.mjs).
 */
export function readersOf(root, files, { code, relativeImports, deleted = [] }) {
  const tops = new Set(readdirSync(root).filter((e) => e !== "node_modules" && e !== ".git"));
  const fileSet = new Set(files);
  const memo = new Map();
  const analyse = (rel) => {
    if (memo.has(rel)) return memo.get(rel);
    let src = "";
    try { src = code(readFileSync(join(root, rel), "utf8")); } catch { /* gone: names nothing */ }
    const a = {
      src, reads: READ.test(src) || SPAWN.test(src), git: GIT.test(src), bundle: BUNDLE.test(src), scans: SCAN.test(src),
      treeRoot: holdsTreeRoot(src), paths: namedPaths(root, rel, src, tops, deleted), deps: relativeImports(src, rel, root),
    };
    memo.set(rel, a);
    return a;
  };
  /* What a named, not imported, test-dir module (a spawned child, a rig entry) loads by relative import. */
  const depsMemo = new Map();
  const depsOf = (rel) => {
    if (!depsMemo.has(rel)) {
      let d = [];
      try { d = relativeImports(code(readFileSync(join(root, rel), "utf8")), rel, root); } catch { /* gone */ }
      depsMemo.set(rel, d.filter((x) => !x.includes("node_modules/")));
    }
    return depsMemo.get(rel);
  };
  const closure = (start) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      queue.push(...depsOf(f));
    }
    return seen;
  };
  const readers = new Map();
  for (const t of files) {
    if (t.startsWith("test/")) continue;
    const own = analyse(t);
    const holders = [own];
    const seen = new Set([t]);
    const queue = own.deps.filter((d) => HELPER.test(d) && !fileSet.has(d));
    while (queue.length) {
      const d = queue.shift();
      if (seen.has(d)) continue;
      seen.add(d);
      const h = analyse(d);
      holders.push(h);
      for (const n of h.deps) if (HELPER.test(n) && !fileSet.has(n)) queue.push(n);
    }
    const reads = holders.some((h) => h.reads);
    const gitSpawn = holders.some((h) => h.git);
    const bundle = holders.some((h) => h.bundle);
    // A census over the whole tree: it walks a directory and holds apps or packages bare (its own code or a helper's).
    const sweep = holders.some((h) => h.scans) && holders.some((h) => h.treeRoot);
    if (!reads && !gitSpawn && !bundle) continue;
    const paths = new Set(holders.flatMap((h) => [...h.paths]));
    const namesNothing = !paths.size;
    const scans = SCAN.test(own.src);
    if (scans) paths.add(posix.dirname(t));
    // An anchored scanner scans its own app or package, whatever else it names.
    if (areaOf(t) && ANCHOR.test(own.src) && (scans || (namesNothing && own.reads))) paths.add(areaOf(t));
    const imported = new Set(holders.flatMap((h) => h.deps));
    const loads = new Set();
    for (const p of paths) {
      if (!CHILD.test(p) || !inTestDir(p) || TEST_FILE.test(p) || imported.has(p) || fileSet.has(p) || !existsSync(join(root, p))) continue;
      for (const f of closure(p)) if (!paths.has(f)) loads.add(f);
    }
    readers.set(t, { paths: [...paths].sort(), loads: [...loads].sort(), git: gitSpawn, bundle, sweep });
  }
  return readers;
}

/** The source modules the readers name (a non-test module under apps/ or packages/): their import
 *  closures are walked, so a census that crawls one by text is selected for what it reaches. */
export function sourceEntries(readers) {
  const out = new Set();
  for (const r of readers.values()) {
    for (const p of r.paths) if (/^(apps|packages)\//.test(p) && !inTestDir(p) && CHILD.test(p)) out.add(p);
  }
  return [...out].sort();
}

/** The modules beside each changed non-module file outside the test directories: they count as changed. */
export function relatedInputs(root, paths) {
  const out = new Set(paths);
  for (const p of paths) {
    if (MODULE.test(p) || !/^(apps|packages)\//.test(p) || inTestDir(p)) continue;
    const dir = posix.dirname(p);
    try { for (const e of readdirSync(join(root, dir))) if (/\.[cm]?[jt]sx?$/.test(e)) out.add(`${dir}/${e}`); } catch { /* no directory */ }
  }
  return [...out].sort();
}

/**
 * The readers a change reaches, each with its rule: named, tree, area, always or sweep. `reached` are the
 * source entries (sourceEntries) whose import closure holds a changed path: a reader naming one is named.
 */
export function readerHits(root, changes, readers, reached = []) {
  const paths = changes.map((c) => c.p);
  const reach = new Set(reached);
  const hits = new Map();
  const set = (t, rule) => { if (!hits.has(t)) hits.set(t, rule); };
  for (const [t, r] of readers) {
    const p = paths.find((x) => r.paths.some((m) => under(x, m)) || (r.loads ?? []).includes(x));
    if (p || r.paths.some((m) => reach.has(m))) set(t, "named");
  }
  for (const p of paths.filter((x) => !/^(apps|packages)\//.test(x))) {
    const top = p.split("/")[0];
    for (const [t, r] of readers) if (r.paths.some((m) => m.split("/")[0] === top)) set(t, "tree");
  }
  for (const p of paths) {
    const area = areaOf(p);
    // A module is the graph's; a data file (JSON other than a manifest) is often read by a computed path.
    if (!area || (MODULE.test(p) && !(p.endsWith(".json") && !MANIFEST.test(p)))) continue;
    // A name of the whole area (an anchored scanner's) claims nothing: the area rule is wider.
    const named = [...readers.values()].some((r) => r.paths.some((m) => under(p, m) && !under(area, m)));
    const siblings = !inTestDir(p) && relatedInputs(root, [p]).length > 1;
    if (named || siblings) continue;
    for (const [t, r] of readers) if (areaOf(t) === area || r.paths.some((m) => under(m, area))) set(t, "area");
  }
  const bundlers = new Set(bundlerClosure(root));
  const source = paths.some((p) => (/^(apps|packages)\//.test(p) && !inTestDir(p)) || bundlers.has(p));
  const tree = paths.some((p) => /^(apps|packages)\//.test(p));
  for (const [t, r] of readers) {
    if (r.git) set(t, "always");
    else if (r.bundle && source) set(t, "always");
    if (r.sweep && tree) set(t, "sweep");
  }
  return hits;
}

/* ── THE GRAPH ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * vitest's own related set for `related` (repo-relative), and the project's whole file set, without
 * running a test. forceRerunTriggers is emptied: by default a package.json in `related` selects all.
 * `entries` (sourceEntries) come back in `reached` when their import closure holds a `related` path;
 * `list: false` skips vitest's own related listing.
 */
export async function vitestGraph(root, related, { config, overrides = {}, defaultTriggers = false, entries = [], list = true } = {}) {
  const { createVitest } = await import("vitest/node");
  const options = {
    root, watch: false, run: true, passWithNoTests: true, related: related.map((p) => resolve(root, p)),
    ...(defaultTriggers ? {} : { forceRerunTriggers: [] }),
    ...(config === false ? { config: false } : config ? { config: join(root, config) } : {}),
    ...overrides,
  };
  const ctx = await createVitest("test", options, {}, {});
  const rel = (spec) => relative(root, spec.moduleId).split("\\").join("/");
  try {
    const all = (await ctx.globTestSpecs()).map(rel);
    const hit = related.length && list ? (await ctx.listFiles()).map(rel) : [];
    const reached = related.length && entries.length ? await entriesReaching(ctx, root, entries, related) : [];
    return { related: [...new Set(hit)].sort(), all: [...new Set(all)].sort(), reached };
  } finally {
    await ctx.close();
  }
}

/**
 * The entries whose import closure holds one of `targets`, walked as vitest's getTestDependencies walks a
 * test file: the project's own transform and alias-aware resolver, static and dynamic imports, nothing
 * under node_modules. Each module is walked once across all entries; a module that cannot be walked
 * counts as reaching every target.
 */
async function entriesReaching(ctx, root, entries, targets) {
  const project = ctx.getCoreWorkspaceProject();
  const bases = [...new Set([root, realpathSync(root)])];
  const want = new Set(targets.flatMap((p) => bases.map((b) => join(b, p))));
  const edges = new Map();
  const depsOf = (id) => {
    if (!edges.has(id)) {
      edges.set(id, (async () => {
        try {
          const tr = project.server.moduleGraph.getModuleById(id)?.ssrTransformResult || await project.vitenode.transformRequest(id);
          if (!tr) return [];
          const out = new Set();
          await Promise.all([...(tr.deps ?? []), ...(tr.dynamicDeps ?? [])].map(async (dep) => {
            const r = await project.server.pluginContainer.resolveId(dep, id, { ssr: true });
            const file = r && !r.external && r.id.split("?")[0];
            if (file && !file.includes("node_modules") && existsSync(file)) out.add(file);
          }));
          return [...out];
        } catch {
          return null;
        }
      })());
    }
    return edges.get(id);
  };
  const seen = new Set();
  let frontier = entries.map((e) => resolve(root, e));
  while (frontier.length) {
    const next = [];
    await Promise.all(frontier.map(async (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const d of (await depsOf(id)) ?? []) if (!seen.has(d)) next.push(d);
    }));
    frontier = next;
  }
  // From the targets (and the modules that could not be walked) back along the imports.
  const importers = new Map();
  const queue = [];
  for (const id of seen) {
    const deps = await edges.get(id);
    if (deps === null || want.has(id)) queue.push(id);
    for (const d of deps ?? []) {
      if (!importers.has(d)) importers.set(d, []);
      importers.get(d).push(id);
    }
  }
  const reaches = new Set();
  while (queue.length) {
    const id = queue.pop();
    if (reaches.has(id)) continue;
    reaches.add(id);
    queue.push(...(importers.get(id) ?? []));
  }
  return entries.filter((e) => reaches.has(resolve(root, e))).sort();
}

/* ── PACKING ───────────────────────────────────────────────────────────────────────────────────── */

/** Longest-first greedy into clamp(ceil(cost / TARGET_S), 1, max) jobs; a group travels as one item. */
export function packFiles(files, costOf, max, groupOf = () => null) {
  if (!files.length) return [];
  const groups = new Map();
  const items = [];
  for (const f of [...files].sort()) {
    const g = groupOf(f);
    if (g) groups.set(g, [...(groups.get(g) ?? []), f]);
    else items.push({ files: [f], ms: costOf(f) });
  }
  for (const fs of groups.values()) items.push({ files: fs, ms: fs.reduce((s, f) => s + costOf(f), 0) });
  items.sort((a, b) => b.ms - a.ms || (a.files[0] < b.files[0] ? -1 : 1));
  const total = items.reduce((s, it) => s + it.ms, 0);
  const k = Math.max(1, Math.min(max, Math.ceil(total / (TARGET_S * 1000))));
  const bins = Array.from({ length: k }, () => ({ files: [], ms: 0 }));
  for (const it of items) {
    const bin = bins.reduce((lo, b) => (b.ms < lo.ms ? b : lo), bins[0]);
    bin.files.push(...it.files);
    bin.ms += it.ms;
  }
  return bins.filter((b) => b.files.length).map((b) => b.files.sort());
}

export function readCosts(root) {
  const p = join(root, COSTS);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { measuredAt: "none", suite: {}, sqlite: {} };
}

/** What a selected plan may not hold; any of it makes the run whole. */
export function planProblems(plan, { files, alone, desktop, sqliteAll }) {
  const problems = [];
  const fileSet = new Set(files);
  const sqliteSet = new Set(sqliteAll ?? []);
  const check = (f, where, set) => {
    if (!PATH_OK.test(f)) problems.push(`${where}: a path outside [A-Za-z0-9@._/+-]`);
    else if (!set.has(f)) problems.push(`${where}: ${f} is not a test file of this run`);
  };
  const seen = new Set();
  for (const s of plan.shards) {
    for (const f of s.files.split("\n")) {
      check(f, `shard ${s.shard}`, fileSet);
      if (alone.has(f)) problems.push(`shard ${s.shard}: ${f} runs alone`);
      if (desktop.has(f)) problems.push(`shard ${s.shard}: ${f} runs in the desktop job`);
      if (seen.has(f)) problems.push(`${f} is handed twice`);
      seen.add(f);
    }
  }
  for (const f of plan.alone) {
    check(f, "alone", fileSet);
    if (!alone.has(f)) problems.push(`alone: ${f} does not run alone`);
    if (seen.has(f)) problems.push(`${f} is handed twice`);
    seen.add(f);
  }
  const seenSqlite = new Set();
  for (const s of plan.sqlite ?? []) {
    for (const f of s.files.split("\n")) {
      check(f, `sqlite shard ${s.shard}`, sqliteSet);
      if (seenSqlite.has(f)) problems.push(`${f} is handed twice to the sqlite run`);
      seenSqlite.add(f);
    }
  }
  return problems;
}

/* ── SELECT ────────────────────────────────────────────────────────────────────────────────────── */

const RULES = ["changed", "graph", "root", "named", "tree", "area", "always", "sweep", "dovecot"];

/**
 * The selected plan, or a whole one with its reason. `graph(root, related, {config})` returns vitest's
 * related set and the project's files; `costs` defaults to test/support/ci-costs.json.
 */
export async function select({ root = ROOT, ctx, changes = null, graph = vitestGraph, costs = null } = {}) {
  const scope = decideScope({ root, ctx, changes });
  if (scope.scope !== "selected") return { scope: "whole", why: scope.why };
  const cs = await import(new URL("../../test/support/ci-shards.mjs", import.meta.url).href);
  const { relativeImports } = await import(new URL("../../test/support/service-needs.mjs", import.meta.url).href);
  const files = cs.testFiles(root);
  const fileSet = new Set(files);
  const alone = new Set(cs.aloneFiles(root, files));
  const desktop = new Set(cs.desktopFiles(root, files));
  const c = costs ?? readCosts(root);
  const rule = new Map();
  const add = (f, r) => { if (fileSet.has(f) && !rule.has(f)) rule.set(f, r); };

  const present = scope.changes.filter((x) => x.s === "A" || x.s === "M").map((x) => x.p);
  for (const p of present) add(p, "changed");
  const related = relatedInputs(root, present);
  const deleted = scope.changes.filter((x) => x.s === "D").map((x) => x.p);
  const readers = readersOf(root, files, { code: stripComments, relativeImports, deleted });
  const main = await graph(root, related, { config: "vitest.config.ts", entries: sourceEntries(readers) });
  for (const f of main.related) add(f, "graph");
  for (const f of files) if (f.startsWith("test/")) add(f, "root");
  for (const [f, r] of readerHits(root, scope.changes, readers, main.reached ?? [])) add(f, r);
  if (scope.dovecotAll) for (const f of files) if (cs.dovecotPinned(root, f)) add(f, "dovecot");

  const picked = [...rule.keys()].sort();
  const mainPicked = picked.filter((f) => !alone.has(f) && !desktop.has(f));
  const alonePicked = picked.filter((f) => alone.has(f));
  const suiteMs = (f) => c.suite?.[f] ?? UNMEASURED_MS;
  const sqliteMs = (f) => c.sqlite?.[f] ?? UNMEASURED_MS;
  const sum = (xs, ms) => xs.reduce((s, f) => s + ms(f), 0);
  const wholeMs = sum(files.filter((f) => !alone.has(f) && !desktop.has(f)), suiteMs);
  const share = wholeMs ? sum(mainPicked, suiteMs) / wholeMs : 1;
  if (share >= WHOLE_SHARE) return { scope: "whole", why: `the selection costs ${Math.round(share * 100)}% of the whole suite` };

  let sqliteFiles = null;
  let sqliteAll = null;
  if (!scope.sqliteWhole) {
    const sq = await graph(root, related, { config: "vitest.sqlite.config.ts" });
    sqliteAll = sq.all;
    const inProject = new Set(sq.all);
    sqliteFiles = [...new Set([...sq.related, ...picked.filter((f) => inProject.has(f))])].filter((f) => inProject.has(f)).sort();
  }
  const shards = packFiles(mainPicked, suiteMs, MAX_SHARDS, (f) => (cs.dovecotPinned(root, f) ? "dovecot" : null))
    .map((fs, shard) => ({ shard, files: fs.join("\n"), dovecot: fs.some((f) => cs.dovecotPinned(root, f)) ? "yes" : "no" }));
  const sqlite = sqliteFiles === null ? null : packFiles(sqliteFiles, sqliteMs, MAX_SQLITE).map((fs, shard) => ({ shard, files: fs.join("\n") }));
  const plan = { scope: "selected", why: scope.why, shards, alone: alonePicked, sqlite };
  const problems = planProblems(plan, { files, alone, desktop, sqliteAll: sqliteAll ?? [] });
  if (problems.length) return { scope: "whole", why: `the plan is refused: ${problems[0]}` };
  const counts = Object.fromEntries(RULES.map((r) => [r, [...rule.values()].filter((v) => v === r).length]));
  return {
    ...plan,
    summary: {
      changed: scope.changes.length, rules: counts, main: mainPicked.length, alone: alonePicked.length,
      sqlite: sqliteFiles === null ? "whole" : sqliteFiles.length, share: Math.round(share * 1000) / 10,
      costsMeasuredAt: c.measuredAt ?? "none",
    },
  };
}

/* ── OUTPUTS ───────────────────────────────────────────────────────────────────────────────────── */

/** The plan job's outputs: the selected plan when it is handed and sound, else the whole run. */
export function composeOutputs({ indexes, sqliteIndexes, alone, scope = "", scopeWhy = "", selectOutcome = "", plan = null }) {
  const whole = (why) => ({
    scope: "whole", why,
    shards: indexes.map((shard) => ({ shard })), alone, sqlite: sqliteIndexes.map((shard) => ({ shard })), summary: null,
  });
  if (scope !== "selected") return whole(scopeWhy || "the scope step said nothing");
  if (selectOutcome !== "success") return whole(`the selector did not finish (${selectOutcome || "skipped"})`);
  if (!plan) return whole("the selector wrote no plan");
  if (plan.scope !== "selected") return whole(plan.why || "the selector chose the whole suite");
  const shape = Array.isArray(plan.shards) && Array.isArray(plan.alone) && (plan.sqlite === null || Array.isArray(plan.sqlite))
    && plan.shards.every((s) => Number.isInteger(s.shard) && typeof s.files === "string" && s.files && (s.dovecot === "yes" || s.dovecot === "no"))
    && (plan.sqlite ?? []).every((s) => Number.isInteger(s.shard) && typeof s.files === "string" && s.files);
  if (!shape) return whole("the plan is not the selector's shape");
  const all = [...plan.shards.flatMap((s) => s.files.split("\n")), ...plan.alone];
  if (all.some((f) => !PATH_OK.test(f))) return whole("the plan holds a path outside [A-Za-z0-9@._/+-]");
  if (new Set(all).size !== all.length) return whole("the plan hands a file twice");
  const aloneSet = new Set(alone);
  if (plan.alone.some((f) => !aloneSet.has(f))) return whole("the plan runs alone a file that does not");
  if (plan.shards.some((s) => s.files.split("\n").some((f) => aloneSet.has(f)))) return whole("the plan puts an alone file in a shard");
  const sq = (plan.sqlite ?? []).flatMap((s) => s.files.split("\n"));
  if (sq.some((f) => !PATH_OK.test(f)) || new Set(sq).size !== sq.length) return whole("the sqlite plan is refused");
  return {
    scope: "selected", why: plan.why, shards: plan.shards, alone: plan.alone,
    sqlite: plan.sqlite ?? sqliteIndexes.map((shard) => ({ shard })), summary: plan.summary ?? null,
  };
}

export function summaryText(out) {
  const lines = [`### suite plan: ${out.scope}`, "", oneLine(out.why), ""];
  if (out.scope === "selected") {
    const s = out.summary ?? {};
    lines.push("partial run: the whole suite runs on the batch and nightly.", "");
    lines.push(`- ${out.shards.length} suite job(s), ${out.alone.length} alone file(s), ${out.sqlite.length} sqlite job(s)`);
    if (s.rules) lines.push(`- files by rule: ${Object.entries(s.rules).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (s.share !== undefined) lines.push(`- ${s.main} main file(s), ${s.share}% of the whole suite's measured time (costs ${oneLine(s.costsMeasuredAt)})`);
    if (s.sqlite === "whole") lines.push("- the SQLite run is whole");
  } else {
    lines.push(`- ${out.shards.length} suite shards, ${out.alone.length} alone file(s), ${out.sqlite.length} sqlite shards`);
  }
  return `${lines.join("\n")}\n`;
}

/* ── CLI ───────────────────────────────────────────────────────────────────────────────────────── */

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const [verb, ...rest] = argv;
  const root = resolve(flag(rest, "--root") ?? ROOT);
  const ctx = () => (flag(rest, "--event") !== undefined ? JSON.parse(flag(rest, "--event")) : ciContext());
  const filesAt = flag(rest, "--files");
  const changes = () => (filesAt !== undefined ? parseNameStatus(readFileSync(filesAt, "utf8")) : null);
  if (verb === "scope") {
    let s;
    try { s = decideScope({ root, ctx: ctx(), changes: changes() }); } catch (e) { s = { scope: "whole", why: `the scope step failed: ${e.message}` }; }
    process.stdout.write(`scope=${s.scope}\nwhy=${oneLine(s.why)}\n`);
    return 0;
  }
  if (verb === "select") {
    const out = flag(rest, "--out");
    if (!out) throw new Error("select takes --out <file>");
    const plan = await select({ root, ctx: ctx(), changes: changes() });
    writeFileSync(out, `${JSON.stringify(plan)}\n`);
    process.stdout.write(`SELECT ${plan.scope}: ${oneLine(plan.why)}${plan.scope === "selected" ? `; ${plan.shards.length} suite job(s), ${plan.alone.length} alone, ${plan.sqlite === null ? "whole" : plan.sqlite.length} sqlite` : ""}\n`);
    return 0;
  }
  if (verb === "outputs") {
    const at = flag(rest, "--plan");
    let plan = null;
    try { plan = at ? JSON.parse(readFileSync(at, "utf8")) : null; } catch { plan = null; }
    const out = composeOutputs({
      indexes: JSON.parse(flag(rest, "--indexes") ?? "null"),
      sqliteIndexes: JSON.parse(flag(rest, "--sqlite-indexes") ?? "null"),
      alone: JSON.parse(flag(rest, "--alone") ?? "null"),
      scope: flag(rest, "--scope") ?? "", scopeWhy: flag(rest, "--scope-why") ?? "", selectOutcome: flag(rest, "--select-outcome") ?? "", plan,
    });
    process.stdout.write([
      `scope=${out.scope}`, `why=${oneLine(out.why)}`,
      `shards=${JSON.stringify(out.shards)}`, `alone=${JSON.stringify(out.alone)}`, `sqlite=${JSON.stringify(out.sqlite)}`,
    ].join("\n") + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText(out));
    return 0;
  }
  process.stderr.write("ci-select: scope | select --out <file> | outputs --indexes <json> --sqlite-indexes <json> --alone <json> [--scope s --scope-why w --select-outcome o --plan <file>]  [--root dir] [--event json] [--files name-status]\n");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc), (err) => {
    process.stderr.write(`ci-select: ${err.message}\n`);
    process.exit(1);
  });
}
