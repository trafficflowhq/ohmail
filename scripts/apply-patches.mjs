#!/usr/bin/env node
/**
 * apply-patches.mjs — carry `patches/` into a tree installed with `npm ci`, and prove an artefact carries it.
 *
 *   node scripts/apply-patches.mjs apply                         patch every installed copy, or refuse
 *   node scripts/apply-patches.mjs markers [--json]              the literals each patch adds
 *   node scripts/apply-patches.mjs assert --in <path> --require <name>   refuse an artefact without them
 *
 * pnpm applies these files itself in the development workspace; an npm install gets them only here.
 * No dependencies: it runs straight after the install, before anything in the tree is built.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* An upstream literal each package's code keeps whether or not our patch reached it. Absent means the
 * bytes read do not hold the package at all, which is a different answer from "unpatched". */
const CONTROLS = {
  nodemailer: "Connection closed unexpectedly",
  "react-native-tcp-socket": "Attempted to write to closed socket",
};
const MIN_MARKER = 20;

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { verb: argv[0], root: null, ins: [], requires: [], json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) refuse(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") out.root = value();
    else if (a === "--in") out.ins.push(value());
    else if (a === "--require") out.requires.push(value());
    else if (a === "--json") out.json = true;
    else refuse(`unknown argument ${a}`);
  }
  return out;
}

/* pnpm's file names: `name@version.patch` or `name.patch`, a scope written `@scope__name`. */
function keyOf(file) {
  const base = file.slice(0, -".patch".length);
  const at = base.indexOf("@", 1);
  const name = (at === -1 ? base : base.slice(0, at)).replace("__", "/");
  const version = at === -1 ? null : base.slice(at + 1);
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(name)) refuse(`patches/${file}: "${name}" is not a package name`);
  if (version !== null && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    refuse(`patches/${file}: "${version}" is not an exact version, and a range cannot be compared`);
  }
  return { name, version };
}

function patchList(root) {
  const dir = join(root, "patches");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".patch")).sort() : [];
  if (files.length === 0) refuse(`no patches to apply: ${dir} holds no .patch file`);
  return files.map((file) => {
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    const paths = [...text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]);
    if (paths.length === 0) refuse(`patches/${file} changes no file (no "diff --git" header)`);
    return { file, text, paths, ...keyOf(file) };
  });
}

