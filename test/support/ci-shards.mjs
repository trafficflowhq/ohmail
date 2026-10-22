/**
 * THE SUITE'S SHARD MAP for the public CI, written from measurements. Verbs: --pack <vitest-json>...
 * [--measured-at <sha>] writes ci-shards.json; --shard N prints shard N's files; --needs-dovecot N says
 * yes/no; --indexes and --alone print JSON arrays; --check refuses a mapped file that is gone, runs alone
 * or is named twice; --verify-report N <json> refuses a file of shard N that did not run, or one that ran
 * unasked. A file no shard names runs in shard sha256(path) % SHARDS, so a new test never waits for a
 * re-pack. The `@postpush: alone` files run in their own job on a database made from empty; the files
 * that dial Dovecot travel together, and only the shard holding them starts it. A desktop test that
 * imports the desktop's own vite config, or carries the desktop-install marker, runs in the desktop job
 * (--desktop), on the desktop's own install. Both verify verbs also refuse a report in which the service
 * gate skipped a file for a missing test service (SERVICE_GATE_PREFIX).
 * The SQLite run has its own map, ci-shards-sqlite.json (--pack-sqlite, --sqlite-indexes, --sqlite-shard N
 * <list>, --verify-sqlite-report N <list> <json>; see SQLITE_MAP below).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MAP = "test/support/ci-shards.json";
/** Sixteen: the measured suite is about 13 000 s of serial file time, so ten shards ran 22 minutes each
 *  and sixteen run about 13 on a 4-CPU runner. */
export const SHARDS = 16;
/** The marker a file writes to run alone (test/postpush-alone-set.test.ts reads the same string). */
export const ALONE_MARKER = "@postpush: alone";
/** The apps whose tests do not publish. */
const PRIVATE_APPS = new Set(["admin"]);
/** A file that dials the CONDSTORE server (Dovecot on 3144) by its port, its variable or the probe. */
export const DOVECOT_TEXT = /IMAP_CONDSTORE|CONDSTORE_PORT|probeCondstore/;
/** …and the files pinned beside it by path: the IMAP adapter's own suite and the wire-probe files. */
export const DOVECOT_PATH = /^packages\/core\/test\/adapters\/imap\.|\.wprobe\./;

const TEST_FILE = /\.test\.tsx?$/;
/** The desktop's vite config imports @vitejs/plugin-react, which only apps/desktop's own lock installs:
 *  a test importing that config, or building with it as its `configFile`, runs where that tree is installed. */
export const DESKTOP_CONFIG_IMPORT = /\bfrom\s+["']\.\.\/vite\.config(?:\.js|\.ts)?["']|\bconfigFile:[^\n]*["']vite\.config\.ts["']/;
/** …and the marker a desktop test writes when what it checks is the two trees installed side by side
 *  (apps/desktop/test/one-react.test.tsx): in a shard, where the root is installed alone, it proves nothing. */
export const DESKTOP_INSTALL_MARKER = "@ci: desktop install";
/** The start of the describe the service gate (test/setup/service-gate.runner.ts) puts in place of a file
 *  that needs a test service the run found absent; a CI report holding one skipped a file, and is refused. */
export const SERVICE_GATE_PREFIX = "needs a test service: ";

/** Every test file the default vitest project selects, as the include globs in vitest.config.ts. */
export function testFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (TEST_FILE.test(e.name)) out.push(child);
    }
  };
  for (const top of ["apps", "packages"]) {
    if (!existsSync(join(root, top))) continue;
    for (const d of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!d.isDirectory() || (top === "apps" && PRIVATE_APPS.has(d.name))) continue;
      walk(`${top}/${d.name}/test`);
    }
  }
  walk("test");
  return out.sort();
}

const textOf = (root, rel) => readFileSync(join(root, rel), "utf8");

