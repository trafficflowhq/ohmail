import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";
import { evalIf, namesStatusCheck, runJobs, startsOn, type IfContext, type JobResult, type RunEvent } from "./support/workflow-if.js";

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
 *   · a `v*` tag, the nightly and a dispatch run every platform job, whatever `changes` did, and every job
 *     after one — a release takes its installers from the tag run. Read as GitHub starts jobs (`runJobs`):
 *     an `if:` naming no status-check function is `success()` over the whole needs chain, so `changes`,
 *     skipped there, would skip any job below it that does not say `!cancelled()`. A push to main and a
 *     merge group build no platform: the engine pair is main's proof, the nightly the platforms';
 *   · `changes` runs on a full-build pull request alone (the batch, the release bump, a fork's or a bot's).
 *     A maintainer's other pull requests skip it and every platform job with it: the hosted runners are the
 *     organisation's one pool. On a full-build pull request a platform job runs when the answer says so, and
 *     when `changes` did not succeed;
 *   · the script answers the paths the builds read, and every script a workflow runs is in its own scope.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Job = { name?: string; if?: unknown; needs?: string | string[]; steps?: Array<{ run?: unknown; id?: string }>; outputs?: Record<string, string> };
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };
const SCRIPT = publicPath("github/scripts/pr-build-scope.sh");
const text = (n: string) => readFileSync(publicPath(`github/workflows/${n}.yml`), "utf8");
const load = (t: string) => yaml.load(t) as Workflow;
const BUILD = text("build"), ANDROID = text("android"), SELFHOST = text("selfhost-smoke");

/** The contexts main's ruleset requires from build.yml, as the jobs' names spell them. */
const REQUIRED = { engine: "engine · typecheck · build", "engine-ui-smoke": "engine-bearing UI · scan · smoke" };
/** The platform jobs that ask `changes` directly; linux-rpm-install asks through `linux`. */
const DESKTOP_GATED = ["macos", "windows", "linux", "linux-arm64", "linux-flatpak"];
const needsOf = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs === undefined ? [] : [j.needs]);

/** The maintainer door's contexts, all null: a run that is no maintainer's pull request (a fork's reads so too). */
const NO_DOOR: IfContext = {
  "github.event.pull_request.head.repo.full_name": null, "github.head_ref": null, "github.event.pull_request.user.type": null,
  "github.event.pull_request.author_association": null, "github.actor": null, "github.triggering_actor": null,
  "github.event.pull_request.draft": null, "github.base_ref": null, "github.event.action": null,
  "inputs.play_version_code": "", "github.event.deleted": false,
};
/** A maintainer's own pull request from a branch of this repository, ready unless `draft`. */
const LANE = (head = "pr/lane-x", draft = false): IfContext => ({
  "github.event.pull_request.head.repo.full_name": "trafficflowhq/ohmail", "github.head_ref": head, "github.event.pull_request.user.type": "User",
  "github.event.pull_request.author_association": "OWNER", "github.actor": "a-maintainer", "github.triggering_actor": "a-maintainer",
  "github.event.pull_request.draft": draft,
});

/** A run as the expressions see it. `scope` is the answer `changes` printed, `result` how `changes` ended. */
function run(event: string, ref: string, result: string, scope: string, extra: IfContext = {}): IfContext {
  return {
    "github.event_name": event, "github.ref": ref, "github.repository": "trafficflowhq/ohmail",
    "needs.changes.result": result, "needs.changes.outputs.desktop": scope, "needs.changes.outputs.android": scope,
    "needs.linux.result": "success", ...NO_DOOR, ...extra,
  };
}
/** A full-build pull request, as a fork's reads; a maintainer's ordinary one skips `changes`. */
const PR = (result: string, scope: string) => run("pull_request", "refs/pull/7/merge", result, scope);
/** Every run that is not a pull request (`changes` is skipped there, so its answer is empty), and whether it builds the platforms. */
const NOT_PR_RUNS: Array<[string, string, string, boolean]> = [
  ["push to main", "push", "refs/heads/main", false],
  ["v* tag", "push", "refs/tags/v1.2.3", true],
  ["merge group", "merge_group", "refs/heads/gh-readonly-queue/main/pr-7-abc", false],
  ["dispatch", "workflow_dispatch", "refs/heads/main", true],
  ["nightly", "schedule", "refs/heads/main", true],
];
const NOT_PR: Array<[string, IfContext, boolean]> = NOT_PR_RUNS.map(([label, event, ref, builds]) => [label, run(event, ref, "skipped", ""), builds]);
/**
 * A job's own condition, for a reader that evaluates it alone. For a job that needs another, an `if:` naming no
 * status-check function is not its own answer: GitHub reads it as `success()` over the whole needs chain, so such a
 * job is read through runJobs, and here it refuses.
 */
