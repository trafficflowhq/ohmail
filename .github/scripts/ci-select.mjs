/**
 * WHAT A PULL REQUEST'S ci.yml RUN TESTS. A maintainer's pull request runs the files its diff can reach;
 * everything else runs the whole suite: the nightly, dispatch, a batch branch (pr/batch-*), a fork's or a
 * bot's pull request, a pull request into any branch but main and next, and any diff that touches the harness
 * (into next, only what decides which files run: THE JUDGE below). Verbs:
 *
 *   scope    whole, selected or build-only, from the event and the diff (git diff HEAD^1 HEAD on the merge commit).
 *            Node built-ins only: no module of the tree it judges is loaded before it decides.
 *   select   the selected files and their jobs (vitest's module graph, the readers' named paths, the
 *            measured costs in test/support/ci-costs.json), written to --out. Any failure leaves it whole.
 *   outputs  the plan job's outputs; whole unless the scope is build-only or a valid selected plan is handed to it.
 *   floor    the floor of a pull request into next, one file per line, from the readers alone (vitest is
 *            not loaded); --local leaves out the bundle readers and the files that run alone.
 *
 * A test file is selected by a rule: changed (added or modified); graph (vitest relates it to a changed
 * path; a changed non-module file outside the test directories counts its sibling modules); root (it is
 * under root test/); named (it reads the tree and names a changed or deleted path or a directory above one,
 * scans the app or package the change is in, names a child script whose relative imports reach it, or
 * names a source module whose import closure, walked by vitest's own resolver, reaches it; or it imports a
 * deleted module by a relative path, and is never cut); tree (a change
 * outside apps/ and packages/ and it names something in that top-level directory); area (a changed
 * non-module file, or a JSON file other than a manifest, that no reader names and no module sits beside,
 * and it lives in or names that app or package); always (it spawns git, or names a bundle or a
 * workspace's dist/ while package source or a bundler changes); sweep (it walks a directory and holds apps
 * or packages as a bare name, and a path under either changes); dovecot (a test/dovecot change, and it
 * dials Dovecot). A deleted module is whole into main.
 *
 * Into main that selection is the run: the reach set, and main is proven whole by the batch and the
 * nightly. Into next (DIRECT_BASES) the run is THE FLOOR and the DIRECT set, held to THE CAP. The direct
 * set is the part of the same selection the change can break where it is and what names it: every rule as
 * above, with graph held to the apps and packages the change touches and root to the files a reader rule would
 * select. A changed module outside apps/ and packages/ beside them adds the files the graph relates to the root
 * files alone; root files alone, or that reading failed, keep the whole reach. The floor runs on every
 * pull request into next and is never cut: every root test, every git spawner, every bundle reader, every
 * census of the whole tree, and with a migration every test of packages/db and packages/db-mail. The rest of
 * the selection is deferred, not dropped: the plan names each file with its rule, and the whole suite runs
 * it on next each night. Into next only THE JUDGE is whole (this file, ci.yml, the shard walker, the service
 * reader, vitest.config.ts beyond an admitted alias line, a root vitest workspace or projects file, test/setup
 * and what it loads), with any failure.
 * Any other harness change, a deleted module and a direct set past the cap are CAPPED: the floor, the
 * changed tests and the readers the change reaches run whatever they cost; the rest of the direct set fills
 * CAP_S, Postgres files first, then the cheapest, and what does not fit waits for the night, named (the
 * CAPPED line and its log groups; FAST when nothing was cut). A harness change that only adds lines (a
 * package's: a tsconfig entry, an alias line of vitest.config.ts, a workspace and its links in the manifests
 * and the lockfile; an alias line for a new entry of a workspace the base names nowhere; a shard map that only
 * follows the diff's own test files) is deferred and named with what it added: THE HARNESS, INTO A DIRECT BASE
 * says what is admitted. main merged across into next (pr/merge-main-*) runs the reach set and is never capped.
 *
 * Test hooks: --root, --event <json> (the github context: event_name, actor, triggering_actor,
 * repository, event), --files <name-status file>; select takes its graph and the diff's two sides as
 * parameters.
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
/** A capped run into a direct base: one pass of the six test machines, CAP_S of measured main-suite time,
 *  and one job of the second store. */
export const CAP_JOBS = 6;
export const CAP_S = CAP_JOBS * TARGET_S;
export const SQLITE_CAP_S = TARGET_S;
export const COSTS = "test/support/ci-costs.json";
/** Every path a plan may hand on; all test paths fit it. */
export const PATH_OK = /^[A-Za-z0-9@._/+-]+$/;
/** A tree path the selector reads (a changed path, a reader's name): PATH_OK, plus a Next route group as a
 *  whole segment, `(name)` of the same characters. It never reaches a plan. */
export const TREE_PATH_OK = /^(?:[A-Za-z0-9@._/+-]|(?<=^|\/)\([A-Za-z0-9@._+-]+\)(?=\/|$))+$/;
const MAINTAINER = ["OWNER", "MEMBER", "COLLABORATOR"];
/** The long-lived lines a lane lands on: main and next, the second line. A pull request into any other branch runs whole. */
const BASES = ["main", "next"];
/** The lines whose pull requests run the direct set: the whole suite runs on the line itself, after landing. */
export const DIRECT_BASES = ["next"];

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
      while (i < n && src[i] !== "\n" && src[i] !== "\r" && src[i] !== "\u2028" && src[i] !== "\u2029") i++;
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
  if (!BASES.includes(pr.base?.ref)) return "the base is not main or next";
  return null;
}

/** The base whose direct set this event runs, or null: a maintainer's pull request into one of DIRECT_BASES,
 *  read from the event alone. main merged across (pr/merge-main-*) keeps the reach set: its diff is main's
 *  whole delta, met by the line's own code for the first time. */
export function directBase(ctx) {
  if (eventWhole(ctx) !== null) return null;
  const pr = ctx.event.pull_request;
  return DIRECT_BASES.includes(pr.base.ref) && !String(pr.head.ref).startsWith("pr/merge-main-") ? pr.base.ref : null;
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

/**
 * THE JUDGE: what decides which test files run and under what (the plan, the walk that lists the test files,
 * the gate that turns a missing service into a failure). A fault there turns a later run green by not running
 * a file, so a change to it runs whole into every base. `admitted`: the harness admission took the change.
 */
export function isJudge(root, p, admitted = false) {
  return judgeOf(new Set(setupClosure(root)))(p, admitted);
}
/** The judge's seven plain tests of a path, with test/setup's closure read once. */
const judgeOf = (closure) => (p, admitted = false) => p === ".github/workflows/ci.yml"
  || p === ".github/scripts/ci-select.mjs"
  || p === "test/support/ci-shards.mjs"
  || p === "test/support/service-needs.mjs"
  || (p === "vitest.config.ts" && !admitted)
  || /^vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)$/.test(p)
  || p.startsWith("test/setup/") || closure.has(p);

/** The scripts that bundle the engine and the hosts (apps/mobile's phone bundler is package source). */
export const BUNDLERS = ["scripts/engine-bundle.mjs", "scripts/bundle-host.mjs"];
/** The bundlers and what they load by relative import: a change to any of them reaches every bundle reader. */
export const bundlerClosure = (root) => [...relativeClosure(root, BUNDLERS)].sort();

