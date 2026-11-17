import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ENTRY, LOCK_PATH, diffPins, fileOf, fixturePath, resolveIn, splitSpecifier,
} from "../scripts/pin-released-organizer.mjs";

/**
 * THE RELEASED ORGANIZER IS A FIXTURE BUNDLED FROM A RELEASE COMMIT, NEVER FROM A CHECKOUT
 * (scripts/pin-released-organizer.mjs). A test runs the released settings code beside this tree's,
 * so the fixture has to be exactly what the release shipped: the file is held to its pin, the
 * packages it leaves outside are held to the versions the release was locked to, and the script's
 * rules are held on a planted repository.
 */
const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/pin-released-organizer.mjs");
const RELEASE = "1.0.11";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface Pin {
  release: string; tag: string; entry: string; esbuild: string;
  externals: Record<string, string | null>; inputs: Record<string, string>; bundle: { bytes: number; sha256: string };
}
const lockOf = (root: string): { fixtures: Record<string, Pin> } => JSON.parse(readFileSync(join(root, LOCK_PATH), "utf8"));
const keyOf = (release: string): string => fixturePath(release).slice(dirname(LOCK_PATH).length + 1);

describe("the fixture this tree carries", () => {
  const pin = lockOf(ROOT).fixtures[keyOf(RELEASE)]!;
  const text = readFileSync(join(ROOT, fixturePath(RELEASE)), "utf8");

  it("is the bundle its lock pins, made from the entry the script holds", () => {
    expect({ bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) }).toEqual(pin.bundle);
    expect(pin.release).toBe(RELEASE);
    // An entry edited without a new pin would test a bundle that is no longer the script's.
    expect(pin.entry).toBe(sha256(ENTRY));
    expect(pin.tag).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pin.inputs)).toEqual(expect.arrayContaining([
      "apps/worker/src/profile.ts", "packages/core/src/adapters/organizer-profile.ts",
      "packages/core/src/adapters/organizer-profile-store.ts",
    ]));
  });

  it("imports nothing of this repository, and from outside only the packages its lock names", () => {
    const imported = [...text.matchAll(/^import [^;]*? from "([^"]+)";$/gm)].map((m) => m[1]!);
    expect(imported.length).toBeGreaterThan(0);
    const outside = [...new Set(imported.filter((s) => !isBuiltin(s)).map((s) => splitSpecifier(s)[0]))].sort();
    expect(outside).toEqual(Object.keys(pin.externals).sort());
    expect(imported.filter((s) => s.startsWith(".") || s.startsWith("@trafficflow/") || s.startsWith("@ohmail/"))).toEqual([]);
  });

  it("runs on the installed packages at the versions the release was locked to", () => {
    // The root's own copy: the suite resolves one copy of every dependency, the root's.
    const installed = Object.fromEntries(Object.keys(pin.externals).map((name) =>
      [name, (JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")) as { version: string }).version]));
    expect(Object.keys(installed).length).toBeGreaterThan(0);
    expect(installed).toEqual(pin.externals);
  });

  const releaseAtHand = spawnSync("git", ["-C", ROOT, "cat-file", "-e", `${pin.tag}^{commit}`]).status === 0;
  it.runIf(releaseAtHand)("where the release's objects are at hand, the script makes the same bytes again", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--check", "--release", RELEASE, "--tag", pin.tag], { encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain(`PIN ${RELEASE} ${pin.tag}`);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  }, 60_000);
});

describe("the script's reading of a commit", () => {
  const tree = new Map([
    ["apps/worker/src/profile.ts", "a"], ["apps/worker/src/lease.ts", "b"], ["packages/db/src/dialect/index.ts", "c"],
    ["packages/db/src/index.ts", "d"], ["packages/ui/src/Part.tsx", "e"],
  ]);
  const packages = new Map([
    ["@trafficflow/db", { dir: "packages/db", exports: { ".": { "ohmail-source": "./src/index.ts" }, "./dialect": { types: "./src/dialect/index.ts" } } }],
  ]);

  it("finds a relative import as the source file the commit holds", () => {
    expect(fileOf(tree, "apps/worker/src/lease.js")).toBe("apps/worker/src/lease.ts");
    expect(fileOf(tree, "packages/db/src/dialect")).toBe("packages/db/src/dialect/index.ts");
    expect(fileOf(tree, "packages/ui/src/Part.js")).toBe("packages/ui/src/Part.tsx");
    expect(fileOf(tree, "apps/worker/src/gone.js")).toBeNull();
    expect(resolveIn(tree, packages, "./lease.js", "apps/worker/src/profile.ts")).toEqual({ file: "apps/worker/src/lease.ts" });
    expect(() => resolveIn(tree, packages, "./gone.js", "apps/worker/src/profile.ts")).toThrow(/the commit does not hold/);
  });

  it("finds a package of the repository through its own exports, and leaves every other package outside", () => {
    expect(splitSpecifier("@trafficflow/db/dialect")).toEqual(["@trafficflow/db", "./dialect"]);
    expect(splitSpecifier("drizzle-orm/pg-core")).toEqual(["drizzle-orm", "./pg-core"]);
    expect(splitSpecifier("postgres")).toEqual(["postgres", "."]);
    expect(resolveIn(tree, packages, "@trafficflow/db", "")).toEqual({ file: "packages/db/src/index.ts" });
    expect(resolveIn(tree, packages, "@trafficflow/db/dialect", "")).toEqual({ file: "packages/db/src/dialect/index.ts" });
    expect(resolveIn(tree, packages, "drizzle-orm/pg-core", "packages/db/src/index.ts")).toEqual({ outside: "drizzle-orm" });
    expect(() => resolveIn(tree, packages, "@trafficflow/db/admin", "")).toThrow(/does not export/);
  });

  it("names what turns one pin into another", () => {
    const a: Pin = { release: "1.0.0", tag: "t", entry: "e", esbuild: "0", externals: { lib: "1" }, inputs: { x: "1", y: "1" }, bundle: { bytes: 1, sha256: "s" } };
    expect(diffPins(a, a)).toEqual([]);
    expect(diffPins(null, a)).toEqual([
      "~ release none -> 1.0.0", "~ tag none -> t", "~ entry none -> e", "~ esbuild none -> 0",
      "+ package lib", "+ input x", "+ input y", "~ bundle none -> s",
    ]);
    const b: Pin = { ...a, externals: { lib: "2" }, inputs: { x: "2", z: "1" }, bundle: { bytes: 2, sha256: "u" } };
    expect(diffPins(a, b)).toEqual(["~ package lib", "~ input x", "- input y", "+ input z", "~ bundle s -> u"]);
  });
});

const scratch = mkdtempSync(join(tmpdir(), "ohmail-pin-organizer-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** What the entry names, as a release would hold it: each package a line or two. */
const RELEASED: Record<string, string> = {
  "package-lock.json": JSON.stringify({ packages: { "node_modules/outside-lib": { version: "9.9.9" } } }),
  "apps/worker/package.json": JSON.stringify({ name: "@trafficflow/worker", exports: { "./profile": { "ohmail-source": "./src/profile.ts" } } }),
  "apps/worker/src/profile.ts":
    'import { stoodDown } from "./lease.js";\nimport { outside } from "outside-lib";\n' +
    'export const PROFILE_VERSION: number = 2;\n' +
    'export class OrganizerProfileSync { says(): string { return `as released ${stoodDown()} ${String(outside)}`; } }\n',
  "apps/worker/src/lease.ts": 'export function stoodDown(): boolean { return false; }\nexport const NEVER_ASKED_FOR = "a name nobody imports";\n',
  "packages/core/package.json": JSON.stringify({
    name: "@trafficflow/core",
    exports: {
      "./adapters/organizer-profile": { "ohmail-source": "./src/adapters/organizer-profile.ts" },
      "./adapters/organizer-profile-store": { "ohmail-source": "./src/adapters/organizer-profile-store.ts" },
    },
  }),
  "packages/core/src/adapters/organizer-profile.ts":
    "export const makeProfileIo = 1;\nexport const profileFingerprint = 2;\nexport const readOrganizerProfile = 3;\n",
  "packages/core/src/adapters/organizer-profile-store.ts": "export const applyOrganizerProfile = 4;\nexport const serializeOrganizerProfile = 5;\n",
  "packages/db/package.json": JSON.stringify({
    name: "@trafficflow/db",
    exports: { ".": { "ohmail-source": "./src/index.ts" }, "./dialect": { "ohmail-source": "./src/dialect/index.ts" } },
  }),
  "packages/db/src/dialect/index.ts": "export const brandDialect = 6;\n",
  "packages/db/src/index.ts":
    "export const contacts = 7;\nexport const fencedAccountWrite = 8;\nexport const latestProfileFoundMarker = 9;\n" +
    "export const recordProfileImportResolution = 10;\nexport const rules = 11;\nexport const tags = 12;\n",
};

/** A repository with one commit holding `files`, tagged `v1`, and the script run against it. */
function plant(files: Record<string, string>) {
  const dir = join(scratch, `r${n++}`);
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const commit = (set: Record<string, string>, subject: string) => {
    for (const [rel, text] of Object.entries(set)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const first = commit(files, "release");
  git("tag", "-a", "v1", "-m", "v1");
  const pin = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, "--root", dir, ...args], { encoding: "utf8" });
  const fixture = join(dir, fixturePath("1.2.3"));
  return { dir, first, git, commit, pin, fixture, lock: (): Pin => lockOf(dir).fixtures[keyOf("1.2.3")]! };
}
const ARGS = ["--release", "1.2.3", "--tag", "v1"];

describe("the fixture is bundled from a release commit", { timeout: 60_000 }, () => {
  it("takes every file from the commit's objects: a later commit and an edited checkout change nothing", () => {
    const r = plant(RELEASED);
    // The line moved on after the release, and the checkout is edited beyond that.
    r.commit({ "apps/worker/src/profile.ts": RELEASED["apps/worker/src/profile.ts"]!.replace("as released", "after the release") }, "later");
    writeFileSync(join(r.dir, "apps/worker/src/lease.ts"), "export function stoodDown(): boolean { return true; }\n");
    const run = r.pin("--write", ...ARGS);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const text = readFileSync(r.fixture, "utf8");
    expect(text).toContain("as released");
    expect(text).not.toContain("after the release");
    expect(text).toContain("return false");
    const pin = r.lock();
    expect(run.stdout).toContain(`PIN 1.2.3 ${r.first} inputs=${Object.keys(pin.inputs).length} bytes=${pin.bundle.bytes} sha256=${pin.bundle.sha256}`);
    expect(pin).toMatchObject({ release: "1.2.3", tag: r.first, entry: sha256(ENTRY), externals: { "outside-lib": "9.9.9" } });
    expect(pin.bundle).toEqual({ bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) });
    for (const path of ["apps/worker/src/profile.ts", "apps/worker/src/lease.ts", "packages/db/src/index.ts"]) {
      expect(pin.inputs[path], path).toBe(r.git("rev-parse", `v1:${path}`));
    }
  });

  it("leaves a package from outside the repository as an import, and drops what nothing asked for", () => {
    const r = plant(RELEASED);
    expect(r.pin("--write", ...ARGS).status).toBe(0);
    const text = readFileSync(r.fixture, "utf8");
    expect(text).toMatch(/^import \{ outside \} from "outside-lib";$/m);
    expect(text).not.toContain("a name nobody imports");
    expect(text).not.toMatch(/from "@trafficflow\//);
  });

  it("check after a write is equal and writes nothing; it names a changed file and a changed pin", () => {
    const r = plant(RELEASED);
    expect(r.pin("--write", ...ARGS).status).toBe(0);
    const written = readFileSync(r.fixture, "utf8");
    const lockText = readFileSync(join(r.dir, LOCK_PATH), "utf8");
    const equal = r.pin("--check", ...ARGS);
    expect(equal.status, equal.stdout + equal.stderr).toBe(0);
    expect(equal.stdout.trim().split("\n")).toHaveLength(1);

    writeFileSync(r.fixture, `${written}\n// edited by hand\n`);
    const edited = r.pin("--check", ...ARGS);
    expect(edited.status).toBe(1);
    expect(edited.stdout).toContain(`~ file ${fixturePath("1.2.3")}`);
    expect(readFileSync(r.fixture, "utf8")).toContain("edited by hand");
    writeFileSync(r.fixture, written);

    const lock = JSON.parse(lockText) as { fixtures: Record<string, Pin> };
    lock.fixtures[keyOf("1.2.3")]!.bundle.sha256 = "0".repeat(64);
    lock.fixtures[keyOf("1.2.3")]!.inputs["apps/worker/src/lease.ts"] = "0".repeat(40);
    writeFileSync(join(r.dir, LOCK_PATH), JSON.stringify(lock, null, 2));
    const repinned = r.pin("--check", ...ARGS);
    expect(repinned.status).toBe(1);
    expect(repinned.stdout).toContain("~ input apps/worker/src/lease.ts");
    expect(repinned.stdout).toContain(`~ bundle ${"0".repeat(64)} -> ${sha256(written)}`);
    expect(readFileSync(join(r.dir, LOCK_PATH), "utf8")).toBe(JSON.stringify(lock, null, 2));
  });

  it("a second release's fixture stands beside the first in one lock", () => {
    const r = plant(RELEASED);
    expect(r.pin("--write", ...ARGS).status).toBe(0);
    expect(r.pin("--write", "--release", "1.2.4", "--tag", "v1").status).toBe(0);
    expect(Object.keys(lockOf(r.dir).fixtures)).toEqual([keyOf("1.2.3"), keyOf("1.2.4")]);
    expect(existsSync(join(r.dir, fixturePath("1.2.4")))).toBe(true);
  });

  it("refuses a release whose code imports a file the commit does not hold, and writes nothing", () => {
    const r = plant({ ...RELEASED, "apps/worker/src/profile.ts": 'export * from "./moved-away.js";\n' });
    const run = r.pin("--write", ...ARGS);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("imports ./moved-away.js, which the commit does not hold");
    expect(existsSync(r.fixture)).toBe(false);
    expect(existsSync(join(r.dir, LOCK_PATH))).toBe(false);
  });

  it("asks for both the release and the commit, and for exactly one of write and check", () => {
    const r = plant(RELEASED);
    for (const args of [[], ["--write"], ["--write", "--release", "1.2.3"], ["--write", "--check", ...ARGS], ["--write", "--release", "next", "--tag", "v1"], ["--bogus"]]) {
      const run = r.pin(...args);
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stderr).toContain("usage: node scripts/pin-released-organizer.mjs");
    }
    const absent = r.pin("--write", "--release", "1.2.3", "--tag", "v9");
    expect(absent.status).toBe(2);
    expect(absent.stderr).toContain("v9 cannot be read as a commit");
    expect(existsSync(join(r.dir, LOCK_PATH))).toBe(false);
  });
});
