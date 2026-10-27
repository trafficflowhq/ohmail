import { hostedJobs, type IfContext, type RunEvent } from "./support/workflow-if.js";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";
import { evalValue } from "./support/workflow-if.js";

/**
 * A MATRIX THAT RUNS ON EVERY PULL REQUEST HOLDS A BOUNDED SHARE OF THE HOSTED RUNNERS.
 *
 * The hosted runners are one pool for the whole organisation, and a single pull request's suite used to
 * take all of it: every shard of every matrix started at once. So each matrix in a workflow that runs on
 * a pull request, a merge group or a push to main says how many of its jobs run at a time
 * (`max-parallel`), and ci.yml's bounds are pinned: three suite shards, one file that runs alone, one
 * SQLite shard. The suite's bound follows the pool its plan job ran on (`runner.environment`): six on the
 * maintainers' own runners, whose supervisor starts at most six VMs, three on GitHub's and on any pool it
 * cannot read. A workflow that runs only on a tag or by hand (ghcr-images.yml) is the release's, and
 * keeps its matrices whole.
 * Whole to this census, that is: the pool is the organisation's, so ghcr-images.yml bounds its two itself (three
 * image builds and two boots at a time), held below with the hosted jobs each event starts.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Workflow = {
  on?: Record<string, unknown> | null;
  jobs?: Record<string, { strategy?: { matrix?: unknown; "max-parallel"?: unknown }; outputs?: Record<string, string> }>;
};
/** The pools a run's plan job can report, the last one unread. */
const POOLS = ["self-hosted", "github-hosted", ""];
const DIR = publicPath("github/workflows");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".yml")).sort();
const text = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");

/** Does this `on:` run on every pull request, merge group or push to main? */
export function runsOnEveryChange(on: Record<string, unknown> | null | undefined): boolean {
  const keys = Object.keys(on ?? {});
  if (keys.some((k) => k === "pull_request" || k === "pull_request_target" || k === "merge_group")) return true;
  if (!keys.includes("push")) return false;
  const push = on!.push as Record<string, unknown> | null;
  if (!push || typeof push !== "object") return true;
  if (Array.isArray(push.branches)) return push.branches.some((b) => b === "main" || b === "*" || b === "**");
  if (Array.isArray(push["branches-ignore"])) return !push["branches-ignore"].includes("main");
  /* A push filtered on tags alone pushes no branch. */
  return !("tags" in push) && !("tags-ignore" in push);
}

/** Every matrix job of a workflow and its bound (undefined when it names none). */
export function matricesOf(t: string): Array<{ job: string; bound: unknown }> {
  const wf = yaml.load(t) as Workflow;
  return Object.entries(wf.jobs ?? {}).filter(([, j]) => j.strategy?.matrix !== undefined)
    .map(([job, j]) => ({ job, bound: j.strategy?.["max-parallel"] }));
}

/** A bound as each pool reads it: a number as written, an expression evaluated (undefined when it cannot be). */
export function boundPerPool(bound: unknown): unknown[] {
  if (typeof bound !== "string") return POOLS.map(() => bound);
  return POOLS.map((pool) => {
    try { return evalValue(bound, { "needs.plan.outputs.pool": pool }); } catch { return undefined; }
  });
}

/** The matrices that start every job at once, on any pool, in a workflow that runs on every change. */
export function unbounded(file: string, t: string): string[] {
  if (!runsOnEveryChange((yaml.load(t) as Workflow).on)) return [];
  return matricesOf(t).filter((m) => !boundPerPool(m.bound).every((b) => Number.isInteger(b) && (b as number) > 0))
    .map((m) => `${file}: ${m.job} starts its whole matrix at once`);
}

