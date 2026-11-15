import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import ohmail, { isDoorFile } from "../../tools/eslint-plugin-ohmail/index.mjs";
import {
  borderVerdict,
  declaredVerdict,
  loadWorkspace,
} from "../../tools/eslint-plugin-ohmail/workspace.mjs";
import { linterConfig, otherLinterConfigs, runEslint } from "../../tools/lib/findings.mjs";
import type { Borders } from "../../tools/lib/table.mjs";

/** A small product: two packages with rows, a types-only pair, two apps and a test package. */
const borders: Borders = {
  packages: {
    tokens: { imports: [] },
    ui: { imports: ["tokens"] },
    engine: { imports: [] },
    app: { imports: ["ui"], typesOnly: ["engine"] },
    testing: { imports: "*" },
  },
  apps: { web: { never: ["testing"] }, server: {}, door: { apps: ["server"] } },
  tests: { alsoImport: ["testing"] },
  roots: { folders: ["test", "scripts"] },
};
const manifests = {
  ".": { name: "root", devDependencies: { vitest: "1", "@types/estree": "1" } },
  "packages/tokens": { name: "@x/tokens" },
  "packages/ui": {
    name: "@x/ui",
    dependencies: { "@x/tokens": "*", react: "19" },
    devDependencies: { "@x/testing": "*" },
  },
  "packages/engine": { name: "@x/engine" },
  "packages/app": { name: "@x/app", dependencies: { "@x/ui": "*", "@x/engine": "*" } },
  "packages/testing": { name: "@x/testing" },
  "packages/stray": { name: "@x/stray" },
  "apps/web": { name: "@x/web", dependencies: { "@x/ui": "*" } },
  "apps/server": { name: "@x/server" },
  "apps/door": { name: "@x/door", dependencies: { "@x/server": "*" } },
};
const workspace = loadWorkspace("/repo", { borders, manifests });
const value = { typeOnly: false };
const border = (file: string, source: string, how = value) =>
  borderVerdict(workspace, `/repo/${file}`, source, how);
const declared = (file: string, source: string, how = value) =>
  declaredVerdict(workspace, `/repo/${file}`, source, how);

describe("the import borders", () => {
  it("lets a package import what its row names, its own files and what is not ours", () => {
    expect(border("packages/ui/src/Button.tsx", "@x/tokens")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "@x/tokens/css")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "./icons.js")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "react")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "node:path")).toBeNull();
  });

  it("refuses a package its row does not name, by name and by path", () => {
    expect(border("packages/ui/src/Button.tsx", "@x/engine")).toBe(
      "packages/ui imports engine; its row names tokens",
    );
    expect(border("packages/ui/src/Button.tsx", "../../engine/src/index.js")).toBe(
      "packages/ui imports engine by path; its row names tokens",
    );
    expect(border("packages/tokens/src/index.ts", "@x/ui")).toBe(
      "packages/tokens imports ui; its row names nothing",
    );
  });

  it("takes a types-only package as a type and refuses its values", () => {
    expect(border("packages/app/src/frame.tsx", "@x/engine", { typeOnly: true })).toBeNull();
    expect(border("packages/app/src/frame.tsx", "@x/engine")).toMatch(
      /imports a value of engine; its row allows types only/,
    );
  });

  it("gives a test its package's row plus the test package, and no more", () => {
    expect(border("packages/ui/test/button.test.tsx", "@x/testing")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "@x/testing")).toMatch(/imports testing/);
    expect(border("packages/ui/test/button.test.tsx", "@x/engine")).toMatch(/imports engine/);
    expect(border("apps/web/test/shell.test.tsx", "@x/testing")).toBeNull();
    expect(border("apps/web/app/shell.tsx", "@x/testing")).toBe(
      "apps/web imports testing; its row refuses testing",
    );
  });

  it("never lets an app or a package import an app, but for the one row that names it", () => {
    expect(border("apps/web/app/shell.tsx", "../../server/src/index.js")).toMatch(
      /imports the app apps\/server by path; an app is never imported/,
    );
    expect(border("packages/ui/src/Button.tsx", "@x/web")).toMatch(/imports the app apps\/web/);
    expect(border("apps/door/src/handler.ts", "@x/server")).toBeNull();
  });

  it("refuses a package that has no row, and lets the repository's own checks import anything", () => {
    expect(border("apps/web/app/shell.tsx", "@x/stray")).toBe(
      "apps/web imports packages/stray, which has no row in tools/borders.json",
    );
    expect(border("test/lockfile.test.ts", "../apps/server/src/index.js")).toBeNull();
    expect(border("packages/ui/src/Button.tsx", "../../../scripts/build.mjs")).toMatch(
      /source imports only packages/,
    );
    expect(border("packages/ui/test/button.test.tsx", "../../../test/support/world.ts")).toBeNull();
  });
});

