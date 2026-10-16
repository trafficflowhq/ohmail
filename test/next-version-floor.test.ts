import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutComments } from "../scripts/lib/source-scan.mjs";
import { presentRoots } from "./support/public-root.mjs";

/**
 * THE FRAMEWORK IS THE AUTH GATE, so its declared floor is a security control: middleware is the only
 * thing between an anonymous visitor and the app route, and the admin cloak is middleware too. 15.5.24
 * is the first release that fixes GHSA-2xp9-vwfh-vxw4 (code execution in the image optimizer) and
 * GHSA-p293-qw3h-jr36 (code execution on a Windows-hosted server); it carries the 14.2.25 middleware
 * bypass fix as well. The lockfile arms keep one React major and every react-dom on its own react:
 * react-dom refuses a react of another version at load, and the desktop renders webapp modules.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

/** The first release carrying both critical fixes named above. */
const NEXT_FLOOR = [15, 5, 24] as const;

/** The Next apps this checkout holds (the operator console is not part of this repository). */
const APPS = presentRoots(["apps/webapp", "apps/admin", "apps/api-vercel"]);
/** The ones whose own manifest names next. Here apps/api-vercel names none and runs the workspace's
 * hoisted copy, which the LOCKED arm below reads; the web app must always be among them. */
const declaredNext = (app: string): string | undefined =>
  (JSON.parse(readFileSync(`${HERE}../${app}/package.json`, "utf8")) as { dependencies?: Record<string, string> }).dependencies?.next;
const DECLARING = APPS.filter((app) => declaredNext(app) !== undefined);

const parse = (v: string): number[] => v.replace(/^[^\d]*/, "").split(".").map(Number);

const atLeast = (got: number[], want: readonly number[]): boolean => {
  for (let i = 0; i < want.length; i++) {
    if ((got[i] ?? 0) > want[i]!) return true;
    if ((got[i] ?? 0) < want[i]!) return false;
  }
  return true;
};

