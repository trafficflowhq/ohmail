import { describe, expect, it } from "vitest";
import { readMounted } from "../../tools/lib/mounted.mjs";
import { leavesWithTheSwitch, readOldTestsTree } from "../../tools/lib/old-tests-tree.mjs";
import { hostEntries, importsOf, makeGraph, makeResolver } from "../../tools/lib/reach.mjs";
import { casesOf, splitKey } from "../../tools/lib/test-cases.mjs";

// The folder's name is spelled apart here, so that this file names no part of today's shell itself.
const APP = "app";
const SHELL = `apps/webapp/${APP}/shell`;
const VIEWS = `apps/webapp/${APP}/views`;
const names = (text: string) => casesOf(text).map((c) => c.name);
const tree = (files: Record<string, string>) => ({
  files: Object.keys(files),
  textOf: (rel: string) => files[rel] ?? null,
});

describe("a case's name, read from the file as text", () => {
  it("joins the describes' titles and the case's own, each as written", () => {
    const text = [
      'describe("the Ohbox", () => {',
      "  describe(`at ${width}`, () => {",
      "    it('files a letter', () => {});",
      '    test("says \\"done\\"", async () => {});',
      "  });",
      '  it.skip("waits", () => {});',
      "});",
      'it("stands alone", () => {});',
    ].join("\n");
    expect(names(text)).toEqual([
      "the Ohbox > at ${width} > files a letter",
      'the Ohbox > at ${width} > says \\"done\\"',
      "the Ohbox > waits",
      "stands alone",
    ]);
  });

  it("names a case of a loop or a table once, by its title as written", () => {
    const text = [
      "for (const verb of VERBS) {",
      "  it(`${verb} files the row`, () => {});",
      "}",
      'it.each([["a"], ["b"]])("moves %s", (x) => {});',
      'describe.each(SIZES)("at $width", ({ width }) => {',
      "  test.concurrent.each(ROWS)(`row ${0}`, () => {});",
      "});",
      "it(title, () => {});",
      'it(PREFIX + " ends", () => {});',
    ].join("\n");
    expect(names(text)).toEqual([
      "${verb} files the row",
      "moves %s",
      "at $width > row ${0}",
      "title",
      'PREFIX + " ends"',
    ]);
  });

  it("reads no case in a comment, a string or a regular expression, and none inside another case", () => {
    const text = [
      '// it("a comment", () => {})',
      '/* test("a block", () => {}) */',
      'const s = "it(\\"a string\\")";',
      'const r = (f) => /[`"]it\\(/.test(f);',
      'it("the case", async () => {',
      '  await test.step("a step", async () => {});',
      '  it("nested", () => {});',
      '  describe("inside", () => it("deeper", () => {}));',
      "});",
      'it("the next", () => expect(`it("x")`).toBe(s));',
    ].join("\n");
    expect(names(text)).toEqual(["the case", "the next"]);
  });

  it("knows a browser runner's describe and its hooks", () => {
    const text = [
      'test.describe("the page", () => {',
      "  test.describe.configure({ mode: 'serial' });",
      "  test.beforeEach(async () => {});",
      '  test("loads", async ({ page }) => {});',
      '  test.fixme("waits", async () => {});',
      "});",
    ].join("\n");
    expect(names(text)).toEqual(["the page > loads", "the page > waits"]);
  });

  it("splits a row's key at its first #, and keeps the rest as written", () => {
    expect(splitKey("a/x.test.ts")).toEqual({ path: "a/x.test.ts", name: null });
    expect(splitKey("a/x.test.ts#the # sign > counts")).toEqual({
      path: "a/x.test.ts",
      name: "the # sign > counts",
    });
  });
});

const CONTRACTS = {
  "packages/app/src/frame/contract.ts":
    'export const PLACE_IDS = ["ohbox", "history", "settings"] as const;\nexport const STAGE_IDS = ["firstRun"] as const;\n',
  "packages/app/src/settings/contract.ts":
    'export const PANE_IDS = [\n  "general",\n  "account",\n] as const;\n',
};
const mountedIn = (files: Record<string, string>) => readMounted(tree({ ...CONTRACTS, ...files }));