/** The files that run alone: the marker, under an app's or a package's test directory, as ci.yml greps. */
export function aloneFiles(root = ROOT, files = testFiles(root)) {
  return files.filter((f) => /^(apps|packages)\/[^/]+\/test\//.test(f) && textOf(root, f).includes(ALONE_MARKER));
}

/** The files that run in the desktop job: a desktop test that imports the desktop's own vite config or
 *  carries the desktop-install marker. With `configOnly`, the first kind alone: the files that cannot be
 *  collected without apps/desktop's tree (the root vitest config leaves them out when it is absent). */
export function desktopFiles(root = ROOT, files = testFiles(root), { configOnly = false } = {}) {
  return files.filter((f) => {
    if (!f.startsWith("apps/desktop/test/")) return false;
    const text = textOf(root, f);
    return DESKTOP_CONFIG_IMPORT.test(text) || (!configOnly && text.includes(DESKTOP_INSTALL_MARKER));
  });
}

export function dovecotPinned(root, rel) {
  return DOVECOT_PATH.test(rel) || DOVECOT_TEXT.test(textOf(root, rel));
}

export function hashShard(rel, shards = SHARDS) {
  return createHash("sha256").update(rel).digest().readUInt32BE(0) % shards;
}

export function readMap(root = ROOT) {
  return JSON.parse(readFileSync(join(root, MAP), "utf8"));
}

/** Shard N's files: the ones the map names that still exist, and every unmapped file hashing to N. */
export function shardFiles(n, root = ROOT, map = readMap(root)) {
  const files = testFiles(root);
  const present = new Set(files);
  const alone = new Set([...aloneFiles(root, files), ...desktopFiles(root, files)]);
  const mapped = new Set(map.shards.flat());
  const own = map.shards[n].filter((f) => present.has(f) && !alone.has(f));
  const unmapped = files.filter((f) => !mapped.has(f) && !alone.has(f) && hashShard(f, map.shards.length) === n);
  return [...own, ...unmapped];
}

/** What --check refuses: a mapped file that is gone (STALE), runs alone or runs in the desktop job. */
export function checkMap(root = ROOT, map = readMap(root)) {
  const files = testFiles(root);
  const present = new Set(files);
  const alone = new Set(aloneFiles(root, files));
  const desktop = new Set(desktopFiles(root, files));
  const problems = [];
  if (map.shards.length !== SHARDS) problems.push(`SHARDS the map holds ${map.shards.length} shards, not ${SHARDS}`);
  const seen = new Set();
  for (const [i, shard] of map.shards.entries()) {
    for (const f of shard) {
      if (!present.has(f)) problems.push(`STALE ${f} (shard ${i}) is not a test file in this tree`);
      else if (alone.has(f)) problems.push(`ALONE ${f} (shard ${i}) carries ${ALONE_MARKER} and runs in its own job`);
      else if (desktop.has(f)) problems.push(`DESKTOP ${f} (shard ${i}) runs in the desktop job`);
      if (seen.has(f)) problems.push(`TWICE ${f} is named by two shards`);
      seen.add(f);
    }
  }
  return problems;
}

/** A shard's report (or the desktop job's, n = "desktop") against the files it was handed: the ones that
 *  did not run, the ones that ran unasked, and the ones the service gate skipped for a missing service. */
export function verifyReport(n, report, root = ROOT, map = readMap(root)) {
  const want = new Set(n === "desktop" ? desktopFiles(root) : shardFiles(n, root, map));
  const ran = new Set(report.testResults.map((r) => relative(root, r.name).split("\\").join("/")));
  return { missing: [...want].filter((f) => !ran.has(f)), extra: [...ran].filter((f) => !want.has(f)), gated: gatedFiles(report, root) };
}

/** `<file>: <title>` for every result the service gate put in place of a file. */
export function gatedFiles(report, root = ROOT) {
  const out = [];
  for (const r of report.testResults) {
    const titles = (r.assertionResults ?? []).flatMap((a) => [...(a.ancestorTitles ?? []), a.title ?? "", a.fullName ?? ""]);
    const hit = titles.find((t) => t.startsWith(SERVICE_GATE_PREFIX));
    if (hit !== undefined) out.push(`${relative(root, r.name).split("\\").join("/")}: ${hit}`);
  }
  return out;
}

/* ── THE SQLITE RUN'S SHARDS ─────────────────────────────────────────────────────────────────────
 * The second store's run (`vitest.sqlite.config.ts`) is one serial job of its own, and it outgrew its
 * 20-minute bound: measured at 1828 s of serial file time over 170 files, 529 s of it one file
 * (apps/sidecar/test/phone-claim-own.imap.test.ts, whose renew windows are real time by design) and
 * 1100 s more in eleven other sidecar IMAP files. Four shards, packed the way the main map is, hold
 * the longest at that one file and the rest near 430 s each. Its own map, because its file set is the
 * sqlite project's include list, not the default walk: a job reads that set with `vitest list` and
 * hands it here. A listed file the map does not name runs in the shard its path hashes to. */
export const SQLITE_MAP = "test/support/ci-shards-sqlite.json";
export const SQLITE_SHARDS = 4;

export function readSqliteMap(root = ROOT) {
  return JSON.parse(readFileSync(join(root, SQLITE_MAP), "utf8"));
}

/** The repository-relative paths in a `vitest list --filesOnly --json` report (absolute `file` rows). */
export function listedFiles(root, list) {
  return list.map((row) => relative(root, row.file).split("\\").join("/")).sort();
}

/** SQLite shard N's files out of the listed set: the ones the map names, and every unmapped one hashing to N. */
export function sqliteShardFiles(n, listed, map) {
  const present = new Set(listed);
  const mapped = new Set(map.shards.flat());
  const own = map.shards[n].filter((f) => present.has(f));
  const unmapped = listed.filter((f) => !mapped.has(f) && hashShard(f, map.shards.length) === n);
  return [...own, ...unmapped];
}

/** What --check refuses in the SQLite map: a shard count that is not SQLITE_SHARDS, a mapped file that is
 *  no test file here, and a file named twice. Whether a file is in the sqlite project is the job's to read. */
export function checkSqliteMap(root = ROOT, map = readSqliteMap(root)) {
  const present = new Set(testFiles(root));
  const problems = [];
  if (map.shards.length !== SQLITE_SHARDS) problems.push(`SQLITE_SHARDS the sqlite map holds ${map.shards.length} shards, not ${SQLITE_SHARDS}`);
  const seen = new Set();
  for (const [i, shard] of map.shards.entries()) {
    for (const f of shard) {
      if (!present.has(f)) problems.push(`STALE ${f} (sqlite shard ${i}) is not a test file in this tree`);
      if (seen.has(f)) problems.push(`TWICE ${f} is named by two sqlite shards`);
      seen.add(f);
    }
  }
  return problems;
}

/** A SQLite shard's report against the files it was handed. */
export function verifySqliteReport(n, listed, report, root = ROOT, map = readSqliteMap(root)) {
  const want = new Set(sqliteShardFiles(n, listed, map));
  const ran = new Set(report.testResults.map((r) => relative(root, r.name).split("\\").join("/")));
  return { missing: [...want].filter((f) => !ran.has(f)), extra: [...ran].filter((f) => !want.has(f)), gated: gatedFiles(report, root) };
}

/** Longest-first greedy of a SQLite run's measured files into SQLITE_SHARDS bins. */
export function packSqlite(cost, measuredAt) {
  const items = [...cost].map(([f, ms]) => ({ f, ms })).sort((a, b) => b.ms - a.ms || a.f.localeCompare(b.f));
  const bins = Array.from({ length: SQLITE_SHARDS }, () => ({ files: [], ms: 0 }));
  for (const it of items) {
    const bin = bins.reduce((lo, b) => (b.ms < lo.ms ? b : lo), bins[0]);
    bin.files.push(it.f);
    bin.ms += it.ms;
  }
  return {
    map: { measuredAt, shards: bins.map((b) => b.files.sort()) },
    seconds: bins.map((b) => Math.round(b.ms / 1000)),
  };
}

/** Per-file cost from vitest JSON reports: the file's own span plus the gap before it in a serial run
 *  (collection and environment). A later report replaces an earlier reading of the same file, so a
 *  re-measurement of some files lays over a whole run. */
export function measuredCosts(root, reports) {
  const cost = new Map();
  for (const report of reports) {
    const rows = [...report.testResults].sort((a, b) => a.startTime - b.startTime);
    let prevEnd = rows.length ? rows[0].startTime : 0;
    for (const r of rows) {
      const rel = relative(root, r.name).split("\\").join("/");
      const ms = Math.max(0, r.endTime - Math.min(prevEnd, r.startTime));
      prevEnd = Math.max(prevEnd, r.endTime);
      cost.set(rel, ms);
    }
  }
  return cost;
}

/** Longest-first greedy into SHARDS bins over the measured files; the Dovecot files are one item. */
export function pack(root, cost, measuredAt) {
  const files = testFiles(root);
  const alone = new Set([...aloneFiles(root, files), ...desktopFiles(root, files)]);
  const runnable = files.filter((f) => cost.has(f) && !alone.has(f));
  const pinned = runnable.filter((f) => dovecotPinned(root, f));
  const items = runnable.filter((f) => !pinned.includes(f)).map((f) => ({ files: [f], ms: cost.get(f) }));
  if (pinned.length) items.push({ files: pinned, ms: pinned.reduce((s, f) => s + cost.get(f), 0) });
  items.sort((a, b) => b.ms - a.ms || a.files[0].localeCompare(b.files[0]));
  const bins = Array.from({ length: SHARDS }, () => ({ files: [], ms: 0 }));
  for (const it of items) {
    const bin = bins.reduce((lo, b) => (b.ms < lo.ms ? b : lo), bins[0]);
    bin.files.push(...it.files);
    bin.ms += it.ms;
  }
  return {
    map: { measuredAt, shards: bins.map((b) => b.files.sort()), pins: { dovecot: pinned.sort() } },
    seconds: bins.map((b) => Math.round(b.ms / 1000)),
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--pack") {
    const at = rest.indexOf("--measured-at");
    const measuredAt = at >= 0 ? rest[at + 1] : "unknown";
    const inputs = rest.filter((a, i) => i !== at && i !== at + 1);
    if (!inputs.length) throw new Error("--pack takes one or more vitest JSON reports");
    const { map, seconds } = pack(ROOT, measuredCosts(ROOT, inputs.map((p) => JSON.parse(readFileSync(p, "utf8")))), measuredAt);
    writeFileSync(join(ROOT, MAP), `${JSON.stringify(map, null, 2)}\n`);
    process.stdout.write(`PACKED ${map.shards.flat().length} file(s) into ${SHARDS} shards; seconds ${seconds.join(" ")}; dovecot ${map.pins.dovecot.length}\n`);
    return 0;
  }
  if (cmd === "--pack-sqlite") {
    const at = rest.indexOf("--measured-at");
    const measuredAt = at >= 0 ? rest[at + 1] : "unknown";
    const inputs = rest.filter((a, i) => i !== at && i !== at + 1);
    if (!inputs.length) throw new Error("--pack-sqlite takes one or more vitest JSON reports of the sqlite run");
    const { map, seconds } = packSqlite(measuredCosts(ROOT, inputs.map((p) => JSON.parse(readFileSync(p, "utf8")))), measuredAt);
    writeFileSync(join(ROOT, SQLITE_MAP), `${JSON.stringify(map, null, 2)}\n`);
    process.stdout.write(`PACKED ${map.shards.flat().length} sqlite file(s) into ${SQLITE_SHARDS} shards; seconds ${seconds.join(" ")}\n`);
    return 0;
  }
  if (cmd === "--sqlite-indexes") {
    process.stdout.write(`${JSON.stringify(readSqliteMap().shards.map((_, i) => i))}\n`);
    return 0;
  }
  if (cmd === "--sqlite-shard") {
    const n = Number(rest[0]);
    const map = readSqliteMap();
    if (!Number.isInteger(n) || n < 0 || n >= map.shards.length) throw new Error(`--sqlite-shard takes a shard index 0..${map.shards.length - 1}`);
    if (!rest[1]) throw new Error("--sqlite-shard takes the `vitest list --filesOnly --json` report of the sqlite run");
    const files = sqliteShardFiles(n, listedFiles(ROOT, JSON.parse(readFileSync(rest[1], "utf8"))), map);
    if (!files.length) throw new Error(`sqlite shard ${n} has no file to run`);
    process.stdout.write(`${files.join("\n")}\n`);
    return 0;
  }
  if (cmd === "--verify-sqlite-report") {
    const n = Number(rest[0]);
    if (!rest[1] || !rest[2]) throw new Error("--verify-sqlite-report takes N, the list report and the run's JSON report");
    const listed = listedFiles(ROOT, JSON.parse(readFileSync(rest[1], "utf8")));
    const report = JSON.parse(readFileSync(rest[2], "utf8"));
    const { missing, extra, gated } = verifySqliteReport(n, listed, report);
    for (const f of missing) process.stderr.write(`ci-shards: MISSING ${f} was handed to sqlite shard ${n} and did not run\n`);
    for (const f of extra) process.stderr.write(`ci-shards: EXTRA ${f} ran in sqlite shard ${n} without being handed to it\n`);
    for (const g of gated) process.stderr.write(`ci-shards: GATED ${g} — a service this job must start was missing\n`);
    process.stdout.write(`REPORT sqlite shard=${n} results=${report.testResults.length} missing=${missing.length} extra=${extra.length} gated=${gated.length}\n`);
    return missing.length || extra.length || gated.length ? 1 : 0;
  }
  if (cmd === "--shard" || cmd === "--needs-dovecot") {
    const n = Number(rest[0]);
    const map = readMap();
    if (!Number.isInteger(n) || n < 0 || n >= map.shards.length) throw new Error(`${cmd} takes a shard index 0..${map.shards.length - 1}`);
    const files = shardFiles(n, ROOT, map);
    if (cmd === "--shard") {
      if (!files.length) throw new Error(`shard ${n} has no file to run`);
      process.stdout.write(`${files.join("\n")}\n`);
    } else {
      process.stdout.write(`${files.some((f) => dovecotPinned(ROOT, f)) ? "yes" : "no"}\n`);
    }
    return 0;
  }
  if (cmd === "--verify-report") {
    const n = rest[0] === "desktop" ? "desktop" : Number(rest[0]);
    const report = JSON.parse(readFileSync(rest[1], "utf8"));
    const { missing, extra, gated } = verifyReport(n, report);
    for (const f of missing) process.stderr.write(`ci-shards: MISSING ${f} was handed to shard ${n} and did not run\n`);
    for (const f of extra) process.stderr.write(`ci-shards: EXTRA ${f} ran in shard ${n} without being handed to it\n`);
    for (const g of gated) process.stderr.write(`ci-shards: GATED ${g} — a service this job must start was missing\n`);
    process.stdout.write(`REPORT shard=${n} results=${report.testResults.length} missing=${missing.length} extra=${extra.length} gated=${gated.length}\n`);
    return missing.length || extra.length || gated.length ? 1 : 0;
  }
  if (cmd === "--desktop") {
    const files = desktopFiles();
    if (!files.length) throw new Error("--desktop: no desktop test imports the desktop's vite config or carries the desktop-install marker");
    process.stdout.write(`${files.join("\n")}\n`);
    return 0;
  }
  if (cmd === "--alone") {
    process.stdout.write(`${JSON.stringify(aloneFiles())}\n`);
    return 0;
  }
  if (cmd === "--indexes") {
    process.stdout.write(`${JSON.stringify(readMap().shards.map((_, i) => i))}\n`);
    return 0;
  }
  if (cmd === "--check") {
    const problems = [...checkMap(), ...checkSqliteMap()];
    for (const p of problems) process.stderr.write(`ci-shards: ${p}\n`);
    process.stdout.write(`CHECK stale=${problems.filter((p) => p.startsWith("STALE")).length} problems=${problems.length}\n`);
    return problems.length ? 1 : 0;
  }
  process.stderr.write("ci-shards: --pack <json>... [--measured-at <sha>] | --pack-sqlite <json>... [--measured-at <sha>] | --sqlite-indexes | --sqlite-shard N <list-json> | --verify-sqlite-report N <list-json> <json> | --shard N | --needs-dovecot N | --indexes | --alone | --desktop | --check | --verify-report N|desktop <json>\n");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ci-shards: ${err.message}\n`);
    process.exitCode = 2;
  }
}
