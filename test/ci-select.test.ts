// @services: none — plants trees and git repositories, and reads this one's files
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAP_JOBS, CAP_S, DIRECT_BASES, MAX_SHARDS, SQLITE_CAP_S, TARGET_S, WHOLE_SHARE, admittedLock, admittedManifest, admittedTsconfig, admittedVitestAlias, areaOf,
  composeOutputs, decideScope, deferredLog, directBase, directSet, eventWhole, isJudge, namedPaths, packFiles, parseNameStatus, pathTriggers,
  planProblems, readerHits, readersOf, relatedInputs, select, setupClosure, sourceEntries, stripComments, summaryText, versionOnly,
  vitestGraph, type Ctx, type GraphOptions, type Plan, type Tree,
} from "../.github/scripts/ci-select.mjs";
import { testFiles } from "./support/ci-shards.mjs";
import { relativeImports } from "./support/service-needs.mjs";

/**
 * WHAT A PULL REQUEST'S RUN TESTS (.github/scripts/ci-select.mjs). A maintainer's pull request runs the
 * test files its diff can reach; the nightly, dispatch, a batch branch, a fork, a bot and a harness change
 * run the whole suite, and so does any fault of the selector. Each rule is held on a planted tree or
 * repository, and the reader rules on this tree's own censuses. A pull request into next runs the direct
 * set and names what it leaves to the whole run on next, a harness change that only adds a package's lines
 * among it; test/fixtures/ci-select-history holds the changed paths of the last pull requests (README.md
 * there), which both bases plan here.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELECT = join(ROOT, ".github/scripts/ci-select.mjs");
const scratch = mkdtempSync(join(tmpdir(), "ohmail-ci-select-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const plantTree = (files: Record<string, string>): string => {
  const dir = join(scratch, `t${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
};

/** A maintainer's pull request from a pr/ branch of this repository. */
const pr = (over: Record<string, unknown> = {}, top: Partial<Ctx> = {}): Ctx => ({
  event_name: "pull_request", actor: "maintainer", triggering_actor: "maintainer", repository: "trafficflowhq/ohmail",
  event: {
    pull_request: {
      head: { ref: "pr/x", repo: { full_name: "trafficflowhq/ohmail" } }, base: { ref: "main" },
      user: { type: "User" }, author_association: "OWNER", ...over,
    },
  },
  ...top,
});
const M = (p: string) => ({ s: "M", p });

/** A planted pull request: a base commit, a head commit (its files written over the base's, `gone` removed),
 *  and the merge GitHub checks out. */
const plantPr = (base: Record<string, string>, head: Record<string, string>, gone: string[] = []) => {
  const dir = plantTree(base);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("checkout", "-q", "-b", "pr/x");
  for (const [rel, text] of Object.entries(head)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  for (const rel of gone) rmSync(join(dir, rel));
  g("add", "-A");
  g("commit", "-q", "-m", "head");
  const headSha = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  g("merge", "-q", "--no-ff", "-m", "merge", "pr/x");
  return { dir, headSha };
};
/** The event of a planted pull request into `base`. */
const merged = (sha: string, base = "main") => pr({ number: 811, base: { ref: base }, head: { ref: "pr/x", repo: { full_name: "trafficflowhq/ohmail" }, sha } });
/** The kinds of file the base's search reads, as git grep's pathspecs name them; vitest.config.ts itself is left out. */
const SEARCHED = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|html)$/;
/** One side of a pull request as a map of its files; `dirs` are the apps and packages that side holds beside them.
 *  It answers whether it names a text from its own files, or from `names` where a fixture recorded the base's
 *  answers (a text it did not record reads as named). */
const tree = (files: Record<string, string>, dirs: string[] = [], names?: Record<string, boolean>): Tree => ({
  read: (p) => files[p] ?? null,
  exists: (p) => dirs.includes(p) || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
  names: (text) => (names ? names[text] ?? true : Object.entries(files).some(([p, t]) => p !== "vitest.config.ts" && SEARCHED.test(p) && t.includes(text))),
});

describe("the scope: who runs the whole suite", () => {
  it("selects for a maintainer's pr/ branch, and runs every other run whole with its reason", () => {
    expect(eventWhole(pr())).toBeNull();
    expect(decideScope({ root: ROOT, ctx: pr(), changes: [M("apps/webapp/app/views/OhboxView.tsx")] }).scope).toBe("selected");
    /* next, the second long-lived line, is a base like main: a maintainer's pull request into it runs the selected set. */
    const intoNext = pr({ base: { ref: "next" } });
    expect(eventWhole(intoNext)).toBeNull();
    expect(decideScope({ root: ROOT, ctx: intoNext, changes: [M("apps/webapp/app/views/OhboxView.tsx")] }).scope).toBe("selected");
    const cases: Array<[string, Ctx, RegExp]> = [
      ["schedule", pr({}, { event_name: "schedule" }), /a schedule run is whole/],
      ["dispatch", pr({}, { event_name: "workflow_dispatch" }), /a workflow_dispatch run is whole/],
      ["a batch branch", pr({ head: { ref: "pr/batch-g", repo: { full_name: "trafficflowhq/ohmail" } } }), /batch branch/],
      ["a fork", pr({ head: { ref: "pr/x", repo: { full_name: "someone/ohmail" } } }), /not a branch of this repository/],
      ["a null head repository", pr({ head: { ref: "pr/x", repo: null } }), /not a branch of this repository/],
      ["a Bot user", pr({ user: { type: "Bot" } }), /not opened by a person/],
      ["a [bot] actor", pr({}, { actor: "dependabot[bot]" }), /a bot started the run/],
      ["a [bot] triggering actor", pr({}, { triggering_actor: "renovate[bot]" }), /a bot started the run/],
      ["a contributor", pr({ author_association: "CONTRIBUTOR" }), /not an owner, member or collaborator/],
      ["a docs/x head", pr({ head: { ref: "docs/x", repo: { full_name: "trafficflowhq/ohmail" } } }), /not a pr\/ branch/],
      ["a base that is neither main nor next", pr({ base: { ref: "release" } }), /the base is not main or next/],
      ["a base that only starts like next", pr({ base: { ref: "next-2" } }), /the base is not main or next/],
    ];
    for (const [what, ctx, why] of cases) {
      const s = decideScope({ root: ROOT, ctx, changes: [M("apps/webapp/app/views/OhboxView.tsx")] });
      expect(s.scope, what).toBe("whole");
      expect(s.why, what).toMatch(why);
    }
  });

  it("gives the direct set to a maintainer's pull request into next alone, and never to main merged across", () => {
    const own = { full_name: "trafficflowhq/ohmail" };
    expect(DIRECT_BASES).toEqual(["next"]);
    expect(directBase(pr({ base: { ref: "next" } }))).toBe("next");
    const across = pr({ base: { ref: "next" }, head: { ref: "pr/merge-main-20261114", repo: own } });
    const reach: Array<[string, Ctx]> = [
      ["into main", pr()],
      ["main merged across into next", across],
      ["a base that only starts like next", pr({ base: { ref: "next-2" } })],
      ["a release base", pr({ base: { ref: "release" } })],
      ["no base", pr({ base: undefined })],
      ["a dispatch on next", pr({ base: { ref: "next" } }, { event_name: "workflow_dispatch" })],
      ["a schedule", pr({ base: { ref: "next" } }, { event_name: "schedule" })],
      ["a fork into next", pr({ base: { ref: "next" }, head: { ref: "pr/x", repo: { full_name: "someone/ohmail" } } })],
      ["a bot into next", pr({ base: { ref: "next" } }, { actor: "dependabot[bot]" })],
      ["a batch branch into next", pr({ base: { ref: "next" }, head: { ref: "pr/batch-g", repo: own } })],
    ];
    for (const [what, ctx] of reach) expect(directBase(ctx), what).toBeNull();
    // Merged across, main's whole delta meets next's own code: it is selected as a pull request into main is.
    expect(eventWhole(across)).toBeNull();
  });

  it("plans build-only for a maintainer's landing round into next", () => {
    const repo = { full_name: "trafficflowhq/ohmail" };
    const head = { ref: "pr/round-example", repo };
    const intoNext = { base: { ref: "next" }, head };
    const changes = [M(".github/workflows/ci.yml")];
    const scope = (ctx: Ctx) => decideScope({ root: ROOT, ctx, changes }).scope;

    expect(scope(pr({ ...intoNext, head: { ref: "pr/batch-example", repo } }))).toBe("whole");
    expect(scope(pr({ head }))).toBe("whole");
    expect(scope(pr({ ...intoNext, head: { ...head, repo: { full_name: "someone/ohmail" } } }))).toBe("whole");
    expect(scope(pr(intoNext, { triggering_actor: "renovate[bot]" }))).toBe("whole");
    expect(scope(pr(intoNext))).toBe("build-only");
  });

  it("prints its decision as two output lines, from the event and a name-status file", () => {
    const at = join(scratch, "changes.tsv");
    writeFileSync(at, "M\tapps/webapp/app/views/OhboxView.tsx\n");
    const run = (ctx: Ctx) => spawnSync(process.execPath, [SELECT, "scope", "--root", ROOT, "--event", JSON.stringify(ctx), "--files", at], { encoding: "utf8" });
    expect(run(pr()).stdout).toBe("scope=selected\nwhy=1 changed path(s)\n");
    expect(run(pr({}, { event_name: "schedule" })).stdout).toBe("scope=whole\nwhy=a schedule run is whole\n");
  });
});

