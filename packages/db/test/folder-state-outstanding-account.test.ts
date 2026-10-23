import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { dialect } from "../src/dialect/index.js";
import {
  controlFreshIntentWithoutTrigger, controlWithoutTrigger, drift, runFreshIntentShapes, runWriteShapes,
} from "./folder-state-outstanding-cases.js";

/**
 * MAIL 0160: `folder_state.outstanding_account_id` cannot drift, because nothing counts. The store
 * copies the message's account onto every outstanding filing on each write; the cases are every
 * write shape the writers use (`folder-state-outstanding-cases.ts`), on whichever store this run
 * is (the sqlite project runs this file too). And no application code writes the column.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("mail 0160's column on every write shape", () => {
  it("is the message's account on every outstanding filing", async () => {
    const db = await makeTestDb();
    expect(await runWriteShapes(db, "t")).toBe(6);
    expect(await drift(db)).toBe(0);
  });

  it("control: without the trigger an outstanding filing carries no account, and the check sees it", async () => {
    const db = await makeTestDb();
    await runWriteShapes(db, "c");
    await controlWithoutTrigger(db, dialect(db).name === "sqlite", "c");
  });
});

describe("mail 0163: a new filing starts its schedule fresh", () => {
  it("resets on a new desired folder, keeps on the same one and on a deferral", async () => {
    const db = await makeTestDb();
    await runFreshIntentShapes(db, "t");
  });

  it("control: without the trigger the new filing keeps the old refusal", async () => {
    const db = await makeTestDb();
    await runFreshIntentShapes(db, "c");
    await controlFreshIntentWithoutTrigger(db, dialect(db).name === "sqlite", "c");
  });
});

/** Every source file of the apps and packages, tests and generated bundles left out. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("nothing but the migrations writes the column", () => {
  it("is named only by its declarations, its prebuild, its read and the /health markers", () => {
    const allowed = new Set([
      "packages/db/src/schema-mail.ts",
      "packages/db/src/schema-mail-sqlite.ts",
      "packages/db/src/search-setup.ts",
      "packages/db/src/folder-state-pending.ts",
      "packages/api/src/routes/health-markers.ts",
      // The inlined SQLite journal, generated from the migration files.
      "packages/db-mail/src/sqlite-journal.ts",
    ]);
    const named: string[] = [];
    for (const top of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(ROOT, top))) {
        const src = join(ROOT, top, pkg, "src");
        try { statSync(src); } catch { continue; }
        for (const f of sources(src)) {
          if (/outstandingAccountId|outstanding_account_id/.test(readFileSync(f, "utf8"))) named.push(relative(ROOT, f));
        }
      }
    }
    expect(named.filter((f) => !allowed.has(f))).toEqual([]);
    expect(named.length, "the scan found the declarations").toBeGreaterThanOrEqual(4);
    // The one read: an equality beside the predicate, never a `.set(` or `.values(` with it.
    const read = readFileSync(join(ROOT, "packages/db/src/folder-state-pending.ts"), "utf8");
    expect(read.match(/folderState\.outstandingAccountId/g)).toEqual(["folderState.outstandingAccountId"]);
    expect(read).toContain("eq(folderState.outstandingAccountId, accountId)");
  });
});
