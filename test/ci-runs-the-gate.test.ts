import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * AN OPT-IN TEST NOBODY OPTS INTO IS NOT A TEST.
 *
 * `apps/webapp/test/proxy.e2e.test.ts` gates itself on `TF_PROXY_E2E === "1"`, and until
 * this repair `grep -rn TF_PROXY_E2E .github package.json scripts` returned NOTHING. Those
 * are the only tests in the repo that EXECUTE the middleware — a real `next build`, a real
 * `next start`, and the anonymous / valid / expired / enrollment / demo states driven over
 * a real socket, plus the `/mailbox` 308, the response headers and the canonical-host
 * redirect. They had never run in CI, not once.
 *
 * What ran instead is `session-gate.test.ts`, which asserts the middleware by REGEX over
 * its own source text. Those assertions are worth having — they pin decisions no
 * behavioural test can see, like `Vary` being deliberately absent — but a refactor that
 * preserved the strings while changing the behaviour would have shipped green.
 *
 * So the flag is asserted here, in the default suite. Deleting the CI job now costs a red
 * test rather than silence.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** The suite workflow, where this checkout keeps it (test/support/public-root.mjs). */
const WORKFLOW = publicRel("github/workflows/ci.yml");
const ci = readFileSync(`${HERE}../${WORKFLOW}`, "utf8");

/** One job's text, from its key to the next job key at the same indent. */
function jobText(job: string): string {
  const lines = ci.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z][\w-]*:$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("CI actually runs the gate", () => {
  it("sets TF_PROXY_E2E=1 in the proxy-e2e job and nowhere else", () => {
    expect(ci, "no job sets TF_PROXY_E2E — the middleware e2e file is skipping in CI")
      .toMatch(/TF_PROXY_E2E:\s*"?1"?/);
    expect(ci.match(/TF_PROXY_E2E:/g) ?? []).toHaveLength(1);
  });

  it("…and points it at the file that reads it", () => {
    expect(ci).toContain("apps/webapp/test/proxy.e2e.test.ts");
    // The flag and the run have to be in the same job, or the file skips anyway.
    const job = jobText("proxy-e2e");
    expect(job).toMatch(/TF_PROXY_E2E:\s*"?1"?/);
    expect(job).toContain("npx vitest run apps/webapp/test/proxy.e2e.test.ts");
  });

  it("the file still gates on exactly that variable", () => {
    // Derived rather than assumed: renaming the flag on one side only would put the tests
    // back to sleep, which is the failure mode this whole file exists for.
    const e2e = readFileSync(`${HERE}../apps/webapp/test/proxy.e2e.test.ts`, "utf8");
    expect(e2e).toMatch(/const ENABLED = process\.env\.TF_PROXY_E2E === "1"/);
    expect(e2e).toMatch(/describe\.skipIf\(!ENABLED\)/);
  });

  it("the gate job runs on every pull request, like the rest of CI", () => {
    // A job behind `workflow_dispatch` only would be the same silence with more ceremony.
    expect(ci).toMatch(/\non:\n {2}pull_request:\n/);
    expect(ci).toMatch(/\n {2}proxy-e2e:\n/);
  });
});
