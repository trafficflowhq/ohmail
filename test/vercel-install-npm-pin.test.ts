import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT, presentRoots } from "./support/public-root.mjs";

/**
 * THE CLOUD BUILD INSTALLS WITH THE npm THAT WROTE THE LOCKFILE.
 *
 * The Vercel projects run Node 24.x, whose npm 11 leaves out two optional lock entries npm 10.9.8 installs,
 * and 0.26.0's API build failed on that. The root's `engines.npm` names the lock's npm, and every Vercel
 * install runs exactly that npm, pinned, whatever Node the build gets. On CI the suite's own npm must be the
 * lock's major too, so a toolchain move to a new npm fails here, not at the release's Cloud step.
 */

const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as Record<string, unknown>;

/** The lock's npm, as the root states it: `^<major>.<minor>.<patch>`, the floor and its major. */
function lockNpm(): { range: string; floor: number[] } {
  const engines = readJson("package.json").engines as Record<string, string> | undefined;
  const range = engines?.npm ?? "";
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  expect(m, `package.json engines.npm is ${JSON.stringify(range)}, not a caret range ^<major>.<minor>.<patch>`).not.toBeNull();
  return { range, floor: m!.slice(1).map(Number) };
}

/** True when `v` is the floor's major and at or above it: what `^floor` admits. */
function caretAdmits(floor: number[], v: number[]): boolean {
  if (v[0] !== floor[0]) return false;
  for (let i = 1; i < 3; i++) {
    if (v[i]! > floor[i]!) return true;
    if (v[i]! < floor[i]!) return false;
  }
  return true;
}

/** The one install shape: from the app's directory to the root, the pinned npm's `ci`, then the applier. */
const PINNED_INSTALL = /^cd \.\.\/\.\. && npx --yes npm@(\d+)\.(\d+)\.(\d+) ci --ignore-scripts && node scripts\/apply-patches\.mjs apply$/;

/** Every Vercel app of this checkout whose vercel.json carries an install command. */
const VERCEL_APPS = presentRoots(["apps/api-vercel", "apps/webapp", "apps/admin"]).filter((app: string) => existsSync(join(ROOT, app, "vercel.json")));
const installOf = (app: string): unknown => readJson(`${app}/vercel.json`).installCommand;

describe("the Cloud build installs with the lock's npm", () => {
  it("the root names the lock's npm, and the lockfile's root entry says the same", () => {
    const { range } = lockNpm();
    const lock = readJson("package-lock.json") as { packages?: Record<string, { engines?: Record<string, string> }> };
    expect(lock.packages?.[""]?.engines?.npm).toBe(range);
  });

  it("the API and the web app are among the Vercel apps read here", () => {
    expect(VERCEL_APPS).toEqual(expect.arrayContaining(["apps/api-vercel", "apps/webapp"]));
  });

  it.each(VERCEL_APPS)("%s/vercel.json installs with an exact npm the lock's range admits", (app) => {
    const { range, floor } = lockNpm();
    const install = installOf(app);
    expect(typeof install, `${app}/vercel.json names no installCommand: the project's own install would run the build image's npm`).toBe("string");
    const m = PINNED_INSTALL.exec(install as string);
    expect(m, `${app}/vercel.json installs with ${JSON.stringify(install)}, not the pinned shape cd ../.. && npx --yes npm@<x.y.z> ci --ignore-scripts && node scripts/apply-patches.mjs apply`).not.toBeNull();
    const pinned = m!.slice(1).map(Number);
    expect(caretAdmits(floor, pinned), `${app} pins npm@${pinned.join(".")}, which the lock's ${range} does not admit`).toBe(true);
  });

  it("every Vercel app pins the same npm", () => {
    const pins = new Set(VERCEL_APPS.map((app) => PINNED_INSTALL.exec(String(installOf(app)))?.slice(1).join(".")));
    expect([...pins]).toHaveLength(1);
  });

  // CI only: a contributor may run the suite on another Node and npm, and the lockfile they read is CI's to check.
  it.skipIf(process.env.CI !== "true")("on CI, the npm running this suite is the lock's major", () => {
    const { range, floor } = lockNpm();
    const r = spawnSync("npm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
    expect(r.status, `npm --version failed: ${r.stderr}`).toBe(0);
    const v = r.stdout.trim();
    expect(Number(v.split(".")[0]), `this suite runs npm ${v}; the lockfile is written and read by ${range}`).toBe(floor[0]);
  });

  it("the arms refuse what they should", () => {
    const floor = [10, 9, 8];
    expect(caretAdmits(floor, [10, 9, 8])).toBe(true);
    expect(caretAdmits(floor, [10, 9, 9])).toBe(true);
    expect(caretAdmits(floor, [10, 10, 0])).toBe(true);
    expect(caretAdmits(floor, [10, 9, 7])).toBe(false);
    expect(caretAdmits(floor, [11, 19, 1])).toBe(false);
    expect(caretAdmits(floor, [9, 9, 9])).toBe(false);
    for (const unpinned of [
      "cd ../.. && npm ci --ignore-scripts && node scripts/apply-patches.mjs apply",
      "cd ../.. && npx --yes npm@latest ci --ignore-scripts && node scripts/apply-patches.mjs apply",
      "cd ../.. && npx --yes npm@10 ci --ignore-scripts && node scripts/apply-patches.mjs apply",
      "cd ../.. && npx --yes npm@10.9.8 ci --ignore-scripts && node scripts/apply-patches.mjs apply || true",
      "cd ../.. && npx --yes npm@10.9.8 install && node scripts/apply-patches.mjs apply",
    ]) expect(PINNED_INSTALL.test(unpinned), unpinned).toBe(false);
  });
});
