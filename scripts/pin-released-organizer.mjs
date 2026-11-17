#!/usr/bin/env node
/**
 * THE RELEASED ORGANIZER AS A TEST FIXTURE: apps/worker/test/fixtures/released/<release>/organizer-profile.mjs,
 * bundled from a release commit's objects, and its pins in released.lock.json beside it.
 *
 *   node scripts/pin-released-organizer.mjs --write --release <x.y.z> --tag <commit-ish>
 *   node scripts/pin-released-organizer.mjs --check --release <x.y.z> --tag <commit-ish>
 *
 * A released organizer rewrites the settings copy a newer one left in the mailbox, and a test has to run that
 * exact code beside this tree's. The fixture is the released `apps/worker/src/profile.ts` with everything of
 * this repository it imports, behind the small entry below, as one module. Every file is read from the
 * commit's objects, never from the checkout and never from a network, so an edit in the working tree changes
 * nothing. What the released code imports from outside this repository stays an import: the test that loads
 * the fixture runs it on the installed versions, and test/pin-released-organizer.test.ts holds those equal
 * to the versions the release was locked to.
 *
 * The lock holds the commit, the entry's hash, each input's blob, each outside package the bundle imports with
 * its version in the commit's lockfile, and the bundle's size and sha256. `--write` writes the bundle and its lock entry.
 * `--check` writes nothing and compares both with what the commit gives: `~` names what differs. Both print
 * `PIN <release> <commit> inputs=N bytes=N sha256=…` first. A bundle is the bytes of one bundler version; the
 * lock names it, and a check on another version says so instead of comparing bytes.
 * Exit 0 written or equal, 1 differs, 2 usage, git or the bundler. `--root <dir>` reads and writes another
 * checkout (the tests plant one).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEsbuild } from "./engine-bundle.mjs";

/* Beside the worker's tests: the fixture is the worker's own released code, and it imports what that package declares. */
export const LOCK_PATH = "apps/worker/test/fixtures/released/released.lock.json";
export const fixturePath = (release) => `apps/worker/test/fixtures/released/${release}/organizer-profile.mjs`;

/**
 * THE ENTRY: what the test that walks a released organizer takes from the release. The organizer's own
 * class, the mail side it writes through, the answer a person gives to found settings, and the tables a
 * store at that release is planted through. Narrow on purpose: every name here pulls its closure in.
 */
export const ENTRY = `export { OrganizerProfileSync, PROFILE_VERSION } from "@trafficflow/worker/profile";
export { makeProfileIo, profileFingerprint, readOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile";
export { applyOrganizerProfile, serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
export { brandDialect } from "@trafficflow/db/dialect";
export {
  contacts, fencedAccountWrite, latestProfileFoundMarker, recordProfileImportResolution, rules, tags,
} from "@trafficflow/db";
`;

const NOTE =
  "Fixtures bundled from a release commit's objects by scripts/pin-released-organizer.mjs: the commit, the entry's " +
  "sha256, each input file's blob, each package left outside the bundle with its version in the commit's lockfile, " +
  "the bundler's version, and the bundle's size and sha256. A fixture is generated, never edited: " +
  "test/pin-released-organizer.test.ts holds the file to its pin.";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byKey(a, b)));

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 512 << 20, stdio: ["ignore", "pipe", "pipe"] });

/** Every blob of `commit`: path to blob id. */
export function treeAt(root, commit) {
  const tree = new Map();
  for (const line of git(root, ["ls-tree", "-r", commit]).split("\n")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m) tree.set(m[2], m[1]);
  }
  return tree;
}

/** The workspace packages of a tree: name to its folder and its `exports`. */
export function workspaceOf(tree, read) {
  const packages = new Map();
  for (const path of tree.keys()) {
    if (!/^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)) continue;
    const manifest = JSON.parse(read(path));
    if (typeof manifest.name === "string") packages.set(manifest.name, { dir: posix.dirname(path), exports: manifest.exports ?? {} });
  }
  return packages;
}

/** `@scope/name/sub/path` as `["@scope/name", "./sub/path"]`; `name` as `["name", "."]`. */
export function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const n = specifier.startsWith("@") ? 2 : 1;
  const sub = parts.slice(n).join("/");
  return [parts.slice(0, n).join("/"), sub === "" ? "." : `./${sub}`];
}

/** The source file an `exports` target names: the source condition first, as this repository's manifests spell it. */
function sourceOf(target) {
  if (typeof target === "string") return target;
  if (target === null || typeof target !== "object") return null;
  return target["ohmail-source"] ?? target.types ?? target.default ?? null;
}

