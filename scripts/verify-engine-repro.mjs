#!/usr/bin/env node
/**
 * verify-engine-repro.mjs — build the engine twice and refuse if the two results differ
 * (`OHMAIL_ESBUILD_FROM=<dir> node scripts/verify-engine-repro.mjs`). The download offers a claim anyone can
 * check: the engine inside it was built from the source here — worth making only if building the same source
 * twice gives the same bytes, so this is the gate under that claim (same commit, tree, bundler, two builds,
 * byte-identical, or fail). It compares the WHOLE shipped layout (the one-file engine in `bin/`, the journal
 * beside it, the vendored storage under `bin/node_modules/`), where a dependency-tree drift or lost file
 * mode shows up. What it does NOT claim: reproducible for a FIXED environment, not every one — the bundle is
 * not minified (a stack trace is worth more), so it carries a path comment per module and two package
 * managers lay a tree out differently, so the honest statement is environment-qualified (`npm ci` then the pinned bundler, the way its CI does). The metafile (written beside the layout) and modification times are outside the comparison by construction. It refuses on an EMPTY layout (two empty dirs compare equal): a three-item floor and a file count, and both output roots passed explicitly and asserted different. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { buildEngine, ROOT } from "./engine-bundle.mjs";

/**
 * The layout is a claim about a directory tree, so the manifest is one entry per file: its path,
 * the sha256 of its contents, and its permission bits — the executable bit on the engine is part
 * of what ships, and a mode that silently stopped being set is a difference worth failing on.
 *
 * The path is kept as its own field rather than parsed back out of a formatted line, because a
 * path is the one part of an entry that can contain anything at all.
 *
 * @returns {{ path: string, line: string }[]} sorted by path
 */
function manifest(root) {
  const rows = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) { walk(abs); continue; }
      /* A symlink whose TARGET hashes clean would hide a change in the layout itself, and the
       * layout is copied wholesale into the app — so anything that is not a plain file is a
       * refusal rather than something to follow. */
      if (!st.isFile()) {
        console.error(`REFUSED: ${relative(root, abs)} is not a regular file (mode ${st.mode.toString(8)})`);
        process.exit(1);
      }
      const rel = relative(root, abs).split(sep).join("/");
      const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
      const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
      rows.push({ path: rel, line: `${sha}  ${mode}  ${rel}` });
    }
  };
  walk(root);
  return rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/* The floor. Named individually rather than as a count alone, because the failure this guards
 * against is a build that produced a plausible-looking partial tree — and each of these three is
 * a different part of the layout: the artifact, the data it reads one level up, and the vendored
 * package beside it. */
const ANCHORS = [
  "bin/ohmail-engine.mjs",
  "drizzle/",
  "bin/node_modules/@electric-sql/pglite/",
];
const MIN_FILES = 20;

function floorOrDie(rows, label) {
  const paths = rows.map((r) => r.path);
  const missing = ANCHORS.filter((a) =>
    a.endsWith("/") ? !paths.some((p) => p.startsWith(a)) : !paths.includes(a));
  if (missing.length || rows.length < MIN_FILES) {
    console.error(`REFUSED: the ${label} layout is not a complete engine build.`);
    if (missing.length) console.error(`  missing: ${missing.join(", ")}`);
    if (rows.length < MIN_FILES) console.error(`  ${rows.length} files, fewer than the ${MIN_FILES} a real layout has`);
    console.error("  Comparing two incomplete trees would pass by not looking.");
    process.exit(1);
  }
}

/**
 * WHICH BUILD THE HEALTH DOCUMENT IS TALKING ABOUT. The reproduction below is evidence about
 * THIS source, so a document naming another commit makes it evidence about nothing. Three
 * refusals: no build named at all, `unknown` (a tree that could not identify itself), or a
 * different commit.
 *
 * @param {unknown} health the parsed `/health` body
 * @param {string} expected the commit this checkout is
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkAgainst(health, expected) {
  const named = health && typeof health === "object" ? health.buildCommit : undefined;
  if (typeof named !== "string" || named.trim() === "") {
    return {
      ok: false,
      reason: "the health document names no buildCommit, so nothing ties it to this source " +
        "(an engine spawned by a shell that bakes no build identity)",
    };
  }
  const got = named.trim().toLowerCase();
  if (got === "unknown") {
    return {
      ok: false,
      reason: "the running engine reports its build commit as `unknown` — it was built from a " +
        "tree that could not name itself, and a reproduction cannot be pinned to it",
    };
  }
  const want = String(expected).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(want)) {
    return { ok: false, reason: `this checkout names no commit to compare against (${expected || "nothing"})` };
  }
  if (got !== want) {
    return {
      ok: false,
      reason: `the running engine was built from ${got}, and this source is ${want}: ` +
        "two builds of the same source is a claim about THIS source",
    };
  }
  return { ok: true, reason: "" };
}

/**
 * The commit this checkout is, in the ORDER `apps/desktop/src-tauri/build.rs` resolves it — one
 * rule in two languages, so the gate and the shell cannot disagree about which build is which.
 * A `git archive` extraction has no `.git`, which is why the environment is asked first.
 */
