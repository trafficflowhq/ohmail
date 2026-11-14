import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";
import { runJobs, startsOn, type IfContext, type JobResult, type JobShape, type RunEvent } from "./support/workflow-if.js";

/**
 * A DRAFT'S PUSH STARTS NO TEST JOB.
 *
 * A pull request opens as a draft and is pushed to while it is worked on; it is tested in full when it is marked
 * ready. So ci.yml's two root jobs, `plan` and `typecheck` (the one job that needs nothing), carry
 * `github.event.pull_request.draft != true`, and every other job needs `plan` and is skipped with it: a draft's run
 * concludes skipped and starts no machine. dco and guard still run on a draft. What must hold, read off the files as
 * GitHub starts jobs (`runJobs`):
 *
 *   · no job of ci.yml starts on a draft's push, and `ready_for_review` starts a run;
 *   · on every other event the jobs that run are the jobs that ran without the condition: a ready pull request's
 *     push, the run marking it ready, a batch's, a fork's, a dispatch and the nightly. The draft field is null on a
 *     dispatch and a schedule, so the condition is a comparison with the boolean, which reads null as "run";
 *   · the literal is the boolean: GitHub reads `true != 'true'` as true, so a guard against the string would start
 *     every draft, and so does this reader.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Workflow = { on?: unknown; jobs: Record<string, JobShape> };
const CI = readFileSync(publicPath("github/workflows/ci.yml"), "utf8");
const DCO = readFileSync(publicPath("github/workflows/dco.yml"), "utf8");
const GUARD = readFileSync(publicPath("github/workflows/guard.yml"), "utf8");
const load = (t: string) => yaml.load(t) as Workflow;
const GUARD_LINE = "    if: github.event.pull_request.draft != true\n";

/** A plan that hands every matrix a job, so nothing is skipped for want of work. */
const PLAN: IfContext = { "needs.plan.outputs.shards": '[{"shard":0}]', "needs.plan.outputs.alone": '["a.test.ts"]', "needs.plan.outputs.sqlite": '[{"shard":0}]' };

/** A maintainer's pull request from a pr/ branch, or a run with no pull request (draft null). */
function ctxOf(draft: boolean | null, extra: IfContext = {}): IfContext {
  const pr = draft !== null;
  return {
    ...PLAN, "github.event.pull_request.draft": draft, "github.head_ref": pr ? "pr/lane-x" : "",
    "github.event.pull_request.head.repo.full_name": pr ? "trafficflowhq/ohmail" : null, ...extra,
  };
}
const prEvent = (action: string, draft: boolean, extra: IfContext = {}): RunEvent =>
  ({ event: "pull_request", action, ref: "refs/pull/7/merge", ctx: ctxOf(draft, extra) });

/** The jobs one event runs, or "no run" when the workflow does not start for it. */
export function jobsOn(wf: Workflow, ev: RunEvent): Record<string, JobResult> | "no run" {
  return startsOn(wf.on, ev) ? runJobs(wf.jobs, ev.ctx) : "no run";
}

/** Every job that starts on a draft's push, and every condition the reader refuses (it guesses no job's fate). */
export function startsOnADraft(wf: Workflow): string[] {
  try {
    const ran = runJobs(wf.jobs, prEvent("synchronize", true).ctx);
    return Object.entries(ran).filter(([, r]) => r === "success").map(([id]) => `${id}: starts on a draft`);
  } catch (e) {
    return [(e as Error).message];
  }
}

/** Whether marking a pull request ready starts a run. */
export const readyStartsIt = (wf: Workflow): boolean => startsOn(wf.on, prEvent("ready_for_review", false));

const ROWS: Array<[string, RunEvent, "draft" | "ready" | "no run"]> = [
  ["a draft opened", prEvent("opened", true), "draft"],
  ["a draft's push", prEvent("synchronize", true), "draft"],
  ["a ready pull request's push", prEvent("synchronize", false), "ready"],
  ["a draft marked ready", prEvent("ready_for_review", false), "ready"],
  ["a batch's pull request", prEvent("synchronize", false, { "github.head_ref": "pr/batch-0307" }), "ready"],
  ["a fork's pull request", prEvent("opened", false, { "github.head_ref": "main", "github.event.pull_request.head.repo.full_name": "someone/ohmail" }), "ready"],
  ["a dispatch on next", { event: "workflow_dispatch", ref: "refs/heads/next", ctx: ctxOf(null) }, "ready"],
  ["the nightly", { event: "schedule", ref: "refs/heads/main", cron: "daily", ctx: ctxOf(null) }, "ready"],
  ["a push to next", { event: "push", ref: "refs/heads/next", ctx: ctxOf(null) }, "no run"],
  ["a push to main", { event: "push", ref: "refs/heads/main", ctx: ctxOf(null) }, "no run"],
];
const JOBS = ["plan", "suite", "alone", "sqlite", "proxy-e2e", "webapp-build", "typecheck", "desktop"];
const all = (r: JobResult) => Object.fromEntries(JOBS.map((j) => [j, r]));

