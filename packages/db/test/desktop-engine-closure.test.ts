import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WHAT THE DESKTOP DOWNLOAD CONVEYS, ENFORCED AT THE IMPORT GRAPH.
 *
 * The desktop engine migrates on every launch, so it needs the migration journal — and the
 * only entry point that offered one, `@trafficflow/db/admin`, also re-exports `setup-prod.js`,
 * which reaches billing, the admin database handle and `schema-cloud`. That single import in
 * `apps/sidecar/src/db.ts` put the entire private half into the engine artifact: a census over
 * the first bundle ever built counted `password_hash` x4, `token_hash` x7, `credit_ledger` x10,
 * `staff_users` x6, `stripe` x24 and the hosted-storage vendor's name x3.
 *
 * `@trafficflow/db/journal` is the narrow entry point that replaced it. This test walks its
 * import closure and refuses two things:
 *   · anything CLOUD-shaped (billing, staff, the cloud schema, the provisioning setup); and
 *   · the postgres SERVER DRIVER. The engine migrates with PGlite's own migrator, composed from
 *     the journal SPECS; it never opens a `postgres` wire connection. `runMigrations` (the
 *     postgres-js migrator) and everything it drags — `postgres`, the SOCKS client, the
 *     IP-address parser — belong on `/admin`, and a re-export of it here would ship a server
 *     driver inside a GPL-published download. The journal specs were split into the leaf
 *     `journal-specs.ts` precisely so this file can name them without reaching `migrate.ts`.
 *
 * WHY A CLOSURE TEST AND NOT ONLY THE ARTIFACT CENSUS: the census in `scripts/build-engine.mjs`
 * is the stronger evidence — it reads what actually ships — but it only runs when somebody
 * builds a bundle. This runs in the suite, so widening the entry point fails in the change that
 * widens it rather than at a release someone has to remember to census. Both exist on purpose;
 * neither replaces the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");

/** Modules a journal run may reach. Adding one here is a decision about the download. */
const ALLOWED = new Set([
  "journal.ts", "journal-specs.ts", "baseline.ts", "mailbox-dedup.ts",
  // The search extensions the engine sets up after its migrator, and the one index builder they
  // share with the server's setup; the lock constants sit in their own leaf so `migrate.ts` stays out.
  "search-setup.ts", "concurrent-index.ts", "migration-lock.ts",
  // Where the 1.0 line ends and 2.0 begins: three constants and three pure readers, no import.
  // The engine reads them to know which of a store's owed entries the 2.0 transition applies.
  "journal-heads.ts",
]);

/**
 * Cloud-shaped and PROVISIONING modules that must never appear in the closure, whatever the path.
 * `migrate` is here because it is the postgres-js runner: reaching it means the server driver is
 * back in the engine's closure.
 */
const FORBIDDEN = /^(migrate|setup-prod|billing|admin-db|schema-cloud|staff-grants|provision-staff-role|session-url)/;

/** Bare specifiers that mean the postgres server driver has entered the closure. */
const SERVER_DRIVER = /from\s+"(postgres|drizzle-orm\/postgres-js(\/migrator)?)"/;

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try { src = readFileSync(join(SRC, file), "utf8"); } catch { continue; }
    // Relative specifiers only — a bare specifier is a dependency, not one of our modules.
    for (const m of src.matchAll(/from\s+"\.\/([A-Za-z0-9._-]+)\.js"/g)) {
      queue.push(`${m[1]}.ts`);
    }
  }
  return seen;
}

/** The files in `files` that import the postgres server driver as a bare specifier. */
function driverImporters(files: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const f of files) {
    let src: string;
    try { src = readFileSync(join(SRC, f), "utf8"); } catch { continue; }
    if (SERVER_DRIVER.test(src)) hits.push(f);
  }
  return hits;
}

describe("the desktop engine's database entry point", () => {
  const reached = closure("journal.ts");

  it("reaches nothing cloud-shaped or provisioning", () => {
    const bad = [...reached].filter((f) => FORBIDDEN.test(f));
    expect(bad, `@trafficflow/db/journal reached: ${bad.join(", ")}`).toEqual([]);
  });

  it("reaches only the modules a journal run needs", () => {
    const extra = [...reached].filter((f) => !ALLOWED.has(f));
    expect(extra,
      `widening this entry point widens the desktop download — justify then add to ALLOWED: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("does not reach the postgres server driver — the engine migrates via PGlite", () => {
    const drivers = driverImporters(reached);
    expect(drivers,
      `@trafficflow/db/journal reaches a module that imports the postgres server driver: ${drivers.join(", ")}`,
    ).toEqual([]);
  });

  it("severs migrate.ts — the runner and its driver stay on /admin", () => {
    // The whole point of the split: the journal entry point names the specs (journal-specs.ts)
    // without reaching the runner (migrate.ts), which is the module the server driver enters through.
    expect(reached.has("journal-specs.ts")).toBe(true);
    expect(reached.has("baseline.ts")).toBe(true);
    expect(reached.has("migrate.ts")).toBe(false);
  });

  it("the walker actually walks, and the rules above are not vacuous", () => {
    expect(reached.size).toBeGreaterThan(1);
    // The control: /admin genuinely reaches the private half AND the server driver, so the two
    // rules above refuse something real rather than passing by finding nothing.
    const adminReached = closure("admin.ts");
    expect([...adminReached].some((f) => FORBIDDEN.test(f))).toBe(true);
    expect(driverImporters(adminReached).length).toBeGreaterThan(0);
  });

  it("the engine imports the narrow entry point, not the operational one", () => {
    const db = readFileSync(resolve(HERE, "..", "..", "..", "apps/sidecar/src/db.ts"), "utf8");
    expect(db).toMatch(/@trafficflow\/db\/journal/);
    expect(db).not.toMatch(/@trafficflow\/db\/admin/);
  });
});