/** A path of the tree for a relative import: as written, a `.js` as its `.ts` or `.tsx`, or a folder's index. */
export function fileOf(tree, path) {
  const tries = [path];
  if (path.endsWith(".js")) tries.push(`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`);
  tries.push(`${path}.ts`, `${path}.tsx`, `${path}/index.ts`);
  return tries.find((t) => tree.has(t)) ?? null;
}

class Refusal extends Error {}

/** Where `specifier`, imported by `importer` (a path of the tree, or "" for the entry), is found: a file of the tree, or outside. */
export function resolveIn(tree, packages, specifier, importer) {
  if (specifier.startsWith(".")) {
    const found = fileOf(tree, posix.normalize(posix.join(posix.dirname(importer), specifier)));
    if (found === null) throw new Refusal(`${importer} imports ${specifier}, which the commit does not hold`);
    return { file: found };
  }
  const [name, sub] = splitSpecifier(specifier);
  const pkg = packages.get(name);
  if (pkg === undefined) return { outside: name };
  const source = sourceOf(pkg.exports[sub]);
  const found = typeof source === "string" ? fileOf(tree, posix.normalize(posix.join(pkg.dir, source))) : null;
  if (found === null) throw new Refusal(`${importer || "the entry"} imports ${specifier}, which ${name} does not export from a file the commit holds`);
  return { file: found };
}

const LOADERS = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".json": "json" };

/** The bundle of the entry over `commit`'s objects, the files it took and the packages it left outside. */
export async function bundleAt(root, commit, esbuild) {
  const tree = treeAt(root, commit);
  const read = (path) => git(root, ["cat-file", "-p", `${commit}:${path}`]);
  const packages = workspaceOf(tree, read);
  const fromObjects = {
    name: "from-the-commits-objects",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: "entry", namespace: "pin" };
        const at = resolveIn(tree, packages, args.path, args.namespace === "pin" ? "" : args.importer);
        if (at.outside !== undefined) return { path: args.path, external: true };
        // No module of the release is kept for a side effect of loading it: only what the entry names, and its closure.
        return { path: at.file, namespace: "released", sideEffects: false };
      });
      build.onLoad({ filter: /.*/, namespace: "pin" }, () => ({ contents: ENTRY, loader: "ts" }));
      build.onLoad({ filter: /.*/, namespace: "released" }, (args) => {
        const loader = LOADERS[posix.extname(args.path)];
        if (loader === undefined) throw new Refusal(`${args.path} is no kind of file this bundle takes`);
        return { contents: read(args.path), loader };
      });
    },
  };
  const result = await esbuild.build({
    entryPoints: ["entry"], bundle: true, write: false, metafile: true, format: "esm", platform: "node", target: "node22",
    treeShaking: true, legalComments: "none", logLevel: "silent", plugins: [fromObjects],
    // The release's own compiler settings where they change what is emitted; nothing is read from a tsconfig on disk.
    tsconfigRaw: { compilerOptions: { target: "ES2022", useDefineForClassFields: true } },
  });
  const inputs = {};
  for (const key of Object.keys(result.metafile.inputs)) {
    const path = key.startsWith("released:") ? key.slice("released:".length) : null;
    if (path !== null && tree.has(path)) inputs[path] = tree.get(path);
  }
  /* What the BUNDLE imports from outside, not what the release's files do: a file the entry needs one name of
     brings none of its other imports. The platform's own modules are no package and carry no version. */
  const lockfile = tree.has("package-lock.json") ? JSON.parse(read("package-lock.json")) : { packages: {} };
  const externals = {};
  for (const out of Object.values(result.metafile.outputs)) {
    for (const imported of out.imports) {
      if (!imported.external || isBuiltin(imported.path)) continue;
      const [name] = splitSpecifier(imported.path);
      externals[name] = lockfile.packages?.[`node_modules/${name}`]?.version ?? null;
    }
  }
  return { text: result.outputFiles[0].text, inputs: sorted(inputs), externals: sorted(externals) };
}

/** The text of a fixture file: a header that says what it is, then the bundle. The commit stands in the lock. */
export function fixtureText(release, bundle) {
  return `// GENERATED by scripts/pin-released-organizer.mjs from release ${release}. Never edited.\n` +
    `// The released organizer's settings code, as one module, for the test that runs it beside this tree's.\n${bundle}`;
}

/** The lock entry for a built fixture. */
export function pinFor(release, commit, esbuildVersion, built, text) {
  return {
    release, tag: commit, entry: sha256(ENTRY), esbuild: esbuildVersion, externals: built.externals, inputs: built.inputs,
    bundle: { bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) },
  };
}

