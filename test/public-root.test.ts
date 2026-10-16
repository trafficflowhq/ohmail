import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { presentRoots, PRIVATE_ROOTS, publicPath, publicRel, ROOT } from "./support/public-root.mjs";

/**
 * THE ONE RULE FOR WHERE A PUBLISHED FILE SITS: public/ohmail/<x> when that directory exists, else
 * <x> at the root with github/ read as .github/. Every reader of the workflows, the README, the
 * CHANGELOG, docs/ and Resources/ goes through it, so it is driven here on both layouts.
 */
const trees: string[] = [];
const tree = () => { const t = mkdtempSync(join(tmpdir(), "ohmail-public-root-")); trees.push(t); return t; };
afterAll(() => { for (const t of trees) rmSync(t, { recursive: true, force: true }); });

describe("test/support/public-root.mjs", () => {
  it("finds the published files in this checkout", () => {
    for (const rel of ["github/workflows/ci.yml", "github/workflows/build.yml", "README.md", "CHANGELOG.md", "Resources/Info.plist"]) {
      expect(existsSync(publicPath(rel)), `${rel} -> ${publicRel(rel)}`).toBe(true);
    }
  });

  it("reads the root, with github/ as .github/, where there is no public/ohmail directory", () => {
    const t = tree();
    expect(publicRel("github/workflows/ci.yml", t)).toBe(".github/workflows/ci.yml");
    expect(publicRel("github", t)).toBe(".github");
    expect(publicRel("README.md", t)).toBe("README.md");
    expect(publicRel("githubish/x", t), "only the whole first segment is renamed").toBe("githubish/x");
    expect(publicRel("docs/github/x.md", t), "never a later segment").toBe("docs/github/x.md");
    expect(publicPath("CHANGELOG.md", t)).toBe(join(t, "CHANGELOG.md"));
  });

  it("reads public/ohmail/<x> as written where that directory exists, and not where it is a file", () => {
    const t = tree();
    mkdirSync(join(t, "public/ohmail"), { recursive: true });
    expect(publicRel("github/workflows/ci.yml", t)).toBe("public/ohmail/github/workflows/ci.yml");
    expect(publicPath("README.md", t)).toBe(join(t, "public/ohmail/README.md"));
    const f = tree();
    mkdirSync(join(f, "public"));
    writeFileSync(join(f, "public/ohmail"), "not a directory\n");
    expect(publicRel("github/workflows/ci.yml", f)).toBe(".github/workflows/ci.yml");
  });

  it("defaults to this checkout's root", () => {
    expect(publicPath("README.md")).toBe(publicPath("README.md", ROOT));
  });
});

describe("presentRoots: a census walks the roots this checkout holds", () => {
  it("skips the operator console where it is absent and walks it where it is there", () => {
    const t = tree();
    mkdirSync(join(t, "apps/webapp/app"), { recursive: true });
    const roots = ["apps/webapp/app", "apps/admin/app", "apps/admin/lib"];
    expect(presentRoots(roots, t)).toEqual(["apps/webapp/app"]);
    mkdirSync(join(t, "apps/admin/app"), { recursive: true });
    expect(presentRoots(roots, t), "the plant: a checkout that holds the console walks it").toEqual(["apps/webapp/app", "apps/admin/app"]);
  });

  it("refuses any other missing root by name", () => {
    const t = tree();
    expect(() => presentRoots(["apps/webapp/app"], t)).toThrow(/a census root is missing: apps\/webapp\/app/);
    expect(() => presentRoots(["apps/administration"], t), "only apps/admin itself and below").toThrow(/missing/);
    expect(PRIVATE_ROOTS).toEqual(["apps/admin"]);
  });
});
