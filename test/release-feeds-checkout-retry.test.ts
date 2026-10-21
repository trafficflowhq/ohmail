import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicPath, ROOT } from "./support/public-root.mjs";

/**
 * EVERY CHECKOUT IN THE FEEDS WORKFLOW IS BOUNDED, AND RUNS ONCE MORE, VISIBLY.
 *
 * At 0.27.4 the publish job's `git fetch` hung without a byte until the job's 20-minute timeout,
 * and its re-run queued behind pull requests: the feeds landed 45 minutes after the page.
 * `actions/checkout` retries a fetch that FAILS, never one that stalls. So each checkout here is an
 * attempt with a short step timeout and `continue-on-error`, a `::warning::` naming the retry, and
 * one retry with the same inputs that fails the job like any step. `outcome`, not `conclusion`:
 * under `continue-on-error` a failed step's conclusion reads success.
 *
 * No other step and no job may carry `continue-on-error`: a step without `if:` runs only when every
 * step before it succeeded, and the promotion relies on that. The rest of the workflow is held as it
 * was: the trigger, the concurrency group, and each job's graph, runner, timeout, scope, environment
 * and checkout inputs.
 */
const yaml = createRequire(join(ROOT, "package.json"))("js-yaml") as { load(text: string): unknown };
const TEXT = readFileSync(publicPath("github/workflows/release-feeds.yml"), "utf8");

type Step = {
  id?: string; name?: string; uses?: string; if?: string; run?: string;
  with?: Record<string, unknown>; "timeout-minutes"?: unknown; "continue-on-error"?: unknown;
};
type Job = {
  needs?: unknown; if?: unknown; "runs-on"?: unknown; "timeout-minutes"?: unknown; permissions?: unknown;
  environment?: unknown; "continue-on-error"?: unknown; steps?: Step[];
};
type Wf = { on: Record<string, unknown>; concurrency: unknown; jobs: Record<string, Job> };

const CHECKOUT = /^actions\/checkout@[0-9a-f]{40}$/;
const WARNING = "::warning title=Retried once%3A checkout::";
/** Minutes. A healthy checkout here takes 5 to 13 s (0.27.0 to 0.27.5). */
const BOUND = 3;
const bounded = (v: unknown) => typeof v === "number" && v > 0 && v <= BOUND;
const isCheckout = (s: Step) => CHECKOUT.test(String(s.uses ?? ""));

/** Each attempt the census read, as "job#index", and every way one is not bounded and retried. */
export function checkoutCensus(text: string): { attempts: string[]; findings: string[] } {
  const wf = yaml.load(text) as Wf;
  const attempts: string[] = [];
  const findings: string[] = [];
  for (const [job, j] of Object.entries(wf.jobs)) {
    const steps = j.steps ?? [];
    if (j["continue-on-error"] !== undefined) findings.push(`${job}: continue-on-error on the job`);
    // A repeated id is a workflow GitHub refuses to run at all.
    const ids = steps.flatMap((s) => (s.id === undefined ? [] : [s.id]));
    for (const id of new Set(ids.filter((id, k) => ids.indexOf(id) !== k))) findings.push(`${job}: the step id ${id} is used twice`);
    const paired = new Set<number>();
    steps.forEach((s, i) => {
      if (!isCheckout(s) || s.if !== undefined) return;
      const at = `${job}#${i}`;
      attempts.push(at);
      if (!s.id) { findings.push(`${at}: the attempt has no id`); return; }
      if (s["continue-on-error"] !== true) findings.push(`${at}: a failed attempt fails the job, nothing retries it`);
      if (!bounded(s["timeout-minutes"])) findings.push(`${at}: the attempt is not bounded at ${BOUND} minutes`);
      const cond = `steps.${s.id}.outcome != 'success'`;
      const warn = steps[i + 1];
      const retry = steps[i + 2];
      if (!warn || warn.if !== cond || !String(warn.run ?? "").includes(WARNING)) findings.push(`${at}: no warning names the retry`);
      if (!retry || retry.uses !== s.uses || retry.if !== cond) { findings.push(`${at}: no retry follows the attempt`); return; }
      paired.add(i + 2);
      if (retry["continue-on-error"] !== undefined) findings.push(`${at}: the retry can fail without failing the job`);
      if (!bounded(retry["timeout-minutes"])) findings.push(`${at}: the retry is not bounded at ${BOUND} minutes`);
      if (JSON.stringify(retry.with ?? null) !== JSON.stringify(s.with ?? null)) findings.push(`${at}: the retry checks out something else`);
    });
    steps.forEach((s, i) => {
      if (isCheckout(s) && s.if !== undefined && !paired.has(i)) findings.push(`${job}#${i}: a conditional checkout no attempt pairs with`);
      if (s["continue-on-error"] !== undefined && !(isCheckout(s) && s.if === undefined)) {
        findings.push(`${job}#${i}: continue-on-error outside a checkout attempt`);
      }
    });
  }
  return { attempts, findings };
}