describe("the manifest", () => {
  it("passes what the manifest declares, and a builtin", () => {
    expect(declared("packages/ui/src/Button.tsx", "react")).toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "react/jsx-runtime")).toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "node:fs")).toBeNull();
  });

  it("refuses what resolves only because something else installed it", () => {
    expect(declared("packages/ui/src/Button.tsx", "lodash")).toBe(
      "lodash is not declared in packages/ui/package.json",
    );
    expect(declared("apps/web/app/shell.tsx", "@x/engine")).toBe(
      "@x/engine is not declared in apps/web/package.json",
    );
    expect(declared("apps/web/app/shell.tsx", "../../../packages/engine/src/index.js")).toMatch(
      /@x\/engine is not declared/,
    );
  });

  it("takes a development dependency for a test, a tool's config and a type, never for shipped code", () => {
    expect(declared("packages/ui/test/button.test.tsx", "vitest")).toBeNull();
    expect(declared("packages/ui/vitest.config.ts", "vitest")).toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "vitest")).toMatch(/vitest is not declared/);
    expect(declared("packages/ui/src/tree.ts", "estree", { typeOnly: true })).toBeNull();
    expect(declared("packages/ui/src/tree.ts", "estree")).toMatch(/estree is not declared/);
  });

  it("leaves an import alone that the border check already refuses", () => {
    expect(border("packages/ui/src/Button.tsx", "@x/engine")).not.toBeNull();
    expect(declared("packages/ui/src/Button.tsx", "@x/engine")).toBeNull();
  });
});

