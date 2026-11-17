import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

/**
 * TWO MODULES A DEVICE MUST NEVER REACH, AND A WALK THAT SAYS SO RATHER THAN A COMMENT.
 *
 * `packages/db/src/baseline.ts` adopts the POSTGRES migration journal — it asks
 * `information_schema.tables` whether `__drizzle_migrations` exists and stamps rows into it. A
 * device runs a different journal through a different migrator (`sqlite-migrate.ts`), so this
 * module has no work to do there and no way to do it.
 *
 * `packages/db/src/mailbox-dedup.ts` reads `information_schema.columns` and `pg_indexes` to decide
 * what shape the schema is in before a de-duplication runs. Those are Postgres catalogs. The
 * device store's catalog is `sqlite_master` and `pragma table_info`, which is not a different
 * spelling of the same query — it is a different question with different answers.
 *
 * Neither is a PORT. Both are server-only, and they are excluded from the dialect census by name
 * for that reason — which is exactly the kind of exclusion that rots. An excluded module is one
 * nobody re-reads, and the day something the phone composes grows an import of it, the census
 * that would have objected has been told not to look.
 *
 * ── SO THE EXCLUSION IS MEASURED ──────────────────────────────────────────────────────────
 *
 * This walks the static import graph from the entry points a device's composition goes through
 * and asserts neither module is reachable. It is not the bundle — the device entry does not exist
 * until the engine is composed for it — and it is the strongest statement available before then,
 * because every one of these roots IS reached on a device and none of them may reach these two.
 *
 * When the device entry lands, this walk's seed becomes that entry and the assertion is unchanged.
 *
 * ── WHAT IS ALLOWED TO REACH THEM, NAMED ──────────────────────────────────────────────────
 *
 * `migrate.ts`, `admin.ts`, `setup-prod.ts`, `search-setup.ts`, `testing.ts` and
 * `apps/sidecar/src/db.ts`. The first five are the server's migration and operator surface; the
 * last is the desktop's PGlite door, which the device composition drops by construction. Those
 * are paths, not exemptions: none of them is reachable from the roots below, and if one becomes
 * reachable this fails naming the chain.
 */
const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

/** The two modules under the rule. */
const SERVER_ONLY = [
  "packages/db/src/baseline.ts",
  "packages/db/src/mailbox-dedup.ts",
] as const;

/**
 * The entry points a device's composition goes through.
 *
 * The barrel and the mail schema are what every service imports; the repository is what the
 * pipeline writes through; the sync loop is the worker's, imported unchanged by the desktop
 * composition and by the device's. Each is reached on a device, which is what makes an assertion
 * about their closure worth making.
 */
const SEED = [
  "packages/db/src/index.ts",
  "packages/db/src/schema-mail.ts",
  "packages/core/src/adapters/drizzle-repo.ts",
  "packages/services/src/mail.ts",
  "packages/organizer/src/sync.ts",
] as const;

/** Workspace specifiers this walk can follow. Anything else is third-party and out of remit. */
const ALIASES: readonly [string, string][] = [
  ["@trafficflow/db/testing", "packages/db/src/testing.ts"],
  ["@trafficflow/db/journal", "packages/db/src/journal.ts"],
  ["@trafficflow/db/admin", "packages/db/src/admin.ts"],
  ["@trafficflow/db/cloud", "packages/db/src/cloud.ts"],
  ["@trafficflow/db/dialect", "packages/db/src/dialect/index.ts"],
  ["@trafficflow/db/mail-sqlite", "packages/db/src/schema-mail-sqlite.ts"],
  ["@trafficflow/db/mail", "packages/db/src/schema-mail.ts"],
  ["@trafficflow/db", "packages/db/src/index.ts"],
  ["@ohmail/db-mail", "packages/db-mail/src/index.ts"],
  ["@trafficflow/services/mail", "packages/services/src/mail.ts"],
  ["@trafficflow/services", "packages/services/src/index.ts"],
  ["@ohmail/organizer/sync", "packages/organizer/src/sync.ts"],
  ["@ohmail/organizer/lease", "packages/organizer/src/lease.ts"],
  ["@trafficflow/core/mail", "packages/core/src/mail.ts"],
  ["@trafficflow/core/adapters/drizzle-repo", "packages/core/src/adapters/drizzle-repo.ts"],
  ["@trafficflow/core", "packages/core/src/index.ts"],
];

/** Every `from "…"` and `import("…")` specifier in a source file. */
function specifiersIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) out.push(m[1] as string);
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1] as string);
  return out;
}

/** A specifier, as a repo-relative source path — or null when it is not this workspace's. */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const guess = normalize(join(dirname(fromRel), spec)).replace(/\.js$/, ".ts");
    return existsSync(join(ROOT, guess)) ? guess : null;
  }
  // Longest alias first: the table is scanned in order and a shorter package name would otherwise
  // swallow its own subpaths — the same ordering hazard the runner's alias table documents.
  for (const [find, target] of ALIASES) {
    if (spec === find) return existsSync(join(ROOT, target)) ? target : null;
  }
  return null;
}

/** Everything the seed reaches, with the chain that got there. */
function walk(): { reached: Set<string>; via: Map<string, string> } {
  const reached = new Set<string>(SEED);
  const via = new Map<string, string>();
  const queue = [...SEED] as string[];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    let src: string;
    try { src = readFileSync(join(ROOT, rel), "utf8"); } catch { continue; }
    for (const spec of specifiersIn(src)) {
      const target = resolveSpecifier(rel, spec);
      if (target === null || reached.has(target)) continue;
      reached.add(target);
      via.set(target, rel);
      queue.push(target);
    }
  }
  return { reached, via };
}

/** The chain from a seed member to a file, for a failure a reader can act on. */
function chainTo(file: string, via: Map<string, string>): string {
  const hops: string[] = [file];
  let cur = file;
  while (via.has(cur) && hops.length < 20) {
    cur = via.get(cur) as string;
    hops.push(cur);
  }
  return hops.reverse().join(" -> ");
}

describe("the modules a device must never reach", () => {
  const { reached, via } = walk();

  it("walks a graph that is plausibly the composition, or the assertion below is vacuous", () => {
    // A resolver that silently stopped matching would reach only the five seeds and report a
    // clean result. These are files the composition demonstrably does reach.
    expect(reached.size, "the import walk reached almost nothing — its resolver has stopped matching")
      .toBeGreaterThan(60);
    expect(reached.has("packages/db/src/change-log.ts")).toBe(true);
    expect(reached.has("packages/db/src/storage.ts")).toBe(true);
    expect(reached.has("packages/core/src/adapters/drizzle-repo.ts")).toBe(true);
  });

  for (const file of SERVER_ONLY) {
    it(`does not reach ${relative("packages/db/src", file)}`, () => {
      expect(reached.has(file) ? chainTo(file, via) : "",
        `${file} is SERVER-ONLY — it speaks to Postgres catalogs or the Postgres migration ` +
        "journal, and it is excluded from the dialect census on that basis. Something the " +
        "device composition reaches now imports it, so the exclusion has stopped being true " +
        "and the census has been told not to look at a module that will be on a phone.").toBe("");
    });
  }
});
