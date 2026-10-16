import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";
import { evalIf, type IfContext } from "./support/workflow-if.js";

/**
 * A PULL REQUEST BUILDS THE PLATFORMS ONLY WHEN IT CHANGES WHAT THEY BUILD, AND THE REQUIRED JOBS ALWAYS REPORT.
 *
 * Every pull request used to run build.yml's six platform jobs and android.yml's APK in full, and a handful
 * of open pull requests saturated the free runner pool: on 2026-10-16 the release's own bump and tag runs
 * queued for over thirty minutes behind test and docs changes. So a `changes` job asks
 * `.github/scripts/pr-build-scope.sh` on a pull request, and the platform jobs read its answer there and
 * nowhere else. What must hold:
 *
 *   · the two contexts the ruleset requires from build.yml run on every pull request, never behind the
 *     answer, and no trigger is path-filtered (a required context that never reports blocks the merge);
 *   · a push to main, a `v*` tag, a merge group and a dispatch run every platform job, whatever `changes`
 *     did — a release takes its installers from the tag run;
 *   · on a pull request a platform job runs when the answer says so, and when `changes` did not succeed;
 *   · the script answers the paths the builds read, and every script a workflow runs is in its own scope.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Job = { name?: string; if?: unknown; needs?: string | string[]; steps?: Array<{ run?: unknown; id?: string }>; outputs?: Record<string, string> };
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };
const SCRIPT = publicPath("github/scripts/pr-build-scope.sh");
const text = (n: string) => readFileSync(publicPath(`github/workflows/${n}.yml`), "utf8");
const load = (t: string) => yaml.load(t) as Workflow;
const BUILD = text("build"), ANDROID = text("android");

/** The contexts main's ruleset requires from build.yml, as the jobs' names spell them. */
const REQUIRED = { engine: "engine · typecheck · build", "engine-ui-smoke": "engine-bearing UI · scan · smoke" };
/** The platform jobs that ask `changes` directly; linux-rpm-install asks through `linux`. */
const DESKTOP_GATED = ["macos", "windows", "linux", "linux-arm64", "linux-flatpak"];
const needsOf = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs === undefined ? [] : [j.needs]);

/** A run as the expressions see it. `scope` is the answer `changes` printed, `result` how `changes` ended. */
function run(event: string, ref: string, result: string, scope: string, extra: IfContext = {}): IfContext {
  return {
    "github.event_name": event, "github.ref": ref, "github.repository": "trafficflowhq/ohmail",
    "needs.changes.result": result, "needs.changes.outputs.desktop": scope, "needs.changes.outputs.android": scope,
    "needs.linux.result": "success", ...extra,
  };
}
const PR = (result: string, scope: string) => run("pull_request", "refs/pull/7/merge", result, scope);
/** Every run that is not a pull request: `changes` is skipped there, so its answer is empty. */
const NOT_PR: Array<[string, IfContext]> = [
  ["push to main", run("push", "refs/heads/main", "skipped", "")],
  ["v* tag", run("push", "refs/tags/v1.2.3", "skipped", "")],
  ["merge group", run("merge_group", "refs/heads/gh-readonly-queue/main/pr-7-abc", "skipped", "")],
  ["dispatch", run("workflow_dispatch", "refs/heads/main", "skipped", "")],
];
const ifOf = (j: Job | undefined) => String(j?.if ?? "true");
/** The script runs with nothing of the caller's run: under CI it would otherwise write to the job's own output. */
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };

/** The script's answer for a list of paths, and a CHANGELOG.md diff when given. */
function scope(paths: string[], changelog?: string): { desktop: string; android: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "pr-scope-"));
  writeFileSync(join(dir, "files"), paths.join("\n") + (paths.length ? "\n" : ""));
  const args = [SCRIPT, "--files", join(dir, "files")];
  if (changelog !== undefined) { writeFileSync(join(dir, "changelog"), changelog); args.push("--changelog", join(dir, "changelog")); }
  const r = spawnSync("bash", args, { encoding: "utf8", env: ENV });
  expect(r.status, r.stderr).toBe(0);
  return { desktop: /^desktop=(\w+)$/m.exec(r.stdout)?.[1] ?? "?", android: /^android=(\w+)$/m.exec(r.stdout)?.[1] ?? "?", out: r.stdout };
}

