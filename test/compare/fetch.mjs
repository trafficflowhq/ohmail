#!/usr/bin/env node
/**
 * fetch.mjs [--from <dir or address>] [--all] [--into <dir>]
 *
 * Puts the reference pictures a comparison run reads into build/reference/: the canary shard, and the
 * shard of every registered screen that has a file in subjects/ (the file's name is the screen's). Each
 * shard is one archive named in archive.lock.json with its SHA-256. An archive that does not match its
 * lock is refused and nothing of it is unpacked.
 *
 * This is the comparison's only egress, and it runs as its own step before the tests: the test run
 * itself reaches no host. --from names where the shards are (a folder, or an address prefix); without
 * it the addresses in the lock are read. The checksums hold wherever the archive lives. While the lock
 * names no address and no --from is given, there is nowhere to fetch from: one line says so, exit 1.
 *
 * Last line: FETCH shards=<n> fetched=<n> kept=<n>; exit 0, or 1 when a shard could not be had whole.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (/** @type {Uint8Array} */ b) => createHash("sha256").update(b).digest("hex");
const ENTRY = /^(\.\/)?([0-9a-f]{16}\.(png|json))?$/;

/** The shards a run needs: the canary, and each registered screen with a subjects file. */
export function wanted(lock, registry, subjectFiles, all = false) {
  if (all) return lock.shards.map((s) => s.id);
  const screens = new Set(registry.screens.map((s) => s.id));
  return [...new Set([lock.canary, ...subjectFiles.map((f) => basename(f, ".ts")).filter((n) => screens.has(n))])];
}

/** @param {string} from a folder or an address prefix @param {string} file */
async function read(from, file) {
  if (!/^https?:\/\//.test(from)) return readFileSync(join(resolve(from), file));
  const res = await fetch(new URL(encodeURIComponent(file), from.endsWith("/") ? from : `${from}/`), { redirect: "follow" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetches one shard, checks it against the lock and unpacks it into <into>/<id>/. Returns "kept" when
 * the shard already stands there at that checksum.
 */
export async function fetchShard(shard, into, from) {
  const dir = join(into, shard.id), stamp = join(dir, ".sha256");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === shard.sha256) return "kept";
  const places = from ? [{ from, file: shard.file }] : shard.urls.map((u) => ({ from: u.slice(0, u.lastIndexOf("/") + 1), file: decodeURIComponent(u.slice(u.lastIndexOf("/") + 1)) }));
  if (!places.length) throw new Error(`shard ${shard.id}: the lock names no place to fetch it from, and no --from was given`);
  let bytes = null;
  const failed = [];
  for (const p of places) {
    try { bytes = await read(p.from, p.file); break; } catch (e) { failed.push(/** @type {Error} */ (e).message); }
  }
  if (!bytes) throw new Error(`shard ${shard.id}: not fetched (${failed.join("; ")})`);
  const got = sha256(bytes);
  if (got !== shard.sha256 || bytes.length !== shard.bytes) throw new Error(`shard ${shard.id}: REFUSED, sha256 ${got} (${bytes.length} bytes) is not the lock's ${shard.sha256} (${shard.bytes} bytes)`);
  const names = execFileSync("tar", ["-tzf", "-"], { input: bytes, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  const stray = names.find((n) => !ENTRY.test(n));
  if (stray) throw new Error(`shard ${shard.id}: REFUSED, it holds an entry that is not a picture or a data file (${stray})`);
  const fresh = `${dir}.incoming`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  execFileSync("tar", ["-xzf", "-", "-C", fresh, "--no-same-owner"], { input: bytes, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(fresh, ".sha256"), `${shard.sha256}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(fresh, dir);
  return "fetched";
}

/** How to give the shards to a run, wherever one is told that they are missing. */
const GIVE = "node test/compare/fetch.mjs --from <a folder or an address prefix that holds the shards>";

/**
 * Fetches the shards `ids` into `into` and returns what to say and the exit code. With no `from` and no
 * address in the lock for any of them there is nowhere to fetch from: one line, code 1, nothing touched.
 * @param {{ shards: { id: string, file: string, sha256: string, bytes: number, urls: string[] }[] }} lock
 * @param {string[]} ids @param {string} into @param {string} [from]
 * @returns {Promise<{ code: 0 | 1, out: string[], err: string[] }>}
 */
export async function fetchAll(lock, ids, into, from) {
  const shardOf = (/** @type {string} */ id) => lock.shards.find((s) => s.id === id);
  if (!from && ids.length && ids.every((id) => !(shardOf(id)?.urls ?? []).length)) {
    return { code: 1, out: [], err: [`fetch: the reference archive has no home yet: archive.lock.json names no address, and no --from was given. Run: ${GIVE}`] };
  }
  mkdirSync(into, { recursive: true });
  /** @type {string[]} */
  const out = [], err = [];
  let fetched = 0, kept = 0;
  for (const id of ids) {
    const shard = shardOf(id);
    try {
      if (!shard) throw new Error(`shard ${id}: not in archive.lock.json`);
      const how = await fetchShard(shard, into, from);
      if (how === "kept") kept++; else fetched++;
      out.push(`SHARD ${id} ${how} sha256=${shard.sha256} bytes=${shard.bytes}`);
    } catch (e) {
      err.push(`fetch: ${/** @type {Error} */ (e).message}`);
    }
  }
  out.push(`FETCH shards=${ids.length} fetched=${fetched} kept=${kept}${err.length ? ` FAILED=${err.length}` : ""}`);
  return { code: err.length ? 1 : 0, out, err };
}

/**
 * What a comparison run does about the shards it reads. Nothing to say when each stands in `into`.
 * Otherwise one line: which are missing and how to give them. The run then skips what reads them, or,
 * told that the reference must be there (`required`: a job that exists to compare), fails on that line.
 * @param {string} into @param {string[]} ids @param {boolean} required
 * @returns {{ missing: string[], line: string, fail: boolean }}
 */
export function referenceIn(into, ids, required) {
  const missing = ids.filter((id) => !existsSync(join(into, id, ".sha256")));
  if (!missing.length) return { missing, line: "", fail: false };
  const what = `the reference pictures are not in ${into} (missing: ${missing.join(", ")}). Give them with: ${GIVE}`;
  return {
    missing,
    line: required ? `COMPARE FAILED: ${what}. This run was told they must be there (COMPARE_REQUIRE_REFERENCE=1).` : `COMPARE SKIPPED: ${what}. Nothing was held against them; COMPARE_REQUIRE_REFERENCE=1 makes this a failure.`,
    fail: required,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (/** @type {string} */ flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const lock = JSON.parse(readFileSync(join(HERE, "archive.lock.json"), "utf8"));
  const registry = JSON.parse(readFileSync(join(HERE, "registry.json"), "utf8"));
  const ids = wanted(lock, registry, readdirSync(join(HERE, "subjects")).filter((f) => f.endsWith(".ts")), argv.includes("--all"));
  const { code, out, err } = await fetchAll(lock, ids, resolve(value("--into") ?? "build/reference"), value("--from"));
  for (const line of err) process.stderr.write(`${line}\n`);
  for (const line of out) process.stdout.write(`${line}\n`);
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`fetch: ${e.stack ?? e}\n`); process.exit(1); });
}
