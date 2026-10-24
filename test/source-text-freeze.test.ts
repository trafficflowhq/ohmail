/**
 * SOURCE-TEXT TESTS ARE FROZEN. A test that reads product source as text and matches it pins how the
 * code is spelled, not what it does, so it goes red on a rename or a moved line while behaviour holds.
 * The files that do it today are listed in `test/support/source-text-baseline.txt` with how many reads
 * each makes; a file may not read more, and the list and its total may only shrink. The guards that
 * cannot be written as behaviour are named, each with its reason, in `test/support/source-text-guards.tsv`,
 * and a test named by `docs/INVARIANTS.tsv` holds a promise. Any other test file that reads product
 * source is refused.
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
  "apps/web/test/aliased.test.ts": `import { ${READ} as text } from "node:fs";\nconst src = text("apps/web/app/View.tsx", "utf8");\n`,
  "apps/web/test/helper.test.ts": `import { ${READ} } from "node:fs";\nconst src = (rel: string) =>\n  ${READ}(rel, "utf8");\nsrc("apps/web/app/View.tsx");\nsrc("apps/web/app/Other.tsx");\n`,
  "apps/web/test/named.test.ts": `import { ${READ} } from "node:fs";\nconst FILE = "../app/View.tsx";\nconst text = ${READ}(new URL(FILE, import.meta.url), "utf8");\n`,
  "apps/web/test/built.test.ts": `import { ${READ}, readdirSync } from "node:fs";\nimport { build } from "esbuild";\n`
    + `await build({ entryPoints: ["apps/web/app/View.tsx"], outdir: "/tmp/out" });\nfor (const f of readdirSync("/tmp/out")) ${READ}(f, "utf8");\n`,
  "test/tooling.test.ts": reads("../scripts/tool.mjs") + reads("../.github/workflows/ci.yml"),
  "docs/INVARIANTS.tsv": "id\tclaim\tstatus\ttests\tverdict\twaits\n1a\tA promise.\tnot yet run\tapps/web/test/promise.test.ts\tdocs/invariant-verdicts/1a.json\t-\n",
  [BASELINE]: "# the frozen readers\napps/web/test/dir.test.ts\t1\napps/web/test/old.test.ts\t1\n",
  [GUARDS]: "apps/web/test/guarded.test.ts\tholds a rule no render can reach\n",
};
/* What the fixture's baseline holds: two files, two reads. */
const FROZEN = { files: 2, reads: 2 };
/* The readers the fixture admits once, so a case plants only what it tests. */
const QUIET = { "apps/web/test/new.test.ts": "", "apps/web/test/raw.test.ts": "", "apps/web/test/aliased.test.ts": "", "apps/web/test/helper.test.ts": "", "apps/web/test/named.test.ts": "" };

describe("which test files read product source as text", () => {
  const root = tree(FIXTURE);
  const readers = sourceReaders(root);

  it("a read of a product file, a read over a product directory and a ?raw import", () => {
    expect(readers.get("apps/web/test/new.test.ts")).toEqual(["apps/web/app/View.tsx"]);
    expect(readers.get("apps/web/test/dir.test.ts")).toEqual(["apps/web/app"]);
    expect(readers.get("apps/web/test/raw.test.ts")).toEqual(["?raw apps/web/app/View.tsx"]);
  });

  it("a read through an alias, a helper that reads its argument, and a name the read is given", () => {
    expect(readers.get("apps/web/test/aliased.test.ts")).toEqual(["apps/web/app/View.tsx"]);
    expect(readers.get("apps/web/test/helper.test.ts")).toEqual(["apps/web/app/Other.tsx", "apps/web/app/View.tsx"]);
    expect(readers.get("apps/web/test/named.test.ts")).toEqual(["apps/web/app/View.tsx"]);
  });

  it("not a fixture, a catalogue, an import, a comment, a script, a workflow or a build's entry", () => {
    for (const f of ["fixture", "renders", "commented", "converted", "built"]) expect(readers.has(`apps/web/test/${f}.test.ts`), f).toBe(false);
    expect(readers.has("test/tooling.test.ts")).toBe(false);
  });
});