/** What turns pin `a` (or none) into pin `b`, one line each; empty when they pin the same. */
export function diffPins(a, b) {
  const out = [];
  for (const key of ["release", "tag", "entry", "esbuild"]) if (a?.[key] !== b[key]) out.push(`~ ${key} ${a?.[key] ?? "none"} -> ${b[key]}`);
  for (const [group, mark] of [["externals", "package"], ["inputs", "input"]]) {
    const was = a?.[group] ?? {};
    for (const key of [...new Set([...Object.keys(was), ...Object.keys(b[group])])].sort(byKey)) {
      if (!(key in was)) out.push(`+ ${mark} ${key}`);
      else if (!(key in b[group])) out.push(`- ${mark} ${key}`);
      else if (was[key] !== b[group][key]) out.push(`~ ${mark} ${key}`);
    }
  }
  if (a?.bundle?.sha256 !== b.bundle.sha256 || a?.bundle?.bytes !== b.bundle.bytes) out.push(`~ bundle ${a?.bundle?.sha256 ?? "none"} -> ${b.bundle.sha256}`);
  return out;
}

class Usage extends Error {}

function parse(argv) {
  const o = { write: false, check: false, release: null, tag: null, root: join(fileURLToPath(import.meta.url), "..", "..") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write" || a === "--check") o[a.slice(2)] = true;
    else if (a === "--release" || a === "--tag" || a === "--root") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Usage(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else throw new Usage(`unknown argument ${a}`);
  }
  if (o.write === o.check) throw new Usage("exactly one of --write and --check");
  if (o.release === null) throw new Usage("--release <x.y.z> is required: the release the fixture is of");
  if (!/^\d+\.\d+\.\d+$/.test(o.release)) throw new Usage(`--release ${o.release} is not x.y.z`);
  if (o.tag === null) throw new Usage("--tag <commit-ish> is required: the commit the fixture is bundled from");
  return o;
}

export async function main(argv) {
  let o;
  try { o = parse(argv); } catch (e) {
    console.error(`pin-released-organizer: ${e.message}`);
    console.error("usage: node scripts/pin-released-organizer.mjs (--write|--check) --release <x.y.z> --tag <commit-ish>");
    return 2;
  }
  let commit, built, esbuild;
  try {
    commit = git(o.root, ["rev-parse", "--verify", "--quiet", `${o.tag}^{commit}`]).trim();
  } catch (e) {
    console.error(`pin-released-organizer: ${o.tag} cannot be read as a commit of ${o.root}${e.stderr ? `: ${String(e.stderr).trim()}` : ""}`);
    return 2;
  }
  try {
    esbuild = await loadEsbuild();
    built = await bundleAt(o.root, commit, esbuild);
  } catch (e) {
    console.error(`pin-released-organizer: ${e instanceof Refusal ? e.message : `the bundle could not be made: ${e.message}`}`);
    return 2;
  }
  const text = fixtureText(o.release, built.text);
  const pin = pinFor(o.release, commit, esbuild.version, built, text);
  const key = fixturePath(o.release).slice(dirname(LOCK_PATH).length + 1);
  const header = `PIN ${pin.release} ${pin.tag} inputs=${Object.keys(pin.inputs).length} bytes=${pin.bundle.bytes} sha256=${pin.bundle.sha256}`;
  const lockAt = join(o.root, LOCK_PATH);
  const fileAt = join(o.root, fixturePath(o.release));
  let lock = null;
  try { if (existsSync(lockAt)) lock = JSON.parse(readFileSync(lockAt, "utf8")); } catch { /* an unreadable lock pins nothing */ }
  const was = lock?.fixtures?.[key] ?? null;
  const diff = diffPins(was, pin);
  if (o.write) {
    mkdirSync(dirname(fileAt), { recursive: true });
    writeFileSync(fileAt, text);
    writeFileSync(lockAt, JSON.stringify({ note: NOTE, fixtures: sorted({ ...(lock?.fixtures ?? {}), [key]: pin }) }, null, 2) + "\n");
    console.log([header, ...(was ? diff : [])].join("\n"));
    return 0;
  }
  // Another bundler version writes other bytes for the same inputs: say so, and compare what does not depend on it.
  if (was && was.esbuild !== pin.esbuild) {
    const rest = diffPins({ ...was, esbuild: pin.esbuild, bundle: pin.bundle }, pin);
    console.log([header, `= bundle not compared: the lock's is esbuild ${was.esbuild}'s, this one esbuild ${pin.esbuild}'s`, ...rest].join("\n"));
    return rest.length ? 1 : 0;
  }
  const onDisk = existsSync(fileAt) ? readFileSync(fileAt, "utf8") : null;
  if (onDisk !== text) diff.push(onDisk === null ? `- file ${fixturePath(o.release)}` : `~ file ${fixturePath(o.release)}`);
  console.log([header, ...diff].join("\n"));
  return diff.length ? 1 : 0;
}

/* Through realpath: `import.meta.url` is the resolved file, so a script reached through a link would compare
 * unequal, run nothing and exit 0. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)));
}
