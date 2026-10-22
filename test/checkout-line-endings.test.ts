import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./support/public-root.mjs";

/**
 * A WINDOWS CHECKOUT IS LF, EXCEPT THE BYTES UNDER TEST.
 *
 * The Windows runners check out with core.autocrlf=true, and most of the tests that read a file as text
 * failed on the CRLF copy (18 of 29 sampled files, measured 2026-10-21). `* text=auto eol=lf` checks every
 * text file out LF on every platform; the updater fixtures keep their own `-text` line after it, which wins.
 * Read with git's own check-attr over the committed .gitattributes, in a repository of its own, so the
 * answer does not depend on this checkout's config.
 */
const ATTRS = join(ROOT, ".gitattributes");
const PAYLOAD = "apps/desktop/test/fixtures/updater/payload.bin";

function attrs(paths: string[]): Record<string, Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), "line-endings-"));
  const env = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "none") };
  expect(spawnSync("git", ["init", "-q"], { cwd: dir, env }).status).toBe(0);
  copyFileSync(ATTRS, join(dir, ".gitattributes"));
  const r = spawnSync("git", ["check-attr", "text", "eol", "--", ...paths], { cwd: dir, env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const out: Record<string, Record<string, string>> = {};
  for (const l of r.stdout.split("\n").filter(Boolean)) {
    const m = /^(.+): (\w+): (.+)$/.exec(l)!;
    (out[m[1]!] ??= {})[m[2]!] = m[3]!;
  }
  return out;
}

describe(".gitattributes", () => {
  it("checks text out LF everywhere", () => {
    expect(attrs(["CONTRIBUTING.md", "test/x.test.ts", "apps/desktop/src-tauri/src/main.rs"])).toEqual({
      "CONTRIBUTING.md": { text: "auto", eol: "lf" },
      "test/x.test.ts": { text: "auto", eol: "lf" },
      "apps/desktop/src-tauri/src/main.rs": { text: "auto", eol: "lf" },
    });
  });

  it("leaves the updater payload's bytes alone", () => {
    expect(attrs([PAYLOAD])[PAYLOAD]?.text).toBe("unset");
  });

  it("the fixture's -text line comes after the global rule, so it wins", () => {
    const lines = readFileSync(ATTRS, "utf8").split("\n");
    const global = lines.findIndex((l) => /^\*\s+text=auto\s+eol=lf\s*$/.test(l));
    const fixture = lines.findIndex((l) => /^apps\/desktop\/test\/fixtures\/updater\/\*\s+-text\s*$/.test(l));
    expect(global, "the global rule").toBeGreaterThanOrEqual(0);
    expect(fixture, "the fixture rule").toBeGreaterThan(global);
  });
});