describe("the lint rules, run on source text", () => {
  const lint = (
    rule: string,
    code: string,
    options: unknown[] = [],
    filename = "/repo/packages/core/src/a.ts",
  ) => {
    const linter = new Linter({ configType: "flat", cwd: "/repo" });
    const config: Linter.Config = {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser as Linter.Parser },
      plugins: { ohmail },
      rules: { [`ohmail/${rule}`]: ["error", ...options] as Linter.RuleEntry },
    };
    const messages = linter.verify(code, [config], { filename });
    return messages
      .filter((message) => message.ruleId === `ohmail/${rule}`)
      .map((message) => message.message);
  };
  const platforms = [
    { id: "vercel", packages: ["vercel", "@vercel"], names: ["VERCEL_", "NEXT_PUBLIC_VERCEL_"] },
    { id: "railway", packages: ["railway", "@railway"], names: ["RAILWAY_"] },
  ];
  const doors = { root: "/repo", doors: ["apps/door/**", "packages/core/src/settings.ts"], platforms };

  it("refuses a platform's name as a property, a key, a string and a package, in every import form", () => {
    expect(lint("platform-name", "export const a = process.env.VERCEL_ENV;", [doors])).toEqual([
      expect.stringMatching(/^VERCEL_ENV is a hosting platform's own name/),
    ]);
    expect(
      lint("platform-name", "const { RAILWAY_REPLICA_ID: id } = process.env; export { id };", [doors]),
    ).toHaveLength(1);
    expect(lint("platform-name", 'export const key = "RAILWAY_REPLICA_ID";', [doors])).toHaveLength(1);
    expect(lint("platform-name", "export const key = `NEXT_PUBLIC_VERCEL_URL`;", [doors])).toHaveLength(1);
    expect(
      lint("platform-name", 'import { waitUntil } from "@vercel/functions"; export { waitUntil };', [doors]),
    ).toHaveLength(1);
    expect(lint("platform-name", 'export const load = () => import("@railway/cli");', [doors])).toHaveLength(
      1,
    );
    expect(lint("platform-name", 'export const sdk = require("railway");', [doors])).toHaveLength(1);
  });

  it("passes the product's own names, a comment, and a door file", () => {
    expect(
      lint("platform-name", "export const token = process.env.TF_SIGNAL_VERCEL_TOKEN;", [doors]),
    ).toEqual([]);
    expect(
      lint("platform-name", 'export const VERCEL_REQUEST_LOGS_URL = "https://example.invalid";', [doors]),
    ).toEqual([]);
    expect(lint("platform-name", "// reads VERCEL_ENV on that host\nexport const a = 1;", [doors])).toEqual(
      [],
    );
    expect(lint("platform-name", 'import { verse } from "vercelish"; export { verse };', [doors])).toEqual(
      [],
    );
    expect(
      lint(
        "platform-name",
        "export const a = process.env.VERCEL_ENV;",
        [doors],
        "/repo/apps/door/src/config.ts",
      ),
    ).toEqual([]);
    expect(
      lint(
        "platform-name",
        "export const a = process.env.VERCEL_ENV;",
        [doors],
        "/repo/packages/core/src/settings.ts",
      ),
    ).toEqual([]);
  });

  it("refuses every file when it has no list of door files, or no platform to look for", () => {
    const empty = { id: "nothing", packages: [], names: [] };
    for (const options of [
      [],
      [{ root: "/repo", doors: [], platforms }],
      [{ root: "/repo", doors: doors.doors }],
      [{ root: "/repo", doors: doors.doors, platforms: [] }],
      [{ root: "/repo", doors: doors.doors, platforms: [empty] }],
    ]) {
      expect(lint("platform-name", "export const a = 1;", options)).toEqual([
        expect.stringMatching(/so every file is refused/),
      ]);
    }
  });

  it("looks for the platforms its list names, and for no other", () => {
    const one = { ...doors, platforms: [{ id: "acme", packages: ["@acme"], names: ["ACME_"] }] };
    expect(lint("platform-name", "export const a = process.env.ACME_REGION;", [one])).toHaveLength(1);
    expect(lint("platform-name", 'import "@acme/edge";', [one])).toHaveLength(1);
    expect(lint("platform-name", "export const a = process.env.ACME_;", [one])).toEqual([]);
    expect(lint("platform-name", "export const a = process.env.ACME_region;", [one])).toEqual([]);
    expect(lint("platform-name", "export const a = process.env.VERCEL_ENV;", [one])).toEqual([]);
    expect(lint("platform-name", 'import "acme";', [one])).toEqual([]);
  });

  it("matches a door by its file or by its folder, never by a prefix of a name", () => {
    expect(isDoorFile("apps/door/src/a.ts", doors.doors)).toBe(true);
    expect(isDoorFile("apps/doorway/src/a.ts", doors.doors)).toBe(false);
    expect(isDoorFile("packages/core/src/settings.ts", doors.doors)).toBe(true);
    expect(isDoorFile("packages/core/src/settings.test.ts", doors.doors)).toBe(false);
  });

  it("lets wire export types and refuses every value", () => {
    const types =
      'export type Kind = "mail" | "event";\nexport interface Ask { kind: Kind }\nexport type { Other } from "./other.js";\nexport type * from "./more.js";';
    expect(lint("wire-exports-no-value", types)).toEqual([]);
    for (const code of [
      "export const version = 1;",
      "export function make() {}",
      "export enum Kind { Mail }",
      "export default {};",
      'export * from "./other.js";',
      'export { make } from "./other.js";',
      "const a = 1; export { a };",
    ]) {
      expect(lint("wire-exports-no-value", code), code).toEqual([
        expect.stringMatching(/^wire exports no value/),
      ]);
    }
  });

  it("refuses a comment that switches a rule off, and leaves other comments alone", () => {
    expect(
      lint("no-inline-config", "// eslint-disable-next-line no-empty\nexport const a = 1;"),
    ).toHaveLength(1);
    // A blanket switch-off silences what follows it, but not the finding on its own first line.
    expect(
      lint("no-inline-config", "/* eslint-disable */\nexport const a = 1;\n/* eslint-enable */"),
    ).toHaveLength(1);
    expect(lint("no-inline-config", "export const a = 1;\n/* eslint-enable */")).toHaveLength(1);
    expect(lint("no-inline-config", "/* eslint no-empty: off */\nexport const a = 1;")).toHaveLength(1);
    expect(lint("no-inline-config", "// eslint is not switched off here\nexport const a = 1;")).toEqual([]);
  });
});