describe("the scope: the paths that make a pull request whole", () => {
  const whole = (p: string, s = "M") => decideScope({ root: ROOT, ctx: pr(), changes: [{ s, p }] });

  it("computes the harness from test/setup's own imports", () => {
    expect(setupClosure(ROOT)).toEqual([
      "packages/db/src/test-services.ts", "packages/db/src/testing.ts", "scripts/lib/lane-greenmail-env.mjs",
      "scripts/lib/pg-url-own.mjs", "test/support/ci-shards.mjs", "test/support/service-needs.mjs", "test/support/services.ts",
    ]);
  });

  it("runs whole for each trigger class, and selects for its neighbours", () => {
    const triggers: Array<[string, RegExp, string?]> = [
      ["patches/some-dep@1.0.0.patch", /a dependency patch/],
      ["scripts/apply-patches.mjs", /a dependency patch/],
      ["tsconfig.base.json", /a tsconfig/],
      ["packages/core/tsconfig.json", /a tsconfig/],
      ["vitest.config.ts", /the vitest config/],
      ["test/setup/services.global.ts", /the test harness/],
      ["test/support/services.ts", /the test harness/],
      ["packages/db/src/testing.ts", /the test harness/],
      ["scripts/lib/pg-url-own.mjs", /the test harness/],
      ["test/support/ci-shards.json", /the shard map/],
      ["test/support/ci-shards-sqlite.json", /the shard map/],
      [".github/workflows/ci.yml", /the suite workflow or its selector/],
      [".github/scripts/ci-select.mjs", /the suite workflow or its selector/],
      ["scripts/lane-db.sh", /the lane database/],
      ["scripts/lane-db.mjs", /the lane database/],
      ["packages/db/drizzle/0999_planted.sql", /a migration/],
      ["packages/db-mail/drizzle-sqlite/0999_planted.sql", /a migration/],
      ["apps/webapp/app/views/OhboxView.tsx", /deleted or renamed/, "D"],
      ["apps/webapp/app/views/OhboxView.tsx", /change kind T/, "T"],
      ["apps/webapp/app/a file.ts", /a changed path outside/],
    ];
    for (const [p, why, s] of triggers) {
      const got = whole(p, s);
      expect(got.scope, p).toBe("whole");
      expect(got.why, p).toMatch(why);
    }
    for (const p of ["apps/webapp/app/views/OhboxView.tsx", "docs/README.md", "test/support/public-root.mjs", "packages/db/src/schema-mail.ts"]) {
      expect(whole(p).scope, p).toBe("selected");
    }
    // A deleted test file is no trigger: nothing imports a test file.
    expect(whole("packages/core/test/planted-gone.test.ts", "D").scope).toBe("selected");
    // A deleted module anywhere is: vitest cannot relate a file that is gone to what still imports it.
    for (const p of ["packages/api/test/_forward-world.ts", "test/support/key-ring-env.ts", "scripts/lib/source-scan.mjs", "packages/core/test/fixtures/planted.json"]) {
      expect(whole(p, "D"), p).toMatchObject({ scope: "whole", why: `${p}: deleted or renamed` });
    }
    // A deleted file that is no module selects its readers by name.
    for (const p of ["docs/organizer-profile.md", "packages/core/test/fixtures/planted.eml"]) expect(whole(p, "D").scope, p).toBe("selected");
    // A Next route group is a whole segment in parentheses; parentheses in any other shape stay whole.
    expect(whole("apps/webapp/app/(product)/mailbox/CloudShell.tsx").scope).toBe("selected");
    for (const p of ["apps/webapp/app/(product$(id))/x.ts", "apps/webapp/app/(a);id/x.ts", "apps/webapp/app/(a b)/x.ts", "apps/webapp/app/((a))/x.ts", "apps/webapp/app/x(1).ts", "apps/webapp/app/(a)`id`/x.ts", "apps/webapp/app/()/x.ts"]) {
      expect(whole(p), p).toMatchObject({ scope: "whole", why: "a changed path outside [A-Za-z0-9@._/+-] and (group) segments" });
    }
  });

  it("makes only the SQLite run whole for its config, and selects every Dovecot file for test/dovecot", () => {
    const sq = whole("vitest.sqlite.config.ts");
    expect(sq).toMatchObject({ scope: "selected", sqliteWhole: true, dovecotAll: false });
    expect(whole("test/dovecot/dovecot.conf")).toMatchObject({ scope: "selected", sqliteWhole: false, dovecotAll: true });
  });

  const manifest = (version: string, deps: Record<string, string>) => `${JSON.stringify({ name: "p", version, dependencies: deps }, null, 2)}\n`;
  const lock = (version: string, dep: string) => `${JSON.stringify({
    name: "p", version, lockfileVersion: 3, packages: {
      "": { name: "p", version, workspaces: ["packages/w"] }, "packages/w": { name: "w", version },
      "node_modules/dep": { version: dep, resolved: `https://registry.example.invalid/dep-${dep}.tgz` },
    },
  }, null, 2)}\n`;

  it("selects for a version-only manifest and lockfile change, and runs a dependency change whole", () => {
    const base = { "package.json": manifest("1.0.0", { dep: "1.0.0" }), "package-lock.json": lock("1.0.0", "1.0.0"), "packages/w/package.json": manifest("1.0.0", {}) };
    const bump = plantPr(base, { "package.json": manifest("1.1.0", { dep: "1.0.0" }), "package-lock.json": lock("1.1.0", "1.0.0"), "packages/w/package.json": manifest("1.1.0", {}) });
    const ctx = (sha: string) => merged(sha);
    const s = decideScope({ root: bump.dir, ctx: ctx(bump.headSha) });
    expect(s.scope, s.why).toBe("selected");
    expect(s.changes!.map((c) => c.p).sort()).toEqual(["package-lock.json", "package.json", "packages/w/package.json"]);
    // The positive control: the same files with a dependency moved.
    const dep = plantPr(base, { "package.json": manifest("1.1.0", { dep: "1.0.1" }), "package-lock.json": lock("1.1.0", "1.0.1") });
    const d = decideScope({ root: dep.dir, ctx: ctx(dep.headSha) });
    expect(d.scope).toBe("whole");
    expect(d.why).toMatch(/: a dependency change/);
    expect(versionOnly(lock("1.0.0", "1.0.0"), lock("2.0.0", "1.0.0"))).toBe(true);
    expect(versionOnly(lock("1.0.0", "1.0.0"), lock("1.0.0", "1.0.1"))).toBe(false);
    // A checkout that is not the pull request's merge commit is not read.
    expect(decideScope({ root: bump.dir, ctx: ctx("0".repeat(40)) })).toMatchObject({ scope: "whole", why: "the diff cannot be read" });
  });

  it("runs whole when HEAD^1 is missing, and reads -z and plain name-status alike", () => {
    const dir = plantTree({ "a.txt": "a\n" });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    expect(decideScope({ root: dir, ctx: pr() })).toEqual({ scope: "whole", why: "the diff cannot be read" });
    expect(parseNameStatus("M\0a/b.ts\0D\0c.ts\0")).toEqual([{ s: "M", p: "a/b.ts" }, { s: "D", p: "c.ts" }]);
    expect(parseNameStatus("M\ta/b.ts\nA\tc.ts\n")).toEqual([{ s: "M", p: "a/b.ts" }, { s: "A", p: "c.ts" }]);
  });
});

describe("the graph: vitest's own related set", () => {
  it("follows an alias, a barrel, a JSON import and a literal dynamic import, and only what imports the change", async () => {
    const dir = plantTree({
      "package.json": '{ "name": "mini", "version": "1.0.0" }\n',
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/index.ts": 'export * from "./a";\nexport * from "./b";\n',
      "test/a.test.ts": 'import { a } from "../src/a";\nexport const x = a;\n',
      "test/b.test.ts": 'import { b } from "../src/b";\nexport const x = b;\n',
      "test/barrel.test.ts": 'import { a } from "@mini";\nexport const x = a;\n',
      "test/dyn.test.ts": 'export const load = () => import("../src/a");\n',
      "test/pkg.test.ts": 'import pkg from "../package.json";\nexport const v = pkg.version;\n',
    });
    const opts = { config: false as const, overrides: { include: ["test/**/*.test.ts"], alias: { "@mini": join(dir, "src/index.ts") } } };
    const a = await vitestGraph(dir, ["src/a.ts"], opts);
    expect(a.related).toEqual(["test/a.test.ts", "test/barrel.test.ts", "test/dyn.test.ts"]);
    expect(a.all).toHaveLength(5);
    expect((await vitestGraph(dir, ["package.json"], opts)).related).toEqual(["test/pkg.test.ts"]);
    // The control: vitest's default triggers turn a package.json into every file.
    expect((await vitestGraph(dir, ["package.json"], { ...opts, defaultTriggers: true })).related).toHaveLength(5);
  }, 60_000);

  it("names the source modules whose import closure reaches a change, through an alias and a dynamic import", async () => {
    const dir = plantTree({
      "package.json": '{ "name": "mini", "version": "1.0.0" }\n',
      "src/entry.ts": 'import { b } from "@mini/b";\nexport const e = b;\n',
      "src/b.ts": 'export const b = () => import("./c");\n',
      "src/c.ts": "export const c = 1;\n",
      "src/leaf.ts": "export const leaf = 1;\n",
      "src/other.ts": "export const o = 1;\n",
      // A census that reads the entry by path and imports nothing: vitest's graph never relates it.
      "test/census.test.ts": 'import { readFileSync } from "node:fs";\nexport const src = readFileSync(new URL("../src/entry.ts", import.meta.url), "utf8");\n',
    });
    const opts = { config: false as const, overrides: { include: ["test/**/*.test.ts"], alias: { "@mini/b": join(dir, "src/b.ts") } }, entries: ["src/entry.ts", "src/leaf.ts"] };
    const c = await vitestGraph(dir, ["src/c.ts"], opts);
    expect(c.related).toEqual([]);
    expect(c.reached).toEqual(["src/entry.ts"]);
    expect((await vitestGraph(dir, ["src/other.ts"], opts)).reached).toEqual([]);
    // Without vitest's own related listing, the closures alone.
    expect((await vitestGraph(dir, ["src/c.ts"], { ...opts, list: false })).reached).toEqual(["src/entry.ts"]);
  }, 60_000);

  it("rejects on a config that throws, and the plan job then runs whole", async () => {
    const dir = plantTree({ "vitest.config.ts": 'throw new Error("planted config fault");\n', "packages/q/src/x.ts": "export {};\n", "packages/q/test/x.test.ts": "export {};\n" });
    await expect(vitestGraph(dir, ["packages/q/src/x.ts"], { config: "vitest.config.ts" })).rejects.toThrow();
    const files = join(scratch, "q.tsv");
    writeFileSync(files, "M\tpackages/q/src/x.ts\n");
    const out = join(scratch, "q-plan.json");
    const cli = spawnSync(process.execPath, [SELECT, "select", "--root", dir, "--event", JSON.stringify(pr()), "--files", files, "--out", out], { encoding: "utf8" });
    expect(cli.status).not.toBe(0);
    expect(composeOutputs({ indexes: [0, 1], sqliteIndexes: [0], alone: [], scope: "selected", scopeWhy: "", selectOutcome: "failure", plan: null }))
      .toMatchObject({ scope: "whole", why: "the selector did not finish (failure)", shards: [{ shard: 0 }, { shard: 1 }], sqlite: [{ shard: 0 }] });
  }, 60_000);
});

describe("the readers: test files that read the tree by path", () => {
  const helper = 'import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nexport const guide = () => readFileSync(join(process.cwd(), "docs/guide.md"), "utf8");\n';
  const head = 'import { readFileSync, readdirSync, existsSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\nimport { dirname, join, resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst HERE = dirname(fileURLToPath(import.meta.url));\n';
  const tree: Record<string, string> = {
    "docs/guide.md": "x\n", "docs/other.md": "x\n", "deploy/selfhost/compose.yml": "x\n", ".github/workflows/x.yml": "x\n",
    "scripts/tool.mjs": "x\n", "scripts/other.sh": "x\n",
    "packages/p1/src/x.ts": "export {};\n", "packages/p1/test/join.test.ts": `${head}readdirSync(join(HERE, "..", "src"));\n`,
    "packages/p2/src/x.ts": "export {};\n", "packages/p2/test/url.test.ts": `${head}readdirSync(new URL("../src/", import.meta.url));\n`,
    "packages/p3/test/literal.test.ts": `${head}readFileSync(join(HERE, "../../..", "deploy/selfhost/compose.yml"));\n`,
    "packages/p4/test/public.test.ts": `${head}import { publicPath } from "./_root";\nreadFileSync(publicPath("github/workflows/x.yml"));\n`,
    "packages/p4/test/_root.ts": "export const publicPath = (p: string) => p;\n",
    "packages/p4/test/held.test.ts": 'import { guide } from "./_guide";\nexport const g = guide;\n',
    "packages/p4/test/_guide.ts": helper,
    "packages/p5/test/scan.test.ts": `${head}readdirSync(HERE);\n`, "packages/p5/test/fixture.txt": "x\n",
    "packages/p6/src/z.ts": "export {};\n", "packages/p6/test/anchored.test.ts": `${head}export const read = (name: string) => readFileSync(new URL(name, import.meta.url));\n`,
    "packages/p7/test/dots.test.ts": `${head}export const up = resolve(HERE, "..", "..");\nreadFileSync(join(up, process.env.X ?? ""));\n`,
    "packages/p7/src/y.ts": "export {};\n",
    "packages/p8/test/git.test.ts": `${head}execFileSync("git", ["ls-files"]);\n`,
    "packages/p9/test/bundle.test.ts": `${head}existsSync(join(HERE, "../../../build/engine/engine.js"));\n`,
    "packages/pa/test/fixtures/mail.eml": "x\n", "packages/pa/test/reader.test.ts": `${head}readFileSync(join(HERE, "data.json"));\n`, "packages/pa/test/data.json": "{}\n",
    "packages/pb/test/fixtures/named.eml": "x\n", "packages/pb/test/names.test.ts": `${head}readFileSync(join(HERE, "fixtures/named.eml"));\n`,
    "packages/pb/test/other.test.ts": `${head}readFileSync(join(HERE, "data.json"));\n`, "packages/pb/test/data.json": "{}\n",
    "packages/pc/test/scripts.test.ts": `${head}readFileSync(join(HERE, "../../../scripts/tool.mjs"));\n`,
    "packages/pd/test/plain.test.ts": "export const one = 1;\n",
    // Names of a file and a directory the pull request deletes.
    "packages/pe/test/gone.test.ts": `${head}readFileSync(join(HERE, "../../../docs/gone.md"));\nexistsSync(join(HERE, "../../pz/gone"));\n`,
    // Template literals: the directory of the static prefix; never a bare top-level directory or dots.
    "packages/pf/views/V.tsx": "export {};\n", "apps/web/messages/en.json": "{}\n",
    "packages/pf/test/tpl.test.ts": `${head}export const v = (n: string) => readFileSync(join(HERE, \`../views/\${n}.tsx\`));\n`
      + "export const m = (l: string) => readFileSync(`apps/web/messages/${l}.json`);\n"
      + "export const b = (a: string) => readFileSync(`apps/${a}/x`);\nexport const d = (a: string) => readFileSync(join(HERE, `../${a}`));\n",
    // An array of literals joined into one path.
    "packages/pg/src/a.ts": "export {};\n",
    "packages/pg/test/arr.test.ts": `${head}import { sep } from "node:path";\nconst F = ["packages", "pg", "src", "a.ts"].join(sep);\nreadFileSync(F);\n`,
    // An import specifier is no name: the anchored reader names nothing and so its own package.
    "packages/ph/src/h.ts": "export {};\n",
    "packages/ph/test/imp.test.ts": `${head}import * as tool from "../../../scripts/tool.mjs";\nexport const t = tool;\nexport const r = (n: string) => readFileSync(new URL(n, import.meta.url));\n`,
    // An anchored scanner names its own package, whatever else it names; its area's unclaimed files stay unclaimed.
    "packages/pi/src/s.ts": "export {};\n", "packages/pi/test/fixtures/a.txt": "x\n", "packages/pi/assets/c.txt": "x\n",
    "packages/pi/test/census.test.ts": `${head}readdirSync(join(HERE, "fixtures"));\nreadFileSync(join(HERE, "../../../docs/guide.md"));\n`,
    "packages/pi/test/near.test.ts": `${head}readFileSync(join(HERE, "../../../docs/other.md"));\nreadFileSync(join(HERE, process.env.F ?? ""));\n`,
    // A workspace's tsc output, and a spawned child's own imports.
    "packages/pj/test/dist.test.ts": `${head}readFileSync(join(HERE, "../../db/dist/x.js"));\n`,
    "packages/pj/test/root-dist.test.ts": `${head}const ROOT = HERE;\nexport const e = \`\${ROOT}apps/w/dist/index.js\`;\nreadFileSync(e);\n`,
    "packages/pj/test/next.test.ts": `${head}readFileSync("next/dist/lib/x.js");\nreadFileSync("/app/apps/w/dist/index.js");\n`,
    "packages/pk/src/entry.ts": 'import { deep } from "./deep.js";\nexport const run = () => deep;\n', "packages/pk/src/deep.ts": "export const deep = 1;\n",
    "packages/pk/test/_child.ts": 'import { run } from "../src/entry.js";\nrun();\n',
    "packages/pk/test/spawn.test.ts": `${head}const CHILD = fileURLToPath(new URL("_child.ts", import.meta.url));\nexecFileSync(process.execPath, [CHILD]);\n`,
    // The engine's metafile in the split form, and the bundlers with a library one of them imports.
    "packages/pl/test/meta.test.ts": `${head}const ROOT = join(HERE, "..", "..", "..");\nexport const meta = () => readFileSync(join(ROOT, "build", "engine.meta.json"), "utf8");\n`,
    "scripts/engine-bundle.mjs": 'import { esb } from "./lib/esb.mjs";\nexport const bundle = esb;\n',
    "scripts/lib/esb.mjs": "export const esb = 1;\n",
    "scripts/bundle-host.mjs": 'import { bundle } from "./engine-bundle.mjs";\nexport const host = bundle;\n',
    // Censuses that walk the whole tree from a bare top-level name: in their own code, and through a helper.
    "packages/pm/test/census.test.ts": `${head}const ROOT = join(HERE, "..", "..", "..");\nfor (const bucket of ["packages", "apps"]) readdirSync(join(ROOT, bucket));\n`,
    "packages/pm/test/swept.test.ts": 'import { sources } from "./_walk";\nexport const all = [...sources("apps"), ...sources("packages")];\n',
    "packages/pm/test/_walk.ts": 'import { readdirSync } from "node:fs";\nimport { join } from "node:path";\nexport const sources = (d: string) => readdirSync(join(process.cwd(), d));\n',
    // A bare top-level name in a file that walks no directory.
    "packages/pm/test/word.test.ts": `${head}export const where = "packages";\nexport const read = () => readFileSync(join(HERE, "data.json"), "utf8");\n`,
    "packages/pm/test/data.json": "{}\n",
    // A directory named through a nested anchor call, read by a helper; a data file and a manifest no reader names.
    "packages/pn/test/_shapes.ts": 'import { readFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\n'
      + 'export const DIR = join(dirname(fileURLToPath(import.meta.url)), "shapes");\nexport const shape = (n: string) => readFileSync(join(DIR, `${n}.json`), "utf8");\n',
    "packages/pn/test/shapes/a.json": "{}\n",
    "packages/pn/test/corpus.test.ts": 'import { shape } from "./_shapes";\nexport const a = shape("a");\n',
    "packages/pa/assets/conf.json": "{}\n", "packages/pa/package.json": '{ "name": "pa", "version": "1.0.0" }\n',
    // A census under root test/: a reader only when it is asked for.
    "test/guide.test.ts": `${head}readFileSync(join(HERE, "../docs/guide.md"));\n`,
  };
  const dir = plantTree(tree);
  const files = Object.keys(tree).filter((f) => f.endsWith(".test.ts")).sort();
  const readers = readersOf(dir, files, { code: stripComments, relativeImports });
  const hits = (...paths: string[]) => readerHits(dir, paths.map((p) => M(p)), readers);
  const picked = (...paths: string[]) => [...hits(...paths)].filter(([, rule]) => rule === "named").map(([f]) => f).sort();

  it("names a join(HERE, '..', 'src'), a new URL('../src/'), a repo-relative literal and a publicPath('github/…')", () => {
    expect(picked("packages/p1/src/x.ts")).toEqual(["packages/p1/test/join.test.ts"]);
    expect(picked("packages/p2/src/x.ts")).toEqual(["packages/p2/test/url.test.ts"]);
    expect(picked("deploy/selfhost/compose.yml")).toEqual(["packages/p3/test/literal.test.ts"]);
    expect(readers.get("packages/p4/test/public.test.ts")!.paths).toEqual([".github/workflows/x.yml"]);
    expect(hits(".github/workflows/x.yml").get("packages/p4/test/public.test.ts")).toBe("named");
  });

  it("follows a name held in a test helper, and a directory the file scans itself", () => {
    expect(readers.get("packages/p4/test/held.test.ts")!.paths).toEqual(["docs/guide.md"]);
    expect(hits("docs/guide.md").get("packages/p4/test/held.test.ts")).toBe("named");
    expect(hits("packages/p5/test/fixture.txt").get("packages/p5/test/scan.test.ts")).toBe("named");
  });

  it("gives an anchored reader that names nothing its own package, and reads a run of dots as no name", () => {
    expect(readers.get("packages/p6/test/anchored.test.ts")!.paths).toEqual(["packages/p6"]);
    expect(hits("packages/p6/src/z.ts").get("packages/p6/test/anchored.test.ts")).toBe("named");
    expect([...namedPaths(dir, "packages/p7/test/dots.test.ts", 'resolve(HERE, "..", "..")', new Set(["packages"]))]).toEqual([]);
    expect(readers.get("packages/p7/test/dots.test.ts")!.paths).toEqual(["packages/p7"]);
    expect(hits("packages/p1/src/x.ts").has("packages/p7/test/dots.test.ts")).toBe(false);
  });

  it("always selects a git spawner, and a bundle reader whenever package source changes", () => {
    expect(hits("docs/other.md").get("packages/p8/test/git.test.ts")).toBe("always");
    expect(hits("packages/p1/src/x.ts").get("packages/p9/test/bundle.test.ts")).toBe("always");
    expect(hits("docs/other.md").has("packages/p9/test/bundle.test.ts")).toBe(false);
    expect(hits("packages/p5/test/fixture.txt").has("packages/p9/test/bundle.test.ts")).toBe(false);
  });

  it("selects by top-level tree outside apps/ and packages/, and an unclaimed fixture's whole area", () => {
    expect(hits("scripts/other.sh").get("packages/pc/test/scripts.test.ts")).toBe("tree");
    expect(hits("docs/other.md").get("packages/p4/test/held.test.ts")).toBe("tree");
    expect(hits("packages/pa/test/fixtures/mail.eml").get("packages/pa/test/reader.test.ts")).toBe("area");
    expect(hits("packages/pa/test/fixtures/mail.eml").has("packages/pb/test/other.test.ts")).toBe(false);
    // A fixture a reader names is claimed: only that reader runs.
    expect(picked("packages/pb/test/fixtures/named.eml")).toEqual(["packages/pb/test/names.test.ts"]);
    expect(readers.has("packages/pd/test/plain.test.ts")).toBe(false);
  });

  it("names a deleted file and a directory above a deleted path, when the diff says so", () => {
    const gone = ["docs/gone.md", "packages/pz/gone/x.txt"];
    expect(readers.get("packages/pe/test/gone.test.ts")!.paths).toEqual(["packages/pe"]);
    const withGone = readersOf(dir, files, { code: stripComments, relativeImports, deleted: gone });
    expect(withGone.get("packages/pe/test/gone.test.ts")!.paths).toEqual(["docs/gone.md", "packages/pz/gone"]);
    for (const p of gone) expect(readerHits(dir, [{ s: "D", p }], withGone).get("packages/pe/test/gone.test.ts"), p).toBe("named");
  });

  it("names a template literal's static directory, an array joined into a path, and no import specifier", () => {
    expect(readers.get("packages/pf/test/tpl.test.ts")!.paths).toEqual(["apps/web/messages", "packages/pf/views"]);
    expect(picked("packages/pf/views/V.tsx")).toEqual(["packages/pf/test/tpl.test.ts"]);
    expect(readers.get("packages/pg/test/arr.test.ts")!.paths).toEqual(["packages/pg/src/a.ts"]);
    expect(picked("packages/pg/src/a.ts")).toEqual(["packages/pg/test/arr.test.ts"]);
    expect(readers.get("packages/ph/test/imp.test.ts")!.paths).toEqual(["packages/ph"]);
  });

  it("gives an anchored scanner its own package, and leaves its package's unclaimed files to the area rule", () => {
    expect(picked("packages/pi/src/s.ts")).toEqual(["packages/pi/test/census.test.ts"]);
    const c = hits("packages/pi/assets/c.txt");
    expect(c.get("packages/pi/test/near.test.ts")).toBe("area");
    expect(c.has("packages/pi/test/census.test.ts")).toBe(true);
  });

  it("always selects a reader of a workspace's built output, and a spawner when its child's imports change", () => {
    for (const f of ["packages/pj/test/dist.test.ts", "packages/pj/test/root-dist.test.ts"]) {
      expect(hits("packages/p1/src/x.ts").get(f), f).toBe("always");
    }
    expect(hits("packages/p1/src/x.ts").has("packages/pj/test/next.test.ts")).toBe(false);
    expect(picked("packages/pk/src/deep.ts")).toEqual(["packages/pk/test/spawn.test.ts"]);
    expect(picked("packages/pk/test/_child.ts")).toEqual(["packages/pk/test/spawn.test.ts"]);
  });

  it("always selects a reader of the engine's metafile in the split form, and every bundle reader when a bundler or what it imports changes", () => {
    expect(readers.get("packages/pl/test/meta.test.ts")!.bundle).toBe(true);
    expect(hits("packages/p1/src/x.ts").get("packages/pl/test/meta.test.ts")).toBe("always");
    for (const p of ["scripts/engine-bundle.mjs", "scripts/bundle-host.mjs", "scripts/lib/esb.mjs"]) {
      for (const f of ["packages/p9/test/bundle.test.ts", "packages/pl/test/meta.test.ts"]) expect(hits(p).get(f), `${p} selects ${f}`).toBe("always");
    }
    expect(hits("scripts/tool.mjs").has("packages/p9/test/bundle.test.ts")).toBe(false);
  });

  it("selects a census that walks the tree from a bare apps or packages name for any change under either", () => {
    for (const f of ["packages/pm/test/census.test.ts", "packages/pm/test/swept.test.ts"]) {
      expect(readers.get(f)!.sweep, f).toBe(true);
      for (const p of ["packages/p1/src/x.ts", "packages/p5/test/fixture.txt", "apps/web/messages/en.json"]) expect(hits(p).get(f), `${p} selects ${f}`).toBe("sweep");
      expect(hits("docs/other.md").has(f), f).toBe(false);
    }
    expect(readers.get("packages/pm/test/word.test.ts")!.sweep).toBe(false);
    expect(hits("packages/p1/src/x.ts").has("packages/pm/test/word.test.ts")).toBe(false);
  });

  it("names a directory through a nested anchor call, and gives an unclaimed data file, not a manifest, its area", () => {
    expect(readers.get("packages/pn/test/corpus.test.ts")!.paths).toEqual(["packages/pn/test/shapes"]);
    expect(picked("packages/pn/test/shapes/a.json")).toEqual(["packages/pn/test/corpus.test.ts"]);
    expect(hits("packages/pa/assets/conf.json").get("packages/pa/test/reader.test.ts")).toBe("area");
    expect(hits("packages/pa/package.json").has("packages/pa/test/reader.test.ts")).toBe(false);
  });

  it("selects a reader whose named source module's import closure reaches the change", async () => {
    const t = plantTree({
      "packages/q/src/entry.ts": "export {};\n", "packages/q/src/deep.ts": "export {};\n",
      "packages/r/test/crawl.test.ts": `${head}readFileSync(join(HERE, "../../q/src/entry.ts"));\n`,
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`packages/q/test/plain${i}.test.ts`, "export {};\n"])),
    });
    const asked: string[][] = [];
    const graph = async (_root: string, _related: string[], o: GraphOptions) => {
      if (o.config === "vitest.config.ts") asked.push(o.entries ?? []);
      return { related: [], all: [], reached: (o.entries ?? []).filter((e) => e === "packages/q/src/entry.ts") };
    };
    const plan = await select({ root: t, ctx: pr(), changes: [M("packages/q/src/deep.ts")], graph, costs: { measuredAt: "planted", suite: {}, sqlite: {} } }) as Plan;
    expect(asked).toEqual([["packages/q/src/entry.ts"]]);
    expect(plan.scope, plan.why).toBe("selected");
    expect(plan.shards.flatMap((s) => s.files.split("\n"))).toEqual(["packages/r/test/crawl.test.ts"]);
    expect(plan.summary!.rules.named).toBe(1);
  });

  it("hands the diff's deletions to the readers when it selects", async () => {
    const t = plantTree({
      "packages/q/test/doc.test.ts": `${head}readFileSync(join(HERE, "../../../docs/gone.md"));\n`,
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`packages/q/test/plain${i}.test.ts`, "export {};\n"])),
    });
    const graph = async () => ({ related: [], all: [] });
    const plan = await select({ root: t, ctx: pr(), changes: [{ s: "D", p: "docs/gone.md" }], graph, costs: { measuredAt: "planted", suite: {}, sqlite: {} } }) as Plan;
    expect(plan.scope, plan.why).toBe("selected");
    expect(plan.shards.flatMap((s) => s.files.split("\n"))).toEqual(["packages/q/test/doc.test.ts"]);
  });

  it("reads root test/ only when asked, and every other reader the same either way", () => {
    expect(readers.has("test/guide.test.ts")).toBe(false);
    const all = readersOf(dir, files, { code: stripComments, relativeImports, includeRoot: true });
    expect(all.get("test/guide.test.ts")!.paths).toEqual(["docs/guide.md"]);
    expect([...all].filter(([t]) => !t.startsWith("test/"))).toEqual([...readers]);
  });

  it("strips comments in one pass: a /* in a line comment or a string opens nothing", () => {
    const src = '// the `/api/*` table\nconst a = readFileSync("x/*y");\n/* real */ const b = "//kept";\nconst re = /\\/\\//g;\n';
    const out = stripComments(src);
    expect(out).toContain('readFileSync("x/*y")');
    expect(out).toContain('"//kept"');
    expect(out).toContain("/\\/\\//g");
    expect(out).not.toContain("real");
    expect(out).not.toContain("table");
    // A line comment ends where JavaScript ends it: at a newline, a carriage return, U+2028 or U+2029.
    for (const end of ["\r", "\u2028", "\u2029"]) expect(stripComments(`// a note${end}const c = readFileSync("z");\n`)).toContain('readFileSync("z")');
    // So a tsconfig's key behind such an end is a key the admission reads, not a note.
    const ts = '{\n  "include": ["src"]\n}\n';
    expect(admittedTsconfig("packages/q/tsconfig.json", ts, ts.replace("{\n", '{\n  // a note\r"exclude": ["src"],\n'))).toBeNull();
  });
});

describe("the readers of this tree", () => {
  const files = testFiles(ROOT);
  const readers = readersOf(ROOT, files, { code: stripComments, relativeImports });
  const hit = (p: string) => readerHits(ROOT, [M(p)], readers);

  it("select the censuses that read a changed file", () => {
    /* Re-pointed to the new shell (RULING-NEW-SHELL-FIRST D (3)): the Ohbox's seat, which the press census walks. */
    expect(hit("packages/app/src/ohbox/Seat.tsx").has("apps/webapp/test/dispatch-seam-census.test.ts")).toBe(true);
    expect(hit("packages/api/src/router.ts").has("packages/api/test/local-door-carries-no-admin.test.ts")).toBe(true);
    expect(hit("packages/db/src/schema-mail.ts").has("packages/db/test/schema-split.test.ts")).toBe(true);
    expect(decideScope({ root: ROOT, ctx: pr(), changes: [M("packages/db/drizzle/meta/_journal.json")] }).scope).toBe("whole");
  });

  it("select each scanning census for a change in the area it scans, and the template and array readers", () => {
    const cases: Array<[string, string[]]> = [
      ["packages/services/src/mailbox-service.ts", ["packages/services/test/organizer-role-census.test.ts", "packages/db/test/organizer-event-census.test.ts"]],
      ["packages/services/src/consent-reset.ts", ["packages/services/test/organizer-role-census.test.ts"]],
      ["packages/organizer/src/sync.ts", ["apps/worker/test/sync-role-census.test.ts"]],
      ["apps/mobile/app/compose.tsx", ["apps/mobile/test/privacy.test.ts", "apps/mobile/test/bearer-construction-census.test.ts"]],
      ["apps/webapp/app/views/HistoryView.tsx", ["apps/webapp/test/row-participants-wiring.test.ts", "apps/webapp/test/row-stamp-wiring.test.ts", "apps/webapp/test/shortcut-hint.test.tsx"]],
      ["packages/app/src/history/HistoryList.tsx", ["apps/webapp/test/row-participants-wiring.test.ts"]],
      ["packages/app-logic/src/ohbox/live-mirror.ts", ["apps/webapp/test/derived-stamp-census.test.ts"]],
      ["packages/app/src/write/Reply.tsx", ["apps/webapp/test/ccbcc-fold.test.ts"]],
      ["apps/webapp/messages/en.json", ["apps/desktop/test/desktop-door-copy.test.ts", "apps/webapp/test/selfhost-says-this-server-census.test.ts", "apps/webapp/test/session-verdict-guard.test.ts"]],
    ];
    for (const [p, want] of cases) {
      const h = hit(p);
      for (const f of want) expect(h.has(f), `${p} selects ${f}`).toBe(true);
    }
  });

  it("select the readers that name a file in a route group", () => {
    expect(hit("apps/mobile/app/(tabs)/screener.tsx").has("apps/mobile/test/screener-row-names-the-claim.test.ts")).toBe(true);
    expect(hit("apps/webapp/app/(product)/mailbox/CloudShell.tsx").has("apps/webapp/test/session-verdict-guard.test.ts")).toBe(true);
  });

  it("select the built worker's loader for package source, and a child's spawner for what the child loads", () => {
    expect(hit("packages/db/src/cloud.ts").get("apps/worker/test/dist-import-graph.test.ts")).toBe("always");
    expect(hit("packages/organizer/src/entry.ts").has("apps/worker/test/driver-startup-outage.test.ts")).toBe(true);
  });

  it("send a build.yml change only to the files that name .github, beside the git spawners", () => {
    const h = hit(".github/workflows/build.yml");
    const naming = [...h].filter(([f]) => !readers.get(f)!.git);
    expect(naming.length).toBeGreaterThan(0);
    for (const [f] of naming) expect(readers.get(f)!.paths.some((p) => p.startsWith(".github/")), f).toBe(true);
  });

  it("select the engine's metafile readers for the engine's source and for the bundlers", () => {
    expect(hit("packages/organizer/src/bubble-up-pass.ts").get("apps/sidecar/test/engine-closure-no-cli-entry.test.ts")).toBe("always");
    const b = hit("scripts/engine-bundle.mjs");
    for (const f of ["apps/sidecar/test/engine-closure-no-cli-entry.test.ts", "apps/sidecar/test/phone-engine-substitutes.test.ts"]) expect(b.has(f), f).toBe(true);
  });

  it("select the phone engine's Postgres-only census for a file the phone bundles and for its scanner", () => {
    for (const p of ["packages/core/src/adapters/drizzle-repo.ts", "packages/db/src/storage.ts", "apps/mobile/scripts/verify-phone-engine-repro.mjs"]) {
      expect(hit(p).get("apps/mobile/test/no-node-builtins.test.ts"), p).toBe("always");
    }
  });

  it("select a tree-wide census for a change outside its own package, and a provider shape's corpus tests", () => {
    const account = hit("packages/api/src/routes/account.ts");
    for (const f of ["packages/services/test/organizer-role-census.test.ts", "packages/services/test/away-responder-pass-hosts.test.ts"]) expect(account.has(f), f).toBe(true);
    expect(hit("apps/worker/src/mailboxes.ts").has("packages/services/test/organizer-role-census.test.ts")).toBe(true);
    const shape = hit("packages/core/test/adapters/provider-shapes/gmail.shape.json");
    for (const f of [
      "packages/core/test/adapters/imap.changes.folder-gone.corpus.test.ts", "packages/core/test/adapters/organizer-lease-provider-shapes.test.ts",
      "packages/client-engine/test/providers-corpus.test.ts",
    ]) expect(shape.has(f), f).toBe(true);
  });

  it("select an import-graph census when a module its named entry reaches changes, through vitest's own resolver", async () => {
    const pairs: Array<[string, string]> = [
      ["apps/sidecar/src/approval-verdict.ts", "apps/sidecar/test/cloud-engine-census.test.ts"],
      ["packages/db/src/junk-sweep.ts", "packages/db/test/server-only-modules.test.ts"],
    ];
    for (const [p, f] of pairs) {
      // Neither names the module: only the closure of what it names reaches it.
      expect(hit(p).has(f), `${p} by name alone`).toBe(false);
      const entries = sourceEntries(new Map([[f, readers.get(f)!]]));
      const g = await vitestGraph(ROOT, [p], { config: "vitest.config.ts", entries, list: false });
      expect(readerHits(ROOT, [M(p)], readers, g.reached).get(f), `${p} selects ${f}`).toBe("named");
    }
  }, 120_000);

  it("keep that census for a pull request into next and defer another app's test that only imports the change", async () => {
    const census = "packages/db/test/server-only-modules.test.ts";
    const far = "apps/sidecar/test/act-admission-retire-drain.test.ts";
    // This tree's own config and resolver, held to the two files and the census's entries: the whole graph takes minutes.
    const entries = sourceEntries(new Map([[census, readers.get(census)!]]));
    const graph = async (root: string, related: string[], o: GraphOptions) => (o.config === "vitest.config.ts"
      ? vitestGraph(root, related, { ...o, entries: (o.entries ?? []).filter((e) => entries.includes(e)), overrides: { include: [census, far] } })
      : { related: [], all: [] });
    const plan = (base: string) => select({ root: ROOT, ctx: pr({ base: { ref: base } }), changes: [M("packages/db/src/junk-sweep.ts")], graph }) as Promise<Plan>;
    const handed = (p: Plan) => [...p.shards.flatMap((s) => s.files.split("\n")), ...p.alone];
    const main = await plan("main");
    expect(handed(main)).toEqual(expect.arrayContaining([census, far]));
    const next = await plan("next");
    expect(next.mode).toBe("direct");
    expect(handed(next)).toContain(census);
    expect(handed(next)).not.toContain(far);
    expect(next.deferred).toContainEqual({ file: far, rule: "graph" });
  }, 120_000);
});

