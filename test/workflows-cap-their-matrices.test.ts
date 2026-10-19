import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * A MATRIX THAT RUNS ON EVERY PULL REQUEST HOLDS A BOUNDED SHARE OF THE HOSTED RUNNERS.
 *
 * The hosted runners are one pool for the whole organisation, and a single pull request's suite used to
 * take all of it: every shard of every matrix started at once. So each matrix in a workflow that runs on
 * a pull request, a merge group or a push to main says how many of its jobs run at a time
 * (`max-parallel`), and ci.yml's bounds are pinned: three suite shards, one file that runs alone, one
 * SQLite shard. A workflow that runs only on a tag or by hand (ghcr-images.yml) is the release's, and
 * keeps its matrices whole.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Workflow = { on?: Record<string, unknown> | null; jobs?: Record<string, { strategy?: { matrix?: unknown; "max-parallel"?: unknown } }> };
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

/** The matrices that start every job at once in a workflow that runs on every change. */
export function unbounded(file: string, t: string): string[] {
  if (!runsOnEveryChange((yaml.load(t) as Workflow).on)) return [];
  return matricesOf(t).filter((m) => !(Number.isInteger(m.bound) && (m.bound as number) > 0))
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

  it("ci.yml runs three suite shards, one alone file and one SQLite shard at a time", () => {
    expect(matricesOf(ci)).toEqual([{ job: "suite", bound: 3 }, { job: "alone", bound: 1 }, { job: "sqlite", bound: 1 }]);
  });

  it("each reading is watched failing", () => {
    const dropped = ci.replace(/\n {6}max-parallel: 1\n/, "\n");
    expect(dropped).not.toBe(ci);
    expect(unbounded("ci.yml", dropped)).toEqual(["ci.yml: alone starts its whole matrix at once"]);
    expect(unbounded("ci.yml", ci.replace(/max-parallel: 3\n/, "max-parallel: 0\n"))).toEqual(["ci.yml: suite starts its whole matrix at once"]);
    /* ghcr-images.yml on a pull request is held to the same bound. */
    const onPr = images.replace("\non:\n  push:\n", "\non:\n  pull_request:\n  push:\n");
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
