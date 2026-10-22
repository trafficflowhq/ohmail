// @services: none — reads the workflow and the vitest configs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import base from "../vitest.config";
import sqlite from "../vitest.sqlite.config";
import { TEST_SERVICES } from "../packages/db/src/test-services.js";
import { publicPath } from "./support/public-root.mjs";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };

/**
 * CI NEVER GREENS BY SKIPPING A SERVICE IT STARTED. Without a service the suite skips what needs it,
 * which is right on a contributor's machine and wrong in CI: every vitest job requires each service it
 * starts (TF_REQUIRE_*), so an absent one fails instead, and the verify verbs refuse a gate title
 * (`ci-shards.test.ts`). Both configs probe the services first and run the gate.
 */

type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { services?: Record<string, unknown>; env?: Record<string, string>; steps?: Step[] };
const ci = yaml.load(readFileSync(publicPath("github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };

/** The services a job starts: its service containers, and the ones a step starts with `docker run`. */
function started(job: Job): { name: keyof typeof TEST_SERVICES; when?: string }[] {
  const out: { name: keyof typeof TEST_SERVICES; when?: string }[] = [];
  for (const k of Object.keys(job.services ?? {})) {
    if (k === "postgres") out.push({ name: "pg" });
    else if (k === "greenmail") out.push({ name: "greenmail" });
    else throw new Error(`a service container this census does not know: ${k}`);
  }
  for (const s of job.steps ?? []) {
    if (!/\bdocker run\b/.test(s.run ?? "")) continue;
    if (/--name rustfs\b/.test(s.run!)) out.push({ name: "rustfs", when: s.if });
    else if (/--name dovecot\b/.test(s.run!)) out.push({ name: "dovecot", when: s.if });
    else throw new Error(`a docker run this census does not know: ${s.name}`);
  }
  return out;
}

describe("the jobs that run the suite", () => {
  const vitestJobs = Object.entries(ci.jobs).filter(([, j]) => (j.steps ?? []).some((s) => /\bnpx vitest run\b/.test(s.run ?? "")));

  it("are found, and the shard job starts all four services", () => {
    expect(vitestJobs.map(([k]) => k)).toEqual(expect.arrayContaining(["suite", "alone", "sqlite", "desktop"]));
    expect(started(ci.jobs.suite!).map((s) => s.name).sort()).toEqual(["dovecot", "greenmail", "pg", "rustfs"]);
  });

  it("require every service they start, a conditional one under the same condition", () => {
    const problems: string[] = [];
    for (const [key, job] of vitestJobs) {
      const testSteps = (job.steps ?? []).filter((s) => /\bnpx vitest run\b/.test(s.run ?? ""));
      for (const svc of started(job)) {
        const v = TEST_SERVICES[svc.name].require;
        for (const step of testSteps) {
          const value = step.env?.[v] ?? job.env?.[v];
          if (svc.when === undefined) {
            if (value !== "1") problems.push(`${key}: starts ${svc.name} and its test step "${step.name}" does not set ${v}=1`);
          } else {
            const cond = svc.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
            if (value !== `\${{ ${cond} && '1' || '' }}`) problems.push(`${key}: starts ${svc.name} if ${cond}, and "${step.name}" does not require it under that condition`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("the vitest configs", () => {
  it("probe the services first and run the gate, the SQLite run included", () => {
    for (const [name, c] of [["vitest.config.ts", base], ["vitest.sqlite.config.ts", sqlite]] as const) {
      const t = c.test!;
      expect((t.globalSetup as string[])[0], name).toBe("./test/setup/services.global.ts");
      expect(t.runner, name).toBe("./test/setup/service-gate.runner.ts");
    }
  });
});