describe("the direct set: a pull request into next", () => {
  const sha = "1".repeat(40);
  const event = (base: string, ref = "pr/x") => pr({ number: 812, base: { ref: base }, head: { ref, sha, repo: { full_name: "trafficflowhq/ohmail" } } });
  const reads = 'import { readFileSync } from "node:fs";\n';
  const own = "packages/p/test/own.test.ts";
  const across = "packages/q/test/across.test.ts";
  const names = "packages/r/test/names.test.ts";

  it("keeps what the change can break in its own workspaces and what names it, and defers the rest by its rule", () => {
    const rule = new Map([
      [own, "graph"], ["packages/p/test/edited.test.ts", "changed"], [across, "graph"], ["packages/q/test/sweeps.test.ts", "graph"],
      ["packages/q/test/condstore.test.ts", "graph"], [names, "named"], ["test/reached.test.ts", "graph"],
      ["test/census.test.ts", "root"], ["test/plain.test.ts", "root"],
    ]);
    const sets = {
      picked: [...rule.keys()].sort(), rule, related: ["packages/p/src/x.ts", "packages/p/test/edited.test.ts"],
      graphRelated: [own, across, "packages/q/test/sweeps.test.ts", "packages/q/test/condstore.test.ts", "test/reached.test.ts"],
      hits: new Map([[names, "named"], ["packages/q/test/sweeps.test.ts", "sweep"]]),
      rootHits: new Map([["test/census.test.ts", "named"]]),
      dovecot: new Set(["packages/q/test/condstore.test.ts"]),
    };
    const left = [{ file: across, rule: "graph" }, { file: "test/plain.test.ts", rule: "root" }];
    const got = directSet(sets);
    expect(got.deferred).toEqual(left);
    expect(got.direct).toEqual(sets.picked.filter((f) => !left.some((d) => d.file === f)));
    // A changed module that no workspace owns keeps the graph's whole reach; a root test file or a document does not.
    expect(directSet({ ...sets, related: [...sets.related, "scripts/lib/tool.mjs"] }).deferred).toEqual([left[1]]);
    expect(directSet({ ...sets, related: [...sets.related, "test/other.test.ts", "docs/guide.md"] }).deferred).toEqual(left);
    // A second workspace in the change brings its own tests back.
    expect(directSet({ ...sets, related: [...sets.related, "packages/q/src/y.ts"] }).deferred).toEqual([left[1]]);
  });

  /** p's test imports p's module, q's test imports it across the workspaces, r's test and a root census name its path. */
  const planted = () => plantTree({
    "vitest.config.ts": 'export default { test: { include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"] } };\n',
    "vitest.sqlite.config.ts": `export default { test: { include: ${JSON.stringify([own, across, "packages/s/test/far0.test.ts"])} } };\n`,
    "packages/p/src/x.ts": "export const x = 1;\n",
    [own]: 'import { x } from "../src/x";\nexport const a = x;\n',
    [across]: 'import { x } from "../../p/src/x";\nexport const b = x;\n',
    [names]: `${reads}export const src = readFileSync(new URL("../../p/src/x.ts", import.meta.url), "utf8");\n`,
    "test/census.test.ts": `${reads}export const src = readFileSync(new URL("../packages/p/src/x.ts", import.meta.url), "utf8");\n`,
    "test/plain.test.ts": "export {};\n",
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`packages/s/test/far${i}.test.ts`, "export {};\n"])),
  });

  it("plans the same change for each base through the CLI, on vitest's own graph, and says what it deferred", () => {
    const dir = planted();
    const files = join(scratch, "direct.tsv");
    writeFileSync(files, "M\tpackages/p/src/x.ts\n");
    const run = (base: string, ref?: string) => {
      const out = join(scratch, `direct-${base}.json`);
      const cli = spawnSync(process.execPath, [SELECT, "select", "--root", dir, "--event", JSON.stringify(event(base, ref)), "--files", files, "--out", out], { encoding: "utf8" });
      expect(cli.status, cli.stderr).toBe(0);
      return { stdout: cli.stdout, text: readFileSync(out, "utf8"), plan: JSON.parse(readFileSync(out, "utf8")) as Plan };
    };
    const said = "SELECT selected: 1 changed path(s); 1 suite job(s), 0 alone, 1 sqlite\n";
    const main = run("main");
    expect(main.stdout).toBe(said);
    expect(Object.keys(main.plan)).toEqual(["scope", "why", "shards", "alone", "sqlite", "summary"]);
    expect(main.plan.shards[0]!.files.split("\n")).toEqual([own, across, names, "test/census.test.ts", "test/plain.test.ts"]);
    expect(main.plan.sqlite).toEqual([{ shard: 0, files: `${own}\n${across}` }]);
    // main merged across into next is planned as a pull request into main is, to the byte.
    expect(run("next", "pr/merge-main-20261114")).toEqual(main);

    const next = run("next");
    expect(next.plan.mode).toBe("direct");
    // Root test/ is next's floor: the root file no change reaches runs as well. The planted tree is no repository: no base to name.
    expect(next.plan.shards[0]!.files.split("\n")).toEqual([own, names, "test/census.test.ts", "test/plain.test.ts"]);
    expect(next.plan.deferred).toEqual([{ file: across, rule: "graph" }]);
    expect(next.plan.sqlite).toEqual([{ shard: 0, files: own }]);
    expect(next.plan.sqliteDeferred).toEqual([across]);
    expect(next.plan.summary).toMatchObject({ base: "next", main: 4, deferred: 1, deferredS: 5, floor: 2, rules: { graph: 1, root: 2, named: 1 } });
    expect(next.stdout).toBe([
      said.trimEnd(),
      `FAST next: pr #812 head ${sha} on ?: runs 4 file(s) (floor 2) in 1 suite job(s) + 0 alone, defers 1 file(s) (5 s measured) to the whole run on next`,
      "::group::deferred to the whole run on next (1)", `graph\t${across}`, "::endgroup::",
      "FAST next sqlite: runs 1 file(s) in 1 job(s), defers 1 file(s) to the whole run on next",
      "::group::deferred to the whole run on next, sqlite (1)", across, "::endgroup::", "",
    ].join("\n"));
    expect(deferredLog(next.plan, event("next"))).toBe(next.stdout.slice(said.length));
    for (const quiet of [main.plan, { scope: "whole", why: "a schedule run is whole" } as Plan]) expect(deferredLog(quiet, event("next"))).toBe("");
  }, 120_000);
});

describe("the harness: a pull request into next that only adds a package's lines", () => {
  type Files = Record<string, string>;
  type World = { base: Files; head: Files; changes: { s: string; p: string }[]; dirs: string[] };
  const j = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const [L, R, V, T, B] = ["package-lock.json", "package.json", "vitest.config.ts", "tsconfig.json", "test/tsconfig.test-dirs-base.json"];
  const [NP, NT, QP, QT, SP] = ["packages/n/package.json", "packages/n/tsconfig.json", "packages/q/package.json", "packages/q/tsconfig.json", "packages/s/package.json"];
  const config = (aliases: string[], test: string[] = []) => [
    'import { fileURLToPath } from "node:url";', "const r = (p) => fileURLToPath(new URL(p, import.meta.url));",
    "export default {", "  resolve: {", "    alias: [", ...aliases.map((a) => `      ${a}`), "    ],", "  },",
    "  test: {", ...test.map((t) => `    ${t}`), '    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],', "  },", "};", "",
  ].join("\n");
  const held = ["// A leaf above its package.", '{ find: "@m/p/leaf", replacement: r("./packages/p/src/leaf.ts") },', '{ find: "@m/p", replacement: r("./packages/p/src/index.ts") },'];
  const added = [
    "// The new package: a folder's door, the bare name, a leaf.",
    '{ find: /^@m\\/n\\/([a-z-]+)$/, replacement: `${r("./packages/n/src")}/$1/index.ts` },',
    '{ find: /^@m\\/n$/, replacement: r("./packages/n/src/index.ts") }, // anchored: a subpath resolves by the package\'s own exports',
    '{ find: "@m/n/leaf", replacement: r("./packages/n/src/leaf.ts") },',
  ];
  const lock = (workspaces: string[], packages: Record<string, unknown>) => j({
    name: "root", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "root", version: "1.0.0", workspaces, devDependencies: { dep: "1.0.0" } }, ...packages },
  });
  const link = (name: string) => ({ [`node_modules/@m/${name}`]: { resolved: `packages/${name}`, link: true } });
  const dep = { "node_modules/dep": { version: "1.0.0", resolved: "https://registry.example.invalid/dep-1.0.0.tgz", dev: true } };
  const qTsconfig = (note: string, paths: string, refs: string) => `{\n  /* ${note} */\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": { "outDir": "dist", "paths": { ${paths} } },\n  "include": ["src"],\n  "references": [${refs}]\n}\n`;
  /** p, q (which depends on p) and s; the pull request adds n, and q's and s's lines for it. */
  const world = (): World => ({
    dirs: ["packages/p", "packages/q", "packages/s"],
    base: {
      [L]: lock(["packages/p", "packages/q", "packages/s"], {
        "packages/p": { name: "@m/p", version: "0.0.0" }, "packages/q": { name: "@m/q", version: "0.0.0", dependencies: { "@m/p": "*" } },
        "packages/s": { name: "@m/s", version: "0.0.0" }, ...link("p"), ...link("q"), ...link("s"), ...dep,
      }),
      [R]: j({ name: "root", version: "1.0.0", workspaces: ["packages/p", "packages/q", "packages/s"], devDependencies: { dep: "1.0.0" } }),
      [QP]: j({ name: "@m/q", version: "0.0.0", exports: { ".": "./src/index.ts" }, dependencies: { "@m/p": "*" } }),
      [QT]: qTsconfig("q reads p", '"@m/p": ["../p/src/index.ts"]', '{ "path": "../p" }'),
      [SP]: j({ name: "@m/s", version: "0.0.0" }),
      [B]: j({ "//": "the alias table, mirrored", extends: "../tsconfig.base.json", compilerOptions: { noEmit: true, paths: { "@m/p": ["../packages/p/src/index.ts"] } } }),
      [T]: j({ files: [], references: [{ path: "./packages/p" }, { path: "./packages/q" }] }),
      [V]: config(held),
    },
    head: {
      [L]: lock(["packages/p", "packages/q", "packages/s", "packages/n"], {
        "packages/n": { name: "@m/n", version: "0.0.0" }, "packages/p": { name: "@m/p", version: "0.0.0" },
        "packages/q": { name: "@m/q", version: "0.0.0", dependencies: { "@m/n": "*", "@m/p": "*" } },
        "packages/s": { name: "@m/s", version: "0.0.0" }, ...link("n"), ...link("p"), ...link("q"), ...link("s"), ...dep,
      }),
      [R]: j({ name: "root", version: "1.0.0", workspaces: ["packages/p", "packages/q", "packages/s", "packages/n"], devDependencies: { dep: "1.0.0" } }),
      [NP]: j({ name: "@m/n", version: "0.0.0", exports: { ".": "./src/index.ts" } }),
      "packages/n/src/index.ts": "export const n = 1;\n",
      "packages/n/test/n.test.ts": 'import { n } from "@m/n";\nexport const got = n;\n',
      [NT]: j({ extends: "../../tsconfig.base.json", include: ["src"] }),
      [QP]: j({ name: "@m/q", version: "0.0.0", exports: { ".": "./src/index.ts", "./extra": "./src/extra.ts" }, dependencies: { "@m/n": "*", "@m/p": "*" } }),
      [QT]: qTsconfig("q reads p and n", '"@m/n": ["../n/src/index.ts"], "@m/p": ["../p/src/index.ts"]', '{ "path": "../n" }, { "path": "../p" }'),
      [SP]: j({ name: "@m/s", version: "0.0.0", exports: { "./door": "./src/door.ts" } }),
      [B]: j({ "//": "the alias table, mirrored", extends: "../tsconfig.base.json", compilerOptions: { noEmit: true, paths: { "@m/p": ["../packages/p/src/index.ts"], "@m/n": ["../packages/n/src/index.ts"] } } }),
      [T]: j({ files: [], references: [{ path: "./packages/p" }, { path: "./packages/n" }, { path: "./packages/q" }] }),
      [V]: config([...added, ...held]),
    },
    changes: [M(L), M(R), { s: "A", p: NP }, { s: "A", p: "packages/n/src/index.ts" }, { s: "A", p: "packages/n/test/n.test.ts" }, { s: "A", p: NT }, M(QP), M(QT), M(SP), M(B), M(T), M(V)],
  });
  const names = new Map([["@m/n", "packages/n"]]);
  const areas = new Set(["packages/n"]);
  const intoNext = pr({ base: { ref: "next" } });
  const bare = plantTree({ "a.txt": "a\n" });
  /** What each harness path of that pull request added, in the diff's order. */
  const shapes: Array<[string, string, string]> = [
    [L, "a dependency change", "a workspace packages/n and its link; a dependency on @m/n in packages/q"],
    [R, "a dependency change", "a workspace packages/n"],
    [NP, "a dependency change", "new with packages/n"],
    [NT, "a tsconfig", "new with packages/n"],
    [QP, "a dependency change", "depends on @m/n; exports ./extra"],
    [QT, "a tsconfig", "a reference to ../n; paths for @m/n"],
    [SP, "a dependency change", "exports ./door"],
    [B, "a tsconfig", "paths for @m/n"],
    [T, "a tsconfig", "a reference to ./packages/n"],
    [V, "the vitest config", "an alias for @m/n"],
  ];
  const harness = shapes.map(([p, what, shape]) => ({ p, what, shape }));

  it("admits an alias line, a tsconfig entry, a manifest entry and a lockfile workspace that only add a package", () => {
    const w = world();
    expect(admittedVitestAlias(w.base[V]!, w.head[V]!, { newNames: names })).toBe("an alias for @m/n");
    // The lines the last three new packages added to this tree's own table.
    const real: Array<[string, string, string]> = [
      ['{ find: "@ohmail/wire", replacement: r("./packages/wire/src/index.ts") },', "@ohmail/wire", "packages/wire"],
      ['{ find: /^@ohmail\\/cal-core$/, replacement: r("./packages/cal-core/src/index.ts") }, // anchored: a subpath resolves by the package\'s own exports', "@ohmail/cal-core", "packages/cal-core"],
      ['{ find: /^@ohmail\\/app-logic\\/([a-z-]+)$/, replacement: `${r("./packages/app-logic/src")}/$1/index.ts` },', "@ohmail/app-logic", "packages/app-logic"],
      ['{ find: /^@ohmail\\/app-logic\\/([a-z-]+\\/[A-Za-z0-9-]+)$/, replacement: `${r("./packages/app-logic/src")}/$1.ts` },', "@ohmail/app-logic", "packages/app-logic"],
      ['{ find: "@ohmail/app/host", replacement: r("./packages/app/src/host/index.ts") },', "@ohmail/app", "packages/app"],
    ];
    for (const [line, name, area] of real) {
      expect(admittedVitestAlias(config(held), config([held[0]!, line, held[1]!, held[2]!]), { newNames: new Map([[name, area]]) }), line).toBe(`an alias for ${name}`);
      // The same line for a name that is not new adds no package.
      expect(admittedVitestAlias(config(held), config([line, ...held]), { newNames: names }), line).toBeNull();
    }
    // A comment alone, and an inserted line equal to its neighbour (the walk reads it one line late, as the same text).
    expect(admittedVitestAlias(config(held), config([held[0]!, ...held]), { newNames: new Map() })).toBe("comments in the alias table");
    expect(admittedVitestAlias(config(held), config(held), { newNames: names })).toBeNull();

    expect(admittedTsconfig(QT, w.base[QT]!, w.head[QT]!, { newAreas: areas })).toBe("a reference to ../n; paths for @m/n");
    expect(admittedTsconfig(NT, null, w.head[NT]!, { newAreas: areas })).toBe("new with packages/n");
    expect(admittedTsconfig(QT, w.base[QT]!, w.base[QT]!.replace("q reads p", "q reads p, still"), { newAreas: areas })).toBe("comments or layout only");
    expect(admittedTsconfig("tsconfig.base.json", w.base[T]!, w.head[T]!, { newAreas: areas })).toBeNull();
    expect(admittedTsconfig("packages/q/tsconfig.x.json", null, w.head[NT]!, { newAreas: areas })).toBeNull();

    const sets = { newAreas: areas, newNames: names, links: new Set(["@m/n", "@m/p", "@m/q", "@m/s"]), depended: new Set(["@m/p"]) };
    expect(admittedManifest(R, w.base[R]!, w.head[R]!, sets)).toBe("a workspace packages/n");
    expect(admittedManifest(NP, null, w.head[NP]!, sets)).toBe("new with packages/n");
    expect(admittedManifest(QP, w.base[QP]!, w.head[QP]!, sets)).toBe("depends on @m/n; exports ./extra");
    expect(admittedManifest(SP, w.base[SP]!, w.head[SP]!, sets)).toBe("exports ./door");
    expect(admittedManifest(SP, w.base[SP]!, w.head[SP]!, { ...sets, depended: new Set(["@m/s"]) })).toBeNull();
    expect(admittedLock(w.base[L]!, w.head[L]!, sets)).toBe("a workspace packages/n and its link; a dependency on @m/n in packages/q");
  });

  it("selects such a pull request into next and names each harness path with what it added; into main it is whole as before", () => {
    const w = world();
    const trees = { base: tree(w.base, w.dirs), head: tree(w.head) };
    const next = decideScope({ root: bare, ctx: intoNext, changes: w.changes, ...trees });
    expect(next).toMatchObject({ scope: "selected", why: "12 changed path(s); 10 harness path(s) deferred to the whole run on next", harness });
    expect(pathTriggers(bare, w.changes, { direct: true, ...trees })).toEqual({ whole: [], sqliteWhole: false, dovecotAll: false, deferred: harness });
    // main reads neither side, and answers in today's keys and words.
    const unread: Tree = { read: () => { throw new Error("main read a side of the pull request"); }, exists: () => { throw new Error("main asked for a directory"); } };
    const main = decideScope({ root: bare, ctx: pr(), changes: w.changes, base: unread, head: unread });
    expect(main).toEqual({ scope: "whole", why: `${L}: a dependency change (and 9 more)` });
    expect(Object.keys(pathTriggers(bare, w.changes))).toEqual(["whole", "sqliteWhole", "dovecotAll"]);
    expect(pathTriggers(bare, w.changes).whole).toEqual(shapes.map(([p, what]) => `${p}: ${what}`));
    // main merged across into next is planned as into main; without the base's side nothing is admitted.
    const across = pr({ base: { ref: "next" }, head: { ref: "pr/merge-main-20261114", repo: { full_name: "trafficflowhq/ohmail" } } });
    expect(decideScope({ root: bare, ctx: across, changes: w.changes, ...trees })).toEqual(main);
    expect(decideScope({ root: bare, ctx: intoNext, changes: w.changes })).toEqual(main);
    // A version bump is no harness change on either base.
    const bump = { ...w.base, [R]: w.base[R]!.replace('"version": "1.0.0"', '"version": "1.1.0"') };
    expect(decideScope({ root: bare, ctx: intoNext, changes: [M(R)], base: tree(w.base), head: tree(bump) })).toMatchObject({ scope: "selected", why: "1 changed path(s)" });
  });

  it("stays whole into main, and into next whole for the vitest config and capped for the rest, when a harness change is anything else", () => {
    const text = (p: string, f: (t: string) => string) => (w: World) => {
      const was = w.head[p]!;
      w.head[p] = f(was);
      expect(w.head[p], p).not.toBe(was);
    };
    const data = (p: string, f: (v: any) => void) => text(p, (t) => { const v = JSON.parse(t); f(v); return j(v); });
    const refused: Array<[string, (w: World) => void]> = [
      ["an alias removed", text(V, (t) => t.replace(`      ${held[1]}\n`, ""))],
      ["an alias changed", text(V, (t) => t.replace("./packages/p/src/leaf.ts", "./packages/p/src/other.ts"))],
      ["a regex find wider than the name", text(V, (t) => t.replace("/^@m\\/n$/", "/^@m\\/n/"))],
      ["a regex find with no anchor", text(V, (t) => t.replace("/^@m\\/n$/", "/@m\\/n$/"))],
      ["a regex find with a second arm", text(V, (t) => t.replace("/^@m\\/n$/", "/^@m\\/n$|^@m\\/p$/"))],
      ["an alias that leaves its package", text(V, (t) => t.replace('r("./packages/n/src/leaf.ts")', 'r("./packages/p/src/leaf.ts")'))],
      ["an alias whose template's tail leaves its package", text(V, (t) => t.replace('`${r("./packages/n/src")}/$1/index.ts`', () => '`${r("./packages/n")}-old/src/$1/index.ts`'))],
      ["a find that is a prefix of one the table holds", (w) => {
        for (const side of [w.base, w.head]) side[V] = side[V]!.replace("    ],", '      { find: "@m/n-old", replacement: r("./packages/p/src/old.ts") },\n    ],');
        text(V, (t) => t.replace("/^@m\\/n$/", '"@m/n"'))(w);
      }],
      ["an include edit", text(V, (t) => t.replace('"test/**/*.test.ts"]', '"test/**/*.test.ts", "extra/**/*.test.ts"]'))],
      ["an exclude that drops a package's tests", text(V, (t) => t.replace("  test: {\n", '  test: {\n    exclude: ["packages/p/test/**"],\n'))],
      ["a project under another name", text(V, (t) => t.replace("  test: {\n", '  test: {\n    name: "other",\n'))],
      ["a comment that closes a comment", text(V, (t) => t.replace("// The new package", "// */ The new package"))],
      ["a comment above the table", text(V, (t) => t.replace("    alias: [\n", "    // The new package.\n    alias: [\n"))],
      ["an alias line below the table", text(V, (t) => t.replace("    ],\n", `    ],\n    ${added[3]}\n`))],
      ["a compiler option", text(QT, (t) => t.replace('"outDir": "dist"', '"outDir": "dist", "jsx": "preserve"'))],
      ["a reference removed", text(QT, (t) => t.replace(', { "path": "../p" }', ""))],
      ["paths where there were none", data(T, (v) => { v.compilerOptions = { paths: { "@m/n": ["./packages/n/src/index.ts"] } }; })],
      ["paths that leave the packages", data(B, (v) => { v.compilerOptions.paths["@m/n"] = ["../scripts/n.ts"]; })],
      ["a new tsconfig.json the root does not reference", (w) => { w.head[T] = w.base[T]!; w.changes = w.changes.filter((c) => c.p !== T); }],
      ["a new tsconfig that builds into another package", data(NT, (v) => { v.compilerOptions = { outDir: "../p/dist" }; })],
      ["a new tsconfig that includes another package", data(NT, (v) => { v.include = ["src", "../p/src"]; })],
      ["a moved version in the lockfile", data(L, (v) => { v.packages["node_modules/dep"].version = "1.0.1"; })],
      ["a first install", data(L, (v) => { v.packages["node_modules/left-pad"] = { version: "1.3.0" }; })],
      ["a dependency on what is no workspace", data(QP, (v) => { v.dependencies["left-pad"] = "1.3.0"; })],
      ["a root dependency", data(R, (v) => { v.devDependencies.other = "1.0.0"; })],
      ["exports made where another package depended on it", (w) => {
        w.base["packages/p/package.json"] = j({ name: "@m/p", version: "0.0.0" });
        w.head["packages/p/package.json"] = j({ name: "@m/p", version: "0.0.0", exports: { ".": "./src/index.ts" } });
        w.changes.push(M("packages/p/package.json"));
      }],
      ["a new package under an installed one's name", data(NP, (v) => { v.name = "dep"; })],
      ["a package folder the base already holds", (w) => { w.dirs.push("packages/n"); }],
    ];
    const admitted: string[] = [];
    for (const [what, change] of refused) {
      const w = world();
      change(w);
      const main = decideScope({ root: bare, ctx: pr(), changes: w.changes });
      expect(main.scope, what).toBe("whole");
      expect(main.why, what).toMatch(/^package-lock\.json: a dependency change \(and \d+ more\)$/);
      const next = decideScope({ root: bare, ctx: intoNext, changes: w.changes, base: tree(w.base, w.dirs), head: tree(w.head) });
      // The vitest config refused is the judge's: whole as into main. Anything else refused is capped by name, or whole as
      // into main where it takes the config's admission with it (a package's name or folder); never admitted.
      const judged = w.base[V] !== world().base[V] || w.head[V] !== world().head[V];
      const same = JSON.stringify(next) === JSON.stringify(main);
      const capped = next.scope === "selected" && next.why.startsWith("CAPPED into next: ") && (next.capped ?? []).length > 0;
      if (judged ? !same : !(same || capped)) admitted.push(what);
    }
    expect(admitted).toEqual([]);
    // A base that cannot be read admits nothing, whatever the head holds.
    const w = world();
    const unreadable = decideScope({ root: bare, ctx: intoNext, changes: w.changes, base: { read: () => null }, head: tree(w.head) });
    expect(unreadable).toEqual({ scope: "whole", why: `${L}: a dependency change (and 9 more)` });
    // Capped for another reason, the admitted paths are still deferred and named.
    const moved = [...w.changes, { s: "D", p: "packages/q/src/gone.ts" }];
    expect(decideScope({ root: bare, ctx: intoNext, changes: moved, base: tree(w.base, w.dirs), head: tree(w.head) })).toMatchObject({
      scope: "selected", why: "CAPPED into next: packages/q/src/gone.ts: deleted or renamed", harness, capped: [{ p: "packages/q/src/gone.ts", what: "deleted or renamed" }],
    });
  });

  /** The same pull request as files a run can load: n's own test, a root census of the manifest, a far test that imports it. */
  const runnable = (w: World, test: string[] = []) => {
    const far = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`packages/t/test/far${i}.test.ts`, "export {};\n"]));
    const shared: Files = {
      "tsconfig.base.json": j({ compilerOptions: { target: "ES2022", module: "NodeNext" } }),
      "vitest.sqlite.config.ts": 'export default { test: { include: ["packages/n/test/n.test.ts", "packages/p/test/p.test.ts"] } };\n',
      "packages/p/src/index.ts": "export const p = 1;\n",
      "packages/p/tsconfig.json": j({ extends: "../../tsconfig.base.json", include: ["src"] }),
      "packages/p/test/p.test.ts": 'import { p } from "@m/p";\nexport const got = p;\n',
      "packages/t/test/pkg.test.ts": 'import pkg from "../../../package.json";\nexport const v = pkg.version;\n',
      "test/census.test.ts": 'import { readFileSync } from "node:fs";\nexport const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");\n',
      "test/plain.test.ts": "export {};\n", ...far,
    };
    return { base: { ...shared, ...w.base, [V]: config(held, test) }, head: { ...shared, ...w.head, [V]: config([...added, ...held], test) } };
  };
  const handed = (plan: Plan) => plan.shards.flatMap((s) => s.files.split("\n"));
  const costs = { measuredAt: "planted", suite: {}, sqlite: {} };

  it("refuses a plan under a config that no longer collects a test file", async () => {
    const w = world();
    // The control: the alias lines alone, on vitest's own collection.
    const ok = runnable(w);
    const plan = await select({ root: plantTree(ok.head), ctx: intoNext, changes: w.changes, base: tree(ok.base, w.dirs), costs }) as Plan;
    expect(plan.scope, plan.why).toBe("selected");
    expect(plan.harness).toEqual(harness);
    expect(plan.summary!.harness).toEqual(shapes.map(([p]) => p));
    // The far test imports the root manifest: it waits for the whole run, the root lists claim no border. Root test/ is the floor.
    expect(handed(plan)).toEqual(["packages/n/test/n.test.ts", "test/census.test.ts", "test/plain.test.ts"]);
    expect(plan.deferred).toEqual([{ file: "packages/t/test/pkg.test.ts", rule: "graph" }]);
    // Both sides drop p's tests, so the diff is still alias lines alone: the collected set decides.
    const shrunk = runnable(w, ['exclude: ["packages/p/test/**"],']);
    const refused = await select({ root: plantTree(shrunk.head), ctx: intoNext, changes: w.changes, base: tree(shrunk.base, w.dirs), costs });
    expect(refused).toEqual({ scope: "whole", why: "the plan is refused: packages/p/test/p.test.ts is not collected under vitest.config.ts" });
  }, 120_000);

  it("plans a new package on a real merge commit through the CLI: its own tests run, the lists are named and deferred", () => {
    const w = world();
    const { base, head } = runnable(w);
    const { dir, headSha } = plantPr(base, head);
    const cli = (verb: string, to: string, ...more: string[]) => spawnSync(process.execPath, [SELECT, verb, "--root", dir, "--event", JSON.stringify(merged(headSha, to)), ...more], { encoding: "utf8" });
    expect(cli("scope", "main").stdout).toBe(`scope=whole\nwhy=${L}: a dependency change (and 9 more)\n`);
    expect(cli("scope", "next").stdout).toBe("scope=selected\nwhy=12 changed path(s); 10 harness path(s) deferred to the whole run on next\n");
    const out = join(scratch, "harness-plan.json");
    const run = cli("select", "next", "--out", out);
    expect(run.status, run.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(out, "utf8")) as Plan;
    expect(handed(plan)).toEqual(["packages/n/test/n.test.ts", "test/census.test.ts", "test/plain.test.ts"]);
    expect(plan.sqlite).toEqual([{ shard: 0, files: "packages/n/test/n.test.ts" }]);
    expect(plan.harness).toEqual(harness);
    const said = [
      `FAST next harness: 10 path(s) deferred to the whole run on next: ${shapes.map(([p, , shape]) => `${p} (${shape})`).join(", ")}`,
      "::group::harness deferred to the whole run on next (10)", ...shapes.map(([p, what, shape]) => `${what}\t${p}\t${shape}`), "::endgroup::", "",
    ].join("\n");
    expect(run.stdout.startsWith("SELECT selected: 12 changed path(s); 10 harness path(s) deferred to the whole run on next; 1 suite job(s), 0 alone, 1 sqlite\nFAST next: pr #811 head ")).toBe(true);
    expect(run.stdout.endsWith(said)).toBe(true);
    expect(deferredLog(plan, merged(headSha, "next")).endsWith(said)).toBe(true);
    const summary = summaryText(composeOutputs({ indexes: [0, 1], sqliteIndexes: [0], alone: [], scope: "selected", selectOutcome: "success", plan }));
    expect(summary).toContain(`- harness deferred to the whole run on next: ${shapes.map(([p]) => p).join(", ")}`);
    // The same merge with a first install in its lockfile is whole into main as before, and capped into next by its lockfile alone.
    const installed = { ...head, [L]: head[L]!.replace('"node_modules/dep": {', '"node_modules/left-pad": { "version": "1.3.0" },\n    "node_modules/dep": {') };
    expect(installed[L]).not.toBe(head[L]);
    const second = plantPr(base, installed);
    const scope = (to: string) => spawnSync(process.execPath, [SELECT, "scope", "--root", second.dir, "--event", JSON.stringify(merged(second.headSha, to))], { encoding: "utf8" }).stdout;
    expect(scope("main")).toBe(`scope=whole\nwhy=${L}: a dependency change (and 9 more)\n`);
    expect(scope("next")).toBe(`scope=selected\nwhy=CAPPED into next: ${L}: a dependency change\n`);
  }, 120_000);
});