describe("the linter as the check runs it", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  /** A small tree of its own: `files` written under a new folder, the linter's configuration among them. */
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ohmail-tools-"));
    made.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    return root;
  };
  const CONFIG = [
    "export default [{",
    '  files: ["**/*.mjs"],',
    '  linterOptions: { reportUnusedDisableDirectives: "error" },',
    '  rules: { "no-var": "error" },',
    "}];",
  ].join("\n");
  const rulesOf = async (root: string, ...rels: string[]) =>
    (
      await runEslint(
        root,
        rels.map((rel) => path.join(root, rel)),
      )
    ).map((f) => `${f.path} ${f.rule}`);

  it("counts a finding that a comment in the file switched off", async () => {
    const root = tree({
      "eslint.config.mjs": CONFIG,
      "plain.mjs": "var a = 1;\nexport { a };\n",
      "next-line.mjs": "// eslint-disable-next-line no-var\nvar a = 1;\nexport { a };\n",
      "blanket.mjs": "/* eslint-disable */\nvar a = 1;\nexport { a };\n",
      "inert.mjs": "// eslint-disable-next-line no-var\nexport const a = 1;\n",
    });
    expect(await rulesOf(root, "plain.mjs", "next-line.mjs", "blanket.mjs", "inert.mjs")).toEqual([
      "plain.mjs no-var",
      "next-line.mjs no-var",
      "blanket.mjs no-var",
      "inert.mjs eslint:unused-directive",
    ]);
  });

  it("refuses a comment that sets a rule, also one that sets the rule against such comments", async () => {
    const root = tree({
      "eslint.config.mjs": CONFIG,
      "set.mjs": "/* eslint no-var: off */\nvar a = 1;\nexport { a };\n",
      "set-both.mjs": "/* eslint ohmail/no-config-comment: off, no-var: off */\nvar a = 1;\nexport { a };\n",
      "said.mjs": 'export const said = "/* eslint no-var: off */";\n// eslint is a word here\n',
    });
    // The second file is refused twice: its comment also names a rule the configuration does not carry.
    expect(await rulesOf(root, "set.mjs", "set-both.mjs", "said.mjs")).toEqual([
      "set-both.mjs eslint:unused-directive",
      "set.mjs ohmail/no-config-comment",
      "set-both.mjs ohmail/no-config-comment",
    ]);
  });

  it("reads eslint.config.mjs alone, whatever other configuration stands beside it", async () => {
    const root = tree({
      "eslint.config.mjs": CONFIG,
      "eslint.config.js": 'module.exports = [{ files: ["**/*.mjs"], rules: { "no-var": "off" } }];\n',
      "plain.mjs": "var a = 1;\nexport { a };\n",
    });
    expect(await rulesOf(root, "plain.mjs")).toEqual(["plain.mjs no-var"]);
    expect(
      otherLinterConfigs(["eslint.config.mjs", "package.json", "eslint.config.js", "eslint.config.cts"]),
    ).toEqual([
      "config: eslint.config.cts stands beside eslint.config.mjs; the linter has one configuration file",
      "config: eslint.config.js stands beside eslint.config.mjs; the linter has one configuration file",
    ]);
    expect(otherLinterConfigs(["eslint.config.mjs", "stylelint.config.mjs"])).toEqual([]);
  });

  it("says which package a border finding reached", async () => {
    const plugin = pathToFileURL(path.resolve("tools/eslint-plugin-ohmail/index.mjs")).href;
    const root = tree({
      "eslint.config.mjs": [
        `import ohmail from ${JSON.stringify(plugin)};`,
        "export default [{",
        '  files: ["**/*.mjs"],',
        "  plugins: { ohmail },",
        '  rules: { "ohmail/package-borders": ["error", { root: import.meta.dirname }] },',
        "}];",
      ].join("\n"),
      "tools/borders.json": JSON.stringify({
        packages: { ui: { imports: [] }, engine: { imports: [] } },
        apps: { web: {}, server: {} },
      }),
      "packages/ui/package.json": '{ "name": "@x/ui" }',
      "packages/engine/package.json": '{ "name": "@x/engine" }',
      "apps/server/package.json": '{ "name": "@x/server" }',
      "packages/ui/src/a.mjs":
        'import "@x/engine";\nimport "../../../apps/server/src/index.mjs";\nimport "node:fs";\n',
      "packages/loose/src/a.mjs": "export const a = 1;\n",
    });
    const findings = await runEslint(root, [
      path.join(root, "packages/ui/src/a.mjs"),
      path.join(root, "packages/loose/src/a.mjs"),
    ]);
    expect(findings.map((f) => [f.path, f.rule, f.reach, f.line])).toEqual([
      ["packages/ui/src/a.mjs", "ohmail/package-borders", "engine", 1],
      ["packages/ui/src/a.mjs", "ohmail/package-borders", "apps/server", 2],
      ["packages/loose/src/a.mjs", "ohmail/package-borders", undefined, 1],
    ]);
  });
});