/* The string literals on one line of code, outside comments; `state.block` carries a block comment. */
function literalsIn(code, state) {
  const found = [];
  let i = 0;
  if (!state.block && /^\s*\*/.test(code)) {
    const end = code.indexOf("*/");
    if (end === -1) return found;
    i = end + 2;
  }
  while (i < code.length) {
    if (state.block) {
      const end = code.indexOf("*/", i);
      if (end === -1) return found;
      state.block = false;
      i = end + 2;
      continue;
    }
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") break;
    if (c === "/" && code[i + 1] === "*") { state.block = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      if (j >= code.length) break;
      if (c !== "`") found.push(code.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return found;
}

/* What the patch ADDS that the build must carry: literals on `+` lines, long enough to be unique, plain
 * ASCII with no escape (so source and compiled bytes agree), and on no context or removed line. */
function markersOf(patch) {
  const added = [];
  const kept = new Set();
  let state = { block: false };
  for (const line of patch.text.split("\n")) {
    if (line.startsWith("diff --git ")) { state = { block: false }; continue; }
    if (/^(index |--- |\+\+\+ |@@ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    const kind = line[0];
    if (kind !== "+" && kind !== "-" && kind !== " ") continue;
    for (const lit of literalsIn(line.slice(1), state)) {
      if (kind === "+") added.push(lit);
      else kept.add(lit);
    }
  }
  const out = [];
  for (const lit of added) {
    if (lit.length < MIN_MARKER || !/^[\x20-\x7e]+$/.test(lit) || lit.includes("\\")) continue;
    if (kept.has(lit) || out.includes(lit)) continue;
    out.push(lit);
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const isDir = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/* The root's node_modules and each workspace's own (npm nests a copy there on a conflict). */
function nodeModulesDirs(root) {
  const dirs = [join(root, "node_modules")];
  const manifest = readJson(join(root, "package.json")) ?? {};
  const ws = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
  for (const w of ws) {
    if (w.endsWith("/*") && !w.slice(0, -2).includes("*")) {
      const parent = join(root, w.slice(0, -2));
      if (isDir(parent)) for (const e of readdirSync(parent)) dirs.push(join(parent, e, "node_modules"));
    } else if (w.includes("*")) {
      refuse(`workspace pattern "${w}" is not one this applier expands (a literal path or "dir/*")`);
    } else {
      dirs.push(join(root, w, "node_modules"));
    }
  }
  return dirs.filter(isDir);
}

/* Every installed copy of `name`: packages nest under packages, and a symlink is a workspace link. */
function copiesOf(nodeModules, name, out = []) {
  for (const e of readdirSync(nodeModules, { withFileTypes: true })) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue;
    const p = join(nodeModules, e.name);
    const pkgs = e.name.startsWith("@")
      ? readdirSync(p, { withFileTypes: true }).filter((s) => s.isDirectory()).map((s) => [`${e.name}/${s.name}`, join(p, s.name)])
      : [[e.name, p]];
    for (const [key, dir] of pkgs) {
      if (key === name && readJson(join(dir, "package.json"))?.name === name) out.push(dir);
      if (isDir(join(dir, "node_modules"))) copiesOf(join(dir, "node_modules"), name, out);
    }
  }
  return out;
}

/* git sees no repository around the copy: inside one, `git apply` from a subdirectory prints
 * "Skipped patch" and exits 0 having changed nothing. The applied-file count is checked besides.
 * `core.autocrlf=false`: a Windows runner's global setting would otherwise rewrite line endings. */
function git(args, cwd, input) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) delete env[k];
  return spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, input, encoding: "utf8", env });
}

function gitErrors(r) {
  const lines = `${r.stderr ?? ""}`.split("\n").filter((l) => l.startsWith("error:"));
  return lines.length ? lines.join("\n    ") : `git exited ${r.status}${r.error ? ` (${r.error.message})` : ""}`;
}

function apply(root) {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) refuse(`TOOL_MISSING git: \`git --version\` did not answer (${probe.error?.code ?? `rc ${probe.status}`}); the patches are applied with git apply`);
  console.log(probe.stdout.trim());
  if (existsSync(join(root, "node_modules", ".pnpm")) || existsSync(join(root, "node_modules", ".modules.yaml"))) {
    refuse(`${root} was installed by pnpm, which applies these patches itself; this applier is for an npm tree`);
  }
  const patches = patchList(root);
  const nms = nodeModulesDirs(root);
  if (nms.length === 0) refuse(`${join(root, "node_modules")} does not exist: install the tree first`);
  let applied = 0;
  let upstream = 0;
  for (const p of patches) {
    const all = nms.flatMap((nm) => copiesOf(nm, p.name)).map((dir) => ({ dir, version: readJson(join(dir, "package.json"))?.version }));
    const rel = (dir) => relative(root, dir) || ".";
    const listed = (cs) => cs.map((c) => `${rel(c.dir)} is ${c.version}`).join("; ");
    if (all.length === 0) refuse(`patch ${p.file}: no copy of ${p.name} is installed in this tree`);
    const match = p.version === null ? all : all.filter((c) => c.version === p.version);
    if (match.length === 0) {
      refuse(`patch ${p.name}@${p.version} names a version the tree does not hold: ${listed(all)} — re-derive with pnpm patch / patch-commit or drop the patch and its markers`);
    }
    const everyFile = (r) => (r.stderr.match(/^Checking patch .+\.\.\.$/gm) ?? []).length === p.paths.length;
    for (const c of match) {
      const check = git(["apply", "--check", "--verbose", "--whitespace=nowarn", "-"], c.dir, p.text);
      if (check.status === 0 && !everyFile(check)) refuse(`patch ${p.file}: git checked fewer files than the patch changes in ${rel(c.dir)}:\n${check.stderr}`);
      if (check.status !== 0) {
        /* A copy whose every hunk already reads as the patch's result carries the change: a newer
         * upstream release that took the same fix. git proves it by applying the patch in reverse. */
        const carried = git(["apply", "--check", "--reverse", "--verbose", "--whitespace=nowarn", "-"], c.dir, p.text);
        if (carried.status === 0 && everyFile(carried)) { c.carried = true; continue; }
        refuse(`patch ${p.file} does not apply to ${rel(c.dir)} (${c.version}), and that copy does not already carry it:\n    ${gitErrors(check)}`);
      }
      const run = git(["apply", "--verbose", "--whitespace=nowarn", "-"], c.dir, p.text);
      const done = (run.stderr.match(/^Applied patch .+ cleanly\.$/gm) ?? []).length;
      if (run.status !== 0) refuse(`patch ${p.file} failed on ${rel(c.dir)}:\n    ${gitErrors(run)}`);
      if (done !== p.paths.length) {
        refuse(`patch ${p.file}: git applied ${done} of ${p.paths.length} file(s) in ${rel(c.dir)}:\n${run.stderr}`);
      }
    }
    const others = all.filter((c) => !match.includes(c));
    const carried = match.filter((c) => c.carried);
    console.log(`PATCH ${p.file} copies=${match.length} (${match.map((c) => rel(c.dir)).join(", ")})`
      + (carried.length ? `; already carried by ${listed(carried)}` : "")
      + (others.length ? `; other versions, not this patch's: ${listed(others)}` : ""));
    applied += 1;
    if (carried.length === match.length) upstream += 1;
  }
  console.log(`PATCHES_APPLIED ${applied}/${patches.length}${upstream ? ` (${upstream} already carried by the installed copy)` : ""}`);
  if (applied !== patches.length) refuse(`applied ${applied} of ${patches.length} patches`);
}

function markers(root, json) {
  const patches = patchList(root);
  if (json) {
    const table = Object.fromEntries(patches.map((p) => [p.file, { name: p.name, version: p.version, paths: p.paths, control: CONTROLS[p.name] ?? null, markers: markersOf(p) }]));
    process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
    return;
  }
  for (const p of patches) {
    const ms = markersOf(p);
    console.log(`MARKERS ${p.file} n=${ms.length}${ms.length ? "" : ` (adds no literal; changes ${p.paths.join(", ")})`}`);
    for (const m of ms) console.log(`  ${JSON.stringify(m)}`);
  }
}

function readAll(ins) {
  const bufs = [];
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else if (st.isFile()) bufs.push(readFileSync(p));
  };
  for (const p of ins) {
    if (!existsSync(p)) refuse(`--in ${p} does not exist`);
    walk(p);
  }
  if (bufs.reduce((n, b) => n + b.length, 0) === 0) refuse(`--in ${ins.join(" ")} holds no bytes to read`);
  return bufs;
}

