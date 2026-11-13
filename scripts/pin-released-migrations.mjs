#!/usr/bin/env node
/**
 * THE PINS OF THE RELEASED MIGRATIONS: packages/db/released-migrations.lock.json, written from a commit.
 *
 *   node scripts/pin-released-migrations.mjs --write --release <x.y.z> --tag <commit-ish>
 *   node scripts/pin-released-migrations.mjs --check --release <x.y.z> --tag <commit-ish>
 *
 * The lock holds, for every `.sql` file the three journals carry at that commit, the sha256 of its text as
 * utf8: the hash drizzle records when it applies one, and the one released-migrations-are-frozen.test.ts
 * compares. Everything is read from the commit's objects, never from the checkout, so an edit in the working
 * tree pins nothing. Both arguments are required: a version read from the tree would stamp the previous
 * release on a bump's pins, and a default commit would pin whatever happens to be checked out.
 *
 * `--write` writes the lock. `--check` writes nothing and compares the lock on disk with what the commit
 * gives: `+` a file the lock lacks, `-` one it holds and the commit does not, `~` one whose pin differs.
 * Both print `LOCK <release> <commit> mail=N cloud=N device=N` first, and a write over an older lock prints the
 * same lines for what it changed. A lock written from an ancestor of the commit that pins the same release and
 * files is equal (`= tag <its commit>, an ancestor of <commit>`): a bump writes its pins from the commit it is
 * cut from, and the release tag is the merge after it. Exit 0 written or equal, 1 differs, 2 usage or git.
 * `--root <dir>` reads another checkout (the tests plant one).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCK_PATH = "packages/db/released-migrations.lock.json";
/** The journals something applies. `packages/db/drizzle` is the record from before the split and applies nowhere. */
export const JOURNALS = [
  { journal: "mail", dir: "packages/db-mail/drizzle" },
  { journal: "cloud", dir: "packages/db/drizzle-cloud" },
  { journal: "device", dir: "packages/db-mail/drizzle-sqlite" },
];
const NOTE =
  "Every migration file the three journals (mail, Cloud, device store) named at this commit, with the sha256 " +
  "drizzle records when it applies one. A released migration is immutable: edit it and " +
  "released-migrations-are-frozen.test.ts reddens. Write a new migration instead. A device store knows an " +
  "applied entry by its file name alone, so a device-store file is also never renamed or removed, no allowance " +
  "admits an edit of one, and no new entry sorts below the highest one pinned here. " +
  "scripts/pin-released-migrations.mjs writes this file.";

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The journals' own `.sql` entries among `paths`, each with its journal, sorted by path. */
export function journalSqlOf(paths) {
  const out = [];
  for (const path of paths) {
    const at = JOURNALS.find((j) => path.startsWith(`${j.dir}/`));
    if (!at || !path.endsWith(".sql") || path.slice(at.dir.length + 1).includes("/")) continue;
    out.push({ journal: at.journal, path });
  }
  return out.sort((a, b) => byPath(a.path, b.path));
}

/** The lock for `entries` (`{ path, sha }`), its files sorted by path. */
export function lockFor(release, tag, entries) {
  const files = {};
  for (const e of [...entries].sort((a, b) => byPath(a.path, b.path))) files[e.path] = e.sha;
  return { release, tag, note: NOTE, files };
}

/** What turns lock `a` (or none) into lock `b`, one line each; empty when they pin the same. */
export function diffLocks(a, b) {
  const out = [];
  const was = a?.files ?? {};
  if (a?.release !== b.release) out.push(`~ release ${a?.release ?? "none"} -> ${b.release}`);
  if (a?.tag !== b.tag) out.push(`~ tag ${a?.tag ?? "none"} -> ${b.tag}`);
  for (const path of [...new Set([...Object.keys(was), ...Object.keys(b.files)])].sort(byPath)) {
    if (!(path in was)) out.push(`+ ${path}`);
    else if (!(path in b.files)) out.push(`- ${path}`);
    else if (was[path] !== b.files[path]) out.push(`~ ${path}`);
  }
  return out;
}

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });

/** The lock `commit` gives, and its count per journal. */
export function lockAt(root, release, commit) {
  const listed = git(root, ["ls-tree", "-r", "--name-only", commit, "--", ...JOURNALS.map((j) => j.dir)]).split("\n").filter(Boolean);
  const sql = journalSqlOf(listed);
  const entries = sql.map(({ path }) => ({ path, sha: createHash("sha256").update(git(root, ["cat-file", "-p", `${commit}:${path}`])).digest("hex") }));
  const counts = Object.fromEntries(JOURNALS.map((j) => [j.journal, sql.filter((s) => s.journal === j.journal).length]));
  return { lock: lockFor(release, commit, entries), counts };
}

/** Whether the lock's commit `a` is a commit of this repository that `b` descends from. */
function isAncestor(root, a, b) {
  if (typeof a !== "string" || !/^[0-9a-f]{40}$/.test(a)) return false;
  try { git(root, ["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; }
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
  if (o.release === null) throw new Usage("--release <x.y.z> is required: the version these pins ship in");
  if (!/^\d+\.\d+\.\d+$/.test(o.release)) throw new Usage(`--release ${o.release} is not x.y.z`);
  if (o.tag === null) throw new Usage("--tag <commit-ish> is required: the commit the pins are read from");
  return o;
}

export function main(argv) {
  let o;
  try { o = parse(argv); } catch (e) {
    console.error(`pin-released-migrations: ${e.message}`);
    console.error("usage: node scripts/pin-released-migrations.mjs (--write|--check) --release <x.y.z> --tag <commit-ish>");
    return 2;
  }
  let made;
  try {
    const commit = git(o.root, ["rev-parse", "--verify", "--quiet", `${o.tag}^{commit}`]).trim();
    made = lockAt(o.root, o.release, commit);
  } catch (e) {
    console.error(`pin-released-migrations: ${o.tag} cannot be read as a commit of ${o.root}${e.stderr ? `: ${String(e.stderr).trim()}` : ""}`);
    return 2;
  }
  const { lock, counts } = made;
  const header = `LOCK ${lock.release} ${lock.tag} ${JOURNALS.map((j) => `${j.journal}=${counts[j.journal]}`).join(" ")}`;
  const at = join(o.root, LOCK_PATH);
  let onDisk = null;
  try { if (existsSync(at)) onDisk = JSON.parse(readFileSync(at, "utf8")); } catch { /* an unreadable lock differs in everything */ }
  const diff = diffLocks(onDisk, lock);
  if (o.write) {
    writeFileSync(at, JSON.stringify(lock, null, 2) + "\n");
    // A first write has nothing to compare with; a later one says what it changed, a re-pinned file above all.
    console.log([header, ...(onDisk ? diff : [])].join("\n"));
    return 0;
  }
  // The commit alone differs (two commits, one line) and the lock's is an ancestor: the same pins, read later.
  if (onDisk && onDisk.tag !== lock.tag && diff.length === 1 && isAncestor(o.root, onDisk.tag, lock.tag)) {
    console.log(`${header}\n= tag ${onDisk.tag}, an ancestor of ${lock.tag}`);
    return 0;
  }
  console.log([header, ...diff].join("\n"));
  return diff.length ? 1 : 0;
}

/* Through realpath: `import.meta.url` is the resolved file, so a script reached through a link would compare
 * unequal, run nothing and exit 0. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
