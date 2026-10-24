import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath, publicRel } from "./support/public-root.mjs";

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

/* The web build's own check: next build exits 0 over a missing export, and the web bundle ships it undefined. */
const CHECK = publicPath("github/scripts/webapp-build-check.mjs");
const check = () => import(pathToFileURL(CHECK).href) as Promise<{
  importErrors(log: string): string[];
  smokeFailure(event: { kind: string; url?: string; status?: number; type?: string; text?: string }): string | null;
}>;
const WARNED = [
  " ⚠ Compiled with warnings in 12.1s",
  "",
  "./app/shell/kept-piles.tsx",
  "Attempted import error: 'Activity' is not exported from 'react' (imported as 'Activity').",
  "",
  "Import trace for requested module:",
  "./app/shell/kept-piles.tsx",
  "",
  " ✓ Generating static pages (16/16)",
].join("\n");

describe("the webapp next build job refuses a missing export", () => {
  it("names the module and the import a build log warns about", async () => {
    const { importErrors } = await check();
    expect(importErrors(WARNED)).toEqual([
      "./app/shell/kept-piles.tsx: Attempted import error: 'Activity' is not exported from 'react' (imported as 'Activity').",
    ]);
    expect(importErrors(" ✓ Compiled successfully in 12.3s\n ✓ Generating static pages (16/16)")).toEqual([]);
  });

  it("reads webpack's own wording too", async () => {
    const { importErrors } = await check();
    const raw = "./lib/a.ts\nexport 'Activity' (imported as 'Activity') was not found in 'react' (possible exports: use)";
    expect(importErrors(raw)).toHaveLength(1);
    expect(importErrors("./lib/b.ts\n'x' is not exported from './y'")).toHaveLength(1);
  });

  it("fails the step over a warned log and passes a clean one", () => {
    const dir = mkdtempSync(join(tmpdir(), "next-build-log-"));
    writeFileSync(join(dir, "red.log"), WARNED);
    writeFileSync(join(dir, "green.log"), " ✓ Compiled successfully");
    const red = spawnSync(process.execPath, [CHECK, "imports", join(dir, "red.log")], { encoding: "utf8" });
    expect(red.status).toBe(1);
    expect(red.stdout + red.stderr).toContain("'Activity' is not exported from 'react'");
    expect(spawnSync(process.execPath, [CHECK, "imports", join(dir, "green.log")]).status).toBe(0);
  });

  it("the smoke fails on a server 5xx, an uncaught page error and a React error, and only those", async () => {
    const { smokeFailure } = await check();
    expect(smokeFailure({ kind: "response", url: "http://127.0.0.1:1/demo", status: 500 })).toMatch(/500/);
    expect(smokeFailure({ kind: "response", url: "http://127.0.0.1:1/favicon.ico", status: 404 })).toBeNull();
    expect(smokeFailure({ kind: "pageerror", text: "boom" })).toMatch(/boom/);
    expect(smokeFailure({ kind: "console", type: "error", text: "Error: Minified React error #130; visit https://react.dev/errors/130" })).toMatch(/#130/);
    expect(smokeFailure({ kind: "console", type: "error", text: "Failed to load resource" })).toBeNull();
    expect(smokeFailure({ kind: "console", type: "log", text: "Minified React error #130" })).toBeNull();
    expect(smokeFailure({ kind: "failcard", text: "reads" })).toMatch(/reads/);
  });
});
