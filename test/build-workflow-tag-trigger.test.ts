import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";
import { evalIf } from "./support/workflow-if.js";

/**
 * THE RELEASE BUILD RUNS AT THE VERSION TAG, AND NOTHING IN IT KEYS ON THE REF.
 *
 * A release's installers are taken from the build run at the `v<version>` tag: the kit's installer
 * fetch and the feeds' provenance check refuse any other run. So the workflow must start on that
 * tag, every job must run there (a job skipped on a tag is an installer the release cannot have),
 * and the commit the binaries name must be the run's own — on a tag push, the tagged commit.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKFLOW = publicPath("github/workflows/build.yml");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Workflow = {
  on?: { push?: { branches?: string[]; tags?: string[] } };
  env?: Record<string, string>;
  jobs?: Record<string, { if?: unknown }>;
};
const wf = yaml.load(readFileSync(WORKFLOW, "utf8")) as Workflow;

/** The jobs a release ships from, read by the parser so the per-job case has something to read. */
const JOBS = ["macos", "windows", "linux", "linux-arm64", "linux-rpm-install", "linux-flatpak", "engine", "engine-ui-smoke"];

describe("build.yml runs at the version tag", () => {
  it("a push of a v* tag starts it, beside a push to main", () => {
    expect(wf.on?.push?.branches).toEqual(["main"]);
    expect(wf.on?.push?.tags, "build.yml no longer runs on the release tag").toContain("v*");
  });

  /* A pull request's platform jobs ask `changes` (test/pr-build-scope.test.ts), which is skipped at the tag;
     every other job's condition is evaluated here as the tag push reads it. */
  it("the parser reads the eight jobs, and every job but the pull request's `changes` runs at the tag", () => {
    const jobs = Object.keys(wf.jobs ?? {});
    expect(jobs.length).toBeGreaterThanOrEqual(JOBS.length);
    expect(jobs).toEqual(expect.arrayContaining(JOBS));
    const atTag = {
      "github.event_name": "push", "github.ref": "refs/tags/v1.2.3", "github.repository": "trafficflowhq/ohmail",
      "needs.changes.result": "skipped", "needs.changes.outputs.desktop": "", "needs.linux.result": "success",
    };
    const skipped = Object.entries(wf.jobs ?? {})
      .filter(([name, job]) => name !== "changes" && !evalIf(String(job.if ?? "true"), atTag))
      .map(([name, job]) => `${name}: if: ${String(job.if)}`);
    expect(skipped, "a job skipped at the tag is an installer the release cannot have").toEqual([]);
    const planted = { ...wf.jobs!.macos, if: "${{ github.event_name == 'pull_request' }}" };
    expect(evalIf(String(planted.if), atTag), "the reader, watched failing on a job gated off the tag").toBe(false);
  });

  it("every job names the run's own commit, which on a tag push is the tagged one", () => {
    expect(wf.env?.OHMAIL_BUILD_SHA).toBe("${{ github.sha }}");
  });
});
