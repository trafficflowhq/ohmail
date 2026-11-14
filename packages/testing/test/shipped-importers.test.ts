import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * WHO IMPORTS THE SAMPLE WORLD. `@ohmail/testing` is the invented mailbox and the adapter that
 * serves it: test support. Source that reaches a person (an app's `app/` or `src/`, a package's
 * `src/`) does not import it, with one standing exception: the web's demo, which runs the real
 * shell over the sample adapter. Its two importers are named below; anything else is refused,
 * and so is a manifest that declares the package for an app that has no demo.
 *
 * The desktop builds compile the same shell and alias the package to a stub that refuses
 * (`apps/desktop/vite.config.ts`, checked on the built files by `scripts/scan-artifact.mjs`); the
 * phone's own scan is `apps/mobile/test/privacy.test.ts`. This file is the list both lean on.
 */
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".next", ".expo", "coverage", "src-tauri", "android", "ios"]);

/** The importers that stand, each with what it takes and why. */
const DEMO_ARM: Record<string, string> = {
  "apps/webapp/app/shell/engine-config.ts": "FixturesAdapter and DEMO_NOW: the demo engine and its fixed clock",
  "apps/webapp/app/(product)/demo/DemoSettings.tsx": "NotificationSettingsFixture: the type of the demo settings snapshot",
};
/** The one manifest that may declare it: the app that carries the demo. */
const DECLARED_BY = ["apps/webapp"];

/**
 * Whether a member's manifest declares it. An app, in any field: its build takes whatever its files
 * import, whichever field names it. A package, in any field but `devDependencies`: there it is its
 * tests' dependency, and the walk below holds that no file of the package's `src/` imports it.
 */
export const declaresTesting = (member: string, pkg: Record<string, Record<string, string> | undefined>): boolean =>
  ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .filter((k) => member.startsWith("apps/") || k !== "devDependencies")
    .some((k) => pkg[k]?.["@ohmail/testing"] !== undefined);

/** `from "…"`, `import("…")`, `require("…")` and a bare `import "…"`, of the package or a path into it. */
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'`])(@ohmail\/testing(?:\/[^"'`]*)?|[^"'`]*packages\/testing\/[^"'`]*)\1/;
export const importsTesting = (src: string): boolean => IMPORT.test(withoutComments(src));

function sources(dir: string, into: string[] = []): string[] {
  if (!existsSync(dir)) return into;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, into);
    else if (/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) into.push(p);
  }
  return into;
}
const members = (kind: "apps" | "packages"): string[] => readdirSync(join(REPO, kind))
  .filter((n) => existsSync(join(REPO, kind, n, "package.json"))).map((n) => `${kind}/${n}`);

/** Every shipped source root: an app's `app/` and `src/`, a package's `src/`; the package itself left out. */
function shippedRoots(): string[] {
  const apps = members("apps").flatMap((a) => [`${a}/app`, `${a}/src`]);
  const packages = members("packages").filter((p) => p !== "packages/testing").map((p) => `${p}/src`);
  return [...apps, ...packages].filter((r) => existsSync(join(REPO, r)));
}

describe("the sample world's importers", () => {
  it("controls: each form of import is read, of the package, an entry of it or a path into it; prose is not", () => {
    expect(importsTesting(`import { getFixtures } from "@ohmail/testing";`)).toBe(true);
    expect(importsTesting(`import { FixturesAdapter } from '@ohmail/testing/adapter';`)).toBe(true);
    expect(importsTesting(`const m = await import("@ohmail/testing/adapter");`)).toBe(true);
    expect(importsTesting(`const m = require("@ohmail/testing");`)).toBe(true);
    expect(importsTesting(`import "@ohmail/testing";`)).toBe(true);
    expect(importsTesting(`export { DEMO_NOW } from "@ohmail/testing/adapter";`)).toBe(true);
    expect(importsTesting(`import { getFixtures } from "../../packages/testing/src/index";`)).toBe(true);
    expect(importsTesting(`// nothing here imports from "@ohmail/testing"\nconst x = 1;`)).toBe(false);
    expect(importsTesting(`/** read from \`@ohmail/testing\` once */\nimport { x } from "@ohmail/testing-library";`)).toBe(false);
    expect(importsTesting(`import { OhmailEngine } from "@ohmail/client-engine";`)).toBe(false);
  });

  it("no shipped source imports it but the web's demo arm, and both of its importers still do", () => {
    const roots = shippedRoots();
    // The roots are the ones a person's download is built from: a walk that lost one would pass empty.
    expect(roots).toEqual(expect.arrayContaining([
      "apps/webapp/app", "apps/desktop/src", "apps/mobile/src", "apps/sidecar/src", "packages/client-engine/src", "packages/ui/src",
    ]));
    const files = roots.flatMap((r) => sources(join(REPO, r)));
    expect(files.length, "the walk read almost nothing").toBeGreaterThan(800);
    const importers = files.filter((f) => importsTesting(readFileSync(f, "utf8"))).map((f) => relative(REPO, f).split("\\").join("/")).sort();
    expect(importers).toEqual(Object.keys(DEMO_ARM).sort());
  });

  it("controls: an app's manifest declares it in any field, a package's in any field but devDependencies", () => {
    const at = (k: string) => ({ [k]: { "@ohmail/testing": "*" } });
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      expect(declaresTesting("apps/sidecar", at(k)), `apps/sidecar ${k}`).toBe(true);
    }
    expect(declaresTesting("packages/services", at("dependencies"))).toBe(true);
    expect(declaresTesting("packages/services", at("peerDependencies"))).toBe(true);
    expect(declaresTesting("packages/services", at("optionalDependencies"))).toBe(true);
    expect(declaresTesting("packages/services", at("devDependencies"))).toBe(false);
    expect(declaresTesting("packages/services", { devDependencies: { "@ohmail/testing-library": "*" } })).toBe(false);
  });

  it("no app or package declares it but the one that carries the demo", () => {
    const declaring = [...members("apps"), ...members("packages")].filter((m) => {
      const pkg = JSON.parse(readFileSync(join(REPO, m, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      return declaresTesting(m, pkg);
    });
    expect(declaring).toEqual(DECLARED_BY);
  });
});
