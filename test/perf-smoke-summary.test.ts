import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * A STEP'S CONCLUSION IS NOT THE CHECKER'S VERDICT.
 *
 * `PERF_SMOKE_REQUIRED=0` turned a REFUSED verdict — rc 3, the large import not
 * finishing within its budget on the runner — into a green step with a summary block nobody opens, and a
 * whole candidate read as measured when nothing had been. Forgiving a refusal is a decision about
 * whether to FAIL; it is not a licence to report the refusal as a pass.
 *
 * The pin is 1 since 2026-09-24, so a refusal fails the step. What this holds is that a forgiven
 * refusal, should the pin ever go back, stays VISIBLE: the summary heading says so, the body says
 * the job is green and nothing was measured, and the log carries a workflow warning.
 */
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const WF = readFileSync(resolve(ROOT, publicRel("github/workflows/build.yml")), "utf8");

/** The perf-smoke step, from its env pin to the end of its exit-code table. */
const step = (() => {
  const a = WF.indexOf("PERF_SMOKE_REQUIRED:");
  expect(a, "the perf smoke step is not in the workflow any more").toBeGreaterThan(0);
  const b = WF.indexOf("\n  ", WF.indexOf("not a code this step admits", a));
  return WF.slice(a, b > a ? b : a + 8000);
})();

describe("a forgiven perf-smoke refusal is visible", () => {
  it("the summary heading names the verdict, one heading per exit code", () => {
    for (const [rc, word] of [["0", "MEASURED"], ["1", "OVER A BUDGET"], ["3", "REFUSED"]] as const) {
      expect(step, `rc ${rc} has no heading of its own`).toContain(word);
    }
    /* Three different headings, not one with a number substituted: the reading a person takes from
     * a summary is the heading, and one heading for three answers is how this was missed. */
    expect(step).toContain("NO MEASUREMENT WAS TAKEN");
  });

  it("a forgiven refusal says in the summary that the job is green and nothing was measured", () => {
    expect(step).toContain("This job is green and nothing was measured");
    expect(step).toContain("\"$PERF_SMOKE_REQUIRED\" != \"1\"");
  });

  it("and raises a workflow warning, which a green run still shows", () => {
    expect(step).toContain("::warning title=perf smoke REFUSED::");
  });

  it("a verdict over a budget is still always red, forgiveness or not", () => {
    expect(step).toMatch(/1\)\s*exit 1 ;;/);
  });

  it("the pin is 1, so a refusal fails the step like a RED", () => {
    /* Moved on 2026-09-24 with the key the engine needs on a runner: at "0" eleven days of runs
     * were green over an engine that never started. */
    expect(step).toMatch(/PERF_SMOKE_REQUIRED:\s*"1"/);
  });

  it("an exit code that is not a verdict still fails the job", () => {
    expect(step).toContain("which is not a code this step admits");
  });
});
