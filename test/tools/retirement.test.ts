import { describe, expect, it } from "vitest";
import { fixtureText, judgeControls, ruleSlug, verdictOf } from "../../tools/lib/controls.mjs";
import { checkReferences, explicitTypechecks } from "../../tools/lib/references.mjs";
import {
  checkRetirement,
  isSuiteTest,
  parseRetirement,
  READS_A_FILE,
  readingTests,
  renderRetirement,
  RETIREMENT_HEADER,
} from "../../tools/lib/retirement.mjs";
import { checkTable, renderCell, type Borders } from "../../tools/lib/table.mjs";

const row = (file: string, over: Partial<ReturnType<typeof parseRetirement>["rows"][number]> = {}) => ({
  file,
  kind: "source-text",
  holds: "reads source as text",
  home: "ohmail/package-borders",
  task: "tools",
  verdict: "",
  ...over,
});
const world = (over: Partial<Parameters<typeof checkRetirement>[0]> = {}) => ({
  rows: [row("test/a.test.ts")],
  reading: new Set(["test/a.test.ts"]),
  present: new Set(["test/a.test.ts", "test/quiet.test.ts"]),
  deleted: [] as string[],
  verdictExists: (path: string) => path === "docs/tool-verdicts/ohmail-package-borders.json",
  ...over,
});
const VERDICT = "docs/tool-verdicts/ohmail-package-borders.json";

