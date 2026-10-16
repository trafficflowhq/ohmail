import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE IMAGE WORKFLOW'S TOKEN CAN PUSH ONLY IN THE JOBS THAT PUSH.
 *
 * ghcr-images.yml once granted packages: write workflow-wide, so a job that only reads a version
 * or boots the stack held a token that could overwrite every published image. The default is now
 * read-only and each job states its own grant: the census below, and, read off the steps, write
 * exactly where a step pushes. A checkout in a job that can push keeps no credential on disk.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = publicRel("github/workflows/ghcr-images.yml");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Perms = string | Record<string, string> | undefined;
type Step = { uses?: unknown; run?: unknown; with?: Record<string, unknown> };
type Workflow = { permissions?: Perms; jobs?: Record<string, { permissions?: Perms; steps?: Step[] }> };

/** Each job's effective grant: its own block, else the workflow's (a job block replaces it whole). */
const CENSUS: Record<string, Record<string, string>> = {
  version: { contents: "read" },
  "mirror-images": { contents: "read", packages: "write" },
  "build-push": { contents: "read", packages: "write" },
  "gate-boot": { packages: "read" },
  "gate-visibility": { contents: "read" },
  "promote-candidate": { packages: "write" },
  promote: { packages: "write" },
};

const effective = (wf: Workflow, job: string): Perms => wf.jobs?.[job]?.permissions ?? wf.permissions;

/** Whether a job's steps write to a registry: a pushing build, a manifest written, a crane copy or push. */
function pushes(steps: Step[]): boolean {
  return steps.some((s) => (String(s.uses ?? "").startsWith("docker/build-push-action@") && String(s.with?.push) === "true")
    || (typeof s.run === "string" && /\bimagetools\s+create\b|\bcrane\s+(?:copy|cp|push|append|mutate|tag)\b|\bdocker\s+push\b|\bmirror-images\.sh\b|\bbuildx\s+build\b[^\n]*--push\b/
      .test(s.run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"))));
}

/** What refuses: a write-all or packages: write at the workflow level, a grant off the census, write where nothing pushes, a kept credential. */
function findings(wf: Workflow): string[] {
  const out: string[] = [];
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: "read" })) out.push(`the workflow default is ${JSON.stringify(wf.permissions)}, not contents: read`);
  const jobs = Object.keys(wf.jobs ?? {}).sort();
  if (JSON.stringify(jobs) !== JSON.stringify(Object.keys(CENSUS).sort())) out.push(`the jobs are ${jobs.join(", ")}, the census names ${Object.keys(CENSUS).sort().join(", ")}`);
  for (const id of jobs) {
    const got = effective(wf, id);
    if (JSON.stringify(got) !== JSON.stringify(CENSUS[id])) out.push(`${id}: ${JSON.stringify(got)}, the census says ${JSON.stringify(CENSUS[id])}`);
    const writes = typeof got === "string" ? /write/.test(got) : got?.packages === "write";
    const steps = wf.jobs?.[id]?.steps ?? [];
    if (writes !== pushes(steps)) out.push(`${id}: packages ${writes ? "write" : "not write"}, while its steps ${pushes(steps) ? "push" : "push nothing"}`);
    for (const s of steps) {
      if (writes && String(s.uses ?? "").startsWith("actions/checkout@") && s.with?.["persist-credentials"] !== false) out.push(`${id}: a checkout keeps the token on disk`);
    }
  }
  return out;
}

describe("ghcr-images.yml grants packages: write only to the jobs that push", () => {
  const text = readFileSync(`${ROOT}${FILE}`, "utf8");

  it("the default is read-only, each job's grant is the census's, and write is exactly where a step pushes", () => {
    const wf = yaml.load(text) as Workflow;
    expect(Object.keys(wf.jobs ?? {}).filter((j) => pushes(wf.jobs?.[j]?.steps ?? [])).sort(), "the jobs that push")
      .toEqual(["build-push", "mirror-images", "promote", "promote-candidate"]);
    expect(findings(wf)).toEqual([]);
  });

  it("refuses write at the workflow level, write on a job that only reads, write-all, a kept checkout credential and a push without write", () => {
    const planted: Array<[string, string, string]> = [
      ["write at the workflow level", "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  packages: write\n"],
      ["write on gate-visibility", "    timeout-minutes: 10\n    steps:\n", "    timeout-minutes: 10\n    permissions:\n      contents: read\n      packages: write\n    steps:\n"],
      ["write-all on promote", "    timeout-minutes: 15\n    permissions:\n      packages: write\n    steps:\n      # The same refusal", "    timeout-minutes: 15\n    permissions: write-all\n    steps:\n      # The same refusal"],
      ["a checkout that keeps its credential", "    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n        with:\n          persist-credentials: false\n\n      # crane runs", "    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n\n      # crane runs"],
      ["a push from gate-boot, which only reads", "          docker compose up -d\n", "          docker compose up -d\n          docker push ghcr.io/trafficflowhq/ohmail-server:x\n"],
    ];
    for (const [what, from, to] of planted) {
      expect(text.includes(from), `${what}: the plant's anchor is not in the workflow`).toBe(true);
      expect(findings(yaml.load(text.replace(from, to)) as Workflow), what).not.toEqual([]);
    }
  });
});
