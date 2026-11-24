import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLITE_MIGRATIONS_DIR, SQLITE_JOURNAL } from "@ohmail/db-mail";

/**
 * THE INLINED JOURNAL IS THE DIRECTORY, AND THIS IS WHAT MAKES THAT TRUE.
 *
 * The application cannot read the journal off disk — a bundler resolves imports, not directory
 * listings — so the files are compiled into a module. Two copies of the same SQL is the shape
 * that drifts, and it drifts silently: an entry edited in the directory and not regenerated
 * leaves a checkout whose tests pass and a device whose store is a version behind.
 */
function statementsOf(sql: string): string[] {
  return sql.split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim())
    .filter((s) => s.length > 0);
}

describe("the inlined SQLite journal", () => {
  const files = readdirSync(SQLITE_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  it("carries every file the directory holds, in the same order", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(SQLITE_JOURNAL.map((e) => e.name)).toEqual(files);
  });

  it("carries the same statements, split the same way", () => {
    for (const file of files) {
      const entry = SQLITE_JOURNAL.find((e) => e.name === file);
      expect(entry, `${file} is on disk and not in the module`).toBeDefined();
      const onDisk = statementsOf(readFileSync(join(SQLITE_MIGRATIONS_DIR, file), "utf8"));
      expect(entry?.statements, `${file} drifted from the directory`).toEqual(onDisk);
    }
  });

  it("ships the same journal from the BUILT module, which is what a device loads", async () => {
    // The suite resolves this package to its source; a device resolves the build output. A stale
    // build therefore ships different SQL while every test here stays green — the drift this file
    // exists to catch, one directory further along than it was looking.
    const built = fileURLToPath(new URL("../../db-mail/dist/sqlite-journal.js", import.meta.url));
    if (!existsSync(built)) {
      throw new Error(
        `the built journal is missing at ${built}. A device loads the build output, not the source, ` +
        "so this comparison is the only thing standing between the two. Build the workspace's packages.",
      );
    }
    // Vitest resolves the absolute path directly, including spaces in the volume name.
    const fromDist = (await import(built)) as {
      SQLITE_JOURNAL: readonly { name: string; statements: readonly string[] }[];
    };
    expect(fromDist.SQLITE_JOURNAL.map((e) => e.name)).toEqual(files);
    for (const file of files) {
      const onDisk = statementsOf(readFileSync(join(SQLITE_MIGRATIONS_DIR, file), "utf8"));
      const shipped = fromDist.SQLITE_JOURNAL.find((e) => e.name === file);
      expect(shipped?.statements, `${file} differs between the directory and the built module`)
        .toEqual(onDisk);
    }
  });

  it("splits on the marker rather than the semicolon, so a trigger arrives whole", () => {
    const compound = SQLITE_JOURNAL
      .flatMap((e) => e.statements)
      .filter((s) => s.startsWith("CREATE TRIGGER"));
    expect(compound.length).toBeGreaterThan(0);
    for (const trigger of compound) {
      expect(trigger, "a trigger body must arrive with its END").toMatch(/END;?$/);
      expect(trigger.split(";").length, "a trigger body carries its own semicolons")
        .toBeGreaterThan(1);
    }
  });
});