/** The manifests and lockfiles: a dependency change is whole, a version bump is not. */
const MANIFEST = /^(?:(?:apps|packages)\/[^/]+\/)?package(?:-lock)?\.json$/;
/** The workspaces whose journals hold the two stores' migrations. */
const JOURNALED = ["packages/db", "packages/db-mail"];
/** A migration of either store: its journal, its statements and its snapshots, under a journaled workspace. */
const MIGRATION = new RegExp(`^(?:${JOURNALED.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/drizzle[^/]*/`);
const HARNESS = "the test harness";
const DELETED = "deleted or renamed";
const SHARD_MAP = "the shard map";
const TRIGGERS = [
  [/^patches\/.*\.patch$|^scripts\/apply-patches\.mjs$/, "a dependency patch"],
  [/(^|\/)tsconfig[^/]*\.json$/, "a tsconfig"],
  [/^vitest\.config\.ts$/, "the vitest config"],
  [/^vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)$/, "the vitest workspace"],
  [/^test\/setup\//, HARNESS],
  [/^test\/support\/ci-shards(?:-sqlite)?\.json$/, SHARD_MAP],
  [/^\.github\/workflows\/ci\.yml$|^\.github\/scripts\/ci-select\.mjs$/, "the suite workflow or its selector"],
  [/^scripts\/lane-db\.(?:sh|mjs)$/, "the lane database"],
  [MIGRATION, "a migration"],
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

/* ── THE HARNESS, INTO A DIRECT BASE ─────────────────────────────────────────────────────────── */

/*
 * A harness path whose change only ADDS A PACKAGE'S LINES does not make a pull request into a direct base
 * whole: its direct set runs, and the whole suite on the base after landing runs the rest, as for any other
 * change. What is admitted is read off both sides' text, never off a file name, and each shape is one that a
 * job of every run proves before landing (the typecheck job and each suite job run `tsc -b`, `npm ci` refuses
 * a manifest its lockfile does not match, and the direct set runs under the new config):
 *
 *   a tsconfig        added in a new app or package, its files and its output inside it (a `tsconfig.json`
 *                     there must be one of the root's new references); or gaining `references` entries,
 *                     `compilerOptions.paths` keys that point into apps/ or packages/, `include` entries
 *                     inside a new one. Never tools/tsconfig.base.json.
 *   vitest.config.ts  lines inserted into the alias table: a line comment, or one entry on a line whose
 *                     `find` can match a new package's name alone and whose target is inside it, or one
 *                     for a new entry of a workspace the base holds that no file of the base names.
 *   a manifest        added with a new app or package; the root's gaining them as workspaces; a workspace's
 *                     gaining dependencies on workspaces, or `exports` subpaths.
 *   the lockfile      gaining those workspaces, their links, and those dependencies. No other entry moves.
 *   a shard map       changed so that each shard, in order, is the base's list without the test files the diff
 *                     deletes and with entries of those it adds; every other key as it was.
 *
 * A new app or package is one the base does not hold and the diff only adds to; its name is new when no
 * entry of the base's lockfile carries it. Anything else is the judge's (vitest.config.ts) or a reason that
 * caps the run (the rest), and every such diff into any other base is whole as before. A side that cannot be
 * read admits nothing.
 */
const DEPENDENCY = "a dependency change";
const TSCONFIG = "a tsconfig";
const VITEST_CONFIG = "the vitest config";
const DEP_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/** A package name the admission will print and match: npm's own shape. */
const NAME_OK = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** A `paths` key, an `exports` subpath, an `include` entry: what the plan's log may print. */
const KEY_OK = /^[A-Za-z0-9@._/+*-]+$/;
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** The same value, key order included: a condition map reads in its order. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
/** A tsconfig's settings: its comments stripped, its `//` note keys dropped. */
function jsonc(text) {
  const plain = (v) => (Array.isArray(v) ? v.map(plain) : isObject(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("//")).map(([k, x]) => [k, plain(x)])) : v);
  try { return plain(JSON.parse(stripComments(text))); } catch { return undefined; }
}
/** The entries `after` holds beyond `before`'s, which it keeps in their order; null when one is gone or moved. */
function gainedEntries(before, after) {
  const out = [];
  let i = 0;
  for (const x of after) {
    if (i < before.length && same(before[i], x)) i++;
    else out.push(x);
  }
  return i === before.length ? out : null;
}
/** The keys `after` holds beyond `before`'s, whose every entry it keeps as it was; null otherwise. */
function gainedKeys(before, after) {
  if (!isObject(before) || !isObject(after)) return null;
  for (const k of Object.keys(before)) if (!(k in after) || !same(before[k], after[k])) return null;
  return Object.keys(after).filter((k) => !(k in before));
}
/** A path written in the file `p`, from the repository's root. */
const fromDir = (p, rel) => posix.normalize(posix.join(posix.dirname(p), rel)).replace(/\/+$/, "");
const leaves = (p) => p === ".." || p.startsWith("../") || p.startsWith("/");
const count = (n, one, many) => (n === 1 ? one : many);

/**
 * What a tsconfig gained, when gaining is all it did: its new `references` (as written, and from the root),
 * `compilerOptions.paths` keys and `include` entries. Null for any other change: a compiler option, `extends`,
 * `files`, an entry removed or moved, `paths` or `include` where there was none (either replaces what the
 * file inherits), a path that leaves apps/ and packages/.
 */
