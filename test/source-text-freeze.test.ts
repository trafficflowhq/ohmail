/**
 * SOURCE-TEXT TESTS ARE FROZEN. A test that reads product source as text and matches it pins how the
 * code is spelled, not what it does, so it goes red on a rename or a moved line while behaviour holds.
 * The files that do it today are listed in `test/support/source-text-baseline.txt`, which may only
 * shrink; the guards that cannot be written as behaviour are named, each with its reason, in
 * `test/support/source-text-guards.tsv`, and a test named by `docs/INVARIANTS.tsv` holds a promise.
 * Any other test file that reads product source is refused.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASELINE, GUARDS, freezeProblems, sourceReaders } from "./support/source-text.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/* Spelled apart, so this file holds no read call of its own. */
const READ = "read" + "FileSync";
const RAW = "?" + "raw";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ohmail-source-text-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const reads = (path: string) => `import { ${READ} } from "node:fs";\nconst src = ${READ}(new URL("${path}", import.meta.url), "utf8");\n`;

const FIXTURE = {
  "apps/web/app/View.tsx": "export const View = () => null;\n",
  "apps/web/test/old.test.ts": reads("../app/View.tsx"),
  "apps/web/test/new.test.ts": reads("../app/View.tsx"),
  "apps/web/test/dir.test.ts": `import { ${READ}, readdirSync } from "node:fs";\nfor (const f of readdirSync("apps/web/app")) ${READ}(f);\n`,
  "apps/web/test/raw.test.ts": `import text from "../app/View.tsx${RAW}";\n`,
  "apps/web/test/fixture.test.ts": reads("./fixtures/one.eml") + reads("../messages/en.json"),
  "apps/web/test/renders.test.ts": `import { View } from "../app/View.tsx";\n${reads("./fixtures/one.eml")}`,
  "apps/web/test/commented.test.ts": `// ${READ}("../app/View.tsx") was the old way\nimport { View } from "../app/View.tsx";\n`,
  "apps/web/test/guarded.test.ts": reads("../app/View.tsx"),
  "apps/web/test/promise.test.ts": reads("../app/View.tsx"),
  "apps/web/test/converted.test.ts": `import { View } from "../app/View.tsx";\n`,
  "test/tooling.test.ts": reads("../scripts/tool.mjs") + reads("../.github/workflows/ci.yml"),
  "docs/INVARIANTS.tsv": "id\tclaim\tstatus\ttests\tverdict\twaits\n1a\tA promise.\tnot yet run\tapps/web/test/promise.test.ts\tdocs/invariant-verdicts/1a.json\t-\n",
  [BASELINE]: "# the frozen readers\napps/web/test/old.test.ts\napps/web/test/dir.test.ts\n",
  [GUARDS]: "apps/web/test/guarded.test.ts\tholds a rule no render can reach\n",
};

describe("which test files read product source as text", () => {
  const root = tree(FIXTURE);
  const readers = sourceReaders(root);

  it("a read of a product file, a read over a product directory and a ?raw import", () => {
    expect(readers.get("apps/web/test/new.test.ts")).toBe("apps/web/app/View.tsx");
    expect(readers.get("apps/web/test/dir.test.ts")).toBe("apps/web/app");
    expect(readers.get("apps/web/test/raw.test.ts")).toBe("?raw apps/web/app/View.tsx");
  });

  it("not a fixture, a catalogue, an import, a comment, a script or a workflow", () => {
    for (const f of ["fixture", "renders", "commented", "converted"]) expect(readers.has(`apps/web/test/${f}.test.ts`), f).toBe(false);
    expect(readers.has("test/tooling.test.ts")).toBe(false);
  });
});

describe("the freeze", () => {
  it("refuses a new reader, a stale baseline line and a guard without its reason", () => {
    const root = tree({
      ...FIXTURE,
      [BASELINE]: `${FIXTURE[BASELINE]}apps/web/test/converted.test.ts\napps/web/test/gone.test.ts\napps/web/test/old.test.ts\napps/web/test/guarded.test.ts\n`,
      [GUARDS]: `${FIXTURE[GUARDS]}apps/web/test/raw.test.ts\n`,
    });
    expect(freezeProblems(root)).toEqual([
      "BOTH apps/web/test/guarded.test.ts is on the baseline and the guard list: remove its baseline line",
      "GUARD apps/web/test/raw.test.ts has no reason: write why after a tab",
      "NEW apps/web/test/new.test.ts reads apps/web/app/View.tsx as text. Source-text tests are frozen: "
        + "write a behaviour test (render, call, assert what comes out) instead",
      "STALE apps/web/test/converted.test.ts is on the baseline and reads no product source now: remove its line",
      "STALE apps/web/test/gone.test.ts is on the baseline and is not in the tree: remove its line",
      "TWICE apps/web/test/old.test.ts is on the baseline twice",
    ]);
  });

  it("admits the baseline, the named guards and a test that holds an invariant", () => {
    const root = tree({ ...FIXTURE, "apps/web/test/new.test.ts": "", "apps/web/test/raw.test.ts": "" });
    expect(freezeProblems(root)).toEqual([]);
  });

  it("holds on this tree, whose baseline and guards are real readers", () => {
    const readers = sourceReaders(ROOT);
    expect(readers.size, "the census reads the tree it guards").toBeGreaterThan(500);
    expect(readers.get("apps/webapp/test/copy-census.test.ts")).toBeTruthy();
    expect(freezeProblems(ROOT, readers)).toEqual([]);
  }, 60_000);
});