/** What this change must leave as it was. A job's checkouts are the attempts' inputs (each retry's
 *  are held equal to its attempt's above), so one reading holds before and after the retries. */
export function shapeOf(text: string) {
  const wf = yaml.load(text) as Wf;
  const dispatch = (wf.on.workflow_dispatch ?? {}) as { inputs?: Record<string, unknown> };
  return {
    release: wf.on.release,
    triggers: Object.keys(wf.on),
    inputs: Object.keys(dispatch.inputs ?? {}),
    concurrency: wf.concurrency,
    jobs: Object.fromEntries(Object.entries(wf.jobs).map(([n, j]) => [n, {
      needs: j.needs, if: j.if, "runs-on": j["runs-on"], "timeout-minutes": j["timeout-minutes"],
      permissions: j.permissions, environment: j.environment,
      checkouts: (j.steps ?? []).filter((s) => isCheckout(s) && s.if === undefined).map((s) => s.with ?? null),
    }])),
  };
}

const TAG_TREE = { ref: "${{ github.event.release.tag_name || inputs.tag }}", "persist-credentials": false };
const TOOLS_TREE = {
  path: ".tools",
  ref: "${{ github.event_name == 'workflow_dispatch' && inputs.tools == 'main' && 'main' || github.ref }}",
  "persist-credentials": false,
};
const ON_A_TAG = "github.event_name == 'workflow_dispatch' || startsWith(github.event.release.tag_name, 'v')";