describe("the retirement table", () => {
  it("reads back what it writes", () => {
    const rows = [row("test/b.test.ts"), row("test/a.test.ts", { kind: "data", home: "none" })];
    const text = renderRetirement(rows);
    expect(text.split("\n")[0]).toBe(RETIREMENT_HEADER);
    expect(parseRetirement(text)).toEqual({ rows: [rows[1], rows[0]], refusals: [] });
  });

  it("knows a test file of the suite, and a call that reads a file", () => {
    expect(isSuiteTest("apps/webapp/test/shell/rail.test.tsx")).toBe(true);
    expect(isSuiteTest("test/tools/baseline.test.ts")).toBe(true);
    expect(isSuiteTest("apps/webapp/app/shell/rail.tsx")).toBe(false);
    // The call's name is written in two halves: this file reads no file, and so has no row.
    expect(READS_A_FILE.test(`const text = ${"read" + "FileSync"}(file, "utf8");`)).toBe(true);
    expect(READS_A_FILE.test("const unread = readMessages(box);")).toBe(false);
  });

  it("passes a table with a row for every test file that reads a file", () => {
    expect(checkRetirement(world())).toEqual([]);
  });

  it("refuses a test file that reads a file and has no row", () => {
    const refusals = checkRetirement(world({ reading: new Set(["test/a.test.ts", "test/planted.test.ts"]) }));
    expect(refusals).toEqual([
      "retirement: test/planted.test.ts reads a file and has no row in tools/retirement.tsv",
    ]);
  });

  it("refuses a row that reads source as text and names no home", () => {
    const refusals = checkRetirement(world({ rows: [row("test/a.test.ts", { home: "none" })] }));
    expect(refusals).toEqual([expect.stringMatching(/test\/a\.test\.ts: it reads source as text/)]);
    expect(checkRetirement(world({ rows: [row("test/a.test.ts", { kind: "data", home: "none" })] }))).toEqual(
      [],
    );
  });

  it("refuses the words a classifier writes when it could not tell what a file reads", () => {
    const undecided = row("test/a.test.ts", {
      kind: "data",
      holds: "reads files named at run time",
      home: "none",
    });
    expect(checkRetirement(world({ rows: [undecided] }))).toEqual([
      expect.stringMatching(
        /test\/a\.test\.ts: "reads files named at run time" does not say what the file reads/,
      ),
    ]);
  });

  it("counts a test as reading when a helper beside it reads the file for it", () => {
    const reads = `export const sliceOf = (file: string) => ${"read" + "FileSync"}(file, "utf8");`;
    const walks = `export const marksUnder = (dir) => ${"readd" + "irSync"}(dir);`;
    const files: Record<string, string> = {
      "apps/web/test/direct.test.ts": `const text = ${"read" + "FileSync"}("a.json", "utf8");`,
      "apps/web/test/through.test.tsx":
        'import { render } from "../app/render.js";\nimport { sliceOf } from "./source-anchor";',
      "apps/web/test/source-anchor.ts": reads,
      "apps/web/test/quiet.test.ts": 'import { world } from "./support/world.js";',
      "apps/web/test/support/world.ts": "export const world = {};",
      "apps/web/test/product.test.ts": 'import { load } from "../src/load.js";',
      "apps/web/src/load.ts": reads,
      "apps/web/test/far.test.ts": 'const { marksUnder } = await import("../../../test/support/marks.mjs");',
      "test/support/marks.mjs": walks,
      "test/second-step.test.ts": 'import { names } from "./support/names.js";',
      "test/support/names.ts": 'export { marksUnder as names } from "./marks.mjs";',
      "test/folder.test.ts": 'import { all } from "./support/corpus";',
      "test/support/corpus/index.ts": walks,
      "packages/ui/test/other-test.test.ts": 'import "./reader.test.js";',
      "packages/ui/test/reader.test.ts": reads,
    };
    const reading = readingTests({
      tests: Object.keys(files).filter(isSuiteTest),
      textOf: (rel) => files[rel] ?? null,
    });
    expect([...reading].sort()).toEqual([
      "apps/web/test/direct.test.ts",
      "apps/web/test/far.test.ts",
      "apps/web/test/through.test.tsx",
      "packages/ui/test/reader.test.ts",
      "test/folder.test.ts",
      "test/second-step.test.ts",
    ]);
  });

  it("refuses a deleted test file unless its row carries a verdict", () => {
    const gone = { reading: new Set<string>(), present: new Set<string>(), deleted: ["test/a.test.ts"] };
    expect(checkRetirement(world(gone))).toEqual([
      "retirement: test/a.test.ts: the file is gone and its row has no verdict",
      "retirement: test/a.test.ts is deleted without a row that carries a verdict",
    ]);
    expect(checkRetirement(world({ ...gone, rows: [row("test/a.test.ts", { verdict: VERDICT })] }))).toEqual(
      [],
    );
    expect(checkRetirement(world({ ...gone, rows: [] }))).toEqual([
      "retirement: test/a.test.ts is deleted without a row that carries a verdict",
    ]);
  });

  it("refuses a verdict that is no file of the two verdict folders", () => {
    const elsewhere = checkRetirement(
      world({ rows: [row("test/a.test.ts", { verdict: "notes/it-was-fine.json" })] }),
    );
    expect(elsewhere).toEqual([expect.stringMatching(/the verdict "notes\/it-was-fine\.json"/)]);
    const missing = checkRetirement(
      world({ rows: [row("test/a.test.ts", { verdict: "docs/tool-verdicts/none.json" })] }),
    );
    expect(missing).toHaveLength(1);
  });

  it("refuses a row whose file reads no file any more, an unknown kind and an empty task", () => {
    expect(checkRetirement(world({ reading: new Set<string>() }))).toEqual([
      expect.stringMatching(/reads no file any more/),
    ]);
    expect(checkRetirement(world({ rows: [row("test/a.test.ts", { kind: "census" })] }))).toEqual([
      expect.stringMatching(/the kind "census"/),
    ]);
    expect(checkRetirement(world({ rows: [row("test/a.test.ts", { task: "" })] }))).toEqual([
      expect.stringMatching(/the task ""/),
    ]);
  });
});

