/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { MACHINE_WORD, machineWordOf } from "../src/platform.js";

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), "utf8");

/**
 * THE MACHINE'S OWN WORD — the fix for the released 0.12.0 Linux AppImage greeting its user
 * with "On this Mac".
 *
 * One test run cannot BE three platforms, so the guard is in two halves: the mapping is pure and
 * asserted for every platform this app ships to, and the wiring — that the two copy-carrying
 * surfaces render the word rather than a hardcoded brand — is asserted where the components are
 * mounted (`desktop-native.test.ts` for the settings pane) and over the source here for the door
 * chooser, whose mount needs a full door driver this file has no business duplicating.
 */
describe("the platform word", () => {
  it("maps each shipping platform to its own word, and the unknown to the generic", () => {
    expect(machineWordOf("darwin")).toBe("Mac");
    expect(machineWordOf("win32")).toBe("PC");
    expect(machineWordOf("linux")).toBe("computer");
    // The silence-over-guess rule `desktopDeviceKind` set: no brand word, no brand claim.
    expect(machineWordOf("freebsd")).toBe("computer");
    expect(machineWordOf("")).toBe("computer");
  });

  it("answers the generic word where no build folded the define", () => {
    // This import ran without a bundler, so the define is absent — the same state an
    // unrecognized platform is in, and the word must not be a guessed brand.
    expect(MACHINE_WORD).toBe("computer");
  });

  it("leaves no hardcoded machine brand in the two copy surfaces", () => {
    /* Source-level, deliberately: the door chooser's user-visible strings all interpolate
       MACHINE_WORD now, and the regression this guards against is precisely a future string
       typing the brand back in. JSX text and string literals both match `this Mac`; the one
       legitimate "Mac" left in either file is inside comments, which this strips. */
    for (const rel of ["../src/DoorChooser.tsx", "../src/DesktopSettings.tsx"]) {
      const src = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, `${rel} hardcodes a machine brand`).not.toMatch(/this Mac\b/);
      expect(src, `${rel} hardcodes a machine brand`).not.toMatch(/this PC\b/);
    }
  });

  it("keeps the build define wired in vite.config.ts", () => {
    // The word is only as platform-aware as the define that feeds it: a build where the define
    // is dropped would quietly ship "computer" to Macs, which is wrong in the polite direction
    // but still wrong.
    expect(read("../vite.config.ts")).toContain("__OHMAIL_PLATFORM__: JSON.stringify(process.platform)");
  });
});
