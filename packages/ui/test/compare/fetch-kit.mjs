#!/usr/bin/env node
/**
 * fetch-kit.mjs --from <dir or address> [--into <dir>]
 *
 * Puts the kit's reference pictures where the comparison reads them: one archive an entry, named in
 * `test/reference/<entry>/manifest.json` with its SHA-256, unpacked into build/reference/kit-<entry>/.
 * The fetching and the refusal of an archive that does not match are the comparison tool's own
 * (`test/compare/fetch.mjs`); this only names the kit's archives to it. An entry without an archive
 * yet is said, and is no failure here: the comparison fails on every state whose picture is missing.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchShard } from "../../../../test/compare/fetch.mjs";

const REFERENCE = join(dirname(fileURLToPath(import.meta.url)), "../reference");
const argv = process.argv.slice(2);
const value = (/** @type {string} */ flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const into = resolve(value("--into") ?? "build/reference");
mkdirSync(into, { recursive: true });

let refused = 0,
  fetched = 0,
  kept = 0;
for (const entry of ["base", "mail", "calendar"]) {
  const file = join(REFERENCE, entry, "manifest.json");
  const shard = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).shard : null;
  if (!shard) {
    process.stdout.write(`SHARD kit-${entry} none yet\n`);
    continue;
  }
  try {
    const how = await fetchShard(shard, into, value("--from"));
    if (how === "kept") kept++;
    else fetched++;
    process.stdout.write(`SHARD ${shard.id} ${how} sha256=${shard.sha256} bytes=${shard.bytes}\n`);
  } catch (e) {
    refused++;
    process.stderr.write(`fetch-kit: ${/** @type {Error} */ (e).message}\n`);
  }
}
process.stdout.write(`FETCH fetched=${fetched} kept=${kept}${refused ? ` FAILED=${refused}` : ""}\n`);
process.exit(refused ? 1 : 0);