describe("the controls", () => {
  const controls = [
    { id: "a planted import", rule: "borders", plant: "p/bad.ts", expect: "refused" as const },
    { id: "a clean file", rule: ["borders", "format"], plant: "p/clean.ts", expect: "passes" as const },
    { id: "an unformatted file", rule: "format", plant: "p/loose.ts", expect: "refused" as const },
  ];
  const fired = [
    { path: "p/bad.ts", rule: "borders", line: 3, message: "ui imports the engine" },
    { path: "p/loose.ts", rule: "format", line: 1, message: "not formatted" },
  ];

  it("writes a fixture's lines, and a repeated line counted up", () => {
    expect(
      fixtureText({ id: "x", plant: "x.ts", source: ["a", { repeat: "line {n}", count: 3 }, "z"] }),
    ).toBe("a\nline 1\nline 2\nline 3\nz\n");
  });

  it("passes when every rule refused its planted violation and passed its clean file", () => {
    const { records, refusals } = judgeControls(controls, fired, ["borders", "format"]);
    expect(refusals).toEqual([]);
    expect(records.filter((r) => r.outcome === "refused").map((r) => r.rule)).toEqual(["borders", "format"]);
  });

  it("refuses a rule that stayed silent on its planted violation", () => {
    const { refusals } = judgeControls(controls, [fired[1]], ["borders", "format"]);
    expect(refusals[0]).toBe("controls: a planted import: borders did not refuse p/bad.ts");
    expect(refusals).toHaveLength(2);
  });

  it("refuses a rule that fired on a file that must pass", () => {
    const noisy = [...fired, { path: "p/clean.ts", rule: "format" }];
    expect(judgeControls(controls, noisy, ["borders", "format"]).refusals).toEqual([
      "controls: a clean file: format refused p/clean.ts, which must pass",
      expect.stringMatching(/^controls: format is switched on and no clean file was seen passing it/),
    ]);
  });

  it("refuses a rule that is switched on and has no control", () => {
    const { refusals } = judgeControls(controls, fired, ["borders", "format", "new-rule"]);
    expect(refusals).toEqual([
      expect.stringMatching(/^controls: new-rule is switched on and no planted violation was refused by it/),
      expect.stringMatching(/^controls: new-rule is switched on and no clean file was seen passing it/),
    ]);
  });

  it("writes one verdict per rule: the planted path and the refusing line", () => {
    const { records } = judgeControls(controls, fired, ["borders", "format"]);
    expect(verdictOf("borders", records, { base: "abc", recorded: "2026-11-14" })).toEqual({
      id: "borders",
      base: "abc",
      recorded: "2026-11-14",
      command: "node tools/check.mjs --controls",
      arms: [{ control: "a planted import", file: "p/bad.ts", line: 3, refused: "ui imports the engine" }],
      green: [{ control: "a clean file", file: "p/clean.ts" }],
    });
    expect(ruleSlug("@typescript-eslint/ban-ts-comment")).toBe("typescript-eslint-ban-ts-comment");
    expect(ruleSlug("stylelint:color-no-hex")).toBe("stylelint-color-no-hex");
  });
});

describe("the projects the type check reaches", () => {
  it("refuses a folder with a tsconfig that no check reaches", () => {
    const given = {
      folders: ["packages/core", "apps/webapp", "packages/new"],
      references: ["./packages/core", "./packages/core/tsconfig.contract.json"],
      explicit: ["apps/webapp"],
    };
    expect(checkReferences(given)).toEqual([
      expect.stringMatching(/^references: packages\/new has a tsconfig/),
    ]);
    expect(checkReferences({ ...given, folders: ["packages/core", "apps/webapp"] })).toEqual([]);
  });

  it("counts a folder's own script only where a workflow runs it in that folder, by its whole name", () => {
    const reach = (...steps: string[]) =>
      explicitTypechecks({
        workflows: [steps.join("\n")],
        rootScripts: { "typecheck:mobile": "tsc --noEmit -p apps/mobile/tsconfig.json" },
        manifests: {
          "packages/new": { scripts: { typecheck: "tsc --noEmit" } },
          "apps/desktop": { scripts: { "ui:typecheck": "tsc --noEmit" } },
        },
      }).sort();
    // The root's script of a longer name is not the folder's own, and a script run at the root is not run in it.
    expect(reach("      - run: npm run typecheck:mobile")).toEqual(["apps/mobile"]);
    expect(reach("      - run: npm run typecheck")).toEqual([]);
    expect(reach("      - run: npm run typecheck:mobile:fast")).toEqual([]);
    expect(
      reach(
        "      - name: types",
        "        working-directory: packages/new",
        "        run: npm run typecheck",
      ),
    ).toEqual(["packages/new"]);
    expect(reach("      - working-directory: apps/desktop", "        run: npm run typecheck")).toEqual([]);
    expect(reach("      - working-directory: packages/new", "        run: npm run typechecks")).toEqual([]);
    expect(reach("      - run: |", "          cd apps/desktop && npm run ui:typecheck")).toEqual([
      "apps/desktop",
    ]);
    expect(
      reach(
        "      - working-directory: packages/new",
        "        run: npm ci",
        "      - run: npm run typecheck",
      ),
    ).toEqual([]);
  });

  it("finds the folders a workflow checks by name, straight or through a script", () => {
    const explicit = explicitTypechecks({
      workflows: [
        "- run: ./node_modules/.bin/tsc --noEmit -p apps/webapp/tsconfig.json\n- run: npm run typecheck:mobile\n- working-directory: apps/desktop\n  run: npm run ui:typecheck\n- run: npm run build",
      ],
      rootScripts: {
        "typecheck:mobile": "tsc --noEmit -p apps/mobile/tsconfig.json",
        build: "tsc -b",
        unused: "tsc -p packages/never/tsconfig.json",
      },
      manifests: {
        "apps/desktop": { scripts: { "ui:typecheck": "tsc --noEmit" } },
        "packages/other": { scripts: { build: "tsc -p ." } },
      },
    });
    expect(explicit.sort()).toEqual(["apps/desktop", "apps/mobile", "apps/webapp"]);
  });
});