describe("the required contexts report on every pull request", () => {
  for (const [file, t] of [["build.yml", BUILD], ["android.yml", ANDROID]] as const) {
    it(`${file}: no trigger is path-filtered`, () => {
      const on = load(t).on ?? {};
      expect(Object.keys(on).length, "the parser read no trigger").toBeGreaterThan(0);
      const filtered = Object.entries(on).filter(([, v]) => v && typeof v === "object" && ("paths" in v || "paths-ignore" in v)).map(([k]) => k);
      expect(filtered, "a path filter on the trigger leaves a required context pending").toEqual([]);
    });
  }

  it("build.yml's two required jobs exist under their context names and wait on nothing", () => {
    const jobs = load(BUILD).jobs ?? {};
    for (const [id, name] of Object.entries(REQUIRED)) {
      expect(jobs[id]?.name, `the required context ${name} has no job`).toBe(name);
      expect(jobs[id]?.if, `${id} is gated`).toBeUndefined();
      expect(needsOf(jobs[id]!), `${id} waits on another job`).toEqual([]);
    }
  });
});

describe("the platform builds are gated on a pull request and nowhere else", () => {
  const build = load(BUILD).jobs ?? {}, android = load(ANDROID).jobs ?? {};

  it("each workflow's `changes` runs on a pull request only and hands on the script's answer", () => {
    for (const [jobs, key] of [[build, "desktop"], [android, "android"]] as const) {
      const c = jobs.changes;
      expect(c, "there is no changes job").toBeDefined();
      expect(c!.outputs?.[key]).toBe(`\${{ steps.scope.outputs.${key} }}`);
      const step = (c!.steps ?? []).find((s) => s.id === "scope");
      expect(String(step?.run ?? "")).toBe("bash .github/scripts/pr-build-scope.sh --base HEAD^1 --head HEAD");
      expect(evalIf(ifOf(c), PR("", ""))).toBe(true);
      for (const [label, ctx] of NOT_PR) expect(evalIf(ifOf(c), ctx), label).toBe(false);
    }
  });

  it("the desktop platform jobs: built when the answer is true or unread, skipped when it is false", () => {
    for (const id of DESKTOP_GATED) {
      const j = build[id];
      expect(j, id).toBeDefined();
      expect(needsOf(j!), id).toEqual(["changes"]);
      expect(evalIf(ifOf(j), PR("success", "false")), `${id} on a pull request that needs no build`).toBe(false);
      expect(evalIf(ifOf(j), PR("success", "true")), `${id} on a pull request that needs it`).toBe(true);
      expect(evalIf(ifOf(j), PR("failure", "")), `${id} when changes failed`).toBe(true);
      expect(evalIf(ifOf(j), PR("success", "true"), { cancelled: true }), `${id} on a cancelled run`).toBe(false);
      for (const [label, ctx] of NOT_PR) expect(evalIf(ifOf(j), ctx), `${id} on a ${label}`).toBe(true);
    }
  });

  it("the rpm install follows the Linux build: it runs exactly when that build succeeded", () => {
    const j = build["linux-rpm-install"];
    expect(needsOf(j!)).toEqual(["linux"]);
    for (const [label, ctx] of [...NOT_PR, ["pull request", PR("success", "true")] as [string, IfContext]]) {
      expect(evalIf(ifOf(j), ctx), label).toBe(true);
      expect(evalIf(ifOf(j), { ...ctx, "needs.linux.result": "skipped" }), `${label}, linux skipped`).toBe(false);
      expect(evalIf(ifOf(j), { ...ctx, "needs.linux.result": "failure" }), `${label}, linux failed`).toBe(false);
    }
  });

  it("the APK: gated the same way on a pull request, built on main, never on a tag as before", () => {
    const j = android.apk;
    expect(needsOf(j!)).toEqual(["changes"]);
    expect(evalIf(ifOf(j), PR("success", "false"))).toBe(false);
    expect(evalIf(ifOf(j), PR("success", "true"))).toBe(true);
    expect(evalIf(ifOf(j), PR("failure", ""))).toBe(true);
    const [main, tag, group, dispatch] = NOT_PR.map(([, c]) => c);
    expect(evalIf(ifOf(j), main!)).toBe(true);
    expect(evalIf(ifOf(j), group!)).toBe(true);
    expect(evalIf(ifOf(j), dispatch!)).toBe(true);
    expect(evalIf(ifOf(j), tag!)).toBe(false);
    expect(evalIf(ifOf(j), { ...main!, "github.repository": "someone/ohmail" }), "a fork's own push").toBe(false);
  });

  it("android's tag jobs do not ask `changes`", () => {
    for (const id of ["build", "sign"]) expect(needsOf(android[id]!)).not.toContain("changes");
  });

  it("the reader refuses what it cannot read, and is watched failing on an ungated job", () => {
    expect(() => evalIf("${{ success() }}", {})).toThrow(/no value given|not an expression/);
    expect(() => evalIf("github.sha == 'x'", {})).toThrow(/no value given for the context github.sha/);
    const ungated = load(BUILD.replace(/^(  macos:\n(?: {4}.*\n)*?) {4}if: .*\n/m, "$1")).jobs!.macos!;
    expect(evalIf(ifOf(ungated), PR("success", "false")), "the planted ungated macOS job").toBe(true);
  });
});