describe("the last pull requests, as each base plans them", () => {
  const at = join(ROOT, "test/fixtures/ci-select-history");
  const history = readdirSync(at).filter((f) => f.endsWith(".tsv")).sort();
  /** Both sides of a fixture's harness paths, where it carries them, and the base's recorded answers to the texts the
   *  selector searches it for (README.md there). */
  const sides = (name: string): { base?: Tree; head?: Tree } => {
    const file = join(at, name.replace(/\.tsv$/, ".trees.json"));
    if (!existsSync(file)) return {};
    const t = JSON.parse(readFileSync(file, "utf8")) as { base: { dirs: string[]; files: Record<string, string>; names?: Record<string, boolean> }; head: { files: Record<string, string> } };
    return { base: tree(t.base.files, t.base.dirs, t.base.names ?? {}), head: tree(t.head.files) };
  };
  const files = testFiles(ROOT);
  const known = new Set(files);
  const sqliteAll = files.filter((_, i) => i % 9 === 0);
  /** A planted graph: every third test of the workspaces the change is in, and every thirteenth file of the tree. */
  const hit = (related: string[]) => {
    const areas = new Set(related.map(areaOf).filter(Boolean));
    return files.filter((f, i) => (areas.has(areaOf(f)) && i % 3 === 0) || i % 13 === 0);
  };
  const graph = async (_root: string, related: string[], { config }: GraphOptions) =>
    (config === "vitest.sqlite.config.ts" ? { related: hit(related).filter((f) => sqliteAll.includes(f)), all: sqliteAll } : { related: hit(related), all: files });
  const handed = (plan: Plan) => [...plan.shards.flatMap((s) => s.files.split("\n")), ...plan.alone].sort();
  const sqliteHanded = (plan: Plan) => (plan.sqlite ?? []).flatMap((s) => s.files.split("\n")).sort();
  const plans = new Map<string, { changes: { s: string; p: string }[]; main: Plan; next: Plan }>();
  /** The pull requests whose harness paths only add a package's lines: selected into next, whole into main. */
  const added = ["811.tsv", "812.tsv"];
  /** The pull requests whose harness paths only add lines beside a reason that caps them into next: an alias line for
   *  a new entry, a shard map that follows their own test files, and deleted modules. */
  const beside = ["869.tsv", "874.tsv"];

  beforeAll(async () => {
    const unread: Tree = { read: () => { throw new Error("main read a side of the pull request"); }, exists: () => { throw new Error("main asked for a directory"); } };
    for (const name of history) {
      const changes = parseNameStatus(readFileSync(join(at, name), "utf8"));
      const main = await select({ root: ROOT, ctx: pr(), changes, graph, base: unread, head: unread }) as Plan;
      const next = await select({ root: ROOT, ctx: pr({ base: { ref: "next" } }), changes, graph, ...sides(name) }) as Plan;
      plans.set(name, { changes, main, next });
    }
  }, 600_000);

  it("plans a base of main as before: no new key, nothing deferred, every related file handed on", async () => {
    const { desktopFiles } = await import("./support/ci-shards.mjs");
    const desktop = new Set(desktopFiles(ROOT, files));
    expect(history).toHaveLength(23);
    for (const [name, { changes, main }] of plans) {
      if (main.scope === "whole") { expect(Object.keys(main), name).toEqual(["scope", "why"]); continue; }
      expect(added, name).not.toContain(name);
      expect(Object.keys(main), name).toEqual(["scope", "why", "shards", "alone", "sqlite", "summary"]);
      expect(Object.keys(main.summary!), name).toEqual(["changed", "rules", "main", "alone", "sqlite", "share", "costsMeasuredAt"]);
      expect(main.why, name).toBe(`${changes.length} changed path(s)`);
      const got = new Set(handed(main));
      const present = changes.map((c) => c.p);
      expect(hit(present).filter((f) => !got.has(f) && !desktop.has(f)), name).toEqual([]);
    }
  });

  it("loses nothing for a base of next: what it runs, leaves and defers is the selection and the floor, file for file", async () => {
    const { desktopFiles } = await import("./support/ci-shards.mjs");
    const desktop = new Set(desktopFiles(ROOT, files));
    /** What the rules select, built here from the same parts: the changed tests, the graph, root test/, the readers. */
    const readers = new Map<string, ReturnType<typeof readersOf>>();
    const readersFor = (changes: { s: string; p: string }[]) => {
      const deleted = changes.filter((c) => c.s === "D").map((c) => c.p);
      const key = deleted.join("\n");
      if (!readers.has(key)) readers.set(key, readersOf(ROOT, files, { code: stripComments, relativeImports, deleted }));
      return readers.get(key)!;
    };
    const selection = (changes: { s: string; p: string }[]) => {
      const present = changes.filter((c) => c.s !== "D").map((c) => c.p);
      const all = new Set([...present, ...hit(relatedInputs(ROOT, present)), ...files.filter((f) => f.startsWith("test/")), ...readerHits(ROOT, changes, readersFor(changes)).keys()]);
      return [...all].filter((f) => known.has(f)).sort();
    };
    /** The floor, from the same parts: root test/, every git spawner, bundle reader and tree-wide census, and both databases' tests for a migration. */
    const floor = (changes: { s: string; p: string }[]) => {
      const out = new Set([...files.filter((f) => f.startsWith("test/")), ...[...readersFor(changes)].filter(([, r]) => r.git || r.bundle || r.sweep).map(([f]) => f)]);
      if (changes.some((c) => /^packages\/(?:db|db-mail)\/drizzle[^/]*\//.test(c.p))) for (const f of files) if (/^packages\/(?:db|db-mail)\//.test(f)) out.add(f);
      return [...out];
    };
    // The desktop job runs its files on every run; the second store's list is the selection's and the floor's part of that project.
    const reach = (changes: { s: string; p: string }[]) => [...new Set([...selection(changes), ...floor(changes)])].filter((f) => !desktop.has(f)).sort();
    const sqliteReach = (changes: { s: string; p: string }[]) => [...new Set([...selection(changes), ...floor(changes)])].filter((f) => sqliteAll.includes(f)).sort();
    const compared: string[] = [];
    const judged: string[] = [];
    for (const [name, { changes, main, next }] of plans) {
      // 818 changes two manifests and no other harness path: beside an overridden diff main's version check reads
      // this checkout's own last commit, so its answer here is not the fixture's (the planted merge below has it).
      if (name === "818.tsv") continue;
      const selected = main.scope === "selected";
      // The judge makes next's run whole as main's, in the same words; every other reason main gives is capped into next.
      if (next.scope === "whole") { expect(next, name).toEqual(main); judged.push(name); continue; }
      expect(next.scope, `${name}: ${next.why}`).toBe("selected");
      if (!selected && !added.includes(name)) {
        expect(next.mode, name).toBe("capped");
        if (beside.includes(name)) {
          // Main's reasons are harness paths next defers or reasons it caps for (the merge's own reading below holds them
          // equal; here main's manifest check reads this checkout's commit, as for 818); the first capped one leads.
          const reasons = next.capped!.map((c) => `${c.p}: ${c.what}`);
          expect(next.why, name).toBe(`CAPPED into next: ${reasons[0]}${reasons.length > 1 ? ` (and ${reasons.length - 1} more)` : ""}`);
        } else expect(next.why, name).toBe(`CAPPED into next: ${main.why}`);
      }
      const deferred = next.deferred!.map((d) => d.file);
      const left = (next.left ?? []).map((d) => d.file);
      const union = [...handed(next), ...deferred, ...left].sort();
      expect(union, name).toEqual(reach(changes));
      expect(new Set(union).size, name).toBe(union.length);
      if (selected) expect(union, name).toEqual([...new Set([...handed(main), ...floor(changes)])].filter((f) => !desktop.has(f)).sort());
      expect(deferred.filter((f) => !known.has(f)), name).toEqual([]);
      // Root test/ is the floor's: what waits for the whole run is the graph's reach into another workspace, and what the cap left.
      expect(next.deferred!.filter((d) => d.rule !== "graph"), name).toEqual([]);
      expect((next.left ?? []).filter((d) => d.rule !== "cap"), name).toEqual([]);
      const sqliteUnion = [...sqliteHanded(next), ...next.sqliteDeferred!, ...(next.sqliteLeft ?? [])].sort();
      expect(sqliteUnion, name).toEqual(sqliteReach(changes));
      if (selected) expect(sqliteUnion, name).toEqual([...new Set([...sqliteHanded(main), ...floor(changes).filter((f) => sqliteAll.includes(f))])].sort());
      expect(next.summary!.deferred, name).toBe(deferred.length);
      // Something waits for the whole run unless a changed module outside apps/ and packages/ keeps the graph's whole
      // reach (an admitted list of the root does not): root test/ is the floor's.
      const lists = new Set((next.harness ?? []).filter((h) => !areaOf(h.p)).map((h) => h.p));
      const wide = changes.some((c) => c.s !== "D" && !areaOf(c.p) && !lists.has(c.p) && /\.(?:[cm]?[jt]sx?|json|css)$/.test(c.p) && !/\.test\.[cm]?[jt]sx?$/.test(c.p));
      expect(deferred.length > 0, name).toBe(!wide);
      // A harness path is named on the plan exactly when the diff holds one the admission takes.
      expect(next.harness !== undefined, name).toBe(added.includes(name) || beside.includes(name));
      if (added.includes(name)) {
        expect(main.why, name).toMatch(/: a (?:dependency change|tsconfig)(?: \(and \d+ more\))?$/);
        // Its harness paths are no reason: FAST, or capped by its cost alone with its leavings named.
        expect(next.capped ?? [], name).toEqual([]);
        if (next.mode === "capped") {
          expect(next.why, name).toMatch(/^CAPPED into next: the (?:direct set|second store's set) costs \d+ s, over the cap of \d+ s$/);
          expect(next.left!.length + next.sqliteLeft!.length, name).toBeGreaterThan(0);
        } else {
          expect(next.why, name).toBe(`${changes.length} changed path(s); ${next.harness!.length} harness path(s) deferred to the whole run on next`);
        }
        expect(next.summary!.harness, name).toEqual(next.harness!.map((h) => h.p));
      }
      compared.push(name);
    }
    expect(compared).toHaveLength(18);
    expect(judged).toEqual(["805.tsv", "817.tsv", "819.tsv", "823.tsv"]);
    const named = (name: string) => plans.get(name)!.next.harness!.map((h) => `${h.p}: ${h.shape}`);
    expect(named("811.tsv")).toEqual([
      "package-lock.json: a workspace packages/cal-core and its link", "package.json: a workspace packages/cal-core",
      "packages/cal-core/package.json: new with packages/cal-core", "packages/cal-core/tsconfig.json: new with packages/cal-core",
      "packages/cal-core/tsconfig.test-dirs.json: new with packages/cal-core", "test/tsconfig.test-dirs-base.json: paths for @ohmail/cal-core",
      "tsconfig.json: a reference to ./packages/cal-core", "vitest.config.ts: an alias for @ohmail/cal-core",
    ]);
    expect(named("812.tsv")).toEqual([
      "apps/api-vercel/package.json: depends on @ohmail/server", "apps/api-vercel/tsconfig.check.json: a reference to ../server",
      "apps/server/package.json: exports ./program, ./settings, ./clocks", "package-lock.json: a dependency on @ohmail/server in apps/api-vercel",
    ]);
    // A first install and a moved version (818) are capped into next, the lockfile and the root manifest named.
    expect(plans.get("818.tsv")!.next).toMatchObject({
      scope: "selected", mode: "capped", why: "CAPPED into next: package-lock.json: a dependency change (and 1 more)",
      capped: [{ p: "package-lock.json", what: "a dependency change" }, { p: "package.json", what: "a dependency change" }],
    });
  });
});

describe("main's plan for each of them, on the merge commit itself", () => {
  const at = join(ROOT, "test/fixtures/ci-select-history");
  const history = readdirSync(at).filter((f) => f.endsWith(".tsv")).sort();
  /**
   * A fixture as a repository: its paths added, modified and deleted between a base commit and a head commit,
   * the fixture's own text where it carries a side (the harness paths, and the lockfile in both commits where the
   * diff leaves it), a stub elsewhere, and the merge.
   */
  const plant = (name: string) => {
    const changes = parseNameStatus(readFileSync(join(at, name), "utf8"));
    const file = join(at, name.replace(/\.tsv$/, ".trees.json"));
    const t = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { base: { dirs: string[]; files: Record<string, string> }; head: { files: Record<string, string> } } : null;
    const stub = (p: string, side: string) => (p.endsWith(".json") ? `{ "side": "${side}" }\n` : `// ${side}\nexport {};\n`);
    const base: Record<string, string> = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`packages/zz-far/test/far${i}.test.ts`, "export {};\n"]));
    const head: Record<string, string> = {};
    for (const d of t?.base.dirs ?? []) base[`${d}/.held`] = "";
    for (const { s, p } of changes) {
      if (s !== "A") base[p] = t?.base.files[p] ?? stub(p, "base");
      if (s !== "D") head[p] = t?.head.files[p] ?? stub(p, "head");
    }
    for (const [p, text] of Object.entries(t?.base.files ?? {})) base[p] ??= text;
    for (const [p, text] of Object.entries(t?.head.files ?? {})) head[p] ??= text;
    return { changes, ...plantPr(base, head, changes.filter((c) => c.s === "D").map((c) => c.p)) };
  };
  /** A planted graph over the planted tree: the tests of the workspaces the change is in, and every fifth file. */
  const graph = async (root: string, related: string[], { config }: GraphOptions) => {
    const files = testFiles(root);
    const areas = new Set(related.map(areaOf).filter(Boolean));
    return config === "vitest.sqlite.config.ts" ? { related: [], all: [] } : { related: files.filter((f, i) => areas.has(areaOf(f)) || i % 5 === 0), all: files };
  };
  const planted = new Map<string, ReturnType<typeof plant>>();
  beforeAll(() => { for (const name of history) planted.set(name, plant(name)); }, 300_000);

  it("is the plan the selector wrote before next deferred any harness path, to the byte", async () => {
    // <pr>.main.json is that plan; CI_SELECT_RECORD_MAIN=1 writes it from the selector under test (README.md there).
    for (const [name, { dir, headSha }] of planted) {
      const golden = join(at, name.replace(/\.tsv$/, ".main.json"));
      const plan = `${JSON.stringify(await select({ root: dir, ctx: merged(headSha), graph }))}\n`;
      if (process.env.CI_SELECT_RECORD_MAIN === "1") writeFileSync(golden, plan);
      expect(plan, name).toBe(readFileSync(golden, "utf8"));
    }
  }, 300_000);

  it("reads the same merge into next from git: selected where the harness paths only add, capped by name for every other reason, whole in main's words for the judge", async () => {
    const whole: string[] = [];
    const capped: string[] = [];
    for (const [name, { dir, headSha, changes }] of planted) {
      const main = decideScope({ root: dir, ctx: merged(headSha) });
      const next = decideScope({ root: dir, ctx: merged(headSha, "next") });
      if (main.scope === "selected") { expect(next, name).toEqual(main); continue; }
      if (next.scope === "whole") { expect(next, name).toEqual(main); whole.push(name); continue; }
      const reasons = (next.capped ?? []).map((c) => `${c.p}: ${c.what}`);
      if (!reasons.length) {
        expect(next.why, name).toBe(`${changes.length} changed path(s); ${next.harness!.length} harness path(s) deferred to the whole run on next`);
        // Each reason main gives is a harness path next names.
        expect(next.harness!.map((h) => `${h.p}: ${h.what}`), name).toEqual(pathTriggers(dir, changes).whole);
        continue;
      }
      // Each reason main gives is a harness path next defers or a reason it caps for, the first of those leading its why.
      expect(next.why, name).toBe(`CAPPED into next: ${reasons[0]}${reasons.length > 1 ? ` (and ${reasons.length - 1} more)` : ""}`);
      expect([...(next.harness ?? []).map((h) => `${h.p}: ${h.what}`), ...reasons].sort(), name).toEqual([...pathTriggers(dir, changes).whole].sort());
      capped.push(name);
    }
    expect(whole).toEqual(["805.tsv", "817.tsv", "819.tsv", "823.tsv"]);
    expect(capped).toEqual(["789.tsv", "808.tsv", "818.tsv", "869.tsv", "874.tsv"]);
  }, 300_000);
});

describe("the packing", () => {
  const cost = (ms: Record<string, number>) => (f: string) => ms[f] ?? 5000;

  it("is deterministic, bounded, keeps a group in one job and hands every file once", () => {
    const fs = Array.from({ length: 100 }, (_, i) => `packages/p/test/f${String(i).padStart(3, "0")}.test.ts`);
    const ms = Object.fromEntries(fs.map((f, i) => [f, 30_000 + (i % 7) * 10_000]));
    const a = packFiles(fs, cost(ms), MAX_SHARDS);
    expect(packFiles([...fs].reverse(), cost(ms), MAX_SHARDS)).toEqual(a);
    const total = Object.values(ms).reduce((s, x) => s + x, 0);
    expect(a).toHaveLength(Math.min(MAX_SHARDS, Math.ceil(total / (TARGET_S * 1000))));
    expect(a.flat().sort()).toEqual([...fs].sort());
    expect(packFiles(fs.slice(0, 2), cost(ms), MAX_SHARDS)).toHaveLength(1);
    expect(packFiles(fs, () => 3_600_000, MAX_SHARDS)).toHaveLength(MAX_SHARDS);
    expect(packFiles([], cost(ms), MAX_SHARDS)).toEqual([]);
    const pinned = new Set(fs.slice(0, 5));
    const g = packFiles(fs, cost(ms), MAX_SHARDS, (f) => (pinned.has(f) ? "dovecot" : null));
    expect(g.filter((b) => b.some((f) => pinned.has(f)))).toHaveLength(1);
  });

  const marker = ["@postpush", "alone"].join(": ");
  const planted = () => plantTree({
    "packages/q/src/x.ts": "export {};\n",
    "packages/q/test/big.test.ts": "export {};\n", "packages/q/test/small.test.ts": "export {};\n",
    "packages/q/test/other.test.ts": "export {};\n", "packages/q/test/sqonly.test.ts": "export {};\n", "packages/q/test/twin.pg.test.ts": `// ${marker}\nexport {};\n`,
    "packages/q/test/condstore.imap.test.ts": "const port = process.env.IMAP_CONDSTORE_PORT;\nexport { port };\n",
    "test/root.test.ts": "export {};\n",
  });
  const costs = { measuredAt: "planted", suite: { "packages/q/test/big.test.ts": 900_000, "packages/q/test/small.test.ts": 10_000, "packages/q/test/other.test.ts": 40_000, "test/root.test.ts": 1000, "packages/q/test/condstore.imap.test.ts": 20_000 }, sqlite: {} };
  const graph = (sqlite: string[], main: string[] = []) => async (_root: string, _related: string[], { config }: { config?: string | false }) =>
    config === "vitest.sqlite.config.ts"
      ? { related: sqlite, all: ["packages/q/test/small.test.ts", "packages/q/test/other.test.ts", "packages/q/test/sqonly.test.ts"] }
      : { related: main, all: [] };

  it("runs whole when the selection costs WHOLE_SHARE of the measured suite", async () => {
    const dir = planted();
    const big = await select({ root: dir, ctx: pr(), changes: [M("packages/q/test/big.test.ts")], graph: graph([]), costs });
    expect(big.scope).toBe("whole");
    expect(big.why).toMatch(/^the selection costs \d+% of the whole suite$/);
    expect(900_000 / (900_000 + 10_000 + 40_000 + 1000 + 20_000)).toBeGreaterThanOrEqual(WHOLE_SHARE);
  });

  it("routes an alone file to its own job, a Dovecot file to a shard that starts it, and the SQLite set apart", async () => {
    const dir = planted();
    const plan = await select({
      root: dir, ctx: pr(), graph: graph(["packages/q/test/sqonly.test.ts"], ["packages/q/test/other.test.ts"]), costs,
      changes: [M("packages/q/test/small.test.ts"), M("packages/q/test/twin.pg.test.ts"), M("packages/q/test/condstore.imap.test.ts")],
    }) as Plan;
    expect(plan.scope).toBe("selected");
    expect(plan.alone).toEqual(["packages/q/test/twin.pg.test.ts"]);
    expect(plan.shards).toEqual([{ shard: 0, files: "packages/q/test/condstore.imap.test.ts\npackages/q/test/other.test.ts\npackages/q/test/small.test.ts\ntest/root.test.ts", dovecot: "yes" }]);
    expect(plan.sqlite).toEqual([{ shard: 0, files: "packages/q/test/other.test.ts\npackages/q/test/small.test.ts\npackages/q/test/sqonly.test.ts" }]);
    expect(plan.summary!.rules).toEqual({ changed: 3, graph: 1, root: 1, named: 0, tree: 0, area: 0, always: 0, sweep: 0, dovecot: 0 });
    const whole = await select({ root: dir, ctx: pr(), graph: graph([]), costs, changes: [M("vitest.sqlite.config.ts")] }) as Plan;
    expect(whole.sqlite).toBeNull();
  });
});

describe("the plan job's outputs", () => {
  const base = { indexes: [0, 1, 2], sqliteIndexes: [0, 1], alone: ["packages/q/test/twin.pg.test.ts"] };
  const plan: Plan = {
    scope: "selected", why: "2 changed path(s)", alone: [], sqlite: null,
    shards: [{ shard: 0, files: "packages/q/test/a.test.ts\ntest/root.test.ts", dovecot: "no" }],
  };

  it("hands a landing round no test jobs and explains when the suite runs", () => {
    const decision = decideScope({
      root: ROOT,
      ctx: pr({ base: { ref: "next" }, head: { ref: "pr/round-example", repo: { full_name: "trafficflowhq/ohmail" } } }),
      changes: [M(".github/workflows/ci.yml")],
    });
    const out = composeOutputs({ ...base, scope: decision.scope, scopeWhy: decision.why });
    expect(out).toMatchObject({ scope: "build-only", shards: [], alone: [], sqlite: [] });
    expect(summaryText(out)).toContain("the batch build");
    expect(summaryText(out)).toContain("after landing");
  });

  it("hands the selected plan on, and the whole run in every other case, with its reason", () => {
    const sel = composeOutputs({ ...base, scope: "selected", selectOutcome: "success", plan });
    expect(sel).toMatchObject({ scope: "selected", shards: plan.shards, alone: [], sqlite: [{ shard: 0 }, { shard: 1 }] });
    const whole = composeOutputs({ ...base, scope: "whole", scopeWhy: "a schedule run is whole" });
    expect(whole).toEqual({ scope: "whole", why: "a schedule run is whole", shards: [{ shard: 0 }, { shard: 1 }, { shard: 2 }], alone: base.alone, sqlite: [{ shard: 0 }, { shard: 1 }], summary: null });
    const refused: Array<[string, Plan]> = [
      ["a bad path", { ...plan, shards: [{ shard: 0, files: "packages/q/test/a b.test.ts", dovecot: "no" }] }],
      ["a file twice", { ...plan, shards: [...plan.shards, { shard: 1, files: "test/root.test.ts", dovecot: "no" }] }],
      ["an alone file in a shard", { ...plan, shards: [{ shard: 0, files: "packages/q/test/twin.pg.test.ts", dovecot: "no" }] }],
      ["an alone file that is not", { ...plan, alone: ["packages/q/test/a.test.ts"] }],
      ["a malformed shard", { ...plan, shards: [{ shard: 0, files: "", dovecot: "no" }] }],
    ];
    for (const [what, p] of refused) expect(composeOutputs({ ...base, scope: "selected", selectOutcome: "success", plan: p }).scope, what).toBe("whole");
    expect(composeOutputs({ ...base, scope: "", selectOutcome: "" }).scope).toBe("whole");
  });

  it("hands a direct plan's jobs on in the same shape, and its summary says where the rest runs", () => {
    const summary = { changed: 2, rules: { graph: 2 }, main: 2, alone: 0, sqlite: "whole" as const, share: 1.5, costsMeasuredAt: "planted" };
    const reach = composeOutputs({ ...base, scope: "selected", selectOutcome: "success", plan: { ...plan, summary } });
    expect(summaryText(reach)).toContain("partial run: the whole suite runs on the batch and nightly.");
    const direct: Plan = {
      ...plan, mode: "direct", deferred: [{ file: "packages/r/test/far.test.ts", rule: "graph" }], sqliteDeferred: [],
      summary: { ...summary, base: "next", deferred: 1, deferredS: 40 },
    };
    const out = composeOutputs({ ...base, scope: "selected", selectOutcome: "success", plan: direct });
    expect(Object.keys(out)).toEqual(Object.keys(reach));
    expect(out).toMatchObject({ scope: "selected", shards: plan.shards, alone: [], sqlite: reach.sqlite });
    const text = summaryText(out);
    expect(text).toContain("fast run: 1 more file(s) (40 s measured) run in the whole suite on next after landing; the plan job's log lists them.");
    expect(text).not.toContain("batch and nightly");
    // A deferred file that is also handed on, or is no test file of the run, is a problem of the plan.
    const sets = { files: ["packages/q/test/a.test.ts", "test/root.test.ts", "packages/r/test/far.test.ts"], alone: new Set<string>(), desktop: new Set<string>(), sqliteAll: [] };
    expect(planProblems(direct, sets)).toEqual([]);
    expect(planProblems({ ...direct, deferred: [{ file: "test/root.test.ts", rule: "root" }] }, sets)).toEqual(["test/root.test.ts is handed on and deferred"]);
    expect(planProblems({ ...direct, sqliteDeferred: ["packages/q/test/gone.test.ts"] }, sets)).toEqual(["sqlite deferred: packages/q/test/gone.test.ts is not a test file of this run"]);
  });

  it("prints them as output lines through the CLI, whole when no plan file is there", () => {
    const run = spawnSync(process.execPath, [SELECT, "outputs", "--indexes", "[0,1]", "--sqlite-indexes", "[0]", "--alone", "[]",
      "--scope", "selected", "--scope-why", "1 changed path(s)", "--select-outcome", "success", "--plan", join(scratch, "no-such-plan.json")], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('scope=whole\nwhy=the selector wrote no plan\nshards=[{"shard":0},{"shard":1}]\nalone=[]\nsqlite=[{"shard":0}]\n');
  });

  it("measures its costs from a whole run, in this tree", () => {
    const costs = JSON.parse(readFileSync(join(ROOT, "test/support/ci-costs.json"), "utf8")) as { measuredAt: string; suite: Record<string, number>; sqlite: Record<string, number> };
    expect(costs.measuredAt).toMatch(/^\d+$/);
    expect(Object.keys(costs.suite).length).toBeGreaterThan(3000);
    expect(Object.keys(costs.sqlite).length).toBeGreaterThan(100);
  });
});

/**
 * THE CAP. A maintainer's pull request into next runs the floor and its direct set held to six jobs' measured
 * time; it runs whole only for the judge (what decides which files run and under what) and for a failure. A
 * dependency, a patch, a tsconfig, a shard map, the lane database, a migration or a deleted module is capped
 * there, not whole, and the plan's log says FAST or CAPPED.
 */
describe("the cap: a pull request into next", () => {
  const own = { full_name: "trafficflowhq/ohmail" };
  const intoNext = pr({ number: 813, base: { ref: "next" }, head: { ref: "pr/x", sha: "2".repeat(40), repo: own } });
  const hdr = 'import { existsSync, readFileSync, readdirSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\n'
    + 'import { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst HERE = dirname(fileURLToPath(import.meta.url));\n';
  const alone = `// ${["@postpush", "alone"].join(": ")}\nexport {};\n`;
  /** A file of each of the floor's four kinds beside root test/: a git spawner, a bundle reader, a census of the whole tree. */
  const floorTree: Record<string, string> = {
    "test/root-a.test.ts": "export {};\n", "test/root-b.test.ts": "export {};\n",
    "packages/g/test/git.test.ts": `${hdr}export const files = () => execFileSync("git", ["ls-files"]);\n`,
    "packages/b/test/bundle.test.ts": `${hdr}export const built = () => existsSync(join(HERE, "../../../build/engine/engine.js"));\n`,
    "packages/w/test/census.test.ts": `${hdr}const ROOT = join(HERE, "..", "..", "..");\nexport const all = () => ["packages", "apps"].map((d) => readdirSync(join(ROOT, d)));\n`,
  };
  const floor = ["packages/b/test/bundle.test.ts", "packages/g/test/git.test.ts", "packages/w/test/census.test.ts", "test/root-a.test.ts", "test/root-b.test.ts"];
  /** vitest's two graphs, planted: what the main config relates, and the second store's project. */
  const graphOf = (main: string[], sqlite: { related: string[]; all: string[] } = { related: [], all: [] }) =>
    async (_root: string, _related: string[], { config }: GraphOptions) => (config === "vitest.sqlite.config.ts" ? sqlite : { related: main, all: [] });
  const unmeasured = { measuredAt: "planted", suite: {}, sqlite: {} };
  const handed = (p: Plan) => [...p.shards.flatMap((s) => s.files.split("\n")), ...p.alone].sort();
  const migration = { s: "A", p: "packages/db/drizzle/0999_planted.sql" };

  it("keeps the whole suite for the judge: the suite workflow, the selector, the shard walker, the service reader, the vitest config and test/setup, into next as into main", () => {
    const judge: Array<[string, string?]> = [
      [".github/workflows/ci.yml"], [".github/scripts/ci-select.mjs"], ["test/support/ci-shards.mjs"], ["test/support/service-needs.mjs"], ["vitest.config.ts"],
      ["test/setup/services.global.ts"], ["test/support/services.ts"], ["packages/db/src/testing.ts"], ["scripts/lib/pg-url-own.mjs"],
      // Gone, a judge path is the judge's still.
      ["test/support/service-needs.mjs", "D"], ["test/setup/services.global.ts", "D"], ["vitest.config.ts", "D"],
      // A workspace or projects file vitest loads beside its config.
      ["vitest.workspace.ts", "A"], ["vitest.projects.json", "A"],
    ];
    for (const [p, s = "M"] of judge) {
      const changes = [{ s, p }];
      const main = decideScope({ root: ROOT, ctx: pr(), changes });
      expect(main.scope, p).toBe("whole");
      expect(decideScope({ root: ROOT, ctx: intoNext, changes }), p).toEqual(main);
      // Beside a reason that is capped, the judge makes the run whole all the same, in main's words.
      const beside = [migration, { s, p }];
      expect(decideScope({ root: ROOT, ctx: intoNext, changes: beside }), p).toEqual(decideScope({ root: ROOT, ctx: pr(), changes: beside }));
    }
    // The six plain tests, and their neighbours that are no judge.
    for (const p of [".github/workflows/ci.yml", ".github/scripts/ci-select.mjs", "test/support/ci-shards.mjs", "test/support/service-needs.mjs", "test/setup/any.ts", ...setupClosure(ROOT)]) {
      expect(isJudge(ROOT, p, false), p).toBe(true);
    }
    expect(isJudge(ROOT, "vitest.config.ts", false)).toBe(true);
    // An admitted alias line for a new package is deferred as today, under the collection guard.
    expect(isJudge(ROOT, "vitest.config.ts", true)).toBe(false);
    for (const p of [".github/workflows/build.yml", ".github/scripts/pr-build-scope.sh", "test/support/ci-shards.json", "test/support/public-root.mjs", "vitest.sqlite.config.ts", "test/setup-notes.md", "packages/db/drizzle/meta/_journal.json"]) {
      expect(isJudge(ROOT, p, false), p).toBe(false);
    }
    // The shard walker and the service reader are the judge's by their path alone: into next they are whole in a tree
    // whose test/setup loads neither, where main, which reads the triggers a path meets, selects them.
    const lean = plantTree({ "test/setup/global.ts": "export default () => {};\n", "test/support/ci-shards.mjs": "export {};\n", "test/support/service-needs.mjs": "export {};\n" });
    expect(setupClosure(lean)).toEqual([]);
    for (const p of ["test/support/ci-shards.mjs", "test/support/service-needs.mjs"]) {
      expect(decideScope({ root: lean, ctx: pr(), changes: [M(p)] }).scope, p).toBe("selected");
      expect(decideScope({ root: lean, ctx: intoNext, changes: [M(p)] }), p).toEqual({ scope: "whole", why: `${p}: the test harness` });
    }
  });

  it("caps a migration, a dependency change, a patch, a tsconfig, a shard map and the lane database into next and names each as its reason; into main each is whole in the words it had", () => {
    const kinds: Array<[string, string]> = [
      ["packages/db/drizzle/0999_planted.sql", "a migration"], ["packages/db-mail/drizzle-sqlite/0999_planted.sql", "a migration"],
      ["packages/db/drizzle/meta/_journal.json", "a migration"], ["patches/some-dep@1.0.0.patch", "a dependency patch"], ["scripts/apply-patches.mjs", "a dependency patch"],
      ["tsconfig.base.json", "a tsconfig"], ["packages/core/tsconfig.json", "a tsconfig"], ["test/support/ci-shards.json", "the shard map"],
      ["test/support/ci-shards-sqlite.json", "the shard map"], ["scripts/lane-db.sh", "the lane database"], ["scripts/lane-db.mjs", "the lane database"],
    ];
    for (const [p, what] of kinds) {
      const changes = [M(p)];
      expect(decideScope({ root: ROOT, ctx: pr(), changes }), p).toEqual({ scope: "whole", why: `${p}: ${what}` });
      expect(decideScope({ root: ROOT, ctx: intoNext, changes }), p).toEqual({
        scope: "selected", why: `CAPPED into next: ${p}: ${what}`, changes, sqliteWhole: false, dovecotAll: false, capped: [{ p, what }],
      });
    }
    // All at once: each named, in the diff's order, the first leading the why.
    const all = kinds.map(([p]) => M(p));
    expect(decideScope({ root: ROOT, ctx: pr(), changes: all })).toEqual({ scope: "whole", why: `${kinds[0]![0]}: a migration (and ${kinds.length - 1} more)` });
    expect(decideScope({ root: ROOT, ctx: intoNext, changes: all })).toMatchObject({
      scope: "selected", why: `CAPPED into next: ${kinds[0]![0]}: a migration (and ${kinds.length - 1} more)`, capped: kinds.map(([p, what]) => ({ p, what })),
    });
    // A dependency moved, read from a real merge on both sides: the manifest and the lockfile, each named.
    const manifest = (dep: string) => `${JSON.stringify({ name: "p", version: "1.0.0", dependencies: { dep } }, null, 2)}\n`;
    const lock = (dep: string) => `${JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "p", version: "1.0.0", dependencies: { dep } }, "node_modules/dep": { version: dep } } }, null, 2)}\n`;
    const { dir, headSha } = plantPr({ "package.json": manifest("1.0.0"), "package-lock.json": lock("1.0.0") }, { "package.json": manifest("1.0.1"), "package-lock.json": lock("1.0.1") });
    expect(decideScope({ root: dir, ctx: merged(headSha) })).toEqual({ scope: "whole", why: "package-lock.json: a dependency change (and 1 more)" });
    expect(decideScope({ root: dir, ctx: merged(headSha, "next") })).toMatchObject({
      scope: "selected", why: "CAPPED into next: package-lock.json: a dependency change (and 1 more)",
      capped: [{ p: "package-lock.json", what: "a dependency change" }, { p: "package.json", what: "a dependency change" }],
    });
  });

  it("caps a deleted or renamed module into next; into main it is whole", () => {
    for (const p of ["apps/webapp/app/views/OhboxView.tsx", "packages/api/test/_forward-world.ts", "test/support/key-ring-env.ts", "scripts/lib/source-scan.mjs", "packages/core/test/fixtures/planted.json"]) {
      const changes = [{ s: "D", p }];
      expect(decideScope({ root: ROOT, ctx: pr(), changes }), p).toEqual({ scope: "whole", why: `${p}: deleted or renamed` });
      expect(decideScope({ root: ROOT, ctx: intoNext, changes }), p).toEqual({
        scope: "selected", why: `CAPPED into next: ${p}: deleted or renamed`, changes, sqliteWhole: false, dovecotAll: false, capped: [{ p, what: "deleted or renamed" }],
      });
    }
    // A rename is a deletion and an addition, and a wide move is many: each path that left is named.
    const moved = ["packages/core/src/a.ts", "packages/core/src/b.ts", "apps/worker/src/c.ts"];
    const move = [...moved.map((p) => ({ s: "D", p })), ...moved.map((p) => ({ s: "A", p: p.replace("/src/", "/src/moved/") }))];
    expect(decideScope({ root: ROOT, ctx: pr(), changes: move })).toEqual({ scope: "whole", why: `${moved[0]}: deleted or renamed (and 2 more)` });
    expect(decideScope({ root: ROOT, ctx: intoNext, changes: move })).toMatchObject({
      scope: "selected", why: `CAPPED into next: ${moved[0]}: deleted or renamed (and 2 more)`, capped: moved.map((p) => ({ p, what: "deleted or renamed" })),
    });
    // A deleted test file or document is no reason on either base.
    for (const p of ["packages/core/test/planted-gone.test.ts", "docs/organizer-profile.md"]) {
      const changes = [{ s: "D", p }];
      expect(decideScope({ root: ROOT, ctx: intoNext, changes }), p).toEqual({ scope: "selected", why: "1 changed path(s)", changes, sqliteWhole: false, dovecotAll: false });
    }
  });

  it("runs every test file that still imports a deleted or renamed module by a relative path, named and never cut; into main the deletion is whole", async () => {
    // A module renamed, three of its importers left behind (one in another workspace): vitest relates nothing to a file that is gone.
    const dir = plantTree({
      "packages/c/src/caps.ts": "export const caps = 1;\n",
      "packages/c/test/limits.test.ts": 'import { caps } from "../src/limits";\nexport const a = caps;\n',
      "packages/c/test/limits-js.test.ts": 'import { caps } from "../src/limits.js";\nexport const b = caps;\n',
      "packages/d/test/across.test.ts": 'import { caps } from "../../c/src/limits";\nexport const d = caps;\n',
      "packages/c/test/caps.test.ts": 'import { caps } from "../src/caps";\nexport const c = caps;\n',
      "packages/c/test/other.test.ts": "export {};\n", "test/root.test.ts": "export {};\n",
    });
    const changes = [{ s: "D", p: "packages/c/src/limits.ts" }, { s: "A", p: "packages/c/src/caps.ts" }];
    const stale = ["packages/c/test/limits-js.test.ts", "packages/c/test/limits.test.ts", "packages/d/test/across.test.ts"];
    // Each importer alone costs the cap: the fill would leave any of them, and they run all the same.
    const costs = { measuredAt: "planted", sqlite: {}, suite: Object.fromEntries(stale.map((f) => [f, CAP_S * 1000])) };
    const plan = await select({ root: dir, ctx: intoNext, changes, graph: graphOf(["packages/c/test/caps.test.ts"]), costs }) as Plan;
    expect(plan).toMatchObject({ mode: "capped", capped: [{ p: "packages/c/src/limits.ts", what: "deleted or renamed" }], deferred: [] });
    expect(handed(plan)).toEqual([...stale, "test/root.test.ts"].sort());
    expect(plan.summary!.rules.named).toBe(stale.length);
    // The rename's own test is the cap's to cut, and it is left by name.
    expect(plan.left).toEqual([{ file: "packages/c/test/caps.test.ts", rule: "cap" }]);
    expect(await select({ root: dir, ctx: pr(), changes, graph: graphOf([]), costs })).toEqual({ scope: "whole", why: "packages/c/src/limits.ts: deleted or renamed" });
  });

  it("runs the floor on every pull request into next: every root test, every git spawner, every bundle reader and every tree-wide census, whatever the diff", async () => {
    const dir = plantTree({
      ...floorTree, "docs/guide.md": "x\n", "packages/p/src/x.ts": "export const x = 1;\n",
      "packages/p/test/own.test.ts": 'import { x } from "../src/x";\nexport const a = x;\n', "packages/p/test/other.test.ts": "export {};\n", "packages/q/test/new.test.ts": "export {};\n",
    });
    const diffs: Array<[string, Array<{ s: string; p: string }>, string[]]> = [
      ["a document", [M("docs/guide.md")], []], ["a module", [M("packages/p/src/x.ts")], ["packages/p/test/own.test.ts"]],
      ["a test file", [M("packages/p/test/other.test.ts")], []], ["a new test file", [{ s: "A", p: "packages/q/test/new.test.ts" }], []],
    ];
    for (const [what, changes, related] of diffs) {
      const plan = await select({ root: dir, ctx: intoNext, changes, graph: graphOf(related), costs: unmeasured }) as Plan;
      expect(plan.mode, what).toBe("direct");
      expect(handed(plan), what).toEqual(expect.arrayContaining(floor));
      expect(plan.deferred!.filter((d) => floor.includes(d.file)), what).toEqual([]);
      expect(plan.summary!.floor, what).toBe(floor.length);
    }
    // Into main a document's change runs what reads it, as before: the bundle reader and the census are next's floor.
    const main = await select({ root: dir, ctx: pr(), changes: [M("docs/guide.md")], graph: graphOf([]), costs: unmeasured }) as Plan;
    expect(handed(main)).toEqual(["packages/g/test/git.test.ts", "test/root-a.test.ts", "test/root-b.test.ts"]);
  });

  it("puts the whole of packages/db and packages/db-mail in the floor when a journal changes, their alone files among them", async () => {
    const db = ["packages/db-mail/test/c.test.ts", "packages/db/test/a.test.ts", "packages/db/test/b.pg.test.ts"];
    const dir = plantTree({
      "test/root.test.ts": "export {};\n", "packages/db/drizzle/meta/_journal.json": "{}\n", "packages/db-mail/drizzle-sqlite/0001_planted.sql": "select 1;\n",
      "packages/db/src/schema.ts": "export {};\n", "packages/db/test/replay.pg.test.ts": alone, "packages/core/test/d.test.ts": "export {};\n",
      ...Object.fromEntries(db.map((f) => [f, "export {};\n"])),
    });
    for (const p of ["packages/db/drizzle/meta/_journal.json", "packages/db-mail/drizzle-sqlite/0001_planted.sql"]) {
      const plan = await select({ root: dir, ctx: intoNext, changes: [M(p)], graph: graphOf([]), costs: unmeasured }) as Plan;
      expect(plan.mode, p).toBe("capped");
      expect(plan.capped, p).toEqual([{ p, what: "a migration" }]);
      expect(plan.shards.flatMap((s) => s.files.split("\n")).sort(), p).toEqual([...db, "test/root.test.ts"]);
      expect(plan.alone, p).toEqual(["packages/db/test/replay.pg.test.ts"]);
      expect(plan.left, p).toEqual([]);
      expect(plan.summary!.floor, p).toBe(5);
    }
    // Without a journal the databases' tests are no part of the floor: a change to their source runs what reaches it.
    const source = await select({ root: dir, ctx: intoNext, changes: [M("packages/db/src/schema.ts")], graph: graphOf(["packages/db/test/a.test.ts"]), costs: unmeasured }) as Plan;
    expect(source.mode).toBe("direct");
    expect(handed(source)).toEqual(["packages/db/test/a.test.ts", "test/root.test.ts"]);
  });

  it("fills the cap with the direct set, the Postgres files first, then the cheapest, and leaves the rest by name; the floor, the changed files and the readers are never cut", async () => {
    const t = (g: string) => `packages/p/test/${g}.test.ts`;
    const rest = ["g1.pg", "g2.pg", "g3a", "g3b", "g4", "g5"];
    const dir = plantTree({
      "test/root.test.ts": "export {};\n", "packages/p/src/x.ts": "export const x = 1;\n", [t("changed")]: "export {};\n",
      [t("reads")]: `${hdr}export const src = () => readFileSync(join(HERE, "../src/x.ts"), "utf8");\n`,
      ...Object.fromEntries(rest.map((g) => [t(g), "export {};\n"])),
    });
    const graph = graphOf(rest.map(t));
    const changes = [M("packages/p/src/x.ts"), M(t("changed"))];
    const seconds: Record<string, number> = { "test/root.test.ts": 600, [t("changed")]: 900, [t("reads")]: 700, [t("g1.pg")]: 800, [t("g2.pg")]: 300, [t("g3a")]: 200, [t("g3b")]: 200, [t("g4")]: 250, [t("g5")]: 400 };
    const cost = (over: Record<string, number> = {}) => ({ measuredAt: "planted", sqlite: {}, suite: Object.fromEntries(Object.entries({ ...seconds, ...over }).map(([f, s]) => [f, s * 1000])) });
    const plan = await select({ root: dir, ctx: intoNext, changes, graph, costs: cost() }) as Plan;
    // 2200 s never cut, then 300 and 800 s of Postgres, then 200 s: 3500 s. The next file, 200 s, would pass the cap.
    expect(plan.mode).toBe("capped");
    expect(plan.why).toBe(`CAPPED into next: the direct set costs 4350 s, over the cap of ${CAP_S} s`);
    expect(plan.capped).toEqual([]);
    expect(handed(plan)).toEqual([...["changed", "g1.pg", "g2.pg", "g3a", "reads"].map(t), "test/root.test.ts"]);
    expect(plan.left).toEqual(["g3b", "g4", "g5"].map((g) => ({ file: t(g), rule: "cap" })));
    expect(plan.summary).toMatchObject({ floor: 1, neverCut: 2, filled: 3, left: 3, leftS: 850, measuredS: 3500 });
    expect(plan.shards.length).toBeLessThanOrEqual(CAP_JOBS);
    // At the first file that does not fit the fill stops: a cheaper file after it is left as well.
    const stopped = await select({ root: dir, ctx: intoNext, changes, graph, costs: cost({ [t("g1.pg")]: 1300 }) }) as Plan;
    expect(stopped.left!.map((d) => d.file)).toEqual(["g1.pg", "g3a", "g3b", "g4", "g5"].map(t));
    // The floor, the changed file and the reader alone pass the cap: they run, nothing else does, and the plan says by how much.
    const over = await select({ root: dir, ctx: intoNext, changes, graph, costs: cost({ [t("changed")]: 5000 }) }) as Plan;
    expect(handed(over)).toEqual([t("changed"), t("reads"), "test/root.test.ts"]);
    expect(over.left).toHaveLength(rest.length);
    expect(over.summary).toMatchObject({ filled: 0, measuredS: 6300, overCapS: 6300 - CAP_S });
    // Under the cap nothing is cut: FAST, as today, with the floor in it.
    const fast = await select({ root: dir, ctx: intoNext, changes, graph, costs: unmeasured }) as Plan;
    expect(fast.mode).toBe("direct");
    expect(fast.left).toBeUndefined();
    expect(handed(fast)).toHaveLength(rest.length + 3);
  });

  it("runs an alone file of a capped run only when it is never cut", async () => {
    const [edited, reached] = ["packages/s/test/edited.pg.test.ts", "packages/s/test/reached.pg.test.ts"];
    const dir = plantTree({ "test/root.test.ts": "export {};\n", "packages/s/src/y.ts": "export const y = 1;\n", [edited]: alone, [reached]: alone, "packages/s/test/plain.test.ts": "export {};\n" });
    const graph = graphOf([reached, "packages/s/test/plain.test.ts"]);
    const changes = [M("packages/s/src/y.ts"), M(edited)];
    const capped = await select({ root: dir, ctx: intoNext, changes: [...changes, M("test/support/ci-shards.json")], graph, costs: unmeasured }) as Plan;
    expect(capped.mode).toBe("capped");
    expect(capped.alone).toEqual([edited]);
    expect(capped.left).toEqual([{ file: reached, rule: "cap" }]);
    expect(handed(capped)).toEqual([edited, "packages/s/test/plain.test.ts", "test/root.test.ts"]);
    // Nothing cut, the run is FAST and runs the alone file the graph reached, as today.
    const fast = await select({ root: dir, ctx: intoNext, changes, graph, costs: unmeasured }) as Plan;
    expect(fast.mode).toBe("direct");
    expect(fast.alone).toEqual([edited, reached]);
  });

  it("holds the second store's run to one job, and keeps it whole for its own config", async () => {
    const sq = ["changed", "s1", "s2", "s3", "s4"].map((x) => `packages/sd/test/${x}.test.ts`);
    const [changed, s1, s2, s3, s4] = sq as [string, string, string, string, string];
    const dir = plantTree({ "test/root.test.ts": "export {};\n", "packages/sd/src/z.ts": "export const z = 1;\n", ...Object.fromEntries(sq.map((f) => [f, "export {};\n"])) });
    const graph = graphOf([s1, s2, s3, s4], { related: [s1, s2, s3, s4], all: sq });
    const costs = { measuredAt: "planted", suite: {}, sqlite: { [changed]: 300_000, [s1]: 100_000, [s2]: 150_000, [s3]: 200_000, [s4]: 50_000 } };
    const changes = [M("packages/sd/src/z.ts"), M(changed)];
    const plan = await select({ root: dir, ctx: intoNext, changes, graph, costs }) as Plan;
    // 300 s never cut, then 50, 100 and 150 s: 600 s, one job. The 200 s file is left to the night, by name.
    expect(plan.sqlite).toEqual([{ shard: 0, files: [changed, s1, s2, s4].join("\n") }]);
    expect(plan.sqliteLeft).toEqual([s3]);
    expect(plan.mode).toBe("capped");
    expect(plan.why).toBe(`CAPPED into next: the second store's set costs 800 s, over the cap of ${SQLITE_CAP_S} s`);
    // Its own config changed, the second store runs whole, as today.
    const whole = await select({ root: dir, ctx: intoNext, changes: [...changes, M("vitest.sqlite.config.ts")], graph, costs }) as Plan;
    expect(whole.sqlite).toBeNull();
    expect(whole.sqliteLeft).toBeUndefined();
    expect(whole.mode).toBe("direct");
  });

  it("says CAPPED on the plan's first log line with the pull request, its head, its base and the reason, FAST when nothing was cut, and never both", () => {
    const base = {
      "vitest.config.ts": 'export default { test: { include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"] } };\n',
      "vitest.sqlite.config.ts": 'export default { test: { include: ["packages/p/test/own.test.ts"] } };\n',
      "packages/p/src/x.ts": "export const x = 1;\n", "packages/q/src/gone.ts": "export const gone = 1;\n",
      "packages/p/test/own.test.ts": 'import { x } from "../src/x";\nexport const a = x;\n', "test/root.test.ts": "export {};\n",
    };
    const run = (gone: string[]) => {
      const { dir, headSha } = plantPr(base, { "packages/p/src/x.ts": "export const x = 2;\n" }, gone);
      const baseSha = execFileSync("git", ["rev-parse", "HEAD^1"], { cwd: dir, encoding: "utf8" }).trim();
      const out = join(scratch, `log-${headSha}.json`);
      const cli = spawnSync(process.execPath, [SELECT, "select", "--root", dir, "--event", JSON.stringify(merged(headSha, "next")), "--out", out], { encoding: "utf8" });
      expect(cli.status, cli.stderr).toBe(0);
      return { headSha, baseSha, stdout: cli.stdout, lines: cli.stdout.split("\n"), plan: JSON.parse(readFileSync(out, "utf8")) as Plan };
    };
    const fast = run([]);
    expect(fast.lines.slice(0, 2)).toEqual([
      "SELECT selected: 1 changed path(s); 1 suite job(s), 0 alone, 1 sqlite",
      `FAST next: pr #811 head ${fast.headSha} on ${fast.baseSha}: runs 2 file(s) (floor 1) in 1 suite job(s) + 0 alone, defers 0 file(s) (0 s measured) to the whole run on next`,
    ]);
    const capped = run(["packages/q/src/gone.ts"]);
    expect(capped.lines).toEqual([
      "SELECT selected: CAPPED into next: packages/q/src/gone.ts: deleted or renamed; 1 suite job(s), 0 alone, 1 sqlite",
      `CAPPED next: pr #811 head ${capped.headSha} on ${capped.baseSha}: packages/q/src/gone.ts: deleted or renamed: runs 2 file(s) (10 s measured; floor 1, never cut 0, filled 1) in 1 suite job(s) + 0 alone, leaves 0 of its direct set (0 s) and defers 0 more (0 s) to the whole run on next`,
      "::group::capped: the reasons (1)", "deleted or renamed\tpackages/q/src/gone.ts", "::endgroup::",
      "::group::left by the cap (0)", "::endgroup::",
      "::group::deferred to the whole run on next (0)", "::endgroup::",
      "CAPPED next sqlite: runs 1 file(s) in 1 job(s), leaves 0 file(s) by the cap and defers 0 file(s) to the whole run on next",
      "::group::left by the cap, sqlite (0)", "::endgroup::",
      "::group::deferred to the whole run on next, sqlite (0)", "::endgroup::", "",
    ]);
    expect(deferredLog(capped.plan, merged(capped.headSha, "next"))).toBe(capped.lines.slice(1).join("\n"));
    // Never both: these fixed texts are what a landing reads.
    expect(fast.stdout).toContain("\nFAST next: pr #");
    expect(fast.stdout).not.toContain("CAPPED next");
    expect(capped.stdout).toContain("\nCAPPED next: pr #");
    expect(capped.lines.filter((l) => l.startsWith("FAST"))).toEqual([]);
  }, 120_000);

  it("prints why=CAPPED through the scope and outputs verbs, and a summary that says it is not a whole run", () => {
    const files = join(scratch, "capped.tsv");
    writeFileSync(files, `A\t${migration.p}\nM\tapps/webapp/app/views/OhboxView.tsx\n`);
    const scope = spawnSync(process.execPath, [SELECT, "scope", "--root", ROOT, "--event", JSON.stringify(intoNext), "--files", files], { encoding: "utf8" });
    expect(scope.stdout).toBe(`scope=selected\nwhy=CAPPED into next: ${migration.p}: a migration\n`);
    const why = `CAPPED into next: ${migration.p}: a migration`;
    const plan: Plan = {
      scope: "selected", why, shards: [{ shard: 0, files: "test/root.test.ts", dovecot: "no" }], alone: [], sqlite: null, mode: "capped",
      capped: [{ p: migration.p, what: "a migration" }], left: [{ file: "packages/p/test/far.test.ts", rule: "cap" }], deferred: [], sqliteDeferred: [],
      summary: {
        changed: 2, rules: { root: 1 }, main: 1, alone: 0, sqlite: "whole", share: 0.1, costsMeasuredAt: "planted", base: "next", deferred: 0, deferredS: 0,
        baseSha: "3".repeat(40), floor: 1, neverCut: 0, filled: 0, left: 1, leftS: 40, measuredS: 5, reason: `${migration.p}: a migration`,
      },
    };
    const at = join(scratch, "capped-plan.json");
    writeFileSync(at, JSON.stringify(plan));
    const summary = join(scratch, "capped-summary.md");
    writeFileSync(summary, "");
    const out = spawnSync(process.execPath, [SELECT, "outputs", "--indexes", "[0,1]", "--sqlite-indexes", "[0]", "--alone", "[]", "--scope", "selected",
      "--scope-why", why, "--select-outcome", "success", "--plan", at], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
    expect(out.status).toBe(0);
    // The plan step's last line greps scope and why: a capped run never reads as a whole one.
    expect(out.stdout.split("\n").filter((l) => /^(scope|why)=/.test(l))).toEqual(["scope=selected", `why=${why}`]);
    const text = readFileSync(summary, "utf8");
    expect(text.split("\n")[0]).toBe("### suite plan: selected (CAPPED, not a whole run)");
    expect(text).toContain("\ncapped run: runs 1 file(s) (5 s measured; floor 1, never cut 0, filled 0) in 1 suite job(s) + 0 alone, leaves 1 of its direct set (40 s) and defers 0 more (0 s) to the whole run on next");
    expect(composeOutputs({ indexes: [0], sqliteIndexes: [0], alone: [], scope: "selected", selectOutcome: "success", plan }).mode).toBe("capped");
    // A FAST plan's summary reads as before.
    const fast = composeOutputs({ indexes: [0], sqliteIndexes: [0], alone: [], scope: "selected", selectOutcome: "success", plan: { ...plan, why: "2 changed path(s)", mode: "direct", capped: undefined, left: undefined } });
    expect(fast.mode).toBeUndefined();
    expect(summaryText(fast).split("\n")[0]).toBe("### suite plan: selected");
  });

  it("never caps a base of main, a batch branch, a dispatch, a schedule, a fork, a bot or main merged across: each plans byte for byte as before", async () => {
    const head = { ref: "pr/x", sha: "4".repeat(40), repo: own };
    const tests = (area: string) => Array.from({ length: 10 }, (_, i) => `packages/${area}/test/t${i}.test.ts`);
    const dir = plantTree({ "test/root.test.ts": "export {};\n", "packages/p/src/x.ts": "export const x = 1;\n", ...Object.fromEntries([...tests("p"), ...tests("z")].map((f) => [f, "export {};\n"])) });
    // Twenty files of 700 s: ten related to the change, 7100 s of a 14 100 s suite, half of it and twice the cap.
    const costs = { measuredAt: "planted", sqlite: {}, suite: Object.fromEntries([["test/root.test.ts", 100_000], ...[...tests("p"), ...tests("z")].map((f) => [f, 700_000])]) };
    const graph = graphOf(tests("p"));
    const capping = [M("packages/p/src/x.ts"), migration];
    const whole: Array<[string, Ctx, string]> = [
      ["a batch branch", pr({ base: { ref: "next" }, head: { ...head, ref: "pr/batch-g" } }), "a batch branch is whole"],
      ["a dispatch", pr({ base: { ref: "next" }, head }, { event_name: "workflow_dispatch" }), "a workflow_dispatch run is whole"],
      ["a schedule", pr({ base: { ref: "next" }, head }, { event_name: "schedule" }), "a schedule run is whole"],
      ["a fork", pr({ base: { ref: "next" }, head: { ...head, repo: { full_name: "someone/ohmail" } } }), "the head is not a branch of this repository"],
      ["a bot", pr({ base: { ref: "next" }, head }, { actor: "dependabot[bot]" }), "a bot started the run"],
    ];
    for (const [what, ctx, why] of whole) {
      expect(JSON.stringify(await select({ root: dir, ctx, changes: capping, graph, costs })), what).toBe(JSON.stringify({ scope: "whole", why }));
    }
    const intoMain = pr({ head });
    const across = pr({ base: { ref: "next" }, head: { ...head, ref: "pr/merge-main-20261116" } });
    for (const ctx of [intoMain, across]) {
      expect(JSON.stringify(await select({ root: dir, ctx, changes: capping, graph, costs }))).toBe(JSON.stringify({ scope: "whole", why: `${migration.p}: a migration` }));
    }
    // A selection twice the cap and under WHOLE_SHARE: into main it runs as it did, every file it selects, in today's keys.
    const changes = [M("packages/p/src/x.ts")];
    const main = await select({ root: dir, ctx: intoMain, changes, graph, costs }) as Plan;
    expect(Object.keys(main)).toEqual(["scope", "why", "shards", "alone", "sqlite", "summary"]);
    expect(Object.keys(main.summary!)).toEqual(["changed", "rules", "main", "alone", "sqlite", "share", "costsMeasuredAt"]);
    expect(main.why).toBe("1 changed path(s)");
    expect(handed(main)).toEqual([...tests("p"), "test/root.test.ts"]);
    expect(deferredLog(main, intoMain)).toBe("");
    expect(JSON.stringify(await select({ root: dir, ctx: across, changes, graph, costs }))).toBe(JSON.stringify(main));
    // The control: into next the same change is capped by its cost.
    const next = await select({ root: dir, ctx: pr({ base: { ref: "next" }, head }), changes, graph, costs }) as Plan;
    expect(next.mode).toBe("capped");
    expect(next.left).toHaveLength(5);
    // main keeps WHOLE_SHARE: three quarters of the suite runs whole there, and is capped into next.
    const wide = graphOf([...tests("p"), ...tests("z").slice(0, 5)]);
    expect(await select({ root: dir, ctx: intoMain, changes, graph: wide, costs })).toEqual({ scope: "whole", why: "the selection costs 75% of the whole suite" });
    expect(await select({ root: dir, ctx: across, changes, graph: wide, costs })).toEqual({ scope: "whole", why: "the selection costs 75% of the whole suite" });
    expect((await select({ root: dir, ctx: pr({ base: { ref: "next" }, head }), changes, graph: wide, costs }) as Plan).mode).toBe("capped");
  });

  it("stays whole when the selector fails, a path cannot be read or the plan is refused", async () => {
    // A path outside the readable set, or a change kind other than A, M or D, beside a capped reason: whole, in main's words.
    for (const odd of [M("apps/webapp/app/a file.ts"), { s: "T", p: "apps/webapp/app/views/OhboxView.tsx" }]) {
      const changes = [migration, odd];
      const main = decideScope({ root: ROOT, ctx: pr(), changes });
      expect(main.scope, odd.p).toBe("whole");
      expect(decideScope({ root: ROOT, ctx: intoNext, changes }), odd.p).toEqual(main);
    }
    // A diff that cannot be read.
    const bare = plantTree({ "a.txt": "a\n" });
    execFileSync("git", ["init", "-q"], { cwd: bare });
    expect(decideScope({ root: bare, ctx: intoNext })).toEqual({ scope: "whole", why: "the diff cannot be read" });
    // A selector that does not finish on a capped diff: the plan job hands the whole run on.
    const failing = plantTree({ "vitest.config.ts": 'throw new Error("planted config fault");\n', "packages/q/src/x.ts": "export {};\n", "packages/q/test/x.test.ts": "export {};\n" });
    const files = join(scratch, "capped-fail.tsv");
    writeFileSync(files, "M\tpackages/q/src/x.ts\nD\tpackages/q/src/gone.ts\n");
    const cli = spawnSync(process.execPath, [SELECT, "select", "--root", failing, "--event", JSON.stringify(intoNext), "--files", files, "--out", join(scratch, "capped-fail.json")], { encoding: "utf8" });
    expect(cli.status).not.toBe(0);
    expect(composeOutputs({ indexes: [0, 1], sqliteIndexes: [0], alone: [], scope: "selected", scopeWhy: "CAPPED into next: packages/q/src/gone.ts: deleted or renamed", selectOutcome: "failure", plan: null }))
      .toMatchObject({ scope: "whole", why: "the selector did not finish (failure)", shards: [{ shard: 0 }, { shard: 1 }] });
    // A plan that would leave what is no test file of this run is refused, and the run is whole.
    const dir = plantTree({ "test/root.test.ts": "export {};\n", "packages/p/src/x.ts": "export {};\n", "packages/p/test/a b.test.ts": "export {};\n" });
    const refused = await select({
      root: dir, ctx: intoNext, changes: [M("packages/p/src/x.ts"), { s: "D", p: "packages/p/src/gone.ts" }], graph: graphOf(["packages/p/test/a b.test.ts"]),
      costs: { measuredAt: "planted", suite: { "packages/p/test/a b.test.ts": 4_000_000 }, sqlite: {} },
    });
    expect(refused).toEqual({ scope: "whole", why: "the plan is refused: left: a path outside [A-Za-z0-9@._/+-]" });
    // The leavings are checked as the deferred list is: a test file of this run, handed on nowhere else.
    const sets = { files: ["test/root.test.ts", "packages/p/test/ok.test.ts"], alone: new Set<string>(), desktop: new Set<string>(), sqliteAll: ["packages/p/test/ok.test.ts"] };
    const capped: Plan = {
      scope: "selected", why: "CAPPED into next: packages/p/src/gone.ts: deleted or renamed", shards: [{ shard: 0, files: "test/root.test.ts", dovecot: "no" }], alone: [],
      sqlite: [{ shard: 0, files: "packages/p/test/ok.test.ts" }], mode: "capped", deferred: [], sqliteDeferred: [], left: [], sqliteLeft: [],
    };
    expect(planProblems(capped, sets)).toEqual([]);
    expect(planProblems({ ...capped, left: [{ file: "test/root.test.ts", rule: "cap" }] }, sets)).toEqual(["test/root.test.ts is handed on and left"]);
    expect(planProblems({ ...capped, left: [{ file: "packages/p/test/gone.test.ts", rule: "cap" }] }, sets)).toEqual(["left: packages/p/test/gone.test.ts is not a test file of this run"]);
    expect(planProblems({ ...capped, sqliteLeft: ["packages/p/test/ok.test.ts"] }, sets)).toEqual(["packages/p/test/ok.test.ts is handed to the sqlite run and left"]);
  }, 60_000);

  it("prints the floor through the CLI without loading vitest, and without the bundle readers and alone files for --local", () => {
    const dir = plantTree({
      ...floorTree, "test/root-bundle.test.ts": `${hdr}export const built = () => existsSync(join(HERE, "../build/engine/engine.js"));\n`,
      "packages/g/test/git-twin.pg.test.ts": `${alone}${hdr}export const files = () => execFileSync("git", ["ls-files"]);\n`, "packages/x/test/plain.test.ts": "export {};\n",
    });
    // A resolve hook that refuses vitest: the floor verb loads Node's own modules and the two support modules alone.
    const hook = join(scratch, "no-vitest.mjs");
    writeFileSync(hook, [
      'import { registerHooks } from "node:module";',
      "registerHooks({ resolve(specifier, context, next) {",
      '  if (specifier === "vitest" || specifier.startsWith("vitest/")) throw new Error(`vitest was loaded: ${specifier}`);',
      "  return next(specifier, context);", "} });", "",
    ].join("\n"));
    const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, SELECT, ...args, "--root", dir], { encoding: "utf8" });
    const all = cli("floor");
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toBe([...floor, "packages/g/test/git-twin.pg.test.ts", "test/root-bundle.test.ts"].sort().map((f) => `${f}\n`).join(""));
    const local = cli("floor", "--local");
    expect(local.status, local.stderr).toBe(0);
    expect(local.stdout).toBe(["packages/g/test/git.test.ts", "packages/w/test/census.test.ts", "test/root-a.test.ts", "test/root-b.test.ts"].map((f) => `${f}\n`).join(""));
    // This tree's floor is longer than a pipe takes at once: every line of it arrives, every root test among them.
    const ours = spawnSync(process.execPath, [SELECT, "floor"], { encoding: "utf8" });
    expect(ours.stdout.length).toBeGreaterThan(8192);
    expect(ours.stdout.split("\n").filter((f) => f.startsWith("test/"))).toEqual(testFiles(ROOT).filter((f) => f.startsWith("test/")));
    // A floor longer than the child's channel takes at once (about 146 KB here): every line arrives only if the CLI waits for its write.
    const wide = plantTree(Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`test/${"a-long-root-test-name-".repeat(5)}${String(i).padStart(5, "0")}.test.ts`, "export {};\n"])));
    const long = spawnSync(process.execPath, [SELECT, "floor", "--root", wide], { encoding: "utf8", maxBuffer: 1 << 26 });
    expect(long.stdout.split("\n").filter(Boolean)).toHaveLength(6000);
    // The control: the same hook stops a verb that does load vitest.
    const files = join(scratch, "floor.tsv");
    writeFileSync(files, "M\tpackages/x/test/plain.test.ts\n");
    const loaded = cli("select", "--event", JSON.stringify(intoNext), "--files", files, "--out", join(scratch, "floor-plan.json"));
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain("vitest was loaded: vitest/node");
  });
});