describe("what the mail entry mounts, read from the tree", () => {
  it("says in one line each that nothing is mounted where the mail entry's files are not in the tree", () => {
    const read = mountedIn({});
    expect([...read.mounted]).toEqual([]);
    expect(read.refusals).toEqual([]);
    expect(read.said).toHaveLength(4);
    expect([...read.targets].sort()).toContain("pane:account");
  });

  it("reads the places SEATED, the stages and panes the mail hands, and what its supplies hand beside them", () => {
    const read = mountedIn({
      "packages/app/src/mail/places.ts":
        "import { ohboxPlace } from '../ohbox/place.js';\n/** SEATED = { history } in a comment counts for nothing */\nconst SEATED: MailPlaces = {\n  ohbox: ohboxPlace,\n};\n",
      "packages/app/src/mail/stages.ts":
        "export function mailStages(parts: P): FrameStages {\n  return {\n    firstRun: firstRunStage({ ...parts.firstRun, ground: useSeat }),\n  };\n}\n",
      "packages/app/src/mail/panes.ts":
        "const PANES = { general: NONE, account: accountPane };\nexport const settings = () => settingsPlace(PANES, useBeside);\n",
      "packages/app/src/mail/supplies.ts":
        "interface Own { readonly reader: ReaderEntry | None }\nconst made = useState(() => ({ reader: own.reader }));\nreturn useMemo(() => ({ ...made, above: MailGround, calendar: NONE }), [made]);\n",
    });
    expect(read.refusals).toEqual([]);
    expect([...read.mounted].sort()).toEqual([
      "ground",
      "ohbox",
      "pane:account",
      "reader",
      "settings",
      "stage:firstRun",
    ]);
  });

  it("counts an entry that hands none as not mounted, and a stage typed as none at its binding", () => {
    const read = mountedIn({
      "packages/app/src/mail/places.ts": "const SEATED: MailPlaces = {};\n",
      "packages/app/src/mail/supplies.ts":
        "const STAGES: FrameStages = { firstRun: NONE };\nexport const s = () => ({ ...made, reader: NONE, above: MailGround });\n",
    });
    expect([...read.mounted].sort()).toEqual(["ground"]);
  });

  it("refuses a record it cannot read by its own lines, and an id that no list names", () => {
    const read = mountedIn({
      "packages/app/src/mail/places.ts": "const SEATED: MailPlaces = { ...OTHERS, ohbox: ohboxPlace };\n",
      "packages/app/src/mail/supplies.ts":
        "export const settings = (panes: SettingsPanes) => settingsPlace(panes, useBeside);\nconst STAGES: FrameStages = { welcome: welcomeStage };\n",
    });
    expect(read.refusals).toEqual([
      "old tests: packages/app/src/mail/places.ts: a spread stands in the record; write one entry a line",
      "old tests: packages/app/src/mail/supplies.ts calls settingsPlace with a record the tool cannot read; bind it to a name with its own lines",
      'old tests: the mail entry mounts "stage:welcome", which no list of ids names',
    ]);
    expect(mountedIn({ "packages/app/src/mail/places.ts": "export const x = 1;\n" }).refusals).toEqual([
      "old tests: packages/app/src/mail/places.ts holds no record SEATED; the tool cannot read the seated places",
    ]);
  });
});

