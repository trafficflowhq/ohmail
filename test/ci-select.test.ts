// @services: none — plants trees and git repositories, and reads this one's files
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DIRECT_BASES, MAX_SHARDS, TARGET_S, WHOLE_SHARE, areaOf, composeOutputs, decideScope, deferredLog, directBase, directSet,
  eventWhole, namedPaths, packFiles, parseNameStatus, planProblems, readerHits, readersOf, select, setupClosure, sourceEntries,
  stripComments, summaryText, versionOnly, vitestGraph, type Ctx, type GraphOptions, type Plan,
} from "../.github/scripts/ci-select.mjs";
import { testFiles } from "./support/ci-shards.mjs";
import { relativeImports } from "./support/service-needs.mjs";

/**
 * WHAT A PULL REQUEST'S RUN TESTS (.github/scripts/ci-select.mjs). A maintainer's pull request runs the
 * test files its diff can reach; the nightly, dispatch, a batch branch, a fork, a bot and a harness change
 * run the whole suite, and so does any fault of the selector. Each rule is held on a planted tree or
 * repository, and the reader rules on this tree's own censuses. A pull request into next runs the direct
 * set and names what it leaves to the whole run on next; test/fixtures/ci-select-history holds the changed
 * paths of the last landed pull requests, which both bases plan here.
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

  /** A planted pull request: a base commit, a head commit, and the merge GitHub checks out. */
  const plantPr = (base: Record<string, string>, head: Record<string, string>) => {
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
    g("add", "-A");
    g("commit", "-q", "-m", "head");
    const headSha = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    g("merge", "-q", "--no-ff", "-m", "merge", "pr/x");
    return { dir, headSha };
  };
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
    const ctx = (sha: string) => pr({ head: { ref: "pr/x", repo: { full_name: "trafficflowhq/ohmail" }, sha } });
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
  });
});

describe("the readers of this tree", () => {
  const files = testFiles(ROOT);
  const readers = readersOf(ROOT, files, { code: stripComments, relativeImports });
  const hit = (p: string) => readerHits(ROOT, [M(p)], readers);

  it("select the censuses that read a changed file", () => {
    expect(hit("apps/webapp/app/views/OhboxView.tsx").has("apps/webapp/test/dispatch-seam-census.test.ts")).toBe(true);
    expect(hit("packages/api/src/router.ts").has("packages/api/test/spend-gate.test.ts")).toBe(true);
    expect(hit("packages/db/src/schema-mail.ts").has("packages/db/test/schema-split.test.ts")).toBe(true);
    expect(decideScope({ root: ROOT, ctx: pr(), changes: [M("packages/db/drizzle/meta/_journal.json")] }).scope).toBe("whole");
  });

  it("select each scanning census for a change in the area it scans, and the template and array readers", () => {
    const cases: Array<[string, string[]]> = [
      ["packages/services/src/mailbox-service.ts", ["packages/services/test/organizer-role-census.test.ts", "packages/db/test/organizer-event-census.test.ts"]],
      ["packages/services/src/consent-reset.ts", ["packages/services/test/organizer-role-census.test.ts"]],
      ["apps/worker/src/sync.ts", ["apps/worker/test/sync-role-census.test.ts"]],
      ["apps/mobile/app/compose.tsx", ["apps/mobile/test/privacy.test.ts", "apps/mobile/test/bearer-construction-census.test.ts"]],
      ["apps/webapp/app/views/HistoryView.tsx", ["apps/webapp/test/row-participants-wiring.test.ts", "apps/webapp/test/row-stamp-wiring.test.ts", "apps/webapp/test/shortcut-hint.test.tsx"]],
      ["apps/webapp/messages/en.json", ["apps/desktop/test/desktop-door-copy.test.ts", "apps/webapp/test/selfhost-says-this-server-census.test.ts", "apps/webapp/test/session-verdict-guard.test.ts"]],
    ];
    for (const [p, want] of cases) {
      const h = hit(p);
      for (const f of want) expect(h.has(f), `${p} selects ${f}`).toBe(true);
    }
  });

  it("select the readers that name a file in a route group", () => {
    expect(hit("apps/mobile/app/(tabs)/screener.tsx").has("apps/mobile/test/screener-row-names-the-claim.test.ts")).toBe(true);
    expect(hit("apps/webapp/app/(product)/mailbox/CloudShell.tsx").has("apps/webapp/test/ai-off-switch.test.tsx")).toBe(true);
  });

  it("select the built worker's loader for package source, and a child's spawner for what the child loads", () => {
    expect(hit("packages/db/src/cloud.ts").get("apps/worker/test/dist-import-graph.test.ts")).toBe("always");
    expect(hit("apps/worker/src/entry.ts").has("apps/worker/test/driver-startup-outage.test.ts")).toBe(true);
  });

  it("send a build.yml change only to the files that name .github, beside the git spawners", () => {
    const h = hit(".github/workflows/build.yml");
    const naming = [...h].filter(([f]) => !readers.get(f)!.git);
    expect(naming.length).toBeGreaterThan(0);
    for (const [f] of naming) expect(readers.get(f)!.paths.some((p) => p.startsWith(".github/")), f).toBe(true);
  });

  it("select the engine's metafile readers for the engine's source and for the bundlers", () => {
    expect(hit("apps/worker/src/bubble-up-pass.ts").get("apps/sidecar/test/engine-closure-no-cli-entry.test.ts")).toBe("always");
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
    expect(next.plan.shards[0]!.files.split("\n")).toEqual([own, names, "test/census.test.ts"]);
    expect(next.plan.deferred).toEqual([{ file: across, rule: "graph" }, { file: "test/plain.test.ts", rule: "root" }]);
    expect(next.plan.sqlite).toEqual([{ shard: 0, files: own }]);
    expect(next.plan.sqliteDeferred).toEqual([across]);
    expect(next.plan.summary).toMatchObject({ base: "next", main: 3, deferred: 2, deferredS: 10, rules: { graph: 1, root: 1, named: 1 } });
    expect(next.stdout).toBe([
      said.trimEnd(),
      `FAST next: pr #812 head ${sha}: runs 3 file(s) in 1 suite job(s) + 0 alone, defers 2 file(s) (10 s measured) to the whole run on next`,
      "::group::deferred to the whole run on next (2)", `graph\t${across}`, "root\ttest/plain.test.ts", "::endgroup::",
      "FAST next sqlite: runs 1 file(s) in 1 job(s), defers 1 file(s) to the whole run on next",
      "::group::deferred to the whole run on next, sqlite (1)", across, "::endgroup::", "",
    ].join("\n"));
    expect(deferredLog(next.plan, event("next"))).toBe(next.stdout.slice(said.length));
    for (const quiet of [main.plan, { scope: "whole", why: "a schedule run is whole" } as Plan]) expect(deferredLog(quiet, event("next"))).toBe("");
  }, 120_000);
});