export function tsconfigAdditions(p, before, after) {
  const b = jsonc(before);
  const a = jsonc(after);
  if (!isObject(b) || !isObject(a)) return null;
  const out = { references: [], paths: [], include: [] };
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (same(b[k], a[k])) continue;
    if (k === "references" && (b[k] === undefined || Array.isArray(b[k])) && Array.isArray(a[k])) {
      const gained = gainedEntries(b[k] ?? [], a[k]);
      if (!gained) return null;
      for (const r of gained) {
        if (!isObject(r) || !same(Object.keys(r), ["path"]) || typeof r.path !== "string" || !PATH_OK.test(r.path) || leaves(fromDir(p, r.path))) return null;
        out.references.push({ path: r.path, to: fromDir(p, r.path) });
      }
    } else if (k === "include" && Array.isArray(b[k]) && Array.isArray(a[k])) {
      const gained = gainedEntries(b[k], a[k]);
      if (!gained) return null;
      for (const x of gained) {
        if (typeof x !== "string" || !KEY_OK.test(x) || leaves(fromDir(p, x))) return null;
        out.include.push(fromDir(p, x));
      }
    } else if (k === "compilerOptions" && isObject(b[k]) && isObject(a[k])) {
      for (const o of new Set([...Object.keys(b[k]), ...Object.keys(a[k])])) {
        if (same(b[k][o], a[k][o])) continue;
        const gained = o === "paths" && a[k].baseUrl === undefined ? gainedKeys(b[k][o], a[k][o]) : null;
        if (!gained) return null;
        for (const key of gained) {
          const to = a[k][o][key];
          if (!KEY_OK.test(key) || !Array.isArray(to) || !to.length) return null;
          if (to.some((v) => typeof v !== "string" || !/^\.\.?\//.test(v) || !/^(?:apps|packages)\/[^/]+\//.test(fromDir(p, v)))) return null;
          out.paths.push(key);
        }
      }
    } else return null;
  }
  return out;
}

/** What an admitted tsconfig change is, in words, or null. `before` is null for an added file. */
export function admittedTsconfig(p, before, after, { newAreas = new Set() } = {}) {
  if (p === "tools/tsconfig.base.json" || typeof after !== "string") return null;
  const inNew = (x) => [...newAreas].some((n) => under(x, n));
  if (before === null) {
    // A new package's own program: its files and what it writes stay in its folder (`paths` only reads).
    const a = jsonc(after);
    const out = (v) => (Array.isArray(v) ? v.some(out) : typeof v === "string" && (v.startsWith("/") || v.split("/").includes("..")));
    const listed = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (!isObject(a) || !inNew(p) || !listed(a.include) || !listed(a.files) || out(a.include) || out(a.files)) return null;
    const options = a.compilerOptions ?? {};
    return isObject(options) && !Object.entries(options).some(([k, v]) => k !== "paths" && out(v)) ? `new with ${areaOf(p)}` : null;
  }
  const d = typeof before === "string" && before !== after ? tsconfigAdditions(p, before, after) : null;
  if (!d || !d.include.every(inNew)) return null;
  const parts = [];
  if (d.references.length) parts.push(`${count(d.references.length, "a reference", "references")} to ${d.references.map((r) => r.path).join(", ")}`);
  if (d.paths.length) parts.push(`paths for ${d.paths.join(", ")}`);
  if (d.include.length) parts.push(`include of ${d.include.join(", ")}`);
  return parts.length ? parts.join("; ") : "comments or layout only";
}

/**
 * One entry of the alias table on a line of its own, read left to right: `{ find: "name" | /source/,
 * replacement: r("./path") | `${r("./path")}tail` },` and a line comment after it. Null for any other line.
 */
function aliasEntry(line) {
  if (line.includes("/*") || line.includes("*/")) return null;
  let rest = line.trim();
  const eat = (re) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };
  if (!eat(/^\{\s*find:\s*/)) return null;
  const find = {};
  const text = eat(/^(["'])([A-Za-z0-9@._/-]+)\1/);
  if (text) find.text = text[2];
  else {
    if (rest[0] !== "/") return null;
    let end = 1;
    while (end < rest.length && rest[end] !== "/") end += rest[end] === "\\" ? 2 : 1;
    if (end >= rest.length) return null;
    find.source = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  if (!eat(/^\s*,\s*replacement:\s*/)) return null;
  const target = /^r\((["'])\.\/([A-Za-z0-9@._/-]+)\1\)/;
  const template = rest[0] === "`";
  if (template && !eat(/^`\$\{/)) return null;
  const to = eat(target);
  const tail = template ? eat(/^\}((?:\/[A-Za-z0-9$._-]*)*)`/) : [""];
  if (!to || !tail || !eat(/^\s*\}\s*,\s*/) || (rest !== "" && !rest.startsWith("//"))) return null;
  return [to[2], tail[1] ?? ""].some((x) => x.split("/").includes("..")) ? null : { ...find, to: to[2] };
}

/** Whether a regex `find` can match only `name` or a subpath of it: anchored at its start, one arm, the
 *  name spelled out, then the end or a `/` that must be there. */
function findsOnly(source, name) {
  if (!source.startsWith("^") || source.includes("|") || !/^[A-Za-z0-9@_/-]+$/.test(name)) return false;
  const plain = source.slice(1).split("\\/").join("/");
  const rest = plain.slice(name.length);
  return plain.startsWith(name) && (rest === "$" || (rest.startsWith("/") && !"?*+{".includes(rest.charAt(1))));
}

/**
 * What an admitted vitest.config.ts change is, in words, or null. Admitted: `after` is `before` with lines
 * inserted into the alias table, each a line comment or one entry (aliasEntry) for a new package (`newNames`
 * maps each new name to its folder) or for a new entry of a workspace the base holds. Read in one pass over
 * both: a line of `after` that is not the next line of `before` is an insertion and must be admitted where it
 * stands. A string `find` matches by prefix, so one that begins a `find` the table already holds is refused.
 *
 * A NEW ENTRY, read in this order: its find is a text F, or a pattern for F and nothing else (`^F$`); F is a
 * workspace's name N, a slash and a rest, where the base's lockfile links N to its folder (`workspaces`); the
 * target is inside that folder; no find the table holds begins with F; the base names F nowhere and builds no
 * specifier of N from parts (`names`, the base's search, and the config itself outside its table). A line that
 * holds a line end JavaScript reads besides a newline is none. A line can change how a specifier resolves only for
 * F and what begins with it, and no file of the base carries such a specifier, so every module that does is
 * one the diff added or changed, and the graph relates every test that loads it to the change.
 */
export function admittedVitestAlias(before, after, { newNames = new Map(), workspaces = new Map(), names = () => true } = {}) {
  if (typeof before !== "string" || typeof after !== "string") return null;
  const b = before.split("\n");
  const opens = b.flatMap((l, i) => (/^\s*alias:\s*\[\s*$/.test(l) ? [i] : []));
  if (opens.length !== 1) return null;
  const [open] = opens;
  const close = b.findIndex((l, i) => i > open && l.trimEnd() === `${b[open].slice(0, b[open].length - b[open].trimStart().length)}],`);
  if (close < 0) return null;
  const held = [...b.slice(open, close).join("\n").matchAll(/find:\s*["']([^"'\\\n]+)["']/g)].map((m) => m[1]);
  /** A new package's name or a subpath of it, its target inside its folder. */
  const newPackage = (e) => {
    const name = [...newNames.keys()].find((n) => (e.text !== undefined ? e.text === n || e.text.startsWith(`${n}/`) : findsOnly(e.source, n)));
    return name && under(posix.normalize(e.to), newNames.get(name)) && !(e.text !== undefined && held.some((f) => f.startsWith(e.text))) ? name : null;
  };
  /** A new entry F of a workspace the base holds, as the comment above reads it; a rest with an empty or a dot segment is none. */
  const newEntry = (e) => {
    const f = e.text ?? (e.source.startsWith("^") && e.source.endsWith("$") ? e.source.slice(1, -1).split("\\/").join("/") : "");
    if (e.text === undefined && !(findsOnly(e.source, f) && e.source === `^${f.split("/").join("\\/")}$`)) return null;
    const m = /^((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(f);
    const folder = m && NAME_OK.test(m[1]) && !m[2].split("/").some((s) => s === "" || s === "." || s === "..") ? workspaces.get(m[1]) : undefined;
    if (folder === undefined || !under(posix.normalize(e.to), folder) || held.some((h) => h.startsWith(f))) return null;
    const outside = [...b.slice(0, open), ...b.slice(close + 1)].join("\n");
    if (outside.includes(f) || outside.includes(`${m[1]}/\${`)) return null;
    return names(f) || names(`${m[1]}/\${`) ? null : f;
  };
  const took = new Set();
  let inserted = 0;
  let i = 0;
  for (const line of after.split("\n")) {
    if (i < b.length && b[i] === line) { i++; continue; }
    if (i <= open || i > close) return null;
    inserted++;
    if (/[\r\u2028\u2029]/.test(line)) return null;
    if (/^\s*\/\//.test(line) && !line.includes("*/")) continue;
    const e = aliasEntry(line);
    const name = e && (newPackage(e) ?? newEntry(e));
    if (!name) return null;
    took.add(name);
  }
  if (i !== b.length || !inserted) return null;
  return took.size ? `${count(took.size, "an alias", "aliases")} for ${[...took].sort().join(", ")}` : "comments in the alias table";
}

/**
 * What an admitted shard map change is, in words, or null. Admitted: both sides are the map's shape (`shards` a
 * list of lists of paths, `measuredAt` and every other key as they were, as many shards as there were), and each
 * shard, in order, is the base's list without the paths the diff deletes, entry for entry, once the paths it adds
 * are taken out of the head's. An entry that leaves with its file moves no other file; one that comes with a new
 * file places a file no run has measured. Every run checks the map against the tree (ci-shards.mjs --check).
 */
export function admittedShardMap(before, after, { deleted = new Set(), added = new Set() } = {}) {
  const b = json(before);
  const a = json(after);
  const shaped = (m) => isObject(m) && "measuredAt" in m && Array.isArray(m.shards) && m.shards.every((s) => Array.isArray(s) && s.every((f) => typeof f === "string"));
  if (!shaped(b) || !shaped(a) || b.shards.length !== a.shards.length) return null;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length || keys.some((k) => !(k in a) || (k !== "shards" && !same(b[k], a[k])))) return null;
  let gone = 0;
  let came = 0;
  for (const [i, was] of b.shards.entries()) {
    const kept = was.filter((f) => !deleted.has(f));
    const now = a.shards[i].filter((f) => !added.has(f));
    if (!same(kept, now)) return null;
    gone += was.length - kept.length;
    came += a.shards[i].length - now.length;
  }
  return `follows ${gone} deleted and ${came} added test file(s)`;
}

/**
 * What an admitted manifest change is, in words, or null. `before` is null for an added file. `links` are
 * the workspace names the lockfile links after the change; `depended` the names some workspace depended on
 * before it (null when unknown): `exports` made where there was none hides every other file of a package.
 */
export function admittedManifest(p, before, after, { newAreas = new Set(), newNames = new Map(), links = new Set(), depended = null } = {}) {
  const area = areaOf(p);
  const a = json(after);
  if (!isObject(a) || p !== (area ? `${area}/package.json` : "package.json")) return null;
  if (before === null) return newAreas.has(area) && newNames.get(a.name) === area ? `new with ${area}` : null;
  const b = json(before);
  if (!isObject(b)) return null;
  const subpaths = (x) => isObject(x) && Object.keys(x).every((k) => k.startsWith(".") && KEY_OK.test(k));
  const parts = { workspaces: [], depends: [], exports: [] };
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (same(b[k], a[k]) || (!area && k === "version")) continue;
    if (!area && k === "workspaces" && Array.isArray(b[k]) && Array.isArray(a[k])) {
      const gained = gainedEntries(b[k], a[k]);
      if (!gained || !gained.every((w) => newAreas.has(w))) return null;
      parts.workspaces.push(...gained);
    } else if (area && DEP_MAPS.includes(k)) {
      const gained = gainedKeys(b[k] ?? {}, a[k]);
      if (!gained || !gained.every((n) => links.has(n))) return null;
      parts.depends.push(...gained);
    } else if (area && k === "exports" && subpaths(a[k])) {
      // A new subpath can take a specifier a pattern served; exports made from nothing end every deep import.
      const made = b[k] === undefined && depended !== null && !depended.has(b.name);
      const gained = made ? Object.keys(a[k]) : subpaths(b[k]) && !Object.keys(b[k]).some((x) => x.includes("*")) ? gainedKeys(b[k], a[k]) : null;
      if (!gained) return null;
      parts.exports.push(...gained);
    } else return null;
  }
  const said = [
    parts.workspaces.length ? `${count(parts.workspaces.length, "a workspace", "workspaces")} ${parts.workspaces.join(", ")}` : "",
    parts.depends.length ? `depends on ${[...new Set(parts.depends)].join(", ")}` : "",
    parts.exports.length ? `exports ${parts.exports.join(", ")}` : "",
  ].filter(Boolean);
  return said.length ? said.join("; ") : null;
}

/**
 * What an admitted root lockfile change is, in words, or null. Admitted: the root gains new workspaces, each
 * with its own entry and its link, and a workspace's entry gains dependencies on linked workspaces. Every
 * entry under node_modules/ reads as before, and no other entry is new: a first install or a moved version
 * is whole.
 */
export function admittedLock(before, after, { newAreas = new Set(), newNames = new Map() } = {}) {
  const b = json(before);
  const a = json(after);
  if (!isObject(b) || !isObject(a) || !isObject(b.packages) || !isObject(a.packages)) return null;
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (k !== "packages" && k !== "version" && !same(b[k], a[k])) return null;
  const linked = (k) => k.startsWith("node_modules/") && isObject(a.packages[k]) && a.packages[k].link === true;
  const depends = new Map();
  for (const [k, was] of Object.entries(b.packages)) {
    const now = a.packages[k];
    if (k.includes("node_modules/") ? !same(was, now) : !isObject(was) || !isObject(now)) return null;
    if (k.includes("node_modules/")) continue;
    for (const f of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (same(was[f], now[f]) || f === "version") continue;
      if (k === "" && f === "workspaces" && Array.isArray(was[f]) && Array.isArray(now[f])) {
        const gained = gainedEntries(was[f], now[f]);
        if (!gained || !gained.every((w) => newAreas.has(w))) return null;
      } else if (k !== "" && DEP_MAPS.includes(f)) {
        const gained = gainedKeys(was[f] ?? {}, now[f]);
        if (!gained || !gained.every((n) => linked(`node_modules/${n}`))) return null;
        for (const n of gained) depends.set(n, [...(depends.get(n) ?? []), k]);
      } else return null;
    }
  }
  const areaName = new Map([...newNames].map(([name, area]) => [area, name]));
  const workspaces = [];
  let links = 0;
  for (const [k, now] of Object.entries(a.packages)) {
    if (k in b.packages) continue;
    const name = k.startsWith("node_modules/") ? k.slice("node_modules/".length) : null;
    if (name === null && isObject(now) && areaName.has(k) && now.name === areaName.get(k)) workspaces.push(k);
    else if (name !== null && newNames.has(name) && linked(k) && now.resolved === newNames.get(name) && Object.keys(now).length === 2) links++;
    else return null;
  }
  const said = [
    workspaces.length ? `${count(workspaces.length, "a workspace", "workspaces")} ${workspaces.join(", ")}${links === workspaces.length ? count(links, " and its link", " and their links") : ""}` : "",
    ...[...depends].map(([n, at]) => `a dependency on ${n} in ${at.length > 2 ? `${at.length} workspaces` : at.join(", ")}`),
  ].filter(Boolean);
  return said.length ? said.join("; ") : null;
}

/* One side of a pull request as the admission reads it: `read(path)` is its text or null, `exists(dir)`
   whether that side holds the folder, `names(text)` whether a file of it holds the text. */
/** The kinds of file the base's search reads, as git grep's pathspecs; the alias table's own file is left out. */
const SEARCHED = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.json", "*.css", "*.html", ":(exclude)vitest.config.ts"];
/** The base: the merge commit's first parent. A folder it cannot rule out is there; a text it cannot rule out is
 *  named (git grep exits 1, printing no line, when no file holds it; any other answer names it). */
const baseSide = (root) => ({
  read: (p) => { try { return git(root, ["show", `HEAD^1:${p}`]); } catch { return null; } },
  exists: (p) => { try { return git(root, ["ls-tree", "HEAD^1", "--", p]).trim() !== ""; } catch { return true; } },
  names: (text) => {
    try { git(root, ["grep", "-F", "-l", "-e", text, "HEAD^1", "--", ...SEARCHED]); return true; } catch (e) { return !(e?.status === 1 && !String(e?.stdout ?? "").trim()); }
  },
});
/** The head: the checkout, which is the merge commit's own tree and what every job loads. */
const headSide = (root) => ({ read: (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return null; } } });

/** For one diff: (path, trigger) → what its admitted change is, in words, or null. Each side is read once. */
function harnessAdmission(changes, base, head) {
  const once = (f) => {
    let v;
    let done = false;
    return () => {
      if (!done) { v = f(); done = true; }
      return v;
    };
  };
  const status = new Map(changes.map(({ s, p }) => [p, s.charAt(0)]));
  const lockBefore = once(() => json(base.read("package-lock.json"))?.packages);
  const lockAfter = once(() => json(head.read("package-lock.json"))?.packages);
  const newAreas = once(() => {
    const touched = new Set(changes.filter((c) => c.s.charAt(0) !== "A").map((c) => areaOf(c.p)));
    const added = new Set(changes.filter((c) => c.s.charAt(0) === "A").map((c) => areaOf(c.p)));
    return new Set([...added].filter((a) => a && !touched.has(a) && typeof base.exists === "function" && base.exists(a) === false));
  });
  const newNames = once(() => {
    const out = new Map();
    const twice = new Set();
    for (const area of isObject(lockBefore()) ? newAreas() : []) {
      const name = status.get(`${area}/package.json`) === "A" ? json(head.read(`${area}/package.json`))?.name : undefined;
      if (typeof name !== "string" || !NAME_OK.test(name) || `node_modules/${name}` in lockBefore()) continue;
      if (out.has(name)) twice.add(name);
      out.set(name, area);
    }
    for (const name of twice) out.delete(name);
    return out;
  });
  const links = once(() => new Set(Object.entries(isObject(lockAfter()) ? lockAfter() : {})
    .filter(([k, v]) => k.startsWith("node_modules/") && isObject(v) && v.link === true).map(([k]) => k.slice("node_modules/".length))));
  const depended = once(() => (isObject(lockBefore())
    ? new Set(Object.entries(lockBefore()).filter(([k, v]) => !k.includes("node_modules/") && isObject(v)).flatMap(([, v]) => DEP_MAPS.flatMap((m) => Object.keys(v[m] ?? {}))))
    : null));
  const rootReferences = once(() => (status.get("tsconfig.json") === "M"
    ? (tsconfigAdditions("tsconfig.json", base.read("tsconfig.json"), head.read("tsconfig.json"))?.references ?? []).map((r) => r.to)
    : []));
  /** The workspaces the base's lockfile links: name → folder. */
  const workspaces = once(() => new Map(Object.entries(isObject(lockBefore()) ? lockBefore() : {}).flatMap(([k, v]) => {
    const name = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k)?.[1];
    return name && isObject(v) && v.link === true && typeof v.resolved === "string" ? [[name, v.resolved]] : [];
  })));
  /** Whether the base names a text, each text searched once; a side that cannot answer says yes. */
  const searched = new Map();
  const names = (text) => {
    if (!searched.has(text)) {
      let named = true;
      try { named = typeof base.names !== "function" || base.names(text) !== false; } catch { named = true; }
      searched.set(text, named);
    }
    return searched.get(text);
  };
  const deleted = once(() => new Set(changes.filter((c) => c.s.charAt(0) === "D").map((c) => c.p)));
  const added = once(() => new Set(changes.filter((c) => c.s.charAt(0) === "A").map((c) => c.p)));
  return (p, what) => {
    const st = status.get(p);
    const before = st === "A" ? null : st === "M" ? base.read(p) : undefined;
    const after = head.read(p);
    if ((st !== "A" && typeof before !== "string") || typeof after !== "string") return null;
    if (what === VITEST_CONFIG) return admittedVitestAlias(before, after, { newNames: newNames(), workspaces: workspaces(), names });
    if (what === SHARD_MAP) return st === "M" ? admittedShardMap(before, after, { deleted: deleted(), added: added() }) : null;
    if (what === TSCONFIG) {
      // `tsc -b` reaches a new package's program through the root's references alone.
      if (st === "A" && p === `${areaOf(p)}/tsconfig.json` && !rootReferences().some((to) => to === areaOf(p) || to === p)) return null;
      return admittedTsconfig(p, before, after, { newAreas: newAreas() });
    }
    if (what !== DEPENDENCY) return null;
    return p === "package-lock.json"
      ? admittedLock(before, after, { newAreas: newAreas(), newNames: newNames() })
      : admittedManifest(p, before, after, { newAreas: newAreas(), newNames: newNames(), links: links(), depended: depended() });
  };
}

/**
 * The diff's whole-suite triggers, and the two narrower ones. With `direct` (a pull request into a direct
 * base; `base` and `head` are its two sides) the met triggers are walked in order: one on the judge's path,
 * an unreadable path or an odd change kind keeps them all, as they read for any other base; an admitted
 * harness change is `deferred` (the path, the trigger it met and what it added); any other trigger and every
 * deleted module is `capped` (the path and the trigger). Without a base nothing is admitted.
 */
export function pathTriggers(root, changes, { direct = false, base = null, head = null } = {}) {
  const sides = direct && base ? { base, head: head ?? headSide(root) } : null;
  const whole = [];
  const met = [];
  const trigger = (text, p = null, what = null) => {
    whole.push(text);
    met.push({ p, what });
  };
  let sqliteWhole = false;
  let dovecotAll = false;
  const closure = new Set(setupClosure(root));
  for (const { s, p } of changes) {
    if (!TREE_PATH_OK.test(p)) { trigger("a changed path outside [A-Za-z0-9@._/+-] and (group) segments"); continue; }
    const st = s.charAt(0);
    if (!["A", "M", "D"].includes(st)) { trigger(`${p}: change kind ${oneLine(s)}`); continue; }
    // vitest cannot relate a deleted module to what still imports it; a deleted test file has no importer.
    if (st === "D" && ((/^(apps|packages)\//.test(p) && !inTestDir(p)) || (MODULE.test(p) && !TEST_FILE.test(p)))) trigger(`${p}: ${DELETED}`, p, DELETED);
    if (MANIFEST.test(p)) {
      let bump = false;
      if (st === "M") {
        try {
          bump = sides ? versionOnly(sides.base.read(p), sides.head.read(p)) : versionOnly(git(root, ["show", `HEAD^1:${p}`]), git(root, ["show", `HEAD:${p}`]));
        } catch { bump = false; }
      }
      if (!bump) trigger(`${p}: ${DEPENDENCY}`, p, DEPENDENCY);
    }
    for (const [re, what] of TRIGGERS) if (re.test(p)) trigger(`${p}: ${what}`, p, what);
    if (closure.has(p)) trigger(`${p}: ${HARNESS}`, p, HARNESS);
    if (p === "test/vitest.sqlite.config.ts") sqliteWhole = true;
    if (p.startsWith("test/dovecot/")) dovecotAll = true;
  }
  if (!direct) return { whole, sqliteWhole, dovecotAll };
  // The judge is asked of every changed path, not only of a met one: the shard walker and the service reader are
  // the judge's by their path, whatever test/setup loads (here it loads both, and they meet its closure).
  const judge = judgeOf(closure);
  const seen = new Set(met.map((m) => m.p));
  for (const { p } of changes) if (TREE_PATH_OK.test(p) && !seen.has(p) && judge(p)) trigger(`${p}: ${HARNESS}`, p, HARNESS);
  const admit = sides ? harnessAdmission(changes, sides.base, sides.head) : () => null;
  const deferred = [];
  const capped = [];
  for (const { p, what } of met) {
    const shape = p === null || what === DELETED ? null : admit(p, what);
    if (p === null || judge(p, shape !== null)) return { whole, sqliteWhole, dovecotAll, deferred: [] };
    if (shape !== null) deferred.push({ p, what, shape });
    else capped.push({ p, what });
  }
  return { whole: [], sqliteWhole, dovecotAll, deferred, ...(capped.length ? { capped } : {}) };
}

/** What a capped plan names first: its first reason, and how many more. */
const capReason = (capped) => `${capped[0].p}: ${capped[0].what}${capped.length > 1 ? ` (and ${capped.length - 1} more)` : ""}`;

/**
 * The run's scope and why. `changes` overrides the diff (a test hook), `base` and `head` the two sides the
 * harness admission reads for a direct base: by default the merge commit's first parent and the checkout,
 * and no base at all beside an overridden diff, which then admits nothing.
 */
export function decideScope({ root = ROOT, ctx, changes = null, base = null, head = null }) {
  const ev = eventWhole(ctx);
  if (ev) return { scope: "whole", why: ev };
  const pr = ctx.event.pull_request;
  if (pr.base.ref === "next" && String(pr.head.ref).startsWith("pr/round-")) {
    return { scope: "build-only", why: "The round lands on the batch build. The whole suite runs after landing." };
  }
  let list = changes;
  if (!list) {
    try { list = readDiff(root, ctx); } catch { return { scope: "whole", why: "the diff cannot be read" }; }
  }
  const line = directBase(ctx);
  const t = pathTriggers(root, list, line === null ? {} : { direct: true, base: base ?? (changes ? null : baseSide(root)), head });
  if (t.whole.length) return { scope: "whole", why: t.whole.length > 1 ? `${t.whole[0]} (and ${t.whole.length - 1} more)` : t.whole[0] };
  const harness = t.deferred ?? [];
  const capped = t.capped ?? [];
  if (capped.length) {
    return {
      scope: "selected", why: `CAPPED into ${line}: ${capReason(capped)}`,
      changes: list, sqliteWhole: t.sqliteWhole, dovecotAll: t.dovecotAll, ...(harness.length ? { harness } : {}), capped,
    };
  }
  if (!harness.length) return { scope: "selected", why: `${list.length} changed path(s)`, changes: list, sqliteWhole: t.sqliteWhole, dovecotAll: t.dovecotAll };
  return {
    scope: "selected", why: `${list.length} changed path(s); ${harness.length} harness path(s) deferred to the whole run on ${line}`,
    changes: list, sqliteWhole: t.sqliteWhole, dovecotAll: t.dovecotAll, harness,
  };
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
  const exists = (p) => !!p && p !== "." && !p.startsWith("..") && TREE_PATH_OK.test(p) && (existsSync(join(root, p)) || deleted.some((d) => under(d, p)));
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
 * `code` strips comments, `relativeImports` follows helpers (service-needs.mjs). `includeRoot` reads the
 * files under root test/ as well (the direct set keeps the ones a change reaches).
 */
export function readersOf(root, files, { code, relativeImports, deleted = [], includeRoot = false }) {
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
    if (t.startsWith("test/") && !includeRoot) continue;
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

/** The test files that import a `deleted` path by a static relative import: vitest relates nothing to a file
 *  that is gone, so a rename's importers left behind are found here, by their own text. */
export function importersOfDeleted(root, files, deleted) {
  const gone = new Set(deleted);
  return files.filter((t) => [...stripComments(readFileSync(join(root, t), "utf8")).matchAll(STATIC_IMPORT)].some((m) => {
    const base = posix.normalize(posix.join(posix.dirname(t), m[1] ?? m[2])).replace(/\.(?:m?js|jsx)$/, "");
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`].some((c) => gone.has(c));
  }));
}

/* ── THE GRAPH ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * vitest's own related set for `related` (repo-relative), and the project's whole file set, without
 * running a test. forceRerunTriggers is emptied: by default a package.json in `related` selects all.
 * `entries` (sourceEntries) come back in `reached` when their import closure holds a `related` path;
 * `list: false` skips vitest's own related listing. With `roots`, `rootsRelated` is the test files the graph
 * relates to those paths alone, read on this same instance by the walk `reached` takes (each module once; a
 * second listing of vitest's own walks every test file's imports again, one file at a time: minutes on this
 * tree), or null when that reading fails.
 */
export async function vitestGraph(root, related, { config, overrides = {}, defaultTriggers = false, entries = [], list = true, roots = [] } = {}) {
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
    const all = [...new Set((await ctx.globTestSpecs()).map(rel))].sort();
    const hit = related.length && list ? (await ctx.listFiles()).map(rel) : [];
    const reached = related.length && entries.length ? await entriesReaching(ctx, root, entries, related) : [];
    const rootsRelated = roots.length ? await entriesReaching(ctx, root, all, roots).catch(() => null) : null;
    return { related: [...new Set(hit)].sort(), all, reached, ...(roots.length ? { rootsRelated } : {}) };
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
  // A direct plan's deferred lists: test files of this run, none of them handed on as well.
  for (const { file } of plan.deferred ?? []) {
    check(file, "deferred", fileSet);
    if (seen.has(file)) problems.push(`${file} is handed on and deferred`);
  }
  for (const f of plan.sqliteDeferred ?? []) {
    check(f, "sqlite deferred", sqliteSet);
    if (seenSqlite.has(f)) problems.push(`${f} is handed to the sqlite run and deferred`);
  }
  // A capped plan's leavings, the same way.
  for (const { file } of plan.left ?? []) {
    check(file, "left", fileSet);
    if (seen.has(file)) problems.push(`${file} is handed on and left`);
  }
  for (const f of plan.sqliteLeft ?? []) {
    check(f, "sqlite left", sqliteSet);
    if (seenSqlite.has(f)) problems.push(`${f} is handed to the sqlite run and left`);
  }
  return problems;
}

/* ── THE DIRECT SET ────────────────────────────────────────────────────────────────────────────── */

/** A changed path no workspace owns that the graph follows: a module or a list of the root (scripts/, test/support/,
 *  a root JSON), no test file. */
const rootModule = (p) => !areaOf(p) && MODULE.test(p) && !TEST_FILE.test(p);

/**
 * Whether a test file the import graph relates to a change is the change's own: it lives in an app or a
 * package the change touches (`related`: the changed paths, test files included) or under root test/, which
 * is every workspace's. A changed root module keeps the whole reach, unless `rootReach` names the test files the
 * graph relates to the root modules alone: then those join the border, and the other workspaces' do not.
 */
export function border(related, rootReach = null) {
  const areas = new Set(related.map(areaOf));
  const wide = related.some(rootModule);
  const rootSet = rootReach === null ? null : new Set(rootReach);
  return (f) => !areaOf(f) || areas.has(areaOf(f)) || (wide && (rootSet === null || rootSet.has(f)));
}

/**
 * A selection split in two. Direct: a changed test file, a reader the change reaches (`hits`, and
 * `rootHits` for the readers under root test/), a Dovecot file when its fixture changed (`dovecot`), and
 * a file the graph relates inside the border (`rootReach`: border's). Deferred, each with the rule that had
 * selected it: the rest, which is a test the graph reaches from another workspace or a root test the change
 * does not reach.
 */
export function directSet({ picked, rule, hits, rootHits, graphRelated, related, dovecot = new Set(), rootReach = null }) {
  const near = border(related, rootReach);
  const graph = new Set(graphRelated);
  const direct = [];
  const deferred = [];
  for (const f of picked) {
    if (rule.get(f) === "changed" || hits.has(f) || rootHits.has(f) || dovecot.has(f) || (graph.has(f) && near(f))) direct.push(f);
    else deferred.push({ file: f, rule: rule.get(f) });
  }
  return { direct, deferred };
}

/**
 * THE FLOOR of a pull request into a direct base, run whatever the diff and never cut: every root test file,
 * every reader that spawns git, every bundle reader, every census of the whole tree, and with a migration among
 * `changes` every test file of packages/db and packages/db-mail.
 */
function floorOf(files, readers, changes = []) {
  const out = new Set(files.filter((f) => f.startsWith("test/")));
  for (const [t, r] of readers) if (r.git || r.bundle || r.sweep) out.add(t);
  if (changes.some((c) => MIGRATION.test(c.p))) for (const f of files) if (JOURNALED.includes(areaOf(f))) out.add(f);
  return [...out].sort();
}

/** The base the job's merge commit was made on (its first parent), or "?". */
function baseOf(root) {
  try { return git(root, ["rev-parse", "--verify", "--quiet", "HEAD^1"]).trim() || "?"; } catch { return "?"; }
}

/* ── SELECT ────────────────────────────────────────────────────────────────────────────────────── */

const RULES = ["changed", "graph", "root", "named", "tree", "area", "always", "sweep", "dovecot"];

/**
 * The selected plan, or a whole one with its reason. `graph(root, related, {config})` returns vitest's
 * related set and the project's files; `costs` defaults to test/support/ci-costs.json; `base` and `head`
 * are decideScope's.
 */
export async function select({ root = ROOT, ctx, changes = null, graph = vitestGraph, costs = null, base = null, head = null } = {}) {
  const scope = decideScope({ root, ctx, changes, base, head });
  if (scope.scope !== "selected") return scope;
  const harness = scope.harness ?? [];
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
  // The direct set reads root test/ as well, in a map of its own: a root reader claims no path from the rest.
  const line = directBase(ctx);
  const everyReader = readersOf(root, files, { code: stripComments, relativeImports, deleted, includeRoot: line !== null });
  const underRoot = ([t]) => t.startsWith("test/");
  const readers = line === null ? everyReader : new Map([...everyReader].filter((e) => !underRoot(e)));
  // A deferred list file of the root (the root manifest, the lockfile, a root tsconfig, vitest.config.ts, a shard
  // map) is no module of behaviour: it does not widen the border as a changed root module does.
  const lists = new Set(harness.filter((h) => !areaOf(h.p)).map((h) => h.p));
  const near = related.filter((p) => !lists.has(p));
  // A changed root module beside a workspace's change widens the border only by the test files the graph relates to
  // the root modules alone, read on the same graph; root modules alone (nothing to keep apart), or that reading
  // failed, keep the whole reach. Into main the border is not read.
  const roots = line === null ? [] : near.filter(rootModule);
  const apart = roots.length > 0 && near.some((p) => !TEST_FILE.test(p) && !rootModule(p));
  const main = await graph(root, related, { config: "vitest.config.ts", entries: sourceEntries(everyReader), ...(apart ? { roots } : {}) });
  // A deferred vitest.config.ts is the config this plan was collected under: every test file the tree holds
  // must be in its collection (the desktop's config importers need the desktop's own install), or the run is
  // whole. A file that stops being collected would be green for ever.
  if (harness.some((h) => h.p === "vitest.config.ts")) {
    const collected = new Set(main.all ?? []);
    const elsewhere = new Set(cs.desktopFiles(root, files, { configOnly: true }));
    const lost = files.find((f) => !collected.has(f) && !elsewhere.has(f));
    if (lost !== undefined) return { scope: "whole", why: `the plan is refused: ${lost} is not collected under vitest.config.ts` };
  }
  for (const f of main.related) add(f, "graph");
  for (const f of files) if (f.startsWith("test/")) add(f, "root");
  const hits = readerHits(root, scope.changes, readers, main.reached ?? []);
  for (const [f, r] of hits) add(f, r);
  // A deleted module's static relative importers: named, and never cut.
  for (const t of importersOfDeleted(root, files, deleted)) { add(t, "named"); hits.set(t, "named"); }
  const pinned = scope.dovecotAll ? files.filter((f) => cs.dovecotPinned(root, f)) : [];
  for (const f of pinned) add(f, "dovecot");

  // Reach: everything a rule selected. Direct: what the change can break in its own workspaces and what
  // names it; the rest is deferred to the whole run on the base, and named.
  const reach = [...rule.keys()].sort();
  const rootHits = line === null ? null : readerHits(root, scope.changes, new Map([...everyReader].filter(underRoot)), main.reached ?? []);
  const rootReach = apart && Array.isArray(main.rootsRelated) ? main.rootsRelated : null;
  const cut = line === null ? null : directSet({ picked: reach, rule, hits, graphRelated: main.related, related: near, dovecot: new Set(pinned), rootHits, rootReach });
  const suiteMs = (f) => c.suite?.[f] ?? UNMEASURED_MS;
  const sqliteMs = (f) => c.sqlite?.[f] ?? UNMEASURED_MS;
  const sum = (xs, ms) => xs.reduce((s, f) => s + ms(f), 0);
  const inMain = (f) => !alone.has(f) && !desktop.has(f);

  // THE CAP, into a direct base. The floor and the never-cut files of the direct set (a changed test, a reader
  // the change reaches, a Dovecot file for its fixture) run whatever they cost; the rest of the direct set fills
  // CAP_S of measured main-suite time, Postgres files first, then the cheapest, then by path, and at the first
  // file that does not fit the fill stops: it and every file after it are left. Its alone files run only when
  // nothing is cut; its desktop files run in the desktop job, as on every run.
  const floorSet = new Set(cut ? floorOf(files, everyReader, scope.changes) : []);
  const pinnedSet = new Set(pinned);
  const never = new Set(cut ? [...floorSet, ...cut.direct.filter((f) => rule.get(f) === "changed" || hits.has(f) || rootHits.has(f) || pinnedSet.has(f))] : []);
  const rest = cut ? cut.direct.filter((f) => !never.has(f)) : [];
  const pg = (f) => (posix.basename(f).includes(".pg.test.") ? 0 : 1);
  const order = rest.filter(inMain).sort((a, b) => pg(a) - pg(b) || suiteMs(a) - suiteMs(b) || (a < b ? -1 : 1));
  const neverMs = sum([...never].filter(inMain), suiteMs);
  const filled = [];
  const mainLeft = [];
  let spent = neverMs;
  for (const f of order) {
    if (!mainLeft.length && spent + suiteMs(f) <= CAP_S * 1000) {
      filled.push(f);
      spent += suiteMs(f);
    } else mainLeft.push(f);
  }
  const kept = cut ? [...never, ...filled, ...rest.filter((f) => desktop.has(f))].sort() : reach;
  const mainPicked = kept.filter(inMain);
  const wholeMs = sum(files.filter(inMain), suiteMs);
  const share = wholeMs ? sum(mainPicked, suiteMs) / wholeMs : 1;
  // main keeps WHOLE_SHARE; into a direct base the cap replaces it.
  if (!cut && share >= WHOLE_SHARE) return { scope: "whole", why: `the selection costs ${Math.round(share * 100)}% of the whole suite` };

  let sqliteFiles = null;
  let sqliteAll = null;
  let sqliteDeferred = [];
  const sqliteLeft = [];
  let sqliteSetMs = 0;
  if (!scope.sqliteWhole) {
    const sq = await graph(root, related, { config: "test/vitest.sqlite.config.ts" });
    sqliteAll = sq.all;
    const inProject = new Set(sq.all);
    const ofProject = (graphed, selected) => [...new Set([...graphed, ...selected.filter((f) => inProject.has(f))])].filter((f) => inProject.has(f)).sort();
    // The same border on the second store's graph, a changed root module keeping its whole reach: the store's run is
    // held to one job, whatever it holds.
    sqliteFiles = ofProject(cut ? sq.related.filter(border(near)) : sq.related, kept);
    if (cut) {
      // Held to SQLITE_CAP_S: the never-cut files stay, the others fill it, the cheapest first, then by path.
      const list = sqliteFiles;
      let held = sum(list.filter((f) => never.has(f)), sqliteMs);
      sqliteSetMs = sum(list, sqliteMs);
      for (const f of list.filter((x) => !never.has(x)).sort((a, b) => sqliteMs(a) - sqliteMs(b) || (a < b ? -1 : 1))) {
        if (!sqliteLeft.length && held + sqliteMs(f) <= SQLITE_CAP_S * 1000) held += sqliteMs(f);
        else sqliteLeft.push(f);
      }
      sqliteLeft.sort();
      sqliteFiles = list.filter((f) => !sqliteLeft.includes(f));
      sqliteDeferred = ofProject(sq.related, reach).filter((f) => !list.includes(f));
    }
  }
  // CAPPED when a reason was met or the fill left a file (the main fill's or the second store's); else FAST, as
  // before, with the floor in it. The direct set's alone files run in a FAST plan, and are left by name only in a
  // capped one: FAST means nothing was cut, which the landing's label rests on, and this never runs fewer files.
  const reasons = scope.capped ?? [];
  const capped = !!cut && (reasons.length > 0 || mainLeft.length > 0 || sqliteLeft.length > 0);
  const restAlone = rest.filter((f) => alone.has(f));
  const picked = cut && !capped ? [...kept, ...restAlone].sort() : kept;
  const alonePicked = picked.filter((f) => alone.has(f));
  const left = capped ? [...mainLeft, ...restAlone].sort().map((file) => ({ file, rule: "cap" })) : [];
  const reason = !capped ? null : reasons.length ? capReason(reasons) : mainLeft.length
    ? `the direct set costs ${Math.round((neverMs + sum(order, suiteMs)) / 1000)} s, over the cap of ${CAP_S} s`
    : `the second store's set costs ${Math.round(sqliteSetMs / 1000)} s, over the cap of ${SQLITE_CAP_S} s`;
  const shards = packFiles(mainPicked, suiteMs, MAX_SHARDS, (f) => (cs.dovecotPinned(root, f) ? "dovecot" : null))
    .map((fs, shard) => ({ shard, files: fs.join("\n"), dovecot: fs.some((f) => cs.dovecotPinned(root, f)) ? "yes" : "no" }));
  const sqlite = sqliteFiles === null ? null : packFiles(sqliteFiles, sqliteMs, MAX_SQLITE).map((fs, shard) => ({ shard, files: fs.join("\n") }));
  // The desktop job runs its files on every run, and the floor runs here: none of them waits for the whole one.
  const deferred = cut ? cut.deferred.filter((d) => !desktop.has(d.file) && !floorSet.has(d.file)) : [];
  const plan = {
    scope: "selected", why: reason === null ? scope.why : `CAPPED into ${line}: ${reason}`, shards, alone: alonePicked, sqlite,
    ...(cut ? { mode: capped ? "capped" : "direct", deferred, sqliteDeferred } : {}),
    ...(capped ? { capped: reasons, left, sqliteLeft } : {}),
    ...(harness.length ? { harness } : {}),
  };
  const problems = planProblems(plan, { files, alone, desktop, sqliteAll: sqliteAll ?? [] });
  if (problems.length) return { scope: "whole", why: `the plan is refused: ${problems[0]}` };
  const counts = Object.fromEntries(RULES.map((r) => [r, picked.filter((f) => rule.get(f) === r).length]));
  const handed = new Set([...mainPicked, ...alonePicked]);
  const ran = (xs) => xs.filter((f) => handed.has(f)).length;
  return {
    ...plan,
    summary: {
      changed: scope.changes.length, rules: counts, main: mainPicked.length, alone: alonePicked.length,
      sqlite: sqliteFiles === null ? "whole" : sqliteFiles.length, share: Math.round(share * 1000) / 10,
      costsMeasuredAt: c.measuredAt ?? "none",
      ...(cut ? {
        base: line, deferred: deferred.length, deferredS: Math.round(sum(deferred.map((d) => d.file), suiteMs) / 1000),
        baseSha: baseOf(root), floor: ran([...floorSet]), neverCut: ran([...never].filter((f) => !floorSet.has(f))), filled: filled.length,
        measuredS: Math.round(sum(mainPicked, suiteMs) / 1000),
        // The floor and the never-cut files alone may pass the cap: the plan says by how much.
        ...(neverMs > CAP_S * 1000 ? { overCapS: Math.round((neverMs - CAP_S * 1000) / 1000) } : {}),
        ...(capped ? { left: left.length, leftS: Math.round(sum(left.map((d) => d.file), suiteMs) / 1000), reason } : {}),
      } : {}),
      ...(harness.length ? { harness: harness.map((h) => h.p) } : {}),
    },
  };
}

/* ── OUTPUTS ───────────────────────────────────────────────────────────────────────────────────── */

/** The plan job's outputs: build-only, a sound selected plan, or the whole run. */
export function composeOutputs({ indexes, sqliteIndexes, alone, scope = "", scopeWhy = "", selectOutcome = "", plan = null }) {
  const whole = (why) => ({
    scope: "whole", why,
    // This shard has repeatedly lost its runner mid-test. Give each half a fresh job and services.
    shards: indexes.flatMap((shard) => shard === 12
      ? ["a", "b"].map((part) => ({ shard: `${shard}${part}`, baseShard: shard, part }))
      : [{ shard }]),
    alone, sqlite: sqliteIndexes.map((shard) => ({ shard })), summary: null,
  });
  if (scope === "build-only") return { scope, why: scopeWhy, shards: [], alone: [], sqlite: [], summary: null };
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
    // The summary says a capped run is no whole one.
    ...(plan.mode === "capped" ? { mode: "capped" } : {}),
  };
}

/** A capped run's counts, as its log's first line and its summary say them. */
const cappedCounts = (s, jobs, alone) => `runs ${s.main + alone} file(s) (${s.measuredS} s measured; floor ${s.floor}, never cut ${s.neverCut}, filled ${s.filled}) `
  + `in ${jobs} suite job(s) + ${alone} alone, leaves ${s.left} of its direct set (${s.leftS} s) and defers ${s.deferred} more (${s.deferredS} s) to the whole run on ${oneLine(s.base)}`;

export function summaryText(out) {
  const capped = out.scope === "selected" && out.mode === "capped";
  const lines = [`### suite plan: ${out.scope}${capped ? " (CAPPED, not a whole run)" : ""}`, "", oneLine(out.why), ""];
  if (out.scope === "selected") {
    const s = out.summary ?? {};
    lines.push(capped
      ? `capped run: ${cappedCounts(s, out.shards.length, out.alone.length)}; the plan job's log lists them.`
      : s.deferred === undefined
        ? "partial run: the whole suite runs on the batch and nightly."
        : `fast run: ${s.deferred} more file(s) (${s.deferredS} s measured) run in the whole suite on ${oneLine(s.base)} after landing; the plan job's log lists them.`, "");
    if (s.overCapS) lines.push(`- the floor and the never-cut files alone pass the cap of ${CAP_S} s by ${s.overCapS} s`);
    lines.push(`- ${out.shards.length} suite job(s), ${out.alone.length} alone file(s), ${out.sqlite.length} sqlite job(s)`);
    if (s.rules) lines.push(`- files by rule: ${Object.entries(s.rules).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (s.share !== undefined) lines.push(`- ${s.main} main file(s), ${s.share}% of the whole suite's measured time (costs ${oneLine(s.costsMeasuredAt)})`);
    if (s.sqlite === "whole") lines.push("- the SQLite run is whole");
    if (s.harness?.length) lines.push(`- harness deferred to the whole run on ${oneLine(s.base)}: ${s.harness.map(oneLine).join(", ")}`);
  } else {
    lines.push(`- ${out.shards.length} suite shards, ${out.alone.length} alone file(s), ${out.sqlite.length} sqlite shards`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What a plan into a direct base says in the plan job's log, so a red in the whole run can be traced to a
 * deferral or a leaving: one first line, FAST when nothing was cut and CAPPED when something was (never
 * both), with the pull request, its head, the base it was merged onto and, when capped, the reason; then a
 * capped plan's reasons and what the cap left, each deferred file under the rule that had selected it, the
 * second store's lists, and each deferred harness path with the trigger it met and what it added. Any other
 * plan says nothing.
 */
export function deferredLog(plan, ctx = {}) {
  if (plan?.scope !== "selected" || (plan.mode !== "direct" && plan.mode !== "capped")) return "";
  const pr = ctx.event?.pull_request ?? {};
  const s = plan.summary;
  const base = oneLine(s.base);
  const capped = plan.mode === "capped";
  const word = capped ? "CAPPED" : "FAST";
  const group = (title, rows) => [`::group::${title} (${rows.length})`, ...rows, "::endgroup::"];
  const lead = `${word} ${base}: pr #${oneLine(pr.number ?? "?")} head ${oneLine(pr.head?.sha ?? "?")} on ${oneLine(s.baseSha ?? "?")}`;
  const lines = capped
    ? [
      `${lead}: ${oneLine(s.reason)}: ${cappedCounts(s, plan.shards.length, plan.alone.length)}`,
      ...group("capped: the reasons", plan.capped.map((c) => `${oneLine(c.what)}\t${oneLine(c.p)}`)),
      ...group("left by the cap", plan.left.map((d) => `${d.rule}\t${d.file}`)),
    ]
    : [`${lead}: runs ${s.main + plan.alone.length} file(s) (floor ${s.floor}) in ${plan.shards.length} suite job(s) + ${plan.alone.length} alone, `
      + `defers ${plan.deferred.length} file(s) (${s.deferredS} s measured) to the whole run on ${base}`];
  lines.push(...group(`deferred to the whole run on ${base}`, plan.deferred.map((d) => `${d.rule}\t${d.file}`)));
  if (plan.sqlite !== null) {
    lines.push(capped
      ? `${word} ${base} sqlite: runs ${s.sqlite} file(s) in ${plan.sqlite.length} job(s), leaves ${plan.sqliteLeft.length} file(s) by the cap and defers ${plan.sqliteDeferred.length} file(s) to the whole run on ${base}`
      : `${word} ${base} sqlite: runs ${s.sqlite} file(s) in ${plan.sqlite.length} job(s), defers ${plan.sqliteDeferred.length} file(s) to the whole run on ${base}`);
    if (capped) lines.push(...group("left by the cap, sqlite", plan.sqliteLeft));
    lines.push(...group(`deferred to the whole run on ${base}, sqlite`, plan.sqliteDeferred));
  }
  if (plan.harness?.length) {
    const rows = plan.harness.map((h) => ({ p: oneLine(h.p), what: oneLine(h.what), shape: oneLine(h.shape) }));
    lines.push(
      `${word} ${base} harness: ${rows.length} path(s) deferred to the whole run on ${base}: ${rows.map((h) => `${h.p} (${h.shape})`).join(", ")}`,
      ...group(`harness deferred to the whole run on ${base}`, rows.map((h) => `${h.what}\t${h.p}\t${h.shape}`)),
    );
  }
  return `${lines.join("\n")}\n`;
}

/* ── CLI ───────────────────────────────────────────────────────────────────────────────────────── */

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Writes to stdout and waits until the write is taken: exiting earlier cuts a pipe's text at 8 KiB. */
const say = (text) => new Promise((done) => (text ? process.stdout.write(text, () => done()) : done()));

async function main(argv) {
  const [verb, ...rest] = argv;
  const root = resolve(flag(rest, "--root") ?? ROOT);
  const ctx = () => (flag(rest, "--event") !== undefined ? JSON.parse(flag(rest, "--event")) : ciContext());
  const filesAt = flag(rest, "--files");
  const changes = () => (filesAt !== undefined ? parseNameStatus(readFileSync(filesAt, "utf8")) : null);
  if (verb === "scope") {
    let s;
    try { s = decideScope({ root, ctx: ctx(), changes: changes() }); } catch (e) { s = { scope: "whole", why: `the scope step failed: ${e.message}` }; }
    await say(`scope=${s.scope}\nwhy=${oneLine(s.why)}\n`);
    return 0;
  }
  if (verb === "select") {
    const out = flag(rest, "--out");
    if (!out) throw new Error("select takes --out <file>");
    const event = ctx();
    const plan = await select({ root, ctx: event, changes: changes() });
    writeFileSync(out, `${JSON.stringify(plan)}\n`);
    await say(`SELECT ${plan.scope}: ${oneLine(plan.why)}${plan.scope === "selected" ? `; ${plan.shards.length} suite job(s), ${plan.alone.length} alone, ${plan.sqlite === null ? "whole" : plan.sqlite.length} sqlite` : ""}\n`);
    await say(deferredLog(plan, event));
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
    await say([
      `scope=${out.scope}`, `why=${oneLine(out.why)}`,
      `shards=${JSON.stringify(out.shards)}`, `alone=${JSON.stringify(out.alone)}`, `sqlite=${JSON.stringify(out.sqlite)}`,
    ].join("\n") + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText(out));
    return 0;
  }
  if (verb === "floor") {
    // From the readers alone: Node's own modules and the two support modules, never vitest.
    const cs = await import(new URL("../../test/support/ci-shards.mjs", import.meta.url).href);
    const { relativeImports } = await import(new URL("../../test/support/service-needs.mjs", import.meta.url).href);
    const files = cs.testFiles(root);
    const readers = readersOf(root, files, { code: stripComments, relativeImports, includeRoot: true });
    // A local run has no bundles built and no database made from empty: the pull request's own run has both.
    const local = rest.includes("--local");
    const alone = new Set(local ? cs.aloneFiles(root, files) : []);
    const floor = floorOf(files, readers).filter((f) => !local || (!alone.has(f) && !readers.get(f)?.bundle));
    await say(floor.map((f) => `${f}\n`).join(""));
    return 0;
  }
  process.stderr.write("ci-select: scope | select --out <file> | outputs --indexes <json> --sqlite-indexes <json> --alone <json> [--scope s --scope-why w --select-outcome o --plan <file>] | floor [--local]  [--root dir] [--event json] [--files name-status]\n");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc), (err) => {
    process.stderr.write(`ci-select: ${err.message}\n`);
    process.exit(1);
  });
}
