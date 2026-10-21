import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * ONE VISIBLE RETRY, ON A NAMED INFRASTRUCTURE CLASS, AND NOTHING ELSE.
 *
 * `.github/scripts/retry-infra.sh CLASS -- COMMAND...` runs a non-test CI step and runs it once more
 * only when it failed AND its output carries the class's signature: a registry reset for npm, a build
 * script the kernel would not execute for cargo, a busy disk for hdiutil. Every other failure keeps its
 * status and runs once. A retry prints a `::warning::` and leaves a marker in $GITHUB_ENV, so the job
 * reads green but says so, and a timing read after it is never widened.
 *
 * Each case drives the real script against a fixture named npm, cargo or hdiutil (called by absolute
 * path) that plays one scripted answer per attempt and logs every call.
 */
const SCRIPT = publicPath("github/scripts/retry-infra.sh");

type Attempt = { out: string; code: number };
type Ran = { status: number | null; stdout: string; calls: string[]; envFile: string };

function fixture(name: string, attempts: Attempt[]): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "retry-infra-"));
  attempts.forEach((a, i) => {
    writeFileSync(join(dir, `out${i + 1}`), a.out);
    writeFileSync(join(dir, `code${i + 1}`), String(a.code));
  });
  const bin = join(dir, name);
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'd="$(cd "$(dirname "$0")" && pwd)"',
      // A clean is logged and answers 0; it is not an attempt.
      'if [ "${1:-}" = clean ]; then printf "clean %s\\n" "$*" >> "$d/calls"; exit 0; fi',
      'n=$(( $(cat "$d/count" 2> /dev/null || echo 0) + 1 )); echo "$n" > "$d/count"',
      'printf "run%s %s\\n" "$n" "$*" >> "$d/calls"',
      `k=$n; [ -f "$d/out$k" ] || k=${attempts.length}`,
      'cat "$d/out$k"',
      'exit "$(cat "$d/code$k")"',
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

function run(cls: string, name: string, attempts: Attempt[], args: string[] = ["ci", "--ignore-scripts"]): Ran {
  const { dir, bin } = fixture(name, attempts);
  const envFile = join(dir, "github-env");
  writeFileSync(envFile, "");
  const r = spawnSync("bash", [SCRIPT, cls, "--", bin, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMPDIR: dir, GITHUB_ENV: envFile },
    timeout: 60_000,
  });
  const callsFile = join(dir, "calls");
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, stdout: r.stdout, calls, envFile: readFileSync(envFile, "utf8") };
}

const warnings = (out: string) => out.split("\n").filter((l) => l.startsWith("::warning"));
const runs = (r: Ran) => r.calls.filter((c) => c.startsWith("run")).length;

const NPM_RESET = "npm error code ECONNRESET\nnpm error syscall read\nnpm error errno -104\n";
const CARGO_126 = [
  "   Compiling libc v0.2.189",
  "error: failed to run custom build command for `libc v0.2.189`",
  "",
  "Caused by:",
  "  process didn't exit successfully: `/Users/runner/work/ohmail/ohmail/apps/desktop/src-tauri/target/debug/build/libc-200f8ab756b3f7bc/build-script-build` (exit status: 126)",
  "  --- stderr",
  "  /Users/runner/work/ohmail/ohmail/apps/desktop/src-tauri/target/debug/build/libc-200f8ab756b3f7bc/build-script-build: cannot execute binary file",
  "warning: build failed, waiting for other jobs to finish...",
  "error: failed to run custom build command for `proc-macro2 v1.0.107`",
  "",
  "Caused by:",
  "  process didn't exit successfully: `/Users/runner/work/ohmail/ohmail/apps/desktop/src-tauri/target/debug/build/proc-macro2-706ace4b2384c385/build-script-build` (exit status: 126)",
  "error: failed to run custom build command for `quote v1.0.47`",
  "",
  "Caused by:",
  "  process didn't exit successfully: `/Users/runner/work/ohmail/ohmail/apps/desktop/src-tauri/target/debug/build/quote-93fb0e6a010b2f89/build-script-build` (exit status: 126)",
  "",
].join("\n");
const HDIUTIL_BUSY = 'hdiutil: couldn\'t eject "disk5" - Resource busy\n';