/**
 * WHAT ONLY ADDS, into next. An alias line for a new entry of a workspace the base holds, when no file of the base
 * names that entry or builds a specifier of its workspace, is no change of the judge's: it is deferred and named, as
 * a new package's line is. A shard map that only drops the entries of the test files the diff deletes and gains
 * entries of those it adds is no reason. A changed root module beside a workspace's change widens the border only by
 * the test files the graph relates to the root files alone. Into main each plans as before.
 */
describe("what only adds: a line for a new entry, a root file, a shard map", () => {
  const own = { full_name: "trafficflowhq/ohmail" };
  const head = { ref: "pr/x", sha: "6".repeat(40), repo: own };
  const intoNext = pr({ number: 815, base: { ref: "next" }, head });
  const intoMain = pr({ number: 815, head });
  const across = pr({ number: 815, base: { ref: "next" }, head: { ...head, ref: "pr/merge-main-20261116" } });
  const events: Array<[string, Ctx, string]> = [
    ["a batch branch", pr({ base: { ref: "next" }, head: { ...head, ref: "pr/batch-g" } }), "a batch branch is whole"],
    ["a dispatch", pr({ base: { ref: "next" }, head }, { event_name: "workflow_dispatch" }), "a workflow_dispatch run is whole"],
    ["a schedule", pr({ base: { ref: "next" }, head }, { event_name: "schedule" }), "a schedule run is whole"],
    ["a fork", pr({ base: { ref: "next" }, head: { ...head, repo: { full_name: "someone/ohmail" } } }), "the head is not a branch of this repository"],
    ["a bot", pr({ base: { ref: "next" }, head }, { actor: "dependabot[bot]" }), "a bot started the run"],
  ];
  const unread: Tree = {
    read: () => { throw new Error("main read a side of the pull request"); }, exists: () => { throw new Error("main asked for a directory"); },
    names: () => { throw new Error("main searched the base"); },
  };
  const bare = plantTree({ "a.txt": "a\n" });
  const unmeasured = { measuredAt: "planted", suite: {}, sqlite: {} };
  const handed = (p: Plan) => [...p.shards.flatMap((s) => s.files.split("\n")), ...p.alone].sort();
  const scopeCli = (dir: string, sha: string, to: string) => spawnSync(process.execPath, [SELECT, "scope", "--root", dir, "--event", JSON.stringify(merged(sha, to))], { encoding: "utf8" }).stdout;
  const j = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const V = "vitest.config.ts";
  const config = (aliases: string[]) => [
    'import { fileURLToPath } from "node:url";', "const r = (p) => fileURLToPath(new URL(p, import.meta.url));",
    "export default {", "  resolve: {", "    alias: [", ...aliases.map((a) => `      ${a}`), "    ],", "  },",
    "  test: {", '    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],', "  },", "};", "",
  ].join("\n");
  /** The base's lockfile: two workspaces it links, @m/p and @m/q, and a package of the registry, dep. */
  const lock = j({
    name: "root", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
      "": { name: "root", version: "1.0.0", workspaces: ["packages/p", "packages/q"] },
      "packages/p": { name: "@m/p", version: "0.0.0" }, "packages/q": { name: "@m/q", version: "0.0.0" },
      "node_modules/@m/p": { resolved: "packages/p", link: true }, "node_modules/@m/q": { resolved: "packages/q", link: true },
      "node_modules/dep": { version: "1.0.0", resolved: "https://registry.example.invalid/dep-1.0.0.tgz" },
    },
  });
  const held = [
    "// A leaf above its package's bare name: a find takes its name and what begins with it and a slash.",
    '{ find: "@m/p/leaf", replacement: r("./packages/p/src/leaf.ts") },',
    '{ find: "@m/p", replacement: r("./packages/p/src/index.ts") },',
  ];
  const door = '{ find: "@m/p/door", replacement: r("./packages/p/src/door/index.ts") },';
  /** The base, and a head that adds p's door, its test and its line, between rows, above the bare name. */
  const entry = (line = door, more: Record<string, string> = {}) => {
    const base: Record<string, string> = {
      "package-lock.json": lock, [V]: config(held), "packages/p/src/index.ts": "export const p = 1;\n", "packages/p/src/leaf.ts": "export const leaf = 1;\n",
      "packages/q/src/q.ts": "export const q = 1;\n", "test/root.test.ts": "export {};\n", ...more,
    };
    const head: Record<string, string> = {
      ...base, [V]: config([held[0]!, held[1]!, "// The door, above the bare name.", line, held[2]!]),
      "packages/p/src/door/index.ts": "export const door = 1;\n", "packages/p/test/door.test.ts": 'import { door } from "@m/p/door";\nexport const d = door;\n',
    };
    return { base, head, changes: [M(V), { s: "A", p: "packages/p/src/door/index.ts" }, { s: "A", p: "packages/p/test/door.test.ts" }] };
  };
  const scopeOf = (w: ReturnType<typeof entry>, base: Tree = tree(w.base)) => decideScope({ root: bare, ctx: intoNext, changes: w.changes, base, head: tree(w.head) });
  const judged = { scope: "whole", why: "vitest.config.ts: the vitest config" };
  const admitted = (shape: string) => ({ scope: "selected", why: "3 changed path(s); 1 harness path(s) deferred to the whole run on next", harness: [{ p: V, what: "the vitest config", shape }] });

  it("admits an alias line for a new entry of a workspace the base holds when nothing in the base names it, and names it in the plan's harness group; into main it is whole in the words it had", async () => {
    const w = entry();
    expect(scopeOf(w)).toMatchObject(admitted("an alias for @m/p/door"));
    // A pattern for that one name; two entries of the two workspaces.
    expect(scopeOf(entry('{ find: /^@m\\/p\\/door$/, replacement: r("./packages/p/src/door/index.ts") },'))).toMatchObject(admitted("an alias for @m/p/door"));
    const two = entry();
    two.head[V] = config([held[0]!, held[1]!, door, '{ find: "@m/q/hall", replacement: r("./packages/q/src/hall.ts") },', held[2]!]);
    expect(scopeOf(two)).toMatchObject(admitted("aliases for @m/p/door, @m/q/hall"));
    // Into main the line is the judge's, in the words it had, and neither side is read.
    expect(decideScope({ root: bare, ctx: intoMain, changes: w.changes, base: unread, head: unread })).toEqual(judged);
    // The plan names it in its harness group.
    const dir = plantTree(w.head);
    const all = testFiles(dir);
    const graph = async (_root: string, _related: string[], o: GraphOptions) => (o.config === "vitest.sqlite.config.ts" ? { related: [], all: [] } : { related: ["packages/p/test/door.test.ts"], all });
    const plan = await select({ root: dir, ctx: intoNext, changes: w.changes, base: tree(w.base), graph, costs: unmeasured }) as Plan;
    expect(plan.scope, plan.why).toBe("selected");
    expect(plan.harness).toEqual([{ p: V, what: "the vitest config", shape: "an alias for @m/p/door" }]);
    expect(handed(plan)).toEqual(["packages/p/test/door.test.ts", "test/root.test.ts"]);
    const log = deferredLog(plan, intoNext);
    expect(log).toContain("\nFAST next harness: 1 path(s) deferred to the whole run on next: vitest.config.ts (an alias for @m/p/door)\n");
    expect(log).toContain("\nthe vitest config\tvitest.config.ts\tan alias for @m/p/door\n");
    // On a real merge, the base's lockfile and its search read from git.
    const real = plantPr(w.base, w.head);
    expect(scopeCli(real.dir, real.headSha, "next")).toBe("scope=selected\nwhy=3 changed path(s); 1 harness path(s) deferred to the whole run on next\n");
    expect(scopeCli(real.dir, real.headSha, "main")).toBe("scope=whole\nwhy=vitest.config.ts: the vitest config\n");
  }, 60_000);

  it("keeps the whole suite when the base names the entry anywhere: an import, a mock, a path key, a longer name that begins with it", () => {
    const naming: Array<[string, Record<string, string>]> = [
      ["an import", { "packages/q/src/uses.ts": 'import { door } from "@m/p/door";\nexport const u = door;\n' }],
      ["a mock", { "packages/q/test/mocked.test.ts": 'import { vi } from "vitest";\nvi.mock("@m/p/door", () => ({ door: 0 }));\n' }],
      ["a path key", { "test/tsconfig.test-dirs-base.json": j({ compilerOptions: { paths: { "@m/p/door": ["../packages/p/src/door/index.ts"] } } }) }],
      ["a longer name that begins with it", { "packages/q/src/longer.ts": 'export const load = () => import("@m/p/doorway");\n' }],
    ];
    // The control: a document may name it; the search reads code and data.
    expect(scopeOf(entry(door, { "docs/door.md": "Import @m/p/door.\n" }))).toMatchObject(admitted("an alias for @m/p/door"));
    for (const [what, more] of naming) expect(scopeOf(entry(door, more)), what).toEqual(judged);
    // The config itself, outside its alias table (a setup file by that name): the search leaves the config out.
    const outside = entry();
    for (const side of [outside.base, outside.head]) side[V] = side[V]!.replace("  test: {\n", '  test: {\n    setupFiles: ["@m/p/door"],\n');
    expect(scopeOf(outside)).toEqual(judged);
    // A side that cannot say whether it names the text says it does.
    const w = entry();
    expect(scopeOf(w, { read: tree(w.base).read, exists: tree(w.base).exists })).toEqual(judged);
    // On a real merge, by git's own search of the base.
    const imp = entry(door, naming[0]![1]);
    const real = plantPr(imp.base, imp.head);
    expect(scopeCli(real.dir, real.headSha, "next")).toBe("scope=whole\nwhy=vitest.config.ts: the vitest config\n");
    // A search that throws, and a git search that fails (grep.threads is read by git grep alone), name the text.
    expect(scopeOf(w, { ...tree(w.base), names: () => { throw new Error("no answer"); } })).toEqual(judged);
    const fine = entry();
    const broken = plantPr(fine.base, fine.head);
    const grepFails = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "grep.threads", GIT_CONFIG_VALUE_0: "many" };
    expect(spawnSync(process.execPath, [SELECT, "scope", "--root", broken.dir, "--event", JSON.stringify(merged(broken.headSha, "next"))], { encoding: "utf8", env: grepFails }).stdout).toBe("scope=whole\nwhy=vitest.config.ts: the vitest config\n");
    expect(scopeCli(broken.dir, broken.headSha, "next")).toBe("scope=selected\nwhy=3 changed path(s); 1 harness path(s) deferred to the whole run on next\n");
  });

  it("keeps the whole suite when the new line begins a find the table holds, is a pattern for more than the one name, points outside its workspace or names no workspace of the base", () => {
    expect(scopeOf(entry())).toMatchObject(admitted("an alias for @m/p/door"));
    const refused: Array<[string, string]> = [
      ["a pattern for its subpaths", '{ find: /^@m\\/p\\/door\\/([a-z-]+)$/, replacement: `${r("./packages/p/src/door")}/$1.ts` },'],
      ["a pattern with no end", '{ find: /^@m\\/p\\/door/, replacement: r("./packages/p/src/door/index.ts") },'],
      ["a target in another workspace", '{ find: "@m/p/door", replacement: r("./packages/q/src/door.ts") },'],
      ["a template whose tail leaves its workspace's folder", '{ find: "@m/p/door", replacement: `${r("./packages/p")}-old/door.ts` },'],
      ["a workspace the base does not link", '{ find: "@m/z/door", replacement: r("./packages/z/src/door.ts") },'],
      ["a package of the registry", '{ find: "dep/door", replacement: r("./packages/p/src/door/index.ts") },'],
      ["a workspace's bare name", '{ find: "@m/q", replacement: r("./packages/q/src/q.ts") },'],
    ];
    for (const [what, line] of refused) expect(scopeOf(entry(line)), what).toEqual(judged);
    // A find the table holds begins with the new one: the line would take what that find took.
    const w = entry();
    const knob = '{ find: "@m/p/door/knob", replacement: r("./packages/p/src/door/knob.ts") },';
    w.base[V] = config([held[0]!, knob, held[1]!, held[2]!]);
    w.head[V] = config([held[0]!, knob, held[1]!, "// The door, above the bare name.", door, held[2]!]);
    expect(scopeOf(w)).toEqual(judged);
  });

  it("keeps the whole suite when the base builds a specifier of that workspace from parts", () => {
    const parts = { "packages/q/src/load.ts": "export const load = (name: string) => import(`@m/p/${name}`);\n" };
    expect(scopeOf(entry())).toMatchObject(admitted("an alias for @m/p/door"));
    expect(scopeOf(entry(door, parts))).toEqual(judged);
    // A specifier built of another workspace is none of p's.
    expect(scopeOf(entry(door, { "packages/q/src/load.ts": "export const load = (name: string) => import(`@m/q/${name}`);\n" }))).toMatchObject(admitted("an alias for @m/p/door"));
    // On a real merge, by git's own search of the base.
    const w = entry(door, parts);
    const real = plantPr(w.base, w.head);
    expect(scopeCli(real.dir, real.headSha, "next")).toBe("scope=whole\nwhy=vitest.config.ts: the vitest config\n");
  });

  it("keeps the whole suite when an inserted line holds a line end JavaScript reads besides a newline: a comment or an entry's trailing comment that carries another entry", () => {
    // The leaf sent to the bare name's module: live code to the config's loader once the line ends inside the line.
    const leaf = '{ find: "@m/p/leaf", replacement: r("./packages/p/src/index.ts") },';
    const lines = (...extra: string[]) => { const w = entry(); w.head[V] = config(extra); return w; };
    const heads: Array<[string, ReturnType<typeof entry>]> = [
      ...[["a carriage return", "\r"], ["U+2028", "\u2028"], ["U+2029", "\u2029"]].map(([name, end]): [string, ReturnType<typeof entry>] => [
        `a comment ended by ${name}`, lines(held[0]!, `// the leaf, as before${end}${leaf}`, held[1]!, "// The door, above the bare name.", door, held[2]!),
      ]),
      ["an entry's trailing comment", entry(`${door} // the door\r${leaf}`)],
      ["a comment that closes the table", lines(held[0]!, held[1]!, "// The door, above the bare name.", door, held[2]!, '// end\r], dedupe: ["x"], alias: [')],
    ];
    for (const [what, w] of heads) expect(scopeOf(w), what).toEqual(judged);
    // The controls: a comment, and an entry with its trailing comment, each a line of its own.
    expect(scopeOf(entry())).toMatchObject(admitted("an alias for @m/p/door"));
    expect(scopeOf(entry(`${door} // the door`))).toMatchObject(admitted("an alias for @m/p/door"));
  });

  it("loses nothing by the admitted line: every file the same diff selects without it is handed, deferred or left by name with it", async () => {
    // p's own tests and q's test (through the bare name) import p's x; four of p's cost a thousand seconds each, so the
    // cap leaves one by name; the second store holds p's own test and q's.
    const base: Record<string, string> = {
      "package-lock.json": lock, [V]: config(held),
      "vitest.sqlite.config.ts": `export default { test: { include: ${JSON.stringify(["packages/p/test/own.test.ts", "packages/q/test/across.test.ts"])} } };\n`,
      "packages/p/src/index.ts": 'export * from "./x";\n', "packages/p/src/leaf.ts": "export const leaf = 1;\n", "packages/p/src/x.ts": "export const x = 1;\n",
      "packages/p/test/own.test.ts": 'import { x } from "../src/x";\nexport const a = x;\n',
      "packages/q/test/across.test.ts": 'import { x } from "@m/p";\nexport const b = x;\n',
      ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`packages/p/test/big${i}.test.ts`, 'import { x } from "../src/x";\nexport const c = x;\n'])),
      "test/root.test.ts": "export {};\n",
    };
    const withLine: Record<string, string> = {
      ...base, "packages/p/src/x.ts": "export const x = 2;\n", [V]: config([held[0]!, held[1]!, door, held[2]!]),
      "packages/p/src/door/index.ts": 'export { x as door } from "../x";\n', "packages/p/test/door.test.ts": 'import { door } from "@m/p/door";\nexport const d = door;\n',
    };
    const without = { ...withLine, [V]: base[V]! };
    const changes = [M("packages/p/src/x.ts"), { s: "A", p: "packages/p/src/door/index.ts" }, { s: "A", p: "packages/p/test/door.test.ts" }];
    const costs = { measuredAt: "planted", sqlite: {}, suite: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`packages/p/test/big${i}.test.ts`, 1_000_000])) };
    // vitest's own graph, on each head.
    const plan = (files: Record<string, string>, diff: typeof changes) => select({ root: plantTree(files), ctx: intoNext, changes: diff, base: tree(base), costs }) as Promise<Plan>;
    const was = await plan(without, changes);
    const now = await plan(withLine, [...changes, M(V)]);
    expect(now.scope, now.why).toBe("selected");
    expect(now.harness).toEqual([{ p: V, what: "the vitest config", shape: "an alias for @m/p/door" }]);
    const fate = (p: Plan) => new Map<string, string>([
      ...handed(p).map((f): [string, string] => [f, "handed"]), ...p.deferred!.map((d): [string, string] => [d.file, `deferred ${d.rule}`]),
      ...(p.left ?? []).map((d): [string, string] => [d.file, `left ${d.rule}`]),
      ...(p.sqlite ?? []).flatMap((s) => s.files.split("\n")).map((f): [string, string] => [`sqlite ${f}`, "handed"]),
      ...p.sqliteDeferred!.map((f): [string, string] => [`sqlite ${f}`, "deferred"]), ...(p.sqliteLeft ?? []).map((f): [string, string] => [`sqlite ${f}`, "left"]),
    ]);
    // Without the line the cap leaves p's fourth big test and q's test waits for the night: each the same with it.
    expect(fate(was).get("packages/p/test/big3.test.ts")).toBe("left cap");
    expect(fate(was).get("packages/q/test/across.test.ts")).toBe("deferred graph");
    expect([...fate(was)].filter(([f, how]) => fate(now).get(f) !== how)).toEqual([]);
    expect(fate(now).size).toBe(fate(was).size);
  }, 120_000);

  /** p changes, q's test imports p across the workspaces, r's test imports a root module and s's a root list; the
   *  second store holds q's test. */
  const rootWorld = () => plantTree({
    [V]: 'export default { test: { include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"] } };\n',
    "vitest.sqlite.config.ts": `export default { test: { include: ${JSON.stringify(["packages/q/test/across.test.ts"])} } };\n`,
    "packages/p/src/x.ts": "export const x = 1;\n",
    "packages/p/test/own.test.ts": 'import { x } from "../src/x";\nexport const a = x;\n',
    "packages/q/test/across.test.ts": 'import { x } from "../../p/src/x";\nexport const b = x;\n',
    "scripts/lib/tool.mjs": "export const tool = 1;\n",
    "packages/r/test/uses-tool.test.ts": 'import { tool } from "../../../scripts/lib/tool.mjs";\nexport const t = tool;\n',
    "test/compare/declared.json": '{ "screens": [] }\n',
    "packages/s/test/reads-list.test.ts": 'import declared from "../../../test/compare/declared.json";\nexport const d = declared;\n',
    "test/root.test.ts": "export {};\n",
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`packages/t/test/far${i}.test.ts`, "export {};\n"])),
  });
  const [ownTest, acrossTest, toolTest, listTest] = ["packages/p/test/own.test.ts", "packages/q/test/across.test.ts", "packages/r/test/uses-tool.test.ts", "packages/s/test/reads-list.test.ts"];

  it("widens the border only for what a changed root file reaches: beside a package change the other workspaces' tests are deferred as without it, and a test elsewhere that imports the root file runs", async () => {
    const dir = rootWorld();
    // vitest's own graph, and its relation to the root files alone read on the same instance.
    const plan = (changes: Array<{ s: string; p: string }>) => select({ root: dir, ctx: intoNext, changes, costs: unmeasured }) as Promise<Plan>;
    const alone = await plan([M("packages/p/src/x.ts")]);
    expect(alone.deferred).toEqual([{ file: acrossTest, rule: "graph" }]);
    for (const [rootFile, reader] of [["scripts/lib/tool.mjs", toolTest], ["test/compare/declared.json", listTest]] as const) {
      const p = await plan([M("packages/p/src/x.ts"), M(rootFile)]);
      expect(p.mode, rootFile).toBe("direct");
      expect(p.deferred, rootFile).toEqual(alone.deferred);
      expect(handed(p), rootFile).toEqual([ownTest, reader, "test/root.test.ts"].sort());
      // The second store's border stays as it was: one job, whatever it holds.
      expect(p.sqlite, rootFile).toEqual([{ shard: 0, files: acrossTest }]);
    }
  }, 120_000);

  it("keeps the whole reach when root files are all the diff changes, and when the second listing fails", async () => {
    const dir = rootWorld();
    const asked: Array<string[] | undefined> = [];
    /** vitest's graph, planted: what it relates to the diff, and to the root files alone (null: that listing failed). */
    const graph = (related: string[], rootsRelated: string[] | null) => async (_root: string, _related: string[], o: GraphOptions) => {
      if (o.config === "vitest.sqlite.config.ts") return { related: [], all: [] };
      asked.push(o.roots);
      return { related, all: [], ...(o.roots ? { rootsRelated } : {}) };
    };
    const plan = (changes: Array<{ s: string; p: string }>, g: ReturnType<typeof graph>) => select({ root: dir, ctx: intoNext, changes, graph: g, costs: unmeasured }) as Promise<Plan>;
    const both = [M("packages/p/src/x.ts"), M("scripts/lib/tool.mjs")];
    // The control: the second listing answers, and q's test, which only the package change reaches, waits for the night.
    expect((await plan(both, graph([ownTest, acrossTest, toolTest], [toolTest]))).deferred).toEqual([{ file: acrossTest, rule: "graph" }]);
    expect(asked).toEqual([["scripts/lib/tool.mjs"]]);
    // The second listing fails: the whole reach runs, as before.
    const failed = await plan(both, graph([ownTest, acrossTest, toolTest], null));
    expect(failed.deferred).toEqual([]);
    expect(handed(failed)).toEqual([ownTest, acrossTest, toolTest, "test/root.test.ts"].sort());
    // Root files are all the diff changes: nothing to keep apart, no second listing, the whole reach runs.
    asked.length = 0;
    const roots = await plan([M("scripts/lib/tool.mjs"), M("test/compare/declared.json")], graph([toolTest, listTest, acrossTest], [toolTest, listTest]));
    expect(asked).toEqual([undefined]);
    expect(roots.deferred).toEqual([]);
    expect(handed(roots)).toEqual([acrossTest, toolTest, listTest, "test/root.test.ts"].sort());
  });

  it("admits a shard map that only drops the entries of test files the diff deletes and gains entries of test files it adds; an entry moved, a shard added or another measuredAt is capped by name; into main whole", () => {
    const MAP = "test/support/ci-shards.json";
    const SQ = "test/support/ci-shards-sqlite.json";
    const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map((x) => `packages/${x < "c" ? "p" : "q"}/test/${x}.test.ts`) as [string, string, string, string, string, string];
    const map = (shards: string[][], over: Record<string, unknown> = {}) => j({ measuredAt: "1a2b3c", shards, pins: { dovecot: [c] }, ...over });
    const changes = [{ s: "D", p: b }, { s: "A", p: e }, M(MAP)];
    const scope = (after: string, diff = changes, before: string = map([[a, b], [c, d]])) =>
      decideScope({ root: bare, ctx: intoNext, changes: diff, base: tree({ [diff[2]!.p]: before }), head: tree({ [diff[2]!.p]: after }) });
    const follows = (p: string) => ({
      scope: "selected", why: "3 changed path(s); 1 harness path(s) deferred to the whole run on next",
      harness: [{ p, what: "the shard map", shape: "follows 1 deleted and 1 added test file(s)" }],
    });
    expect(scope(map([[a], [c, e, d]]))).toMatchObject(follows(MAP));
    // The second store's map, its seconds as they were.
    const sq = (shards: string[][], seconds = [10, 20]) => j({ measuredAt: "4d5e6f", shards, seconds });
    expect(scope(sq([[e, a], [c, d]]), [{ s: "D", p: b }, { s: "A", p: e }, M(SQ)], sq([[a, b], [c, d]]))).toMatchObject(follows(SQ));
    const capped = { scope: "selected", why: `CAPPED into next: ${MAP}: the shard map`, capped: [{ p: MAP, what: "the shard map" }] };
    const refused: Array<[string, string]> = [
      ["an entry moved", map([[a, c], [e, d]])],
      ["a shard added", map([[a], [c, e, d], []])],
      ["another measuredAt", map([[a], [c, e, d]], { measuredAt: "7a8b9c" })],
      ["its pins changed", map([[a], [c, e, d]], { pins: { dovecot: [] } })],
      ["an entry dropped whose file stays", map([[a], [c, e]])],
      ["an entry gained whose file is no new one", map([[a, f], [c, e, d]])],
      ["a deleted file still named", map([[a, b], [c, e, d]])],
      ["a map that is no map", "[]\n"],
    ];
    for (const [what, after] of refused) expect(scope(after), what).toMatchObject(capped);
    expect(scope(sq([[e, a], [c, d]], [10, 30]), [{ s: "D", p: b }, { s: "A", p: e }, M(SQ)], sq([[a, b], [c, d]])), "the second store's seconds changed")
      .toMatchObject({ why: `CAPPED into next: ${SQ}: the shard map` });
    // A map the diff adds is no map that follows.
    expect(decideScope({ root: bare, ctx: intoNext, changes: [{ s: "A", p: MAP }], base: tree({}), head: tree({ [MAP]: map([[a]]) }) })).toMatchObject(capped);
    // Into main the map is whole, as it was, and neither side is read.
    expect(decideScope({ root: bare, ctx: intoMain, changes, base: unread, head: unread })).toEqual({ scope: "whole", why: `${MAP}: the shard map` });
    // On a real merge: the map follows the test file the diff deletes and the one it adds.
    const files = { [a]: "export {};\n", [b]: "export {};\n", [c]: "export {};\n", [d]: "export {};\n" };
    const real = plantPr({ ...files, [MAP]: map([[a, b], [c, d]]) }, { [MAP]: map([[a], [c, e, d]]), [e]: "export {};\n" }, [b]);
    expect(scopeCli(real.dir, real.headSha, "next")).toBe("scope=selected\nwhy=3 changed path(s); 1 harness path(s) deferred to the whole run on next\n");
    expect(scopeCli(real.dir, real.headSha, "main")).toBe(`scope=whole\nwhy=${MAP}: the shard map\n`);
  });

  it("reads pull request 869 as no judge member, and 874 as capped by its deleted modules", () => {
    const at = join(ROOT, "test/fixtures/ci-select-history");
    const read = (name: string) => {
      const changes = parseNameStatus(readFileSync(join(at, `${name}.tsv`), "utf8"));
      const t = JSON.parse(readFileSync(join(at, `${name}.trees.json`), "utf8")) as { base: { dirs: string[]; files: Record<string, string>; names?: Record<string, boolean> }; head: { files: Record<string, string> } };
      const next = decideScope({ root: ROOT, ctx: pr({ base: { ref: "next" } }), changes, base: tree(t.base.files, t.base.dirs, t.base.names ?? {}), head: tree(t.head.files) });
      return { changes, next, main: decideScope({ root: ROOT, ctx: pr(), changes, base: unread, head: unread }) };
    };
    const harness = (rows: Array<[string, string, string]>) => rows.map(([p, what, shape]) => ({ p, what, shape }));
    const ohbox = read("869");
    expect(ohbox.main.scope).toBe("whole");
    expect(ohbox.next).toMatchObject({
      scope: "selected", why: "CAPPED into next: apps/webapp/app/views/OhboxView.tsx: deleted or renamed (and 1 more)",
      capped: [{ p: "apps/webapp/app/views/OhboxView.tsx", what: "deleted or renamed" }, { p: "apps/webapp/app/views/ohbox-groups.ts", what: "deleted or renamed" }],
    });
    expect(ohbox.next.harness).toEqual(harness([
      ["apps/desktop/tsconfig.json", "a tsconfig", "paths for @ohmail/ui/squares-window, @ohmail/app/ohbox"],
      ["packages/app-logic/package.json", "a dependency change", "exports ./ohbox/context"],
      ["packages/app/package.json", "a dependency change", "exports ./ohbox"],
      ["test/support/ci-shards.json", "the shard map", "follows 27 deleted and 17 added test file(s)"],
      ["test/tsconfig.test-dirs-base.json", "a tsconfig", "paths for @ohmail/app/ohbox"],
      ["vitest.config.ts", "the vitest config", "an alias for @ohmail/app/ohbox"],
    ]));
    const doors = read("874");
    const gone = doors.changes.filter((c) => c.s === "D" && !/\.test\.[cm]?[jt]sx?$/.test(c.p)).map((c) => ({ p: c.p, what: "deleted or renamed" }));
    expect(gone).toHaveLength(18);
    expect(doors.main.scope).toBe("whole");
    expect(doors.next).toMatchObject({ scope: "selected", why: `CAPPED into next: ${gone[0]!.p}: deleted or renamed (and 17 more)`, capped: gone });
    expect(doors.next.harness!.map((h) => `${h.p}: ${h.shape}`)).toEqual([
      "packages/app/package.json: exports ./doors, ./doors/stage, ./doors/signed-out, ./doors/sign-in, ./doors/verify, ./doors/no-page, ./doors/setup, ./doors/invite, ./doors/subscribed, ./doors/join, ./doors/step-up, ./doors/step-up/ceremony-generation, ./doors/approve, ./doors/authorize-desktop, ./doors/link-desktop, ./doors/delete-account, ./doors/wall",
      "packages/ui/package.json: exports ./theme",
      "vitest.config.ts: an alias for @ohmail/ui/theme",
    ]);
  });

  it("plans a base of main, a batch branch, a dispatch, a schedule, a fork, a bot and main merged across byte for byte as before", async () => {
    // The alias line for a new entry, and the shard map that follows: whole into main in the words they had.
    const w = entry();
    const MAP = "test/support/ci-shards.json";
    const map = (shards: string[][]) => j({ measuredAt: "1a2b3c", shards, pins: { dovecot: [] } });
    const shardDiff = [{ s: "D", p: "packages/p/test/b.test.ts" }, M(MAP)];
    const shardSides = { base: tree({ [MAP]: map([["packages/p/test/a.test.ts", "packages/p/test/b.test.ts"]]) }), head: tree({ [MAP]: map([["packages/p/test/a.test.ts"]]) }) };
    const lines: Array<[string, Array<{ s: string; p: string }>, { base: Tree; head: Tree }, string]> = [
      ["an alias line for a new entry", w.changes, { base: tree(w.base), head: tree(w.head) }, "vitest.config.ts: the vitest config"],
      ["a shard map that follows", shardDiff, shardSides, `${MAP}: the shard map`],
    ];
    for (const [what, changes, sides, why] of lines) {
      const main = decideScope({ root: bare, ctx: intoMain, changes, base: unread, head: unread });
      expect(main, what).toEqual({ scope: "whole", why });
      expect(decideScope({ root: bare, ctx: across, changes, ...sides }), what).toEqual(main);
      for (const [event, ctx, eventWhy] of events) expect(decideScope({ root: bare, ctx, changes, ...sides }), `${what}: ${event}`).toEqual({ scope: "whole", why: eventWhy });
      // The control: into next it is no reason.
      expect(decideScope({ root: bare, ctx: intoNext, changes, ...sides }).scope, what).toBe("selected");
      expect(decideScope({ root: bare, ctx: intoNext, changes, ...sides }).why, what).not.toMatch(/^CAPPED/);
    }
    // A root module beside a package change: into main the whole reach, in today's keys, its graph asked as before.
    const dir = rootWorld();
    const asked: GraphOptions[] = [];
    const graph = async (_root: string, _related: string[], o: GraphOptions) => {
      if (o.config === "vitest.sqlite.config.ts") return { related: [], all: [] };
      asked.push(o);
      return { related: [ownTest, acrossTest, toolTest], all: [], ...(o.roots ? { rootsRelated: [toolTest] } : {}) };
    };
    const changes = [M("packages/p/src/x.ts"), M("scripts/lib/tool.mjs")];
    const main = await select({ root: dir, ctx: intoMain, changes, graph, costs: unmeasured }) as Plan;
    expect(Object.keys(main)).toEqual(["scope", "why", "shards", "alone", "sqlite", "summary"]);
    expect(Object.keys(main.summary!)).toEqual(["changed", "rules", "main", "alone", "sqlite", "share", "costsMeasuredAt"]);
    expect(main.why).toBe("2 changed path(s)");
    expect(handed(main)).toEqual([acrossTest, ownTest, toolTest, "test/root.test.ts"].sort());
    expect(deferredLog(main, intoMain)).toBe("");
    expect(asked.map((o) => Object.keys(o))).toEqual([["config", "entries"]]);
    expect(JSON.stringify(await select({ root: dir, ctx: across, changes, graph, costs: unmeasured }))).toBe(JSON.stringify(main));
    for (const [event, ctx, why] of events) expect(JSON.stringify(await select({ root: dir, ctx, changes, graph, costs: unmeasured })), event).toBe(JSON.stringify({ scope: "whole", why }));
    // The control: into next q's test, which only the package change reaches, waits for the night.
    expect((await select({ root: dir, ctx: intoNext, changes, graph, costs: unmeasured }) as Plan).deferred).toEqual([{ file: acrossTest, rule: "graph" }]);
  });
});