describe("the last landed pull requests, as each base plans them", () => {
  const at = join(ROOT, "test/fixtures/ci-select-history");
  const history = readdirSync(at).filter((f) => f.endsWith(".tsv")).sort();
  const files = testFiles(ROOT);
  const sqliteAll = files.filter((_, i) => i % 9 === 0);
  /** A planted graph: every third test of the workspaces the change is in, and every thirteenth file of the tree. */
  const hit = (related: string[]) => {
    const areas = new Set(related.map(areaOf).filter(Boolean));
    return files.filter((f, i) => (areas.has(areaOf(f)) && i % 3 === 0) || i % 13 === 0);
  };
  const graph = async (_root: string, related: string[], { config }: GraphOptions) =>
    (config === "vitest.sqlite.config.ts" ? { related: hit(related).filter((f) => sqliteAll.includes(f)), all: sqliteAll } : { related: hit(related), all: [] });
  const handed = (plan: Plan) => [...plan.shards.flatMap((s) => s.files.split("\n")), ...plan.alone].sort();
  const sqliteHanded = (plan: Plan) => (plan.sqlite ?? []).flatMap((s) => s.files.split("\n")).sort();
  const plans = new Map<string, { changes: { s: string; p: string }[]; main: Plan; next: Plan }>();

  beforeAll(async () => {
    for (const name of history) {
      const changes = parseNameStatus(readFileSync(join(at, name), "utf8"));
      const plan = (base: string) => select({ root: ROOT, ctx: pr({ base: { ref: base } }), changes, graph }) as Promise<Plan>;
      plans.set(name, { changes, main: await plan("main"), next: await plan("next") });
    }
  }, 600_000);

  it("plans a base of main as before: no new key, nothing deferred, every related file handed on", async () => {
    const { desktopFiles } = await import("./support/ci-shards.mjs");
    const desktop = new Set(desktopFiles(ROOT, files));
    expect(history).toHaveLength(15);
    for (const [name, { changes, main }] of plans) {
      if (main.scope === "whole") { expect(Object.keys(main), name).toEqual(["scope", "why"]); continue; }
      expect(Object.keys(main), name).toEqual(["scope", "why", "shards", "alone", "sqlite", "summary"]);
      expect(Object.keys(main.summary!), name).toEqual(["changed", "rules", "main", "alone", "sqlite", "share", "costsMeasuredAt"]);
      const got = new Set(handed(main));
      const present = changes.map((c) => c.p);
      expect(hit(present).filter((f) => !got.has(f) && !desktop.has(f)), name).toEqual([]);
    }
  });

  it("loses nothing for a base of next: the direct set and the deferred list are main's selection, file for file", () => {
    const known = new Set(files);
    const compared: string[] = [];
    for (const [name, { main, next }] of plans) {
      // Whatever makes main's run whole (the harness, the selector, a migration) makes next's whole too.
      if (main.scope === "whole") { expect(next, name).toEqual(main); continue; }
      expect(next.scope, name).toBe("selected");
      expect(next.mode, name).toBe("direct");
      const deferred = next.deferred!.map((d) => d.file);
      expect([...handed(next), ...deferred].sort(), name).toEqual(handed(main));
      expect(deferred.filter((f) => !known.has(f)), name).toEqual([]);
      expect(next.deferred!.filter((d) => d.rule !== "graph" && d.rule !== "root"), name).toEqual([]);
      expect([...sqliteHanded(next), ...next.sqliteDeferred!].sort(), name).toEqual(sqliteHanded(main));
      expect(next.summary!.deferred, name).toBe(deferred.length);
      expect(deferred.length, name).toBeGreaterThan(0);
      compared.push(name);
    }
    expect(compared).toHaveLength(12);
  });
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
