#!/usr/bin/env node
/**
 * THE SUITE'S SHARD MAP for the public CI, written from measurements. Verbs: --pack <vitest-json>...
 * [--measured-at <sha>] writes ci-shards.json; --shard N prints shard N's files; --needs-dovecot N says
 * yes/no; --indexes and --alone print JSON arrays; --check refuses a mapped file that is gone, runs alone
 * or is named twice; --verify-report N <json> refuses a file of shard N that did not run, or one that ran
 * unasked. A file no shard names runs in shard sha256(path) % SHARDS, so a new test never waits for a
 * re-pack. The `@postpush: alone` files run in their own job on a database made from empty; the files
 * that dial Dovecot travel together, and only the shard holding them starts it. A desktop test that
 * imports the desktop's own vite config runs in the desktop job (--desktop), on the desktop's own install.
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

/** The files that run in the desktop job: a desktop test that imports the desktop's own vite config. */
export function desktopFiles(root = ROOT, files = testFiles(root)) {
  return files.filter((f) => f.startsWith("apps/desktop/test/") && DESKTOP_CONFIG_IMPORT.test(textOf(root, f)));
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
      else if (desktop.has(f)) problems.push(`DESKTOP ${f} (shard ${i}) imports the desktop's vite config and runs in the desktop job`);
      if (seen.has(f)) problems.push(`TWICE ${f} is named by two shards`);
      seen.add(f);
    }
  }
  return problems;
}

/** A shard's report (or the desktop job's, n = "desktop") against the files it was handed: the ones that
 *  did not run, and the ones that ran unasked. */
export function verifyReport(n, report, root = ROOT, map = readMap(root)) {
  const want = new Set(n === "desktop" ? desktopFiles(root) : shardFiles(n, root, map));
  const ran = new Set(report.testResults.map((r) => relative(root, r.name).split("\\").join("/")));
  return { missing: [...want].filter((f) => !ran.has(f)), extra: [...ran].filter((f) => !want.has(f)) };
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
    const { missing, extra } = verifyReport(n, report);
    for (const f of missing) process.stderr.write(`ci-shards: MISSING ${f} was handed to shard ${n} and did not run\n`);
    for (const f of extra) process.stderr.write(`ci-shards: EXTRA ${f} ran in shard ${n} without being handed to it\n`);
    process.stdout.write(`REPORT shard=${n} results=${report.testResults.length} missing=${missing.length} extra=${extra.length}\n`);
    return missing.length || extra.length ? 1 : 0;
  }
  if (cmd === "--desktop") {
    const files = desktopFiles();
    if (!files.length) throw new Error("--desktop: no desktop test imports the desktop's vite config");
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
    const problems = checkMap();
    for (const p of problems) process.stderr.write(`ci-shards: ${p}\n`);
    process.stdout.write(`CHECK stale=${problems.filter((p) => p.startsWith("STALE")).length} problems=${problems.length}\n`);
    return problems.length ? 1 : 0;
  }
  process.stderr.write("ci-shards: --pack <json>... [--measured-at <sha>] | --shard N | --needs-dovecot N | --indexes | --alone | --desktop | --check | --verify-report N|desktop <json>\n");
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