/** The root lockfile's install tree: every `node_modules/...` path and what it resolves. */
type LockNode = { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type Lock = { packages: Record<string, LockNode> };
const rootLock = (): Lock => JSON.parse(read("../package-lock.json")) as Lock;

/** Every installed copy of `name`, nested ones included, as `path=version`. */
const installed = (lock: Lock, name: string): string[] => Object.entries(lock.packages)
  .filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
  .map(([k, v]) => `${k}=${v.version ?? ""}`);

/** The installed packages that depend on `name`, by path; the workspace's own manifests ("" and its links) included. */
const dependents = (lock: Lock, name: string): string[] => Object.entries(lock.packages)
  .filter(([, v]) => ["dependencies", "optionalDependencies", "peerDependencies"].some((f) => (v as Record<string, Record<string, string> | undefined>)[f]?.[name] !== undefined))
  .map(([k]) => k);

describe("the declared Next floor carries the critical fixes", () => {
  it("the web app is among the apps that declare next", () => {
    expect(DECLARING).toContain("apps/webapp");
  });

  it.each(DECLARING)("%s declares a floor at or above 15.5.24", (app) => {
    const declared = declaredNext(app);
    expect(declared, `${app} does not depend on next`).toBeDefined();
    expect(
      atLeast(parse(declared!), NEXT_FLOOR),
      `${app} declares "next": "${declared}" — that range resolves to versions carrying ` +
        `GHSA-2xp9-vwfh-vxw4 and GHSA-p293-qw3h-jr36`,
    ).toBe(true);
  });

  /** Every installed next below the floor, as `path=version`; empty when none is. */
  const lockedBelow = (lock: Lock): string[] =>
    installed(lock, "next").filter((e) => !atLeast(parse(e.slice(e.lastIndexOf("=") + 1)), NEXT_FLOOR));

  it("the LOCKED version — what actually deploys — is above it too", () => {
    // The floor is what a regeneration may pick; this is what every `npm ci` install,
    // the images' and Vercel's included, really resolves.
    const lock = rootLock();
    expect(installed(lock, "next").length, "no node_modules/next in package-lock.json").toBeGreaterThan(0);
    expect(lockedBelow(lock), "package-lock.json installs a next below the floor").toEqual([]);
    const planted: Lock = { packages: { ...lock.packages, "node_modules/x/node_modules/next": { version: "15.5.23" } } };
    expect(lockedBelow(planted), "the control: a nested copy below the floor").toEqual(["node_modules/x/node_modules/next=15.5.23"]);
  });

  it("the apps agree — one framework version across the deployment", () => {
    const declared = DECLARING.map(declaredNext);
    expect(new Set(declared).size, `the apps declare different Next ranges: ${declared.join(", ")}`).toBe(1);
  });
});

describe("one React across the workspace", () => {
  /** The copy of `name` that the package at `at` resolves: its own node_modules first, then each parent's. */
  const resolveFrom = (lock: Lock, at: string, name: string): string | undefined => {
    for (let dir = at; ; dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/node_modules/")))) {
      const hit = lock.packages[`${dir ? `${dir}/` : ""}node_modules/${name}`];
      if (hit) return hit.version;
      if (!dir) return undefined;
    }
  };
  /** Each react-dom whose react is another version, as `path: dom vs react`. */
  const mispaired = (lock: Lock): string[] => installed(lock, "react-dom").flatMap((e) => {
    const path = e.slice(0, e.lastIndexOf("="));
    const dom = e.slice(e.lastIndexOf("=") + 1);
    const react = resolveFrom(lock, path, "react");
    return react === dom ? [] : [`${path}: react-dom ${dom} vs react ${react ?? "none"}`];
  });

  it("package-lock.json holds one react major, and every react-dom resolves a react of its own version", () => {
    const lock = rootLock();
    const reacts = installed(lock, "react").map((e) => e.slice(e.lastIndexOf("=") + 1).split(".")[0]);
    expect(reacts.length, "no node_modules/react in package-lock.json").toBeGreaterThan(0);
    expect([...new Set(reacts)], "package-lock.json holds more than one react major").toEqual(["19"]);
    expect(installed(lock, "react-dom").length, "no node_modules/react-dom in package-lock.json").toBeGreaterThan(0);
    expect(mispaired(lock)).toEqual([]);
    const planted: Lock = { packages: { ...lock.packages, "node_modules/x/node_modules/react-dom": { version: "19.0.0" } } };
    expect(mispaired(planted), "the control: a nested react-dom on the hoisted react of another version").toHaveLength(1);
  });

  it("the desktop's npm lockfile resolves the same pair", () => {
    const lock = JSON.parse(read("../apps/desktop/package-lock.json")) as {
      packages: Record<string, { version?: string }>;
    };
    const react = lock.packages["node_modules/react"]?.version;
    expect(react, "apps/desktop/package-lock.json has no node_modules/react").toBeDefined();
    expect(react!.split(".")[0]).toBe("19");
    expect(lock.packages["node_modules/react-dom"]?.version).toBe(react);
  });
});

/* GHSA-2xp9-vwfh-vxw4 decodes AVIF through sharp. Next 15 installs sharp as its own optional
   dependency; nothing here configures the optimizer or depends on sharp directly. */
describe("the image optimizer is left as the framework ships it", () => {
  it.each(APPS)("%s/next.config.mjs sets no `images` key", (app) => {
    const src = withoutComments(read(`../${app}/next.config.mjs`));
    expect(src, `${app}/next.config.mjs configures the image optimizer`).not.toMatch(/\bimages\s*:/);
  });

  it("no workspace manifest declares sharp", () => {
    const manifests = ["package.json"];
    for (const group of ["apps", "packages"]) {
      for (const name of readdirSync(`${HERE}../${group}`)) {
        if (existsSync(`${HERE}../${group}/${name}/package.json`)) manifests.push(`${group}/${name}/package.json`);
      }
    }
    expect(manifests.length).toBeGreaterThan(10);
    for (const rel of manifests) {
      const pkg = JSON.parse(read(`../${rel}`)) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        expect(pkg[field]?.sharp, `${rel} ${field} declares sharp`).toBeUndefined();
      }
    }
  });

  it("next is the only package in package-lock.json that depends on sharp", () => {
    const lock = rootLock();
    expect(dependents(lock, "sharp"), "sharp is reached from another package or a workspace manifest").toEqual(["node_modules/next"]);
    const planted: Lock = { packages: { ...lock.packages, "apps/webapp": { ...lock.packages["apps/webapp"], dependencies: { sharp: "^0.34.0" } } } };
    expect(dependents(planted, "sharp"), "the control: a workspace manifest that names sharp").toContain("apps/webapp");
  });
});
