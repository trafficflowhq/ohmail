#!/usr/bin/env node
/**
 * migration-numbers.mjs — one number, one entry, on every migration journal.
 *
 *   node scripts/migration-numbers.mjs              this tree: any number two entries share on one journal (exit 1)
 *   node scripts/migration-numbers.mjs --open-prs   also the numbers open pull requests add, and the next free one
 *
 * The shared mail journal and the device journal count one sequence (a device-only entry takes a
 * number too); the Cloud journal counts its own. `--open-prs` reads the open pull requests with `gh`
 * (`--repo owner/name`, default trafficflowhq/ohmail). Run it before cutting a migration.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const JOURNALS = [
  { dir: "packages/db-mail/drizzle", sequence: "mail" },
  { dir: "packages/db-mail/drizzle-sqlite", sequence: "mail" },
  { dir: "packages/db/drizzle-cloud", sequence: "cloud" },
];

/** Shipped before this census, on the device journal; admitted only as exactly this pair. */
const ADMITTED = {
  "packages/db-mail/drizzle-sqlite": [["0138_auto_filing_undone_at.sql", "0138_device_search_stems.sql"]],
};

const ENTRY = /^(\d{4})(?:_.*\.sql|\.noop)$/;

export function numberOf(file) {
  const m = ENTRY.exec(file);
  return m ? m[1] : null;
}

function byNumber(files) {
  const groups = new Map();
  for (const f of [...files].sort()) {
    const n = numberOf(f);
    if (n) groups.set(n, [...(groups.get(n) ?? []), f]);
  }
  return groups;
}

/** Every number two or more entries share on one journal of the tree at `root`. */
export function journalCollisions(root) {
  const out = [];
  for (const { dir } of JOURNALS) {
    const admitted = (ADMITTED[dir] ?? []).map((pair) => [...pair].sort().join("\n"));
    for (const [number, files] of byNumber(readdirSync(join(root, dir)))) {
      if (files.length > 1 && !admitted.includes(files.join("\n"))) out.push({ dir, number, files });
    }
  }
  return out;
}

/**
 * Per sequence: the next number neither the tree nor an open pull request holds, and each number held
 * by more than one of them. `prs` is `{ number, files }` with the paths each pull request adds.
 */
export function nextFree(root, prs) {
  const result = {};
  for (const sequence of new Set(JOURNALS.map((j) => j.sequence))) {
    const dirs = JOURNALS.filter((j) => j.sequence === sequence).map((j) => j.dir);
    const holders = new Map();
    const hold = (n, who) => holders.set(n, new Set([...(holders.get(n) ?? []), who]));
    for (const dir of dirs) for (const f of readdirSync(join(root, dir))) if (numberOf(f)) hold(numberOf(f), "main");
    for (const pr of prs) {
      for (const path of pr.files) {
        const cut = path.lastIndexOf("/");
        const n = numberOf(path.slice(cut + 1));
        if (n && dirs.includes(path.slice(0, cut))) hold(n, `#${pr.number}`);
      }
    }
    const numbers = [...holders.keys()].sort();
    const top = numbers.length ? Number.parseInt(numbers[numbers.length - 1], 10) : -1;
    result[sequence] = {
      next: String(top + 1).padStart(4, "0"),
      clashes: numbers.filter((n) => holders.get(n).size > 1).map((n) => ({ number: n, holders: [...holders.get(n)] })),
    };
  }
  return result;
}

function openPrs(repo) {
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const list = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", "number"]));
  return list.map(({ number }) => ({
    number,
    files: gh(["api", "--paginate", `repos/${repo}/pulls/${number}/files`, "--jq", '.[] | select(.status != "removed" and .status != "modified") | .filename'])
      .split("\n")
      .filter(Boolean),
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const args = process.argv.slice(2);
  const collisions = journalCollisions(root);
  for (const c of collisions) console.log(`COLLISION ${c.dir} ${c.number}: ${c.files.join(", ")}`);
  if (args.includes("--open-prs")) {
    const at = args.indexOf("--repo");
    const repo = at >= 0 ? args[at + 1] : "trafficflowhq/ohmail";
    for (const [sequence, { next, clashes }] of Object.entries(nextFree(root, openPrs(repo)))) {
      console.log(`${sequence}: next free ${next}`);
      for (const c of clashes) console.log(`  ${c.number} held by ${c.holders.join(", ")}`);
    }
  }
  process.exit(collisions.length ? 1 : 0);
}