describe("what every host's entry reaches", () => {
  it("reads the imports by value: never a type's, always a dynamic one, a side effect and a re-export", () => {
    const text = [
      'import type { A } from "./a";',
      'import { type B, type C } from "./b";',
      'import { type D, e } from "./d";',
      'import f from "./f";',
      'import "./g.css";',
      'export { h } from "./h";',
      'export type { I } from "./i";',
      'const j = await import("./j");',
      'const k = require("./k");',
      '// import l from "./l";',
    ].join("\n");
    expect(importsOf(text)).toEqual(["./d", "./f", "./h", "./g.css", "./j", "./k"]);
  });

  it("reads an import in time linear in its text: a run of 4,000 spaces returns at once", () => {
    const spaces = " ".repeat(4000);
    const started = performance.now();
    expect(importsOf(`export${spaces}`)).toEqual([]);
    expect(
      importsOf(`import${spaces}{ a }${spaces}from${spaces}"./a";\nexport${spaces}* from "./b";`),
    ).toEqual(["./a", "./b"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("lands a specifier: a relative path and its endings, the web's @/, and a package by its exports' source", () => {
    const present = new Set([
      "apps/webapp/app/x.ts",
      "apps/webapp/app/door/index.tsx",
      "apps/webapp/lib/y.ts",
      "packages/app/src/frame/index.ts",
      "packages/app/dist/frame/index.js",
    ]);
    const resolve = makeResolver(present, {
      "packages/app": {
        name: "@ohmail/app",
        exports: {
          "./frame": {
            types: "./src/frame/index.ts",
            node: "./dist/frame/index.js",
            "ohmail-source": "./src/frame/index.ts",
          },
        },
      },
    });
    expect(resolve("./x.js", "apps/webapp/app/page.tsx")).toBe("apps/webapp/app/x.ts");
    expect(resolve("./door", "apps/webapp/app/page.tsx")).toBe("apps/webapp/app/door/index.tsx");
    expect(resolve("@/lib/y", "apps/webapp/app/page.tsx")).toBe("apps/webapp/lib/y.ts");
    expect(resolve("@ohmail/app/frame", "apps/desktop/src/main.tsx")).toBe("packages/app/src/frame/index.ts");
    expect(resolve("@ohmail/app/mail", "apps/desktop/src/main.tsx")).toBe(null);
    expect(resolve("react", "apps/desktop/src/main.tsx")).toBe(null);
  });

  it("starts from each host's entries and follows the graph through every module, once", () => {
    const files = {
      "apps/webapp/app/(product)/mailbox/page.tsx": 'import { a } from "../../a";\n',
      "apps/webapp/app/a.ts": 'import { b } from "./b";\nexport const a = 1;\n',
      "apps/webapp/app/b.ts": 'import { a } from "./a";\nimport "./b.css";\n',
      "apps/webapp/app/b.css": "",
      "apps/webapp/app/dead.ts": 'import { a } from "./a";\n',
      "apps/desktop/src/main.tsx": "",
      "apps/paired-page/src/main.tsx": "",
      "apps/mobile/app/(tabs)/index.tsx": "",
      "apps/webapp/test/page.test.tsx": "",
    };
    const { files: list, textOf } = tree(files);
    expect(hostEntries(list).sort()).toEqual([
      "apps/desktop/src/main.tsx",
      "apps/mobile/app/(tabs)/index.tsx",
      "apps/paired-page/src/main.tsx",
      "apps/webapp/app/(product)/mailbox/page.tsx",
    ]);
    const graph = makeGraph(makeResolver(new Set(list), {}), textOf);
    expect([...graph.closure(hostEntries(list))].sort()).toEqual([
      "apps/desktop/src/main.tsx",
      "apps/mobile/app/(tabs)/index.tsx",
      "apps/paired-page/src/main.tsx",
      "apps/webapp/app/(product)/mailbox/page.tsx",
      "apps/webapp/app/a.ts",
      "apps/webapp/app/b.ts",
    ]);
  });
});

describe("the scope, read from the tree by the ruling's words", () => {
  it("takes a test that names today's shell or its views, by a path or by a join of its two segments, comments aside", () => {
    const read = readOldTestsTree({
      ...tree({
        "apps/webapp/test/a.test.tsx": `import { x } from "../${APP}/shell/x";\n`,
        "apps/webapp/test/b.test.ts": `const dir = join(root, "${APP}", "views");\n`,
        "test/c.test.ts": `const file = "apps/webapp/${APP}/views/HistoryView.tsx";\n`,
        "apps/webapp/test/d.test.ts": `// it once lived in ${APP}/shell/x\n`,
        "apps/webapp/test/e.test.ts": `const x = "${APP}/shellfish";\n`,
        "apps/webapp/app/shell-note.ts": `export const p = "${APP}/shell/x";\n`,
      }),
      manifests: {},
    });
    expect([...read.scope].sort()).toEqual([
      "apps/webapp/test/a.test.tsx",
      "apps/webapp/test/b.test.ts",
      "test/c.test.ts",
    ]);
  });

  it("takes a test that mounts through a test door, through a door's door too, and stops at a circle", () => {
    const read = readOldTestsTree({
      ...tree({
        "apps/webapp/test/_door.tsx": `export { AppShell } from "../${APP}/shell/AppShell";\n`,
        "apps/webapp/test/_outer.tsx": 'export * from "./_door";\n',
        "apps/webapp/test/_ring-a.ts": 'export * from "./_ring-b";\n',
        "apps/webapp/test/_ring-b.ts": 'export * from "./_ring-a";\n',
        "apps/webapp/test/through.test.tsx": 'import { AppShell } from "./_outer";\n',
        "apps/webapp/test/ring.test.ts": 'import "./_ring-a";\n',
        "apps/webapp/test/product.test.ts": `import { page } from "../${APP}/page";\n`,
      }),
      manifests: {},
    });
    expect([...read.scope].sort()).toEqual(["apps/webapp/test/through.test.tsx"]);
  });

  it("takes a test whose imports by value reach a file that leaves with the switch, through any module", () => {
    const read = readOldTestsTree({
      ...tree({
        "apps/webapp/app/components/Attach.tsx":
          'import { scope } from "../shell/todays-scope";\nexport const cap = 1;\n',
        "apps/webapp/app/components/Words.tsx":
          'import { locale } from "../shell/locale";\nexport const w = 1;\n',
        "apps/webapp/app/components/Typed.tsx":
          'import type { Scope } from "../shell/todays-scope";\nexport const t = 1;\n',
        [`${SHELL}/todays-scope.ts`]: "export const scope = 1;\n",
        [`${SHELL}/locale.ts`]: "export const locale = 1;\n",
        "test/attach-cap.test.ts": 'import { cap } from "../apps/webapp/app/components/Attach";\n',
        "test/words.test.ts": 'import { w } from "../apps/webapp/app/components/Words";\n',
        "test/typed.test.ts": 'import { t } from "../apps/webapp/app/components/Typed";\n',
      }),
      manifests: {},
    });
    expect([...read.scope].sort()).toEqual(["test/attach-cap.test.ts"]);
  });

  it("knows what leaves with the switch: every view, today's composition and feeds, the first run's old files", () => {
    for (const rel of [
      `${VIEWS}/OhboxView.tsx`,
      `${SHELL}/AppShell.tsx`,
      `${SHELL}/TodaysFrame.tsx`,
      `${SHELL}/todays-feeds.tsx`,
      `${SHELL}/shell-keys.tsx`,
      `${SHELL}/FirstRun.tsx`,
    ])
      expect(leavesWithTheSwitch(rel), rel).toBe(true);
    for (const rel of [`${SHELL}/locale.ts`, `${SHELL}/engine.tsx`, "packages/app/src/frame/Frame.tsx"])
      expect(leavesWithTheSwitch(rel), rel).toBe(false);
  });
});