describe("every checkout in release-feeds.yml is bounded and retried once", () => {
  it("bounds and retries all three checkouts, and only their attempts carry continue-on-error", () => {
    const { attempts, findings } = checkoutCensus(TEXT);
    expect(attempts, "the census read another set of checkouts").toEqual(["prepare#0", "prepare#3", "publish#0"]);
    expect(findings).toEqual([]);
  });

  it("leaves the trigger, the concurrency group and every job as they were", () => {
    expect(shapeOf(TEXT)).toEqual({
      release: { types: ["published", "released"] },
      triggers: ["release", "workflow_dispatch"],
      inputs: ["tag", "promote", "verify_only", "tools"],
      concurrency: { group: "release-feeds-${{ github.event.release.tag_name || inputs.tag }}", "cancel-in-progress": false },
      jobs: {
        fence: { if: ON_A_TAG, "runs-on": "ubuntu-latest", "timeout-minutes": 5, permissions: { contents: "write" }, checkouts: [] },
        prepare: {
          needs: "fence", if: `(${ON_A_TAG}) && github.event.action != 'released'`, "runs-on": "macos-15", "timeout-minutes": 30,
          permissions: { contents: "read", actions: "read" }, checkouts: [TAG_TREE, TOOLS_TREE],
        },
        sign: {
          needs: "prepare", if: "inputs.verify_only != true", environment: "release", "runs-on": "macos-15", "timeout-minutes": 20,
          permissions: { contents: "read" }, checkouts: [],
        },
        publish: {
          needs: ["fence", "prepare", "sign"], if: "inputs.verify_only != true", "runs-on": "macos-15", "timeout-minutes": 20,
          permissions: { contents: "write" }, checkouts: [TAG_TREE],
        },
        refence: {
          needs: "fence", if: "github.event_name == 'release' && github.event.action == 'released'", "runs-on": "ubuntu-latest",
          "timeout-minutes": 10, permissions: { contents: "write" }, checkouts: [],
        },
      },
    });
  });

  it("prints the warning as one workflow command", () => {
    const wf = yaml.load(TEXT) as Wf;
    const warns = Object.values(wf.jobs).flatMap((j) => j.steps ?? []).filter((s) => String(s.run ?? "").includes(WARNING));
    expect(warns).toHaveLength(3);
    for (const s of warns) {
      const r = spawnSync("bash", ["-e", "-c", String(s.run)], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.startsWith(WARNING), r.stdout).toBe(true);
      expect(r.stdout.trimEnd().split("\n"), "the command spans lines").toHaveLength(1);
    }
  });

  it("each reader is watched refusing the shape it guards", () => {
    const first = (re: RegExp, to: string) => {
      const out = TEXT.replace(re, to);
      expect(out, `the mutation planted nothing: ${re}`).not.toBe(TEXT);
      return checkoutCensus(out).findings;
    };
    expect(first(/\n {8}continue-on-error: true\n/, "\n")).toContain("prepare#0: a failed attempt fails the job, nothing retries it");
    expect(first(/\n {8}timeout-minutes: 3\n {8}continue-on-error: true\n/, "\n        timeout-minutes: 20\n        continue-on-error: true\n"))
      .toContain("prepare#0: the attempt is not bounded at 3 minutes");
    expect(first(/steps\.tag-tree\.outcome != 'success'\n {8}timeout-minutes: 3\n/, "steps.tag-tree.conclusion != 'success'\n        timeout-minutes: 3\n"))
      .toContain("prepare#0: no retry follows the attempt");
    expect(first(/(if: steps\.tag-tree\.outcome != 'success'\n {8}timeout-minutes: 3\n)/, "$1        continue-on-error: true\n"))
      .toContain("prepare#0: the retry can fail without failing the job");
    expect(first(/(if: steps\.tag-tree\.outcome != 'success'\n {8}timeout-minutes: 3\n {8}with:\n {10}ref: )\$\{\{[^\n]*\}\}/, "$1main"))
      .toContain("prepare#0: the retry checks out something else");
    expect(first(/::warning title=Retried once%3A checkout::the tag checkout/, "the tag checkout")).toContain("prepare#0: no warning names the retry");
    // A plain checkout added to the signing job: unbounded, and unpaired.
    const added = TEXT.replace(/(\n {2}sign:\n(?:(?: {4}.*)?\n)*? {4}steps:\n)/, "$1      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n");
    expect(added).not.toBe(TEXT);
    expect(checkoutCensus(added).attempts).toContain("sign#0");
    expect(checkoutCensus(added).findings).toContain("sign#0: the attempt has no id");
    // A step elsewhere, or a whole job, that keeps going when it fails.
    expect(first(/(\n {6}- name: Write, verify and attach the feeds\n {8}id: feeds\n)/, "$1        continue-on-error: true\n"))
      .toContain("publish#6: continue-on-error outside a checkout attempt");
    expect(first(/(\n {2}publish:\n {4}name: [^\n]*\n)/, "$1    continue-on-error: true\n")).toContain("publish: continue-on-error on the job");
    // Both prepare attempts under one id.
    const one = TEXT.replace("id: tools-tree", "id: tag-tree").replaceAll("steps.tools-tree.outcome", "steps.tag-tree.outcome");
    expect(one).not.toBe(TEXT);
    expect(checkoutCensus(one).findings).toEqual(["prepare: the step id tag-tree is used twice"]);
    // The shape: a trigger narrowed, a runner moved, a job's condition changed, a credential kept.
    expect(shapeOf(TEXT.replace("types: [published, released]", "types: [published]")).release).toEqual({ types: ["published"] });
    const publish = (from: string) => shapeOf(from).jobs.publish;
    expect(publish(TEXT.replace(/(\n {2}publish:\n(?:(?: {4}.*)?\n)*? {4}runs-on: )macos-15/, "$1self-hosted"))["runs-on"]).toBe("self-hosted");
    expect(publish(TEXT.replace(/(\n {2}publish:\n(?:(?: {4}.*)?\n)*? {4}if: )[^\n]*/, "$1always()")).if).toBe("always()");
    expect(publish(TEXT.replaceAll("persist-credentials: false", "persist-credentials: true")).checkouts)
      .toEqual([{ ...TAG_TREE, "persist-credentials": true }]);
  });
});
