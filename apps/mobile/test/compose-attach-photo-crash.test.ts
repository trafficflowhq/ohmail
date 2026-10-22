/**
 * ═══ ATTACHING A LIBRARY PHOTO MUST NOT ABORT THE APP (iOS 27.1) ══════════════════════════════
 *
 * Measured on the iPhone Duo simulator (iOS 27.1 beta, 2026-09-21): a photo picked in the phone's
 * composer took the app down with SIGABRT — expo-image-picker's `MediaHandler.handleMultipleMedia`
 * asked `NSItemProvider.canLoadObject(ofClass: PHLivePhoto.self)` BEFORE reading whether the caller
 * had asked for live photos, and on 27.1 that probe throws inside the Photos framework. The composer
 * asks for `["images"]` alone, so the guard is the ORDER of the two operands, carried as a patch in
 * `patches/` shaped after upstream's own fix (expo/expo#50435, unpublished for SDK 57 at the time of
 * writing), which `scripts/apply-patches.mjs` applies after the install.
 *
 * Three things are asked, each where it is real:
 *  · the OPTIONS the composer passes (`src/compose/attach-native.ts`, read as text — the twin is
 *    never imported: Expo ships Flow-typed JS the node toolchain cannot parse);
 *  · the PATCH — named for the version the app pins and the lockfile installs, and carrying its hunk's
 *    own literals (the removed probe-first line, the added option-first pair);
 *  · the COPY the iOS build compiles — autolinking resolves `expo-image-picker` from `apps/mobile`, so
 *    that copy must carry the hunk, and so must every other installed copy (a patched native module
 *    once existed in two copies with the build compiling the other). A pristine copy, the patch undone
 *    in scratch, is shown refused by the same reader.
 *
 * ── MUTATIONS WATCHED ──────────────────────────────────────────────────────────────────────────
 *  · `attach-native.ts`: `mediaTypes: ["images"]` → `["images", "livePhotos"]` ⇒ the options case RED;
 *  · the resolved copy's `MediaHandler.swift`: the option-first pair put back to the probe-first
 *    line ⇒ the "copy the build compiles" case RED.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installedCopies, resolvedFrom, versionOf } from "./helpers/installed-copies";

/* @reads: apps/mobile/src/compose/attach-native.ts
   The composer's options are read as TEXT through a runtime-built path — the Expo twin is never
   imported — so nothing else selects this file when that source moves (`reads-list.mjs`). */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SWIFT_IN_PICKER = join("ios", "MediaHandler.swift");
const ROOT = resolve(APP, "../..");
const PICKER_PIN = "expo-image-picker@57.0.19";
const PATCH = `patches/${PICKER_PIN}.patch`;
const PROBE_FIRST =
  "if itemProvider.canLoadObject(ofClass: PHLivePhoto.self) && options.mediaTypes.contains(.livePhotos) {";
const OPTION_FIRST = [
  "if options.mediaTypes.contains(.livePhotos)",
  "&& itemProvider.hasItemConformingToTypeIdentifier(UTType.livePhoto.identifier) {",
];

/** What a copy's `MediaHandler.swift` gets wrong of the fix; empty means it carries it. */
function unfixed(swift: string): string[] {
  const out: string[] = [];
  // The CALL, with its receiver — upstream's comment quotes the bare method name on purpose.
  if (swift.includes("itemProvider.canLoadObject(ofClass: PHLivePhoto.self)")) out.push("still probes PHLivePhoto first");
  if (!swift.includes(`${OPTION_FIRST[0]}\n        ${OPTION_FIRST[1]}`)) out.push("lacks the option-first pair");
  // The other probe stays: the UIImage fallback is a different class and a different call site.
  if (!swift.includes("itemProvider.canLoadObject(ofClass: UIImage.self)")) out.push("lost the UIImage probe");
  return out;
}

describe("the composer's photo pick asks for images alone", () => {
  const native = readFileSync(join(APP, "src/compose/attach-native.ts"), "utf8");
  const call = /launchImageLibraryAsync\(\{([\s\S]*?)\}\)/.exec(native);

  it("passes mediaTypes of exactly [\"images\"] — no live photos, no videos", () => {
    expect(call).not.toBeNull();
    const options = call![1];
    expect(options).toMatch(/mediaTypes:\s*\["images"\]/);
    expect(options).not.toMatch(/livePhotos|videos/);
  });
});

describe("the picker's live-photo probe sits behind the option that asks for it", () => {
  const patch = readFileSync(join(ROOT, PATCH), "utf8");

  it("the patch is named for the picker the app pins and the lockfile installs", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(`expo-image-picker@${pkg.dependencies["expo-image-picker"]}`).toBe(PICKER_PIN);
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    expect(`expo-image-picker@${lock.packages["node_modules/expo-image-picker"]?.version}`).toBe(PICKER_PIN);
  });

  it("the hunk removes the probe-first line and adds the option-first pair, in MediaHandler.swift", () => {
    expect(patch).toContain("+++ b/ios/MediaHandler.swift");
    expect(patch).toContain(`-      ${PROBE_FIRST}`);
    expect(patch).toContain(`+      ${OPTION_FIRST[0]}`);
    expect(patch).toContain(`+        ${OPTION_FIRST[1]}`);
    // The hunk is the reorder and nothing else: one line out, the pair plus its two comment lines in.
    const removed = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(4);
  });

  it("the copy the iOS build compiles carries the hunk, and so does every installed copy", () => {
    const resolved = resolvedFrom(APP, "expo-image-picker");
    expect(`expo-image-picker@${versionOf(resolved)}`).toBe(PICKER_PIN);
    expect(unfixed(readFileSync(join(resolved, SWIFT_IN_PICKER), "utf8")), resolved).toEqual([]);
    const copies = installedCopies(ROOT, "expo-image-picker");
    expect(copies, `the resolved copy ${resolved} is not among the installed ones`).toContain(resolved);
    for (const c of copies) expect(unfixed(readFileSync(join(c, SWIFT_IN_PICKER), "utf8")), c).toEqual([]);
    // And the lockfile, the only input a fresh clone has, installs one picker and no other.
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).filter((k) => /(^|\/)node_modules\/expo-image-picker$/.test(k))).toEqual(["node_modules/expo-image-picker"]);
  });

  it("control: the same reader refuses a pristine copy, the patch undone in scratch", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ohmail-picker-pristine-"));
    try {
      cpSync(join(resolvedFrom(APP, "expo-image-picker"), SWIFT_IN_PICKER), join(scratch, SWIFT_IN_PICKER));
      writeFileSync(join(scratch, "undo.patch"), patch);
      const undo = spawnSync("git", ["apply", "--reverse", "undo.patch"], { cwd: scratch, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(scratch) } });
      expect(undo.status, undo.stderr).toBe(0);
      expect(unfixed(readFileSync(join(scratch, SWIFT_IN_PICKER), "utf8"))).toEqual(["still probes PHLivePhoto first", "lacks the option-first pair"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
