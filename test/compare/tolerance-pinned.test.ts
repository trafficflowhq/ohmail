import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOLERANCE } from "./render.mjs";

/**
 * The tolerance was measured with one browser. Playwright pins the browser, so a new Playwright is a
 * new measurement: take the own subjects' readings again, then move `tolerance.json`'s `playwright`.
 */
describe("the comparison's tolerance", () => {
  it("was measured with the Playwright this repository installs", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(TOLERANCE.playwright).toBe(pkg.devDependencies["@playwright/test"]);
  });

  it("keeps each line where it was argued: a box within a pixel, a pixel above a rounding step and under the palette's closest two, a mark between two draws' noise and the smallest change", () => {
    expect(TOLERANCE.pictureRatio).toBeGreaterThanOrEqual(0.001);
    expect(TOLERANCE.pictureRatio).toBeLessThan(0.01);
    // A region has its own line: above the whole picture's, and under the one that fails any state.
    expect(TOLERANCE.regionRatio).toBeGreaterThan(TOLERANCE.pictureRatio);
    expect(TOLERANCE.grossRatio).toBeGreaterThan(TOLERANCE.regionRatio);
    expect(TOLERANCE.grossRatio).toBeLessThanOrEqual(0.05);
    expect([TOLERANCE.box, TOLERANCE.regionFloor]).toEqual([1, 12]);
    // pixelmatch counts a pixel whose distance is over 35215 × pixel². One step of every channel at once is 0.51
    // (what two machines may round apart); the closest two surfaces of the design are 0.68 apart.
    expect(35215 * TOLERANCE.pixel ** 2).toBeGreaterThan(0.51);
    expect(35215 * TOLERANCE.pixel ** 2).toBeLessThan(0.68);
    // A mark: more touching pixels than two draws of one steady state ever showed (11 at a scale of one, 3 at two), fewer than the
    // smallest mark changed on purpose (a caret in 11 px type turned a quarter: 23; a line through words: 20).
    expect(TOLERANCE.mark).toBeLessThan(20);
    expect(TOLERANCE.mark).toBeGreaterThan(11);
    expect(TOLERANCE.mark).toBeLessThan(23);
    // The reference's longest timer into a state is 260 ms with its motion shortened; a shorter wait takes the moment before.
    expect(TOLERANCE.settle.quietMs).toBeGreaterThanOrEqual(600);
    expect(TOLERANCE.settle.withinMs).toBeGreaterThan(TOLERANCE.settle.quietMs * 4);
    expect(TOLERANCE.chromiumArgs).toEqual(["--font-render-hinting=none", "--disable-lcd-text", "--disable-font-subpixel-positioning", "--force-color-profile=srgb", "--disable-threaded-animation"]);
  });
});