function expectedCommit() {
  for (const name of ["OHMAIL_BUILD_SHA", "OHMAIL_BUILD_COMMIT", "GITHUB_SHA"]) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** The health document, from a file or from a running engine. */
async function readHealth(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    return await res.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

const ARGV = process.argv.slice(2);
if (ARGV.includes("--selftest")) process.exit(selftest());

const againstAt = ARGV.indexOf("--against");
if (againstAt !== -1) {
  const source = ARGV[againstAt + 1];
  if (!source || source.startsWith("--")) {
    console.error("REFUSED: --against needs a path or URL to a /health document");
    process.exit(2);
  }
  /* FIRST, before the two builds: a reproduction of the wrong source is minutes spent proving
     nothing, and the refusal is the same either way. */
  let health;
  try {
    health = await readHealth(source);
  } catch (err) {
    console.error(`REFUSED: the health document at ${source} could not be read (${err})`);
    process.exit(1);
  }
  const verdict = checkAgainst(health, expectedCommit());
  if (!verdict.ok) {
    console.error(`REFUSED: ${verdict.reason}`);
    process.exit(1);
  }
  console.log(`the running engine names this source's commit (${expectedCommit().trim()})`);
}

const scratch = mkdtempSync(join(tmpdir(), "ohmail-engine-repro-"));
try {
  const outA = join(scratch, "a");
  const outB = join(scratch, "b");
  /* Explicit, and asserted — see the header. Passing no output root makes `buildEngine` read an
   * environment variable, and both builds landing in one directory is a comparison that can only
   * ever pass. */
  if (outA === outB) { console.error("REFUSED: both builds would write to one directory"); process.exit(1); }

  console.log(`building twice from ${ROOT}`);
  await buildEngine({ root: ROOT, outRoot: outA });
  await buildEngine({ root: ROOT, outRoot: outB });

  const a = manifest(outA);
  const b = manifest(outB);
  floorOrDie(a, "first");
  floorOrDie(b, "second");

  /* The differences, all of them, named — a gate that says only "they differ" over a tree of a
   * thousand files leaves the reader to rebuild it themselves to find out what moved. */
  const byPath = (rows) => new Map(rows.map((r) => [r.path, r.line]));
  const [ma, mb] = [byPath(a), byPath(b)];
  const differences = [];
  for (const [p, line] of ma) {
    if (!mb.has(p)) differences.push(`only in the first build:  ${p}`);
    else if (mb.get(p) !== line) differences.push(`differs:  ${p}\n    first:  ${line}\n    second: ${mb.get(p)}`);
  }
  for (const p of mb.keys()) if (!ma.has(p)) differences.push(`only in the second build: ${p}`);

  const digest = createHash("sha256").update(a.map((r) => r.line).join("\n")).digest("hex");
  console.log(`\nengine layout: ${a.length} files`);
  console.log(`engine layout manifest sha256: ${digest}`);

  if (differences.length) {
    console.error(`\nREFUSED: two builds of the same source produced ${differences.length} difference(s).`);
    for (const d of differences) console.error(`  ${d}`);
    console.error("\nThe published engine cannot be checked against this source until this is fixed:");
    console.error("a rebuild that does not match proves nothing if a rebuild never matches.");
    process.exit(1);
  }
  console.log("\nthe engine builds byte-identically from the same source");
} finally {
  rmSync(scratch, { recursive: true, force: true });
  /* The bundler writes its build record beside the output root, so the two scratch roots leave
   * two files one level up from themselves — inside `scratch`, which has just gone. */
}

// ── SELFTEST ─────────────────────────────────────────────────────────────────────────────────
//
// The arms of the `--against` half alone: it is a pure function over a parsed document, so every
// case is drivable here with no engine, no network and no build. The two builds are NOT run — a
// selftest that took minutes and a bundler would be a selftest nobody runs between releases.
function selftest() {
  let pass = 0;
  let fail = 0;
  const arm = (cond, msg) => {
    if (cond) { pass += 1; console.log(`  ok   ${msg}`); }
    else { fail += 1; console.log(`  BAD  ${msg}`); }
  };
  const SHA = "a".repeat(39) + "1";
  const OTHER = "b".repeat(39) + "2";

  // ARM 1 — THE POSITIVE CONTROL: the ordinary case is admitted, or every refusal below could
  // pass by refusing everything.
  arm(checkAgainst({ buildCommit: SHA }, SHA).ok === true, "ARM 1 green: the matching commit is admitted");
  // ARM 2 — a different build refuses: the reproduction is about THIS source.
  arm(checkAgainst({ buildCommit: OTHER }, SHA).ok === false, "ARM 2 red: another commit refuses");
  // ARM 3 — `unknown` refuses BY NAME, and the reason says which of the three things is wrong.
  const unknown = checkAgainst({ buildCommit: "unknown" }, SHA);
  arm(unknown.ok === false && unknown.reason.includes("unknown"), "ARM 3 red: `unknown` refuses by name");
  // ARM 4 — a document naming no build at all is its own refusal, never a silent pass.
  arm(checkAgainst({ ok: true, version: "0.23.0" }, SHA).ok === false, "ARM 4 red: no buildCommit refuses");
  // ARM 5 — and neither is an empty string, which is the shape a trimmed-away value takes.
  arm(checkAgainst({ buildCommit: "   " }, SHA).ok === false, "ARM 5 red: a blank buildCommit refuses");
  // ARM 6 — a checkout that cannot name its own commit refuses rather than comparing nothing to
  // nothing: two unidentifiable halves are not a match.
  arm(checkAgainst({ buildCommit: SHA }, "").ok === false, "ARM 6 red: no expected commit refuses");
  // ARM 7 — case and whitespace are not a difference; a sha is a sha.
  arm(checkAgainst({ buildCommit: ` ${SHA.toUpperCase()} ` }, SHA).ok === true,
    "ARM 7 green: case and surrounding space are not a mismatch");

  if (fail === 0) { console.log(`SELFTEST_OK verify-engine-repro.mjs ${pass}/${pass}`); return 0; }
  console.log(`SELFTEST_FAIL verify-engine-repro.mjs ${pass}/${pass + fail}`);
  return 1;
}