function assertIn(root, ins, requires) {
  if (ins.length === 0) refuse("assert needs --in <file or directory>");
  if (requires.length === 0) refuse("assert needs --require <name>: an unrequired package that is absent would read as a pass");
  const patches = patchList(root);
  for (const r of requires) {
    const named = patches.filter((p) => p.name === r);
    if (named.length !== 1) refuse(`--require ${r}: ${named.length ? "more than one patch names it" : "no patch names it"} (patches: ${patches.map((p) => p.file).join(", ")})`);
  }
  const bufs = readAll(ins);
  const has = (s) => {
    const needle = Buffer.from(s, "utf8");
    return bufs.some((b) => b.indexOf(needle) !== -1);
  };
  const failed = [];
  for (const p of patches) {
    const required = requires.includes(p.name);
    const ms = markersOf(p);
    const control = CONTROLS[p.name];
    if (ms.length === 0 || !control) {
      if (required) failed.push(`${p.name}: ${ms.length ? "no control literal is recorded for it" : "its patch adds no literal to look for"}`);
      continue;
    }
    if (!has(control)) {
      console.log(`NOT PRESENT ${p.name} (control ${JSON.stringify(control)} absent)`);
      if (required) failed.push(`NOT PRESENT ${p.name}: the bytes read do not hold the package, so they say nothing about its patch`);
      continue;
    }
    const missing = ms.filter((m) => !has(m));
    console.log(`PATCH_MARKERS ${p.name} present=${ms.length - missing.length}/${ms.length}`);
    if (missing.length) failed.push(`UNPATCHED ${p.name}: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
  }
  if (failed.length) refuse(failed.join("\n  "));
  console.log(`PATCH_ASSERT ok: ${requires.join(", ")} in ${ins.join(" ")}`);
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
if (args.verb === "apply") apply(root);
else if (args.verb === "markers") markers(root, args.json);
else if (args.verb === "assert") assertIn(root, args.ins, args.requires);
else {
  process.stderr.write("usage: node scripts/apply-patches.mjs apply | markers [--json] | assert --in <path> --require <name> [--root <dir>]\n");
  process.exit(2);
}