describe("the matrices share the hosted runners", () => {
  const ci = text("ci.yml"), images = text("ghcr-images.yml");

  it("every matrix that runs on a pull request or a push to main is bounded", () => {
    expect(FILES).toEqual(expect.arrayContaining(["android.yml", "build.yml", "ci.yml", "ghcr-images.yml"]));
    expect(FILES.flatMap((f) => unbounded(f, text(f)))).toEqual([]);
    /* The census has subjects: ci.yml's three matrices, and ghcr-images.yml's two, which it exempts. */
    const held = FILES.filter((f) => runsOnEveryChange((yaml.load(text(f)) as Workflow).on))
      .flatMap((f) => matricesOf(text(f)).map((m) => `${f}: ${m.job}`));
    expect(held).toEqual(["ci.yml: suite", "ci.yml: alone", "ci.yml: sqlite"]);
    expect(matricesOf(images).map((m) => m.job)).toEqual(["build-push", "gate-boot"]);
  });

  it("ci.yml runs six suite shards at a time on its own runners and three on GitHub's, one alone file and one SQLite shard", () => {
    const [suite, alone, sqlite] = matricesOf(ci);
    expect([suite!.job, alone, sqlite]).toEqual(["suite", { job: "alone", bound: 1 }, { job: "sqlite", bound: 1 }]);
    expect(boundPerPool(suite!.bound)).toEqual([6, 3, 3]);
    /* The pool is the plan job's own, as the runner reports it. */
    expect((yaml.load(ci) as Workflow).jobs?.plan?.outputs?.pool).toBe("${{ runner.environment }}");
  });

  it("each reading is watched failing", () => {
    const dropped = ci.replace(/\n {6}max-parallel: 1\n/, "\n");
    expect(dropped).not.toBe(ci);
    expect(unbounded("ci.yml", dropped)).toEqual(["ci.yml: alone starts its whole matrix at once"]);
    /* An expression bound is read for every pool: one that leaves a pool unbounded, or reads a context it is not given. */
    const suiteBound = /max-parallel: (\$\{\{ .+ \}\})\n/.exec(ci)?.[1];
    expect(suiteBound, "the suite's bound is no expression").toBeDefined();
    expect(unbounded("ci.yml", ci.replace(suiteBound!, "${{ needs.plan.outputs.pool == 'self-hosted' && 6 || 0 }}"))).toEqual(["ci.yml: suite starts its whole matrix at once"]);
    expect(unbounded("ci.yml", ci.replace(suiteBound!, "${{ vars.X == 'zorin' && 6 || 3 }}"))).toEqual(["ci.yml: suite starts its whole matrix at once"]);
    expect(unbounded("ci.yml", ci.replace(suiteBound!, "0"))).toEqual(["ci.yml: suite starts its whole matrix at once"]);
    expect(boundPerPool(suiteBound!.replace("'self-hosted'", "'github-hosted'"))).toEqual([3, 6, 3]);
    /* ghcr-images.yml on a pull request is held to the same bound. */
    const onPr = images.replace("\non:\n  push:\n", "\non:\n  pull_request:\n  push:\n").replace(/\n {6}max-parallel: \d+\n/g, "\n"); // its own bounds dropped
    expect(onPr).not.toBe(images);
    expect(unbounded("ghcr-images.yml", onPr)).toEqual([
      "ghcr-images.yml: build-push starts its whole matrix at once",
      "ghcr-images.yml: gate-boot starts its whole matrix at once",
    ]);
    expect(runsOnEveryChange({ push: { branches: ["main"] } })).toBe(true);
    expect(runsOnEveryChange({ push: null })).toBe(true);
    expect(runsOnEveryChange({ push: { tags: ["v*"] }, workflow_dispatch: null })).toBe(false);
    expect(runsOnEveryChange({ schedule: [{ cron: "0 0 * * *" }] })).toBe(false);
  });
});

/**
 * THE ORGANISATION'S HOSTED RUNNERS ARE ONE POOL, AND AN ORDINARY PULL REQUEST TAKES TWO JOBS OF IT.
 *
 * The pool (twenty jobs at once, five of them macOS) is shared with the organisation's other repositories, and each
 * push of a maintainer's pull request used to start fourteen hosted jobs, about two hours of runner time, while the
 * other repositories' runs queued (2026-10-26). So a maintainer's pull request runs ci.yml and build.yml's engine
 * pair on the maintainers' own runners and dco and guard on GitHub's; the platform builds, the APK and the self-host
 * smoke run on the batch branch, the release bump, a fork's or a bot's pull request, a tag, the nightly and a
 * dispatch. Each event's hosted jobs are read off the files (`hostedJobs`); each title carries the count.
 */