describe("retry-infra.sh: npm-network", () => {
  it("a registry reset (exit 152) runs once more, warns once and leaves the marker", () => {
    const r = run("npm-network", "npm", [{ out: NPM_RESET, code: 152 }, { out: "added 952 packages\n", code: 0 }]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["run1 ci --ignore-scripts", "run2 ci --ignore-scripts"]);
    expect(warnings(r.stdout)).toEqual([
      "::warning title=Retried once%3A npm-network::npm error code ECONNRESET (exit 152); running it once more",
    ]);
    expect(r.envFile).toMatch(/^OHMAIL_RETRIED_AT=\d+\n$/);
  });

  it("the old spelling with a CR line end is the same class", () => {
    const r = run("npm-network", "npm", [{ out: "npm ERR! code ETIMEDOUT\r\n", code: 1 }, { out: "", code: 0 }]);
    expect(r.status).toBe(0);
    expect(runs(r)).toBe(2);
    expect(warnings(r.stdout)).toHaveLength(1);
  });

  it.each([
    ["EINTEGRITY", "npm error code EINTEGRITY\n", 1],
    ["EUSAGE", "npm error code EUSAGE\n", 1],
    ["E404", "npm error code E404\n", 1],
    ["ENOSPC", "npm error code ENOSPC\n", 228],
  ])("%s runs once and keeps its status", (_code, out, status) => {
    const r = run("npm-network", "npm", [{ out, code: status }, { out: "", code: 0 }]);
    expect(r.status).toBe(status);
    expect(runs(r)).toBe(1);
    expect(warnings(r.stdout)).toEqual([]);
    expect(r.envFile).toBe("");
  });

  it("a plain failure keeps its own status, not the pipe's", () => {
    const r = run("npm-network", "npm", [{ out: "something else\n", code: 3 }]);
    expect(r.status).toBe(3);
    expect(runs(r)).toBe(1);
  });

  it("a reset twice ends on the second status after exactly two runs", () => {
    const r = run("npm-network", "npm", [{ out: NPM_RESET, code: 152 }, { out: NPM_RESET, code: 151 }, { out: "", code: 0 }]);
    expect(r.status).toBe(151);
    expect(runs(r)).toBe(2);
    expect(warnings(r.stdout)).toHaveLength(1);
  });

  it("a success runs once and says nothing", () => {
    const r = run("npm-network", "npm", [{ out: "added 1 package\n", code: 0 }]);
    expect(r.status).toBe(0);
    expect(runs(r)).toBe(1);
    expect(r.stdout).toBe("added 1 package\n");
    expect(r.envFile).toBe("");
  });
});

describe("retry-infra.sh: cargo-exec-126 and hdiutil-busy", () => {
  it("build scripts that would not execute are cleaned, then the build runs once more", () => {
    const args = ["test", "--locked", "--no-run"];
    const r = run("cargo-exec-126", "cargo", [{ out: CARGO_126, code: 101 }, { out: "", code: 0 }], args);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      "run1 test --locked --no-run",
      "clean clean --locked -p libc@0.2.189 -p proc-macro2@1.0.107 -p quote@1.0.47",
      "run2 test --locked --no-run",
    ]);
    expect(warnings(r.stdout)).toHaveLength(1);
    expect(warnings(r.stdout)[0]).toMatch(/^::warning title=Retried once%3A cargo-exec-126::.*\(exit status: 126\) \(exit 101\); running it once more$/);
  });

  it("an ordinary compile error is not retried and nothing is cleaned", () => {
    const out = "error[E0425]: cannot find value `x` in this scope\nerror: could not compile `ohmail`\n";
    const r = run("cargo-exec-126", "cargo", [{ out, code: 101 }, { out: "", code: 0 }], ["test", "--locked", "--no-run"]);
    expect(r.status).toBe(101);
    expect(r.calls).toEqual(["run1 test --locked --no-run"]);
    expect(warnings(r.stdout)).toEqual([]);
  });

  it("a busy disk image is retried; another hdiutil error is not", () => {
    const busy = run("hdiutil-busy", "hdiutil", [{ out: HDIUTIL_BUSY, code: 16 }, { out: "", code: 0 }], ["detach", "/tmp/x"]);
    expect(busy.status).toBe(0);
    expect(runs(busy)).toBe(2);
    expect(warnings(busy.stdout)).toEqual([
      '::warning title=Retried once%3A hdiutil-busy::hdiutil: couldn\'t eject "disk5" - Resource busy (exit 16); running it once more',
    ]);
    const other = run("hdiutil-busy", "hdiutil", [{ out: "hdiutil: detach failed - No such file or directory\n", code: 1 }], ["detach", "/tmp/x"]);
    expect(other.status).toBe(1);
    expect(runs(other)).toBe(1);
    expect(warnings(other.stdout)).toEqual([]);
  });

  it("a % in the matched line is escaped in the warning", () => {
    const r = run("hdiutil-busy", "hdiutil", [{ out: "hdiutil: 100% done - Resource busy\n", code: 16 }, { out: "", code: 0 }], ["detach", "x"]);
    expect(warnings(r.stdout)).toEqual(["::warning title=Retried once%3A hdiutil-busy::hdiutil: 100%25 done - Resource busy (exit 16); running it once more"]);
  });
});

describe("retry-infra.sh: usage", () => {
  it.each([
    ["an unknown class", (bin: string) => ["npm-anything", "--", bin, "ci"]],
    ["no --", (bin: string) => ["npm-network", bin, "ci"]],
    ["no command", () => ["npm-network", "--"]],
  ])("%s exits 2 and runs nothing", (_label, args) => {
    const { dir, bin } = fixture("npm", [{ out: "", code: 0 }]);
    const r = spawnSync("bash", [SCRIPT, ...args(bin)], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: dir } });
    expect(r.status).toBe(2);
    expect(existsSync(join(dir, "calls")), "the fixture ran").toBe(false);
  });
});
