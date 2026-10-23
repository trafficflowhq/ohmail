import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";
import { evalIf, runJobs, type IfContext, type JobShape } from "./support/workflow-if.js";

/**
 * THE RELEASE BUILD RUNS AT THE VERSION TAG, AND NOTHING IN IT KEYS ON THE REF.
 *
 * A release's installers are taken from the build run at the `v<version>` tag: the kit's installer
 * fetch and the feeds' provenance check refuse any other run. So the workflow must start on that
 * tag, every job must run there (a job skipped on a tag is an installer the release cannot have),
 * and the commit the binaries name must be the run's own — on a tag push, the tagged commit.
 *
 * Whether a job runs is read as GitHub decides it (`runJobs`): an `if:` naming no status-check
 * function is `success()` over the whole needs chain, so the pull request's `changes`, skipped at
 * the tag, skips every job below it that does not say `!cancelled()`, however far down.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKFLOW = publicPath("github/workflows/build.yml");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Workflow = {
  on?: { push?: { branches?: string[]; tags?: string[] } };
  env?: Record<string, string>;
  jobs?: Record<string, JobShape>;
};
const wf = yaml.load(readFileSync(WORKFLOW, "utf8")) as Workflow;

/** The jobs a release ships from, read by the parser so the per-job case has something to read. */
const JOBS = ["macos", "macos-sign", "macos-signed-check", "windows", "linux", "linux-arm64", "linux-rpm-install", "linux-flatpak", "engine", "engine-ui-smoke"];
/** The tag push as the expressions see it: `changes` is skipped there, so its answer is empty. */
const atTag: IfContext = {
  "github.event_name": "push", "github.ref": "refs/tags/v1.2.3", "github.repository": "trafficflowhq/ohmail",
  "needs.changes.outputs.desktop": "",
};

describe("build.yml runs at the version tag", () => {
  it("a push of a v* tag starts it, beside a push to main", () => {
    expect(wf.on?.push?.branches).toEqual(["main"]);
    expect(wf.on?.push?.tags, "build.yml no longer runs on the release tag").toContain("v*");
  });

  /* A pull request's platform jobs ask `changes` (test/pr-build-scope.test.ts), which is skipped at the tag;
     every job is read here as the tag push starts it. */
  it("the parser reads the ten jobs, and every job but the pull request's `changes` runs at the tag", () => {
    const jobs = Object.keys(wf.jobs ?? {});
    expect(jobs.length).toBeGreaterThanOrEqual(JOBS.length);
    expect(jobs).toEqual(expect.arrayContaining(JOBS));
    const at = runJobs(wf.jobs ?? {}, atTag);
    expect(at.changes, "the pull request's own job").toBe("skipped");
    const skipped = Object.entries(at)
      .filter(([name, r]) => name !== "changes" && r !== "success")
      .map(([name]) => `${name}: if: ${String(wf.jobs![name]!.if)}`);
    expect(skipped, "a job skipped at the tag is an installer the release cannot have").toEqual([]);
    const planted = runJobs({ ...wf.jobs, macos: { ...wf.jobs!.macos, if: "${{ github.event_name == 'pull_request' }}" } }, atTag);
    expect(planted.macos, "the reader, watched failing on a job gated off the tag").toBe("skipped");
    expect([planted["macos-sign"], planted["macos-signed-check"]], "and on the jobs that wait for it").toEqual(["skipped", "skipped"]);
  });

  /* A job's own `if:` read alone says it runs; GitHub skips it, because `changes`, further up, was skipped. The shape
     the signing job first had: no `if:`, and a check job whose `if:` asks the ref alone. */
  it("the reader is watched failing on a job below a skipped one whose `if:` names no status function", () => {
    const jobs = wf.jobs!;
    const head = runJobs({
      ...jobs,
      "macos-sign": { ...jobs["macos-sign"], if: undefined },
      "macos-signed-check": { ...jobs["macos-signed-check"], if: "${{ startsWith(github.ref, 'refs/tags/v') }}" },
    }, atTag);
    expect(head.macos, "the build itself names !cancelled() and runs").toBe("success");
    expect([head["macos-sign"], head["macos-signed-check"]]).toEqual(["skipped", "skipped"]);
    expect(evalIf("${{ startsWith(github.ref, 'refs/tags/v') }}", atTag), "while the check job's own condition alone reads true").toBe(true);
    /* A result read with no status function beside it is still `success()` over the chain. */
    const bare = runJobs({ ...jobs, "macos-sign": { ...jobs["macos-sign"], if: "${{ needs.macos.result == 'success' }}" } }, atTag);
    expect(bare["macos-sign"]).toBe("skipped");
    expect(() => runJobs(jobs, { ...atTag, "needs.macos.result": "success" }), "a result handed in, not worked out").toThrow(/never takes it/);
  });

  it("every job names the run's own commit, which on a tag push is the tagged one", () => {
    expect(wf.env?.OHMAIL_BUILD_SHA).toBe("${{ github.sha }}");
  });
});