describe("the hosted jobs each event starts", () => {
  const parsed = (edit: (file: string, t: string) => string = (_f, t) => t) =>
    Object.fromEntries(FILES.map((f) => [f, yaml.load(edit(f, text(f)))]));
  const WORKFLOWS = parsed();
  const PLAN: IfContext = { "needs.plan.outputs.shards": '[{"shard":0},{"shard":1}]', "needs.plan.outputs.alone": '["a.test.ts"]', "needs.plan.outputs.sqlite": '[{"shard":0}]' };
  /** An event as the files' expressions read it: a maintainer started it, and a pull request is theirs, from a pr/ branch. */
  const at = (event: string, ref: string, extra: IfContext): IfContext => {
    const pr = event.startsWith("pull_request");
    return {
      "vars.OHMAIL_LINUX_RUNNER": "zorin", "github.repository": "trafficflowhq/ohmail", "github.event_name": event, "github.ref": ref,
      "github.actor": "a-maintainer", "github.triggering_actor": "a-maintainer", "github.head_ref": pr ? "pr/lane-x" : "",
      "github.event.pull_request.head.repo.full_name": pr ? "trafficflowhq/ohmail" : null,
      "github.event.pull_request.user.type": pr ? "User" : null, "github.event.pull_request.author_association": pr ? "OWNER" : null,
      "github.event.pull_request.draft": null, "github.event.action": null, "github.event.release.tag_name": null, "inputs.verify_only": null,
      "needs.changes.outputs.desktop": "true", "needs.changes.outputs.android": "true", "needs.changes.outputs.selfhost": "true",
      "needs.version.outputs.promote_public": "yes", ...PLAN, ...extra,
    };
  };
  const hosted = (event: string, ref: string, more: Partial<RunEvent> = {}, extra: IfContext = {}, wfs = WORKFLOWS) =>
    hostedJobs(wfs, { event, ref, ctx: at(event, ref, extra), ...more });
  /** One push of a pull request: its pull_request run and its pull_request_target run. */
  const push = (extra: IfContext = {}, wfs = WORKFLOWS) =>
    [...hosted("pull_request", "refs/pull/7/merge", {}, extra, wfs), ...hosted("pull_request_target", "refs/heads/main", {}, extra, wfs)];
  const nightly = (wfs = WORKFLOWS) => hosted("schedule", "refs/heads/main", { cron: "daily" }, {}, wfs);

  const QUICK = ["dco.yml: sign-off @ubuntu-latest", "guard.yml: guard @ubuntu-latest"];
  const APK = "android.yml: apk @ubuntu-latest", SMOKE = "selfhost-smoke.yml: boot-smoke @ubuntu-latest";
  const ENGINE = ["build.yml: engine @ubuntu-latest", "build.yml: engine-ui-smoke @ubuntu-latest"];
  const DESKTOP = ["macos @macos-15", "macos-sign @macos-15", "windows @windows-latest", "linux @ubuntu-latest", "linux-arm64 @ubuntu-24.04-arm",
    "linux-rpm-install @ubuntu-latest", "linux-flatpak @ubuntu-latest"].map((j) => `build.yml: ${j}`);
  const CI = ["plan", "suite (0)", "suite (1)", "alone (a.test.ts)", "sqlite (0)", "proxy-e2e", "webapp-build", "typecheck", "desktop"]
    .map((j) => `ci.yml: ${j} @ubuntu-latest`);
  const FULL = ["android.yml: changes @ubuntu-latest", APK, "build.yml: changes @ubuntu-latest", ...DESKTOP,
    "selfhost-smoke.yml: changes @ubuntu-latest", SMOKE, ...QUICK];
  const BATCH = { "github.head_ref": "pr/batch-0307" };

  it("an ordinary maintainer pull request: 2 hosted jobs, dco and guard", () => {
    expect(push()).toEqual(QUICK);
  });

  it("an ordinary pull request that changes only tests: 2", () => {
    expect(push({ "needs.changes.outputs.desktop": "false", "needs.changes.outputs.android": "false", "needs.changes.outputs.selfhost": "false" })).toEqual(QUICK);
  });

  it("a lane whose branch starts like a bump's, pr/release-run-on-vms: 2", () => {
    expect(push({ "github.head_ref": "pr/release-run-on-vms" })).toEqual(QUICK);
  });

  it("the batch pr/batch-0307 and the release bump pr/release-0307-bump: 14 each, 2 of them macOS", () => {
    expect(push(BATCH)).toEqual(FULL);
    expect(push({ "github.head_ref": "pr/release-0307-bump" })).toEqual(FULL);
    expect(FULL.filter((j) => j.endsWith("@macos-15"))).toHaveLength(2);
  });

  it("a fork's pull request: 25, every job on GitHub's runners", () => {
    const fork = { "github.event.pull_request.head.repo.full_name": "someone/ohmail", "github.event.pull_request.author_association": "CONTRIBUTOR",
      "github.actor": "someone", "github.triggering_actor": "someone", "github.head_ref": "fix-x" };
    expect(push(fork)).toEqual([...FULL.slice(0, 10), ...ENGINE, ...CI, ...FULL.slice(10)]);
  });

  it("an ordinary pull request while the switch reads hosted: 13, the routed jobs, dco and guard, no platform", () => {
    expect(push({ "vars.OHMAIL_LINUX_RUNNER": "hosted" })).toEqual([...ENGINE, ...CI, ...QUICK]);
  });

  it("a push to main: 0", () => {
    expect(hosted("push", "refs/heads/main")).toEqual([]);
  });

  it("a v* tag: 22, build.yml's 10 and ghcr-images.yml's 12", () => {
    expect(hosted("push", "refs/tags/v0.30.7")).toEqual([
      "build.yml: macos @macos-15", "build.yml: macos-sign @macos-15", "build.yml: macos-signed-check @macos-15", "build.yml: windows @windows-latest",
      "build.yml: linux @ubuntu-latest", "build.yml: linux-arm64 @ubuntu-24.04-arm", "build.yml: linux-rpm-install @ubuntu-latest",
      "build.yml: linux-flatpak @ubuntu-latest", ...ENGINE,
      "ghcr-images.yml: version @ubuntu-latest", "ghcr-images.yml: mirror-images @ubuntu-latest",
      "ghcr-images.yml: build-push (ohmail-server, amd64, ubuntu-latest, apps/server/Dockerfile) @ubuntu-latest",
      "ghcr-images.yml: build-push (ohmail-server, arm64, ubuntu-24.04-arm, apps/server/Dockerfile) @ubuntu-24.04-arm",
      "ghcr-images.yml: build-push (ohmail-worker, amd64, ubuntu-latest, apps/worker/Dockerfile.selfhost) @ubuntu-latest",
      "ghcr-images.yml: build-push (ohmail-worker, arm64, ubuntu-24.04-arm, apps/worker/Dockerfile.selfhost) @ubuntu-24.04-arm",
      "ghcr-images.yml: build-push (ohmail-web, amd64, ubuntu-latest, apps/webapp/Dockerfile) @ubuntu-latest",
      "ghcr-images.yml: build-push (ohmail-web, arm64, ubuntu-24.04-arm, apps/webapp/Dockerfile) @ubuntu-24.04-arm",
      "ghcr-images.yml: gate-boot (amd64, ubuntu-latest) @ubuntu-latest", "ghcr-images.yml: gate-boot (arm64, ubuntu-24.04-arm) @ubuntu-24.04-arm",
      "ghcr-images.yml: gate-visibility @ubuntu-latest", "ghcr-images.yml: promote @ubuntu-latest",
    ]);
  });

  it("an android-v* tag: 2, the build and the signing", () => {
    expect(hosted("push", "refs/tags/android-v0.30.7")).toEqual(["android.yml: build @ubuntu-latest", "android.yml: sign @ubuntu-latest"]);
  });

  it("the nightly: 9, every platform, the APK and the self-host smoke", () => {
    expect(nightly()).toEqual([APK, ...DESKTOP, SMOKE]);
  });

  it("the weekly fresh-clone run: 11", () => {
    expect(hosted("schedule", "refs/heads/main", { cron: "weekly" })).toEqual([
      "linux-build @ubuntu-24.04", "linux-suite-1 @ubuntu-24.04", "linux-suite-2 @ubuntu-24.04", "macos-build @macos-latest",
      "macos-suite-1 @macos-latest", "macos-suite-2 @macos-latest", "windows-build @windows-latest", "windows-suite-1 @windows-latest",
      "windows-suite-2 @windows-latest", "windows-suite-3 @windows-latest", "windows-suite-4 @windows-latest",
    ].map((j) => `contributor.yml: ${j}`));
  });

  it("a release tag's images: three builds and two boots at a time", () => {
    expect(matricesOf(text("ghcr-images.yml"))).toEqual([{ job: "build-push", bound: 3 }, { job: "gate-boot", bound: 2 }]);
  });

  it("each count is watched failing", () => {
    const planted = (from: string, to: string, only?: string) => {
      const wfs = parsed((f, t) => (only === undefined || f === only ? t.replaceAll(from, to) : t));
      expect(JSON.stringify(wfs), `the planting changed nothing: ${from}`).not.toBe(JSON.stringify(WORKFLOWS));
      return wfs;
    };
    expect(push(BATCH, planted(" && !startsWith(github.head_ref, 'pr/batch-')", "")), "the batch clause dropped").toEqual(QUICK);
    expect(push({}, planted("needs.changes.result != 'skipped' && ", "")), "a skipped `changes` read as unread").toEqual([APK, ...DESKTOP, SMOKE, ...QUICK]);
    expect(nightly(planted('  schedule:\n    - cron: "41 0 * * *"\n', "", "build.yml")), "build.yml's schedule dropped").toEqual([APK, SMOKE]);
    expect(matricesOf(text("ghcr-images.yml").replace("      max-parallel: 3\n", ""))[0]).toEqual({ job: "build-push", bound: undefined });
  });
});