describe("a draft's push starts no test job in ci.yml", () => {
  const ci = load(CI);

  it("no job starts on a draft, and marking it ready starts the run", () => {
    expect(Object.keys(ci.jobs)).toEqual(JOBS);
    expect(startsOnADraft(ci)).toEqual([]);
    expect(readyStartsIt(ci)).toBe(true);
  });

  it("each event runs these jobs: none on a draft, all eight otherwise, no run on a push", () => {
    for (const [what, ev, kind] of ROWS) {
      expect(jobsOn(ci, ev), what).toEqual(kind === "no run" ? "no run" : all(kind === "draft" ? "skipped" : "success"));
    }
  });

  it("every event but a draft's runs the jobs it ran without the condition", () => {
    const before = CI.replaceAll(GUARD_LINE, "");
    expect(CI.split(GUARD_LINE).length - 1, "the condition stands on plan and typecheck").toBe(2);
    expect(before).not.toBe(CI);
    for (const [what, ev, kind] of ROWS) {
      if (kind === "draft") expect(jobsOn(load(before), ev), what).toEqual(all("success"));
      else expect(jobsOn(ci, ev), what).toEqual(jobsOn(load(before), ev));
    }
  });

  it("dco and guard still run on a draft's push", () => {
    const target = (action: string): RunEvent => ({ event: "pull_request_target", action, ref: "refs/heads/next", ctx: ctxOf(true) });
    for (const [file, text, job] of [["dco.yml", DCO, "sign-off"], ["guard.yml", GUARD, "guard"]] as const) {
      const wf = load(text);
      for (const action of ["opened", "synchronize"]) {
        expect(startsOn(wf.on, target(action)), `${file} on ${action}`).toBe(true);
        expect(runJobs(wf.jobs, target(action).ctx), file).toEqual({ [job]: "success" });
      }
    }
  });

  it("each reading is watched failing", () => {
    const planted = (from: string | RegExp, to: string) => {
      const text = CI.replace(from, to);
      expect(text, `the planting changed nothing: ${String(from)}`).not.toBe(CI);
      return load(text);
    };
    // The one job that needs nothing, unguarded: it alone starts.
    expect(startsOnADraft(planted(`    name: typecheck\n${GUARD_LINE}`, "    name: typecheck\n"))).toEqual(["typecheck: starts on a draft"]);
    // The plan unguarded: everything below it starts.
    expect(startsOnADraft(planted(new RegExp(`(    name: suite · plan\\n(?: *#.*\\n)*)${GUARD_LINE}`), "$1")))
      .toEqual(JOBS.filter((j) => j !== "typecheck").map((j) => `${j}: starts on a draft`));
    // A status function lets a job past a skipped plan.
    expect(startsOnADraft(planted("    name: suite · desktop\n", "    name: suite · desktop\n    if: \"!cancelled()\"\n"))).toEqual(["desktop: starts on a draft"]);
    // always() is a condition this reader does not decide: it refuses, by name, rather than guess.
    expect(startsOnADraft(planted("    name: suite · desktop\n", "    name: suite · desktop\n    if: always()\n"))).toEqual([expect.stringMatching(/^desktop: .*always/)]);
    // ready_for_review dropped from the trigger: marking a draft ready would start nothing.
    expect(readyStartsIt(planted("types: [opened, synchronize, reopened, ready_for_review]", "types: [opened, synchronize, reopened]"))).toBe(false);
    // The string literal: GitHub reads `true != 'true'` as true, so every draft would run.
    const quoted = CI.replaceAll(GUARD_LINE, "    if: github.event.pull_request.draft != 'true'\n");
    expect(quoted).not.toBe(CI);
    expect(startsOnADraft(load(quoted))).toEqual(JOBS.map((j) => `${j}: starts on a draft`));
  });
});