describe("the written package table", () => {
  const borders: Borders = {
    packages: {
      tokens: { imports: [] },
      wire: { imports: [], exportsNoValue: true },
      app: { imports: ["ui", "wire"], typesOnly: ["client-engine"] },
      testing: { imports: "*", folders: ["packages/testing", "packages/fixtures"] },
    },
    apps: { webapp: { never: ["testing"] }, "api-vercel": { apps: ["server"], never: ["testing"] } },
  };
  const table = (appCell: string) =>
    [
      "<!-- package-table:begin -->",
      "| Folder | Name | May import | Status |",
      "|---|---|---|---|",
      "| `packages/tokens` | tokens | nothing | kept |",
      "| `packages/wire` | wire | nothing; **exports no value** | new |",
      `| \`packages/app\` | app | ${appCell} **[FIX2 1]** | new |`,
      "| `packages/testing` | testing | anything | new |",
      "| `apps/webapp` | the web shell | packages; never: `testing` | kept |",
      "| `apps/api-vercel` | the door | packages; apps: `server`; never: `testing` | kept |",
      "<!-- package-table:end -->",
    ].join("\n");
  const good = table("`ui`, `wire`; types only: `client-engine`");

  it("writes a row in one grammar", () => {
    expect(renderCell(borders.packages.app, "package")).toBe("`ui`, `wire`; types only: `client-engine`");
    expect(renderCell(borders.apps["api-vercel"], "app")).toBe("packages; apps: `server`; never: `testing`");
  });

  it("passes a table that says what the border data says, source marks aside", () => {
    expect(checkTable(borders, good, good)).toEqual([]);
  });

  it("refuses a cell that differs, a row on one side only, and a twin that drifted", () => {
    expect(checkTable(borders, table("`ui`, `wire`, `client-engine`"))).toEqual([
      'table: packages/app reads "`ui`, `wire`, `client-engine`", tools/borders.json says "`ui`, `wire`; types only: `client-engine`"',
    ]);
    const more = { ...borders, packages: { ...borders.packages, core: { imports: ["wire"] } } };
    expect(checkTable(more, good)).toEqual([
      "table: packages/core has a row in tools/borders.json and none in the table",
    ]);
    const { tokens: _tokens, ...fewer } = borders.packages;
    expect(checkTable({ ...borders, packages: fewer }, good)).toEqual([
      "table: packages/tokens has a row in the table and none in tools/borders.json",
    ]);
    expect(checkTable(borders, good, good.replace("kept", "moved"))).toEqual([
      "table: the two documents' package-table blocks differ",
    ]);
    expect(checkTable(borders, "no table here")).toEqual(["table: the document has no package-table block"]);
  });
});