describe("the freeze", () => {
  it("refuses a new reader, a stale baseline line and a guard without its reason", () => {
    const root = tree({
      ...FIXTURE,
      [BASELINE]: `${FIXTURE[BASELINE]}apps/web/test/converted.test.ts\t1\napps/web/test/gone.test.ts\t1\napps/web/test/old.test.ts\t1\napps/web/test/guarded.test.ts\t1\n`,
      [GUARDS]: `${FIXTURE[GUARDS]}apps/web/test/raw.test.ts\n`,
    });
    expect(freezeProblems(root, sourceReaders(root), { files: 6, reads: 6 }).filter((p: string) => !/^(?:NEW|UNSORTED) .*(?:aliased|helper|named)/.test(p))).toEqual([
      "BOTH apps/web/test/guarded.test.ts is on the baseline and the guard list: remove its baseline line",
      "GUARD apps/web/test/raw.test.ts has no reason: write why after a tab",
      "NEW apps/web/test/new.test.ts reads apps/web/app/View.tsx as text. Source-text tests are frozen: "
        + "write a behaviour test (render, call, assert what comes out) instead",
      "STALE apps/web/test/converted.test.ts is on the baseline and reads no product source now: remove its line",
      "STALE apps/web/test/gone.test.ts is on the baseline and is not in the tree: remove its line",
      "TWICE apps/web/test/old.test.ts is on the baseline twice",
      "UNSORTED test/support/source-text-baseline.txt is not sorted: keep its lines in order",
    ]);
  });

  it("refuses a baselined file that reads more than its count, and asks a smaller count to be written down", () => {
    const grew = tree({ ...FIXTURE, ...QUIET, "apps/web/test/old.test.ts": reads("../app/View.tsx") + reads("../app/Other.tsx") });
    expect(freezeProblems(grew, sourceReaders(grew), FROZEN)).toEqual([
      "GREW apps/web/test/old.test.ts reads product source 2 times, the baseline allows 1. Source-text tests are frozen: "
        + "write a behaviour test (render, call, assert what comes out) instead",
    ]);
    const shrank = tree({ ...FIXTURE, ...QUIET, [BASELINE]: "apps/web/test/dir.test.ts\t1\napps/web/test/old.test.ts\t2\n" });
    expect(freezeProblems(shrank, sourceReaders(shrank), { files: 2, reads: 3 })).toEqual([
      "SHRANK apps/web/test/old.test.ts reads product source 1 time now, the baseline says 2: write 1",
    ]);
  });

  it("refuses a baseline that grew: a line added, or a count raised, past what it was frozen at", () => {
    const added = tree({ ...FIXTURE, ...QUIET, "apps/web/test/new.test.ts": FIXTURE["apps/web/test/new.test.ts"],
      [BASELINE]: `${FIXTURE[BASELINE]}apps/web/test/zz.test.ts\t1\n`, "apps/web/test/zz.test.ts": reads("../app/View.tsx") });
    expect(freezeProblems(added, sourceReaders(added), FROZEN).filter((p: string) => !p.startsWith("NEW"))).toEqual([
      "SIZE test/support/source-text-baseline.txt holds 3 files and 3 reads, frozen at 2 and 2: a retirement lowers both "
        + "in test/support/source-text.mjs, nothing raises them",
    ]);
    const raised = tree({ ...FIXTURE, ...QUIET, "apps/web/test/old.test.ts": reads("../app/View.tsx") + reads("../app/Other.tsx"),
      [BASELINE]: "apps/web/test/dir.test.ts\t1\napps/web/test/old.test.ts\t2\n" });
    expect(freezeProblems(raised, sourceReaders(raised), FROZEN)).toEqual([
      "SIZE test/support/source-text-baseline.txt holds 2 files and 3 reads, frozen at 2 and 2: a retirement lowers both "
        + "in test/support/source-text.mjs, nothing raises them",
    ]);
  });

  it("admits the baseline, the named guards and a test that holds an invariant", () => {
    const root = tree({ ...FIXTURE, ...QUIET });
    expect(freezeProblems(root, sourceReaders(root), FROZEN)).toEqual([]);
  });

  it("holds on this tree, whose baseline and guards are real readers", () => {
    const readers = sourceReaders(ROOT);
    expect(readers.size, "the census reads the tree it guards").toBeGreaterThan(500);
    expect(readers.get("apps/webapp/test/copy-census.test.ts")).toBeTruthy();
    expect(readers.has("apps/webapp/test/first-load-defers-editor.test.ts"), "a build's entry is not a read").toBe(false);
    expect(freezeProblems(ROOT, readers)).toEqual([]);
  }, 60_000);
});
