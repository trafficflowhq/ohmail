import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { MAIL_MIGRATIONS_DIR } from "@ohmail/db-mail";

/**
 * `@ohmail/db-mail` is a real workspace package, and the two things that would make it a
 * decorative one instead.
 *
 * The stage-3 journal split creates this package to own the shared mail journal. The 35-table
 * schema move has not happened, so what there is to get wrong is small — and both of
 * the ways to get it wrong are silent.
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("@ohmail/db-mail", () => {
  /**
   * THE ONE THAT ONLY BITES AFTER A BUILD.
   *
   * `MAIL_MIGRATIONS_DIR` is `join(HERE, "..", "drizzle")`, and `HERE` is `src/` under vitest
   * but `dist/` after `tsc -b`. One `..` too many or too few passes every test that runs from
   * source and produces a migrator pointed at nothing in the packaged worker — which fails at
   * boot, in production, having been green on every laptop.
   *
   * So the built artifact is loaded in a SEPARATE node process and asked what it resolved to.
   * Importing `dist/index.js` from this file would not do: vitest's alias table maps
   * `@ohmail/db-mail` to `src/index.ts`, so the assertion would silently re-measure the source
   * path a second time.
   */
  it("resolves to the same journal from src and from the built dist", () => {
    const dist = join(PKG_ROOT, "dist", "index.js");
    expect(existsSync(dist), "packages/db-mail/dist is missing — build the package first").toBe(true);

    const fromDist = execFileSync(
      process.execPath,
      // A file URL, not a path: `import("C:\\…")` reads the drive letter as a URL scheme on Windows.
      ["-e", `import(process.argv[1]).then(m => process.stdout.write(m.MAIL_MIGRATIONS_DIR))`, pathToFileURL(dist).href],
      { encoding: "utf8" },
    );

    expect(fromDist).toBe(MAIL_MIGRATIONS_DIR);
    expect(MAIL_MIGRATIONS_DIR).toBe(join(PKG_ROOT, "drizzle"));
    expect(existsSync(join(MAIL_MIGRATIONS_DIR, "meta", "_journal.json"))).toBe(true);
  });

  /**
   * THE DRIVER LOCK, AT THE MANIFEST.
   *
   * The engine tier bans the pooled production driver: the LOCAL
   * sidecar runs on PGlite, and a shared package that depends on `postgres` would drag a Cloud
   * driver into an artifact whose entire claim is that it has no Cloud in it. The journal
   * split states it as a rule for this package by name.
   *
   * Asserted against the manifest rather than the module graph on purpose — the dependency is
   * the commitment, and it is wrong the moment it is DECLARED, not the moment something imports
   * it.
   */
  it("declares no dependency on the pooled production driver", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.name).toBe("@ohmail/db-mail");
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(declared).not.toContain("postgres");
  });

  /*
   * Two cases asked a build step of the earlier private tree which of the two journals it copied
   * out. That step is not part of this repository, which tracks both journals itself, so they left.
   */

  /** The journal is hand-written; drizzle-kit is deleted and must stay deleted. */
  it("ships no drizzle-kit config", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "."], { cwd: PKG_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(tracked).not.toContain("drizzle.config.ts");
    expect(tracked.filter((f) => f.includes("_snapshot.json"))).toEqual([]);
  });
});