const ifOf = (j: Job | undefined) => {
  const raw = j?.if === undefined ? "" : String(j.if);
  if (needsOf(j ?? {}).length && !namesStatusCheck(raw)) throw new Error(`${j?.name}: an if: naming no status function waits on the whole needs chain: read it through runJobs`);
  return raw === "" ? "true" : raw;
};
/** A run as runJobs takes it: what no job decides, the event and the answer `changes` printed; it works out the rest. */
const graphRun = (event: string, ref: string, scope: string): IfContext => ({
  "github.event_name": event, "github.ref": ref, "github.repository": "trafficflowhq/ohmail",
  "needs.changes.outputs.desktop": scope, "needs.changes.outputs.android": scope, ...NO_DOOR,
});
const ran = (r: Record<string, JobResult>) => Object.keys(r).filter((id) => r[id] === "success").sort();
/** The script runs with nothing of the caller's run: under CI it would otherwise write to the job's own output. */
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };

/** The script's answer for a list of paths, and a CHANGELOG.md diff when given. */
function scope(paths: string[], changelog?: string): { desktop: string; android: string; selfhost: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "pr-scope-"));
  writeFileSync(join(dir, "files"), paths.join("\n") + (paths.length ? "\n" : ""));
  const args = [SCRIPT, "--files", join(dir, "files")];
  if (changelog !== undefined) { writeFileSync(join(dir, "changelog"), changelog); args.push("--changelog", join(dir, "changelog")); }
  const r = spawnSync("bash", args, { encoding: "utf8", env: ENV });
  expect(r.status, r.stderr).toBe(0);
  const read = (k: string) => new RegExp(`^${k}=(\\w+)$`, "m").exec(r.stdout)?.[1] ?? "?";
  return { desktop: read("desktop"), android: read("android"), selfhost: read("selfhost"), out: r.stdout };
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

  it("each workflow's `changes` runs on a full-build pull request only and hands on the script's answer", () => {
    for (const [jobs, key] of [[build, "desktop"], [android, "android"], [load(SELFHOST).jobs ?? {}, "selfhost"]] as const) {
      const c = jobs.changes;
      expect(c, "there is no changes job").toBeDefined();
      expect(c!.outputs?.[key]).toBe(`\${{ steps.scope.outputs.${key} }}`);
      const step = (c!.steps ?? []).find((s) => s.id === "scope");
      expect(String(step?.run ?? "")).toBe("bash .github/scripts/pr-build-scope.sh --base HEAD^1 --head HEAD");
      expect(evalIf(ifOf(c), PR("", "")), "a fork's").toBe(true);
      for (const head of ["pr/batch-0307", "pr/release-0307-bump"]) expect(evalIf(ifOf(c), { ...PR("", ""), ...LANE(head) }), head).toBe(true);
      expect(evalIf(ifOf(c), { ...PR("", ""), ...LANE("pr/batch-0307", true) }), "a batch that is a draft").toBe(false);
      expect(evalIf(ifOf(c), { ...PR("", ""), ...LANE("pr/release-0307-bump", true) }), "the release bump as a draft").toBe(true);
      expect(evalIf(ifOf(c), { ...PR("", ""), "github.event.pull_request.draft": true }), "a fork's draft").toBe(true);
      expect(evalIf(ifOf(c), { ...PR("", ""), ...LANE(), "github.event.pull_request.user.type": "Bot" }), "a bot's").toBe(true);
      for (const head of ["pr/lane-x", "pr/release-run-on-vms", "pr/batch", "pr/release-0307-bump-fix"]) {
        expect(evalIf(ifOf(c), { ...PR("", ""), ...LANE(head) }), `a maintainer's ${head}`).toBe(false);
      }
      for (const [label, ctx] of NOT_PR) expect(evalIf(ifOf(c), ctx), label).toBe(false);
    }
  });

  it("the desktop platform jobs: built when the answer is true or unread, skipped when it is false or `changes` skipped", () => {
    for (const id of DESKTOP_GATED) {
      const j = build[id];
      expect(j, id).toBeDefined();
      expect(needsOf(j!), id).toEqual(["changes"]);
      expect(evalIf(ifOf(j), PR("skipped", "")), `${id} on a maintainer's ordinary pull request`).toBe(false);
      expect(evalIf(ifOf(j), PR("success", "false")), `${id} on a pull request that needs no build`).toBe(false);
      expect(evalIf(ifOf(j), PR("success", "true")), `${id} on a pull request that needs it`).toBe(true);
      expect(evalIf(ifOf(j), PR("failure", "")), `${id} when changes failed`).toBe(true);
      expect(evalIf(ifOf(j), PR("success", "true"), { cancelled: true }), `${id} on a cancelled run`).toBe(false);
      for (const [label, ctx, builds] of NOT_PR) expect(evalIf(ifOf(j), ctx), `${id} on a ${label}`).toBe(builds);
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

  it("the APK: gated the same way on a pull request, built nightly and by dispatch, never on main or a tag", () => {
    const j = android.apk;
    expect(needsOf(j!)).toEqual(["changes"]);
    expect(evalIf(ifOf(j), PR("skipped", ""))).toBe(false);
    expect(evalIf(ifOf(j), PR("success", "false"))).toBe(false);
    expect(evalIf(ifOf(j), PR("success", "true"))).toBe(true);
    expect(evalIf(ifOf(j), PR("failure", ""))).toBe(true);
    const [main, tag, group, dispatch, nightly] = NOT_PR.map(([, c]) => c);
    expect(evalIf(ifOf(j), main!)).toBe(false);
    expect(evalIf(ifOf(j), group!)).toBe(false);
    expect(evalIf(ifOf(j), dispatch!)).toBe(true);
    expect(evalIf(ifOf(j), nightly!)).toBe(true);
    expect(evalIf(ifOf(j), tag!)).toBe(false);
    expect(evalIf(ifOf(j), { ...nightly!, "github.repository": "someone/ohmail" }), "a fork's own nightly").toBe(false);
    expect(load(ANDROID).on?.push, "a push to main starts no android run").toEqual({ tags: ["android-v*"] });
  });

  it("android's tag jobs do not ask `changes`", () => {
    for (const id of ["build", "sign"]) expect(needsOf(android[id]!)).not.toContain("changes");
  });

  it("the reader refuses what it cannot read, and is watched failing on an ungated job", () => {
    expect(() => evalIf("${{ success() }}", {})).toThrow(/no value given|not an expression/);
    expect(() => evalIf("github.sha == 'x'", {})).toThrow(/no value given for the context github.sha/);
    const ungated = load(BUILD.replace(/^(  macos:\n(?: {4}.*\n)*?) {4}if: .*\n/m, "$1")).jobs!;
    expect(ungated.macos!.if, "the plant").toBeUndefined();
    expect(() => ifOf(ungated.macos), "a job that needs another, read alone").toThrow(/whole needs chain/);
    expect(runJobs(ungated, graphRun("pull_request", "refs/pull/7/merge", "false")).macos, "the planted ungated macOS job").toBe("success");
  });
});

describe("every job after a platform build follows it, read as GitHub reads the whole needs chain", () => {
  const build = load(BUILD).jobs ?? {};
  const ALL = Object.keys(build).sort();
  /** The one job that runs on a release tag alone: it opens what was shipped. */
  const TAG_ONLY = ["macos-signed-check"];
  const PR_RUN = (scope: string, ended: Record<string, JobResult> = {}) => runJobs(build, graphRun("pull_request", "refs/pull/7/merge", scope), { ended });

  it("a v* tag, the nightly and a dispatch run every job but `changes`, the check job on the tag alone; main and a merge group the engine pair", () => {
    expect(ALL, "the parser read the signing jobs").toEqual(expect.arrayContaining(["macos", "macos-sign", "macos-signed-check", "linux-rpm-install"]));
    for (const [label, event, ref, builds] of NOT_PR_RUNS) {
      const r = runJobs(build, graphRun(event, ref, ""));
      expect(r.changes, label).toBe("skipped");
      expect(ran(r), label).toEqual(builds ? ALL.filter((id) => id !== "changes" && (ref.startsWith("refs/tags/v") || !TAG_ONLY.includes(id))) : ["engine", "engine-ui-smoke"]);
    }
  });

  it("on a pull request the signing job follows the macOS build, and the check job waits for a tag", () => {
    expect(ran(runJobs(build, { ...graphRun("pull_request", "refs/pull/7/merge", "true"), ...LANE() })), "a maintainer's ordinary pull request").toEqual(["engine", "engine-ui-smoke"]);
    expect(ran(PR_RUN("true")), "a pull request that builds the desktop").toEqual(ALL.filter((id) => !TAG_ONLY.includes(id)));
    expect(ran(PR_RUN("false")), "a pull request that builds nothing").toEqual(["changes", "engine", "engine-ui-smoke"]);
    expect(ran(PR_RUN("", { changes: "failure" })), "an answer that could not be read").toEqual(ALL.filter((id) => id !== "changes" && !TAG_ONLY.includes(id)));
    const failed = PR_RUN("true", { macos: "failure" });
    expect([failed.macos, failed["macos-sign"], failed["macos-signed-check"]], "a failed build signs nothing").toEqual(["failure", "skipped", "skipped"]);
    expect(runJobs(build, graphRun("push", "refs/tags/v1.2.3", ""), { ended: { "macos-sign": "failure" } })["macos-signed-check"], "nor is a failed signing opened").toBe("skipped");
  });

  /* The shape the signing job first had: no `if:`, and a check job whose `if:` asks the ref alone. Each reads true
     alone and runs on a pull request, where `changes` ran; GitHub skips both everywhere else. */
  it("is watched failing on a job below a skipped one whose `if:` names no status function", () => {
    const head = {
      ...build,
      "macos-sign": { ...build["macos-sign"], if: undefined },
      "macos-signed-check": { ...build["macos-signed-check"], if: "${{ startsWith(github.ref, 'refs/tags/v') }}" },
    };
    for (const [label, event, ref] of NOT_PR_RUNS.filter(([, , , builds]) => builds)) {
      const r = runJobs(head, graphRun(event, ref, ""));
      expect([r.macos, r["macos-sign"], r["macos-signed-check"]], label).toEqual(["success", "skipped", "skipped"]);
    }
    expect(runJobs(head, graphRun("pull_request", "refs/pull/7/merge", "true"))["macos-sign"], "where changes ran").toBe("success");
    expect(() => ifOf(head["macos-sign"]), "read alone").toThrow(/whole needs chain/);
  });
});

/**
 * PLATFORM BUILDS FOR DRAFT BATCHES AND READY MARKS.
 *
 * A batch's pull request can land its members on its own build run while it is a draft: the engine pair takes minutes,
 * the platform builds most of an hour, and those follow on the branch once the members are in. So `changes` reads the
 * draft flag on the batch's arm and nowhere else, and the three workflows start on `ready_for_review`, so that a batch
 * marked ready into main still builds every platform, the APK and the self-host smoke. On next the ready mark
 * of a maintainer's batch retains just the two required engine jobs. Read as GitHub starts each run
 * (`startsOn`) and its jobs (`runJobs`), against each file as it was without the flag and the trigger:
 *   · a draft batch's opening, push or reopening runs build.yml's engine pair alone, what every draft runs;
 *   · marking any pull request ready into main runs the jobs its ready push runs; none of the three started on it before;
 *   · every other event and kind of pull request runs exactly the jobs it ran before.
 */
describe("platform builds for draft batches and ready pull requests", () => {
  const TERM = " && !(startsWith(github.head_ref, 'pr/batch-') && (github.repository != 'trafficflowhq/ohmail' || github.base_ref != 'next' || github.event.action != 'ready_for_review') && github.event.pull_request.draft != true)";
  const OLD = " && !startsWith(github.head_ref, 'pr/batch-')";
  const TYPES = "\n    types: [opened, synchronize, reopened, ready_for_review]\n";
  const TEXTS: Record<string, string> = { "build.yml": BUILD, "android.yml": ANDROID, "selfhost-smoke.yml": SELFHOST };
  /** Each file as it was: the batch's arm without the draft flag, the pull request's three default types. */
  const asItWas = (t: string) => t.replace(TERM, OLD).replace(TYPES, "\n");
  const BEFORE: Record<string, string> = Object.fromEntries(Object.entries(TEXTS).map(([f, t]) => [f, asItWas(t)]));
  /** Every job of build.yml but the check of a shipped tag's app. */
  const ALL_BUILD = Object.keys(load(BUILD).jobs ?? {}).filter((id) => id !== "macos-signed-check").sort();
  const ENGINE_PAIR = ["engine", "engine-ui-smoke"];
  /** A run's contexts: what the conditions read, every scope answer "true" (the change reaches every build). */
  const at = (event: string, ref: string, extra: IfContext = {}): IfContext => ({
    "github.event_name": event, "github.ref": ref, "github.repository": "trafficflowhq/ohmail", ...NO_DOOR,
    "needs.changes.outputs.desktop": "true", "needs.changes.outputs.android": "true", "needs.changes.outputs.selfhost": "true", ...extra,
  });
  const BATCH = LANE("pr/batch-0307");
  const KINDS: Array<[string, IfContext]> = [
    ["a maintainer's pull request", LANE()],
    ["a batch", BATCH],
    ["the release bump", LANE("pr/release-0307-bump")],
    ["a fork's pull request", { "github.event.pull_request.head.repo.full_name": "someone/ohmail", "github.head_ref": "fix-x", "github.event.pull_request.user.type": "User",
      "github.event.pull_request.author_association": "CONTRIBUTOR", "github.actor": "someone", "github.triggering_actor": "someone" }],
    ["a bot's pull request", { "github.event.pull_request.head.repo.full_name": "trafficflowhq/ohmail", "github.head_ref": "dependabot/npm_and_yarn/x",
      "github.event.pull_request.user.type": "Bot", "github.event.pull_request.author_association": "NONE", "github.actor": "dependabot[bot]", "github.triggering_actor": "dependabot[bot]" }],
  ];
  const prEvent = (action: string, draft: boolean, kind: IfContext): RunEvent =>
    ({ event: "pull_request", action, ref: "refs/pull/7/merge", ctx: at("pull_request", "refs/pull/7/merge", { "github.base_ref": "main", "github.event.action": action, ...kind, "github.event.pull_request.draft": draft }) });
  /** Every row: its label, the event, and whether it is a draft batch's push. */
  const ROWS: Array<[string, RunEvent, boolean]> = [
    ...KINDS.flatMap(([kind, ctx]) => ["opened", "synchronize", "reopened"].flatMap((action) => [true, false].map((draft) =>
      [`${kind}, ${action}, ${draft ? "a draft" : "ready"}`, prEvent(action, draft, ctx), ctx === BATCH && draft] as [string, RunEvent, boolean]))),
    ...KINDS.map(([kind, ctx]) => [`${kind}, marked ready`, prEvent("ready_for_review", false, ctx), false] as [string, RunEvent, boolean]),
    ...([["a push to main", "push", "refs/heads/main"], ["a push to next", "push", "refs/heads/next"], ["a v* tag", "push", "refs/tags/v1.2.3"],
      ["an android-v* tag", "push", "refs/tags/android-v1.2.3"], ["a dispatch on main", "workflow_dispatch", "refs/heads/main"],
      ["a dispatch on next", "workflow_dispatch", "refs/heads/next"], ["a merge group", "merge_group", "refs/heads/gh-readonly-queue/main/pr-7-abc"]] as const)
      .map(([label, event, ref]) => [label, { event, ref, ctx: at(event, ref) }, false] as [string, RunEvent, boolean]),
    ["the nightly", { event: "schedule", ref: "refs/heads/main", cron: "daily", ctx: at("schedule", "refs/heads/main") }, false],
  ];
  /** The jobs one event runs in a file, or "no run" when the file does not start for it. */
  const jobsOn = (t: string, ev: RunEvent): string[] | "no run" => {
    const wf = load(t);
    return startsOn(wf.on, ev) ? ran(runJobs(wf.jobs ?? {}, ev.ctx)) : "no run";
  };
  /** The rows whose jobs differ from the files as they were, a draft batch's push and a ready mark left out. */
  const changedRows = (texts: Record<string, string>) => Object.entries(texts).flatMap(([file, t]) => ROWS
    .filter(([, ev, draftBatch]) => !draftBatch && ev.action !== "ready_for_review")
    .filter(([, ev]) => JSON.stringify(jobsOn(t, ev)) !== JSON.stringify(jobsOn(BEFORE[file]!, ev)))
    .map(([label]) => `${file}: ${label}`));

  it("each file reads the draft flag on the batch's arm alone and starts on ready_for_review", () => {
    for (const [file, t] of Object.entries(TEXTS)) {
      expect(t.split(TERM).length - 1, `${file}: the batch's arm reads the draft flag`).toBe(1);
      expect(t.split("github.event.pull_request.draft").length - 1, `${file}: the flag is read nowhere else`).toBe(1);
      expect(t.split(TYPES).length - 1, `${file}: the pull request's types`).toBe(1);
      expect((load(t).on?.pull_request as { types?: string[] } | null)?.types, file).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
    }
  });

  it("every other event and kind of pull request runs exactly the jobs it ran before", () => {
    expect(ROWS.length, "the rows").toBe(KINDS.length * 7 + 8);
    expect(changedRows(TEXTS)).toEqual([]);
  });

  it("a batch that is a draft, opened, pushed or reopened, runs build.yml's engine pair alone: no platform, no APK, no self-host smoke", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      const draft = prEvent(action, true, BATCH), ready = prEvent(action, false, BATCH);
      expect([jobsOn(BUILD, draft), jobsOn(ANDROID, draft), jobsOn(SELFHOST, draft)], action).toEqual([ENGINE_PAIR, [], []]);
      expect([jobsOn(BUILD, ready), jobsOn(ANDROID, ready), jobsOn(SELFHOST, ready)], `${action}, ready`).toEqual([ALL_BUILD, ["apk", "changes"], ["boot-smoke", "changes"]]);
      expect([jobsOn(BEFORE["build.yml"]!, draft), jobsOn(BEFORE["android.yml"]!, draft), jobsOn(BEFORE["selfhost-smoke.yml"]!, draft)], `${action}, a draft, as it was`)
        .toEqual([ALL_BUILD, ["apk", "changes"], ["boot-smoke", "changes"]]);
    }
  });

  it("marking a pull request into main ready runs the jobs its ready push runs; none of the three started on it before", () => {
    for (const [kind, ctx] of KINDS) for (const [file, t] of Object.entries(TEXTS)) {
      const ready = prEvent("ready_for_review", false, ctx);
      expect(jobsOn(BEFORE[file]!, ready), `${file}: ${kind}, as it was`).toBe("no run");
      expect(jobsOn(t, ready), `${file}: ${kind}`).toEqual(jobsOn(t, prEvent("synchronize", false, ctx)));
    }
    expect(jobsOn(BUILD, prEvent("ready_for_review", false, BATCH)), "the batch marked ready").toEqual(ALL_BUILD);
    expect(jobsOn(BUILD, prEvent("ready_for_review", false, LANE())), "a maintainer's other pull request marked ready").toEqual(ENGINE_PAIR);
  });

  it("marking a maintainer batch ready on next starts only the two required engine jobs", () => {
    const nextBatch = { ...BATCH, "github.base_ref": "next" };
    const jobs = (action: string, context: IfContext) => {
      const event = prEvent(action, false, context);
      return [jobsOn(BUILD, event), jobsOn(ANDROID, event), jobsOn(SELFHOST, event)];
    };
    const full = [ALL_BUILD, ["apk", "changes"], ["boot-smoke", "changes"]];
    for (const role of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(jobs("ready_for_review", { ...nextBatch, "github.event.pull_request.author_association": role }), role).toEqual([ENGINE_PAIR, [], []]);
    }
    for (const action of ["opened", "synchronize", "reopened"]) expect(jobs(action, nextBatch), action).toEqual(full);
    for (const context of [
      { ...nextBatch, "github.base_ref": "main" },
      { ...nextBatch, "github.head_ref": "pr/release-0307-bump" },
      { ...nextBatch, "github.event.pull_request.head.repo.full_name": "someone/ohmail" },
      { ...nextBatch, "github.event.pull_request.author_association": "CONTRIBUTOR" },
      { ...nextBatch, "github.event.pull_request.user.type": "Bot" },
      { ...nextBatch, "github.actor": "builder[bot]" },
      { ...nextBatch, "github.triggering_actor": "builder[bot]" },
    ]) expect(jobs("ready_for_review", context)).toEqual(full);
  });

  it("each reading is watched failing", () => {
    const draft = prEvent("synchronize", true, BATCH);
    const planted = (from: string, to: string) => {
      const t = BUILD.replace(from, to);
      expect(t, `the planting changed nothing: ${from}`).not.toBe(BUILD);
      return t;
    };
    // The flag dropped from the batch's arm: a draft batch builds every platform again.
    expect(jobsOn(planted(TERM, OLD), draft)).toEqual(ALL_BUILD);
    // The string literal: GitHub reads `true != 'true'` as true, so a draft batch builds every platform.
    expect(jobsOn(planted(TERM, TERM.replace("!= true", "!= 'true'")), draft)).toEqual(ALL_BUILD);
    // ready_for_review dropped from the trigger: marking the batch ready starts nothing, and the way back is gone.
    expect(jobsOn(planted(TYPES, "\n"), prEvent("ready_for_review", false, BATCH))).toBe("no run");
    // The flag read on the release bump's arm too: a draft bump stops building, and the rows name each such push.
    const bump = "!(startsWith(github.head_ref, 'pr/release-') && endsWith(github.head_ref, '-bump'))";
    expect(changedRows({ "build.yml": planted(bump, bump.replace("'-bump'))", "'-bump') && github.event.pull_request.draft != true)")) }))
      .toEqual(["opened", "synchronize", "reopened"].map((a) => `build.yml: the release bump, ${a}, a draft`));
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
    ["the shared tsconfig", ["tools/tsconfig.base.json"], "true", "true"],
    ["the root test program", ["test/tsconfig.test-dirs.json"], "true", "true"],
    ["the engine's type program", ["tools/tsconfig.engine.json"], "true", "true"],
    ["this script", [".github/scripts/pr-build-scope.sh"], "true", "true"],
    ["the Play upload script", [".github/scripts/play-upload.mjs"], "false", "true"],
    ["the CI retry wrapper", [".github/scripts/retry-infra.sh"], "true", "true"],
    ["nothing", [], "false", "false"],
    ["a changelog fragment", ["changelog.d/x.md"], "false", "false"],
    ["the line-ending rules every checkout reads", [".gitattributes"], "true", "true"],
    ["the weekly fresh-clone workflow", [".github/workflows/contributor.yml"], "false", "false"],
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
    for (const [t, key, least] of [[BUILD, "desktop", 3], [ANDROID, "android", 3], [SELFHOST, "selfhost", 2]] as const) {
      const exec = t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      const named = [...new Set([...exec.matchAll(/(?:^|[\s"'])((?:\.github\/)?scripts\/[\w./-]+\.(?:sh|mjs|js))/gm)].map((m) => m[1]!))];
      expect(named.length, "the reader found no script").toBeGreaterThanOrEqual(least);
      for (const p of named) expect(scope([p])[key], p).toBe("true");
    }
  });

  it("a list it cannot read needs every build", () => {
    const r = spawnSync("bash", [SCRIPT, "--files", join(tmpdir(), "pr-scope-no-such-list")], { encoding: "utf8", env: ENV });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("desktop=true\nandroid=true\nselfhost=true\n");
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
    expect(r.stdout).toBe("desktop=false\nandroid=true\nselfhost=false\n");
    const bad = spawnSync("bash", [SCRIPT, "--base", "no-such-rev", "--head", "HEAD"], { cwd: dir, encoding: "utf8", env: ENV });
    expect(bad.stdout, "a diff it could not read").toBe("desktop=true\nandroid=true\nselfhost=true\n");
  });
});

describe("pr-build-scope.sh answers selfhost= for what the three self-host images build from", () => {
  /** The paths a recipe's context admits: each `!` line of its dockerignore, a directory as a file inside it. */
  const RECIPES = ["apps/server/Dockerfile", "apps/worker/Dockerfile.selfhost", "apps/webapp/Dockerfile"];
  const admitted = (ignore: string) => ignore.split("\n").map((l) => /^!(\S+)$/.exec(l.trim())?.[1]).filter((p): p is string => p !== undefined)
    .map((p) => p.replace(/\*/g, "x")).map((p) => (/\.[a-z]+$/.test(p.split("/").pop()!) ? p : `${p}/src/sample.ts`));
  const ignoreOf = (recipe: string) => readFileSync(publicPath(`${recipe}.dockerignore`), "utf8");

  it("every path a recipe's dockerignore admits reads selfhost=true", () => {
    for (const recipe of RECIPES) {
      const paths = admitted(ignoreOf(recipe));
      expect(paths.length, `${recipe}: the reader found no admitted path`).toBeGreaterThan(5);
      for (const p of paths) expect(scope([p]).selfhost, `${recipe}: ${p}`).toBe("true");
    }
  });

  it("is watched failing on a package a recipe admits and the scope does not", () => {
    const planted = admitted(`${ignoreOf("apps/server/Dockerfile")}\n!packages/x\n`);
    expect(planted.map((p) => scope([p]).selfhost)).toContain("false");
  });

  it.each([
    ["the boot smoke", ["deploy/selfhost/boot-smoke.mjs"], "true"],
    ["the operator compose", ["deploy/selfhost/docker-compose.yml"], "true"],
    ["the workflow", [".github/workflows/selfhost-smoke.yml"], "true"],
    ["its script", [".github/scripts/selfhost-smoke.sh"], "true"],
    ["this script", [".github/scripts/pr-build-scope.sh"], "true"],
    ["the lockfile", ["package-lock.json"], "true"],
    ["docs", ["docs/x.md", "README.md"], "false"],
    ["the desktop window", ["apps/desktop/src/App.tsx"], "false"],
    ["the phone app", ["apps/mobile/src/x.ts"], "false"],
    ["the engine host", ["apps/sidecar/src/main.ts"], "false"],
    ["the root suite", ["test/a.test.ts"], "false"],
    ["a package's tests", ["packages/core/test/c.test.ts", "apps/server/test/d.test.ts"], "false"],
    ["another workflow", [".github/workflows/ci.yml"], "false"],
  ])("%s", (_label, paths, selfhost) => {
    expect(scope(paths).selfhost).toBe(selfhost);
  });
});