describe("pr-build-scope.sh answers the paths each build reads", () => {
  it.each([
    ["docs and root pages", ["README.md", "docs/x.md", "CONTRIBUTING.md"], "false", "false"],
    ["the suite's tests", ["test/a.test.ts", "apps/sidecar/test/b.test.ts", "packages/core/test/c.test.ts", "apps/mobile/test/d.test.ts"], "false", "false"],
    ["another workflow", [".github/workflows/ci.yml", "test/support/ci-shards.json"], "false", "false"],
    ["the server alone", ["apps/server/src/index.ts", "deploy/selfhost/docker-compose.yml"], "false", "false"],
    ["the desktop app", ["apps/desktop/src/App.tsx"], "true", "false"],
    ["the desktop's own tests", ["apps/desktop/test/desktop-shell.test.ts"], "true", "false"],
    ["the Rust shell", ["apps/desktop/src-tauri/Cargo.lock"], "true", "false"],
    ["the web app's views", ["apps/webapp/app/shell/x.tsx"], "true", "false"],
    ["the macOS plist", ["Resources/Info.plist"], "true", "false"],
    ["build.yml", [".github/workflows/build.yml"], "true", "false"],
    ["the phone app", ["apps/mobile/src/x.ts"], "false", "true"],
    ["android.yml", [".github/workflows/android.yml"], "false", "true"],
    ["an APK assertion", [".github/scripts/assert-no-fcm.sh"], "false", "true"],
    ["the engine", ["apps/sidecar/src/main.ts"], "true", "true"],
    ["the worker", ["apps/worker/src/x.ts"], "true", "true"],
    ["a package", ["packages/core/src/x.ts"], "true", "true"],
    ["a patch", ["patches/x.patch"], "true", "true"],
    ["a build script", ["scripts/engine-bundle.mjs"], "true", "true"],
    ["the lockfile", ["package-lock.json"], "true", "true"],
    ["the root tsconfig", ["tsconfig.base.json"], "true", "true"],
    ["this script", [".github/scripts/pr-build-scope.sh"], "true", "true"],
    ["nothing", [], "false", "false"],
  ])("%s", (_label, paths, desktop, android) => {
    expect(scope(paths)).toMatchObject({ desktop, android });
  });

  it("CHANGELOG.md needs the desktop build only when it gains a released version", () => {
    const unreleased = "@@ -3,0 +4 @@\n+- the list keeps its place\n";
    const folded = "@@ -2 +2,3 @@\n-## [Unreleased]\n+## [Unreleased]\n+\n+## [1.2.3] — 2026-10-16\n";
    expect(scope(["CHANGELOG.md"], unreleased)).toMatchObject({ desktop: "false", android: "false" });
    expect(scope(["CHANGELOG.md"], folded)).toMatchObject({ desktop: "true", android: "false" });
  });

  it("every script a workflow runs is in that workflow's scope", () => {
    for (const [t, key] of [[BUILD, "desktop"], [ANDROID, "android"]] as const) {
      const exec = t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      const named = [...new Set([...exec.matchAll(/(?:^|[\s"'])((?:\.github\/)?scripts\/[\w./-]+\.(?:sh|mjs|js))/gm)].map((m) => m[1]!))];
      expect(named.length, "the reader found no script").toBeGreaterThan(2);
      for (const p of named) expect(scope([p])[key], p).toBe("true");
    }
  });

  it("a list it cannot read needs every build", () => {
    const r = spawnSync("bash", [SCRIPT, "--files", join(tmpdir(), "pr-scope-no-such-list")], { encoding: "utf8", env: ENV });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("desktop=true\nandroid=true\n");
  });

  it("reads a real diff between two commits, a moved file counting at both paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-scope-git-"));
    const git = (...a: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8", env: ENV });
      expect(r.status, r.stderr).toBe(0);
    };
    git("init", "-q");
    mkdirSync(join(dir, "apps/mobile/src"), { recursive: true });
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "apps/mobile/src/a.ts"), "export const a = 1;\n".repeat(20));
    writeFileSync(join(dir, "README.md"), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("mv", "apps/mobile/src/a.ts", "docs/a.ts");
    git("commit", "-q", "-m", "move");
    const r = spawnSync("bash", [SCRIPT, "--base", "HEAD^1", "--head", "HEAD"], { cwd: dir, encoding: "utf8", env: ENV });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("desktop=false\nandroid=true\n");
    const bad = spawnSync("bash", [SCRIPT, "--base", "no-such-rev", "--head", "HEAD"], { cwd: dir, encoding: "utf8", env: ENV });
    expect(bad.stdout, "a diff it could not read").toBe("desktop=true\nandroid=true\n");
  });
});
