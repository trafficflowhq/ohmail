import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * THE RELEASE SIGNS A NAMED SET OF ASSETS, AND REFUSES ANY OTHER.
 *
 * A feed says nothing about what its payload IS, so a signature over the wrong file verifies
 * perfectly: an arm64 install handed an x86_64 AppImage, or a Windows install handed an installer
 * its build refuses by name and then reporting itself up to date. The workflow therefore names
 * every asset instead of globbing, and counts the Linux artifacts so a third one cannot ride in
 * unsigned.
 *
 * Nothing here runs GitHub Actions, so the assertions are run as the SHELL THEY ARE — pulled out
 * of the workflow and executed against a planted assets directory, rather than a retyped copy
 * that could pass while the shipped bytes fail.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WF = publicPath("github/workflows/release-feeds.yml");
const wf = readFileSync(WF, "utf8").split("\n");

/* The named picks and the count check, lifted verbatim. Bounded by their own first and last
 * lines so an edit that moves them is a red here rather than a block that quietly shrinks. */
function assertionBlock(): string {
  const first = wf.findIndex((l) => l.includes("pick_one() {"));
  const last = wf.findIndex((l, i) => i > first && l.includes("Every Linux artifact needs a platform key"));
  expect(first, "the resolver is gone from release-feeds.yml").toBeGreaterThan(0);
  expect(last, "the AppImage count check is gone from release-feeds.yml").toBeGreaterThan(first);
  // Through the `fi` that closes the count check: two lines past the message, so a slice that
  // stopped short would leave an unbalanced `if` and fail loudly rather than pass narrowly.
  const body = wf.slice(first, last + 3).map((l) => l.replace(/^ {10}/, ""));
  expect(body[body.length - 1].trim()).toBe("fi");
  // It has to be the real thing: the resolver, the four names and the count, or the arms below
  // prove nothing.
  expect(body.join("\n")).toContain("ohmail-linux-aarch64.AppImage");
  expect(body.join("\n")).toContain("ohmail-windows-setup.exe");
  expect(body.join("\n")).toContain("APPIMAGE_COUNT");
  expect(body.join("\n")).toContain("return 1");
  return body.join("\n");
}

const BLOCK = assertionBlock();
/* The block quotes the tag and the version in its refusals, so the harness supplies both.
 *
 * `RPM_FROM`/`RPM_LINUX` are here for the same reason as the arm64 pair: the block reads them
 * under `set -u`, so a harness that omits them dies on an unbound variable BEFORE any assertion
 * runs — which reads as the guard refusing, from a run in which it never fired. The two floors
 * are the workflow's own (`release-feeds.yml`: ARM_FROM=0.13.3, RPM_FROM=0.16.0). */
const PREAMBLE = (version: string, armLinux: 0 | 1, wantAppImages: 1 | 2, rpmLinux: 0 | 1) =>
  `set -euo pipefail\nVERSION=${version}\nARM_FROM=0.13.3\nARM_LINUX=${armLinux}\n` +
  `RPM_FROM=0.16.0\nRPM_LINUX=${rpmLinux}\n` +
  `WANT_APPIMAGES=${wantAppImages}\nRELEASE_TAG=v${version}\n`;

const NAMED = [
  "ohmail-windows-setup.exe",
  "ohmail.app.tar.gz",
  "ohmail-linux-x86_64.AppImage",
  "ohmail-linux-aarch64.AppImage",
  /* The two RPMs are part of what a release at or above RPM_FROM produces, so the positive
     control has to carry them: without them the ordinary release is REFUSED, and a guard that
     refuses every release is worse than one that refuses none. */
  "ohmail-linux-x86_64.rpm",
  "ohmail-linux-aarch64.rpm",
];

/** Runs the block against a planted `assets/`, and answers with the shell's own exit code. */
function run(present: string[]): { code: number; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-asset-set-"));
  mkdirSync(join(dir, "assets"));
  for (const name of present) writeFileSync(join(dir, "assets", name), "payload bytes");
  const script = PREAMBLE("0.17.0", 1, 2, 1) + BLOCK + "\n";
  writeFileSync(join(dir, "check.sh"), script);
  try {
    execFileSync("bash", ["check.sh"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, err: "" };
  } catch (e) {
    const x = e as { status?: number; stderr?: string };
    return { code: x.status ?? -1, err: x.stderr ?? "" };
  }
}

describe("the release's asset set", () => {
  it("admits the release the build workflow actually produces", () => {
    // The positive control: a guard whose every case is a refusal has no evidence it admits the
    // ordinary release, and one that refuses every release is worse than one that refuses none.
    expect(run(NAMED).code).toBe(0);
  });

  it("refuses two assets matching one platform, naming both", () => {
    /* The pick may never be "whatever matched first": a feed says nothing about what its payload
       is, so a second file matching a platform's pattern has to stop the release rather than be
       chosen between. The Windows arm is the one that only this refusal covers — the AppImage
       count below would catch a second Linux artifact anyway. */
    const { code, err } = run([...NAMED, "ohmail-windows-setup-legacy.exe"]);
    expect(code).not.toBe(0);
    expect(err).toContain("2 assets match *setup*.exe");
    expect(err).toContain("ohmail-windows-setup.exe");
    expect(err).toContain("ohmail-windows-setup-legacy.exe");
  });

  it("refuses one match under a name installs would not accept", () => {
    // The client refuses any asset name but its own build's (`updater.rs::EXPECTED_ASSET`), so a
    // renamed installer is a feed every Windows install silently rejects while reporting itself
    // up to date. Resolving by pattern is what makes this state reachable; this is its refusal.
    const { code, err } = run([...NAMED.filter((n) => n !== "ohmail-windows-setup.exe"),
      "ohmail-win-setup.exe"]);
    expect(code).not.toBe(0);
    expect(err).toContain("refuse any name but ohmail-windows-setup.exe");
  });

  it("refuses an unsigned Linux artifact nobody named", () => {
    const { code, err } = run([...NAMED, "ohmail-linux-riscv64.AppImage"]);
    expect(code).not.toBe(0);
    expect(err).toContain("expected exactly 2 AppImage asset(s)");
  });

  it("refuses a release missing an asset the feed would point at", () => {
    for (const missing of NAMED) {
      const { code, err } = run(NAMED.filter((n) => n !== missing));
      expect(code, `${missing} absent and the release went on`).not.toBe(0);
      expect(err).toContain(missing);
    }
  });

  it("refuses an arm64 AppImage on a release below the floor", () => {
    // Asserted in both directions on purpose: an old release quietly growing a platform key
    // nothing was ever built for is as wrong as a new one missing the key it needs.
    const dir = mkdtempSync(join(tmpdir(), "ohmail-asset-set-"));
    mkdirSync(join(dir, "assets"));
    for (const name of NAMED) writeFileSync(join(dir, "assets", name), "payload bytes");
    writeFileSync(join(dir, "check.sh"),
      /* 0.13.2 is below BOTH floors, so neither the arm64 AppImage nor an RPM was ever
         built for it; the arm64 refusal is the earlier of the two and the one asserted. */
      PREAMBLE("0.13.2", 0, 1, 0) + BLOCK + "\n");
    let code = 0;
    let err = "";
    try {
      execFileSync("bash", ["check.sh"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const x = e as { status?: number; stderr?: string };
      code = x.status ?? -1;
      err = x.stderr ?? "";
    }
    expect(code).not.toBe(0);
    expect(err).toContain("carries an arm64 AppImage");
  });
});
