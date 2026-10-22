/**
 * ═══ THE COPIES THE iOS BUILD COMPILES CARRY THE SQLITE AND JSI PATCHES ═════════════════════════
 *
 * `patches/expo-sqlite.patch` and `patches/expo-modules-jsi.patch` are UNVERSIONED (they apply to
 * whatever version resolves), and they change Swift sources only, so no marker string of theirs reaches
 * a JS bundle or a dex. The image-picker patch has its twin (`compose-attach-photo-crash.test.ts`); these
 * are read the same way, on the copy the build resolves: autolinking takes `expo-sqlite` from this app,
 * and `expo-modules-jsi` from `expo-modules-core` as `expo` resolves it. That copy, and every other
 * installed copy, must carry every line the patch adds and none it removes. The reader is shown refusing
 * a pristine copy (the patch undone in scratch).
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hunks, installedCopies, resolvedFrom, unpatchedIn } from "./helpers/installed-copies";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(APP, "../..");
const SCRATCH = mkdtempSync(join(tmpdir(), "ohmail-store-copy-twins-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const CASES = [
  { name: "expo-sqlite", patch: "patches/expo-sqlite.patch", copy: () => resolvedFrom(APP, "expo-sqlite") },
  { name: "expo-modules-jsi", patch: "patches/expo-modules-jsi.patch", copy: () =>
    resolvedFrom(resolvedFrom(resolvedFrom(APP, "expo"), "expo-modules-core"), "expo-modules-jsi") },
] as const;

describe.each(CASES)("$name", ({ name, patch: patchPath, copy }) => {
  const patch = readFileSync(join(ROOT, patchPath), "utf8");

  it("is in patches/ without a version, and changes lines the reader can hold", () => {
    const named = readdirSync(join(ROOT, "patches")).filter((f) => f === `${name}.patch` || f.startsWith(`${name}@`));
    expect(named, `patches/ holds one ${name} patch, unversioned`).toEqual([`${name}.patch`]);
    const hs = hunks(patch);
    expect(hs.length).toBeGreaterThan(0);
    for (const h of hs) expect(h.added.length + h.removed.length, h.file).toBeGreaterThan(0);
  });

  it("the copy the iOS build compiles carries it, and so does every installed copy", () => {
    const at = copy();
    expect(unpatchedIn(at, patch), at).toEqual([]);
    const copies = installedCopies(ROOT, name);
    expect(copies, `the resolved copy ${at} is not among the installed ones`).toContain(at);
    for (const c of copies) expect(unpatchedIn(c, patch), c).toEqual([]);
  });

  it("the reader refuses a pristine copy — the patch undone in scratch", () => {
    const at = copy();
    const pristine = join(SCRATCH, name);
    for (const h of hunks(patch)) cpSync(join(at, h.file), join(pristine, h.file));
    writeFileSync(join(pristine, "undo.patch"), patch);
    const undo = spawnSync("git", ["apply", "--reverse", "undo.patch"], { cwd: pristine, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(pristine) } });
    expect(undo.status, undo.stderr).toBe(0);
    expect(unpatchedIn(pristine, patch).length).toBeGreaterThan(0);
  });
});
