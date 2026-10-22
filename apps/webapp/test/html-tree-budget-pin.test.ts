/** @vitest-environment jsdom */
/* @reads: apps/mobile/src/mail/frame-budget.ts apps/mobile/package.json apps/desktop/package.json packages/client-engine/package.json package-lock.json apps/desktop/package-lock.json
   The phone's two bounds and the manifests and lockfile entries that pin parse5, read by path. */
/**
 * THE WEB, THE DESKTOP AND THE PHONE COUNT A FRAME WITH ONE MODULE, `@ohmail/client-engine/html-tree-budget`.
 * It overrides a protected parse5 method and reaches parse5's in-table-text internals, so parse5 is pinned
 * exactly in the engine and in every manifest that declares it, both lockfiles resolve only that version,
 * and the phone's two frame bounds are this app's. The web app declares no parse5 of its own: it reaches
 * parse5 only through the engine package, whose pin is the one it gets.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_FRAME_ELEMENTS, MAX_FRAME_TEXT_CHARS } from "../app/components/MessageBody";
import { FRAME_BUDGET } from "../../mobile/src/mail/frame-budget";

const REPO = join(fileURLToPath(new NodeURL(import.meta.url)), "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");
const PIN = "7.3.0";
const LOCKS = ["package-lock.json", "apps/desktop/package-lock.json"];

/** Every manifest of the workspace and of the desktop install that declares parse5, with its specifier. */
function declaredParse5(): Map<string, string> {
  const out = new Map<string, string>();
  const dirs = ["."];
  for (const parent of ["apps", "packages"]) {
    for (const d of readdirSync(join(REPO, parent))) if (existsSync(join(REPO, parent, d, "package.json"))) dirs.push(`${parent}/${d}`);
  }
  for (const dir of dirs) {
    const pkg = JSON.parse(read(`${dir}/package.json`)) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const spec = pkg[field]?.["parse5"];
      if (spec !== undefined) out.set(`${dir} ${field}`, spec);
    }
  }
  return out;
}

/** Every parse5 an npm lockfile installs, nested copies included: `<entry path> <version>`. */
function lockedParse5(lock: string): string[] {
  const { packages } = JSON.parse(lock) as { packages: Record<string, { version?: string }> };
  return Object.entries(packages)
    .filter(([path]) => /(^|\/)node_modules\/parse5$/.test(path))
    .map(([path, e]) => `${path} ${e.version}`)
    .sort();
}

describe("one tree counter, one parse5", () => {
  it("parse5 is pinned exactly 7.3.0 wherever it is declared, and both lockfiles install only that", () => {
    const declared = declaredParse5();
    const dirs = [...declared.keys()].map((k) => k.split(" ")[0]);
    expect(dirs).toEqual(expect.arrayContaining(["packages/client-engine", "apps/mobile"]));
    for (const [where, spec] of declared) expect(spec, where).toBe(PIN);
    for (const lock of LOCKS) {
      const entries = lockedParse5(read(lock));
      expect(entries.length, `${lock} installs no parse5`).toBeGreaterThan(0);
      for (const e of entries) expect(e.split(" ")[1], `${lock}: ${e}`).toBe(PIN);
    }
  });

  it("control: the lockfile reader finds a nested copy at another version", () => {
    const planted = JSON.stringify({
      packages: {
        "": { name: "x" },
        "node_modules/parse5": { version: PIN },
        "node_modules/some-dep/node_modules/parse5": { version: "7.2.0" },
        "node_modules/parse5-htmlparser2-tree-adapter": { version: PIN },
      },
    });
    expect(lockedParse5(planted)).toEqual([
      `node_modules/parse5 ${PIN}`,
      "node_modules/some-dep/node_modules/parse5 7.2.0",
    ]);
  });

  it("the phone's two frame bounds are this app's", () => {
    expect(FRAME_BUDGET.elements).toBe(MAX_FRAME_ELEMENTS);
    expect(FRAME_BUDGET.textChars).toBe(MAX_FRAME_TEXT_CHARS);
  });
});