/** The two switches of a Next.js configuration this file reads (the root manifest does not declare next). */
type NextBuildSwitches = {
  eslint?: { ignoreDuringBuilds?: boolean };
  typescript?: { ignoreBuildErrors?: boolean };
};

describe("the one linter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is the check: the web builds lint nothing, and the check reads the web app", async () => {
    vi.stubEnv("NEXT_PUBLIC_GITHUB_STARS", "1");
    const load = async (app: string): Promise<unknown> =>
      (await import(pathToFileURL(path.resolve("apps", app, "next.config.mjs")).href)).default;
    const web = (await load("webapp")) as () => Promise<NextBuildSwitches>;
    const api = (await load("api-vercel")) as NextBuildSwitches;
    for (const config of [await web(), api]) {
      expect(config.eslint?.ignoreDuringBuilds).toBe(true);
      expect(config.typescript?.ignoreBuildErrors).not.toBe(true);
    }

    const root = path.resolve(".");
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: root, overrideConfigFile: linterConfig(root), warnIgnored: false });
    const [result] = await eslint.lintText(
      'import { a } from "../../worker/src/a.js";\n// eslint-disable-next-line no-console\nexport const b = a;\n',
      { filePath: path.join(root, "apps/webapp/app/planted.tsx") },
    );
    expect(result?.messages.map((m) => `${m.line} ${m.ruleId ?? "directive"}`)).toEqual([
      "1 ohmail/package-borders",
      "2 directive",
    ]);
  });
});
