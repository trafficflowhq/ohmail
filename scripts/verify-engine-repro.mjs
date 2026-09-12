#!/usr/bin/env node
/**
 * verify-engine-repro.mjs — build the engine twice and refuse if the two results differ.
 *
 *     D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)
 *     OHMAIL_ESBUILD_FROM=$D node scripts/verify-engine-repro.mjs
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────────────────────
 *
 * The download offers a claim anyone is invited to check: the engine inside it was built from
 * the source in this repository. That check is only worth making if building the same source
 * twice gives the same bytes — otherwise a rebuild that does not match tells you nothing,
 * because it never would have. So this is the gate under that claim: same commit, same
 * dependency tree, same bundler, two builds, byte-identical output, or the build fails.
 *
 * It compares the WHOLE shipped layout and not only the bundle. What the app carries is the
 * directory as a unit — the one-file engine in `bin/`, the migration journal beside it, and the
 * vendored storage package under `bin/node_modules/` — so that is the thing whose bytes have to
 * be a function of the commit. The two copied trees are where a dependency-tree drift or a lost
 * file mode would show up, and hashing ten megabytes twice costs less than a second.
 *
 * ── WHAT IT DOES NOT CLAIM, STATED PLAINLY ───────────────────────────────────────────────
 *
 * **Reproducible for a fixed environment, not across every possible one.** The bundle is not
 * minified — a stack trace out of a shipped engine is worth more than the bytes — so it carries
 * a path comment above each of the 800-odd modules it contains, and those paths are the paths
 * the module resolver actually found. Two package managers lay a dependency tree out
 * differently (`node_modules/<pkg>/…` against a store with the version in the directory name),
 * so a build against one layout and a build against the other differ by construction, in
 * comments, for the same source.
 *
 * That is not a defect to normalise away. The two ways to erase those comments are to minify —
 * refused, deliberately — or to post-process the bundle after esbuild wrote it, which would
 * mean the shipped file is no longer the bundler's own output and would cost exactly the
 * property this gate exists to establish. So the honest statement is the environment-qualified
 * one: **rebuild from this repository the way its CI does — `npm ci`, then the pinned bundler —
 * and you get the published bytes.** That is the environment a stranger checking a download
 * rebuilds in, and it is the environment this gate runs in.
 *
 * Two other things are outside the comparison, both by construction rather than by an
 * exclusion rule:
 *
 *   · **The bundler's metafile.** It is written BESIDE the layout, not inside it, so a walk
 *     rooted at the layout never sees it. It also could not be compared as-is: it records where
 *     the output was written, and the two builds here write to two different scratch
 *     directories.
 *   · **Modification times.** The comparison is over content and file mode. A build that
 *     stamped a timestamp INTO a file is exactly what this catches; the timestamps the
 *     filesystem keeps about the files are not part of what ships.
 *
 * ── WHY IT REFUSES ON AN EMPTY LAYOUT ────────────────────────────────────────────────────
 *
 * Two empty directories compare equal. A gate that passes because it found nothing is worse
 * than no gate, so the comparison is preceded by a floor: the three things the layout must
 * contain, and a file count. `buildEngine` also falls back to an environment variable when it
 * is given no output directory, which would put both builds in ONE place and have this compare
 * a tree against itself — permanently green. Both output roots are therefore passed
 * explicitly, and asserted to be different directories, before anything is built.
 */
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
