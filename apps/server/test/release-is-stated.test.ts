import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReleaseOf, processDoor } from "../src/build-release.js";

/**
 * THE SELF-HOST SERVER STATES WHICH RELEASE IT IS, not which commit. The published images carry a
 * commit as their build label, which `GET /hello` must not mistake for the release: it says what the
 * host bundler baked in from the root manifest, else the checkout's own manifest, else nothing (and
 * `/hello` then says `0.0.0`, the one place a guess would be a lie).
 */
describe("the release this server is a build of", () => {
  it("is the checkout's manifest where nothing was baked in", () => {
    const manifest = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
    expect(buildReleaseOf()).toBe(manifest);
    expect(buildReleaseOf(() => " 0.31.2 ")).toBe("0.31.2");
    // And it is what the process door hands the settings, so a server that starts states it.
    expect(processDoor(() => "").release).toBe(manifest);
  });

  it("is what the bundler baked in, ahead of the manifest", () => {
    const g = globalThis as Record<string, unknown>;
    try {
      g.__OHMAIL_RELEASE__ = "9.8.7";
      expect([buildReleaseOf(() => "0.31.2"), buildReleaseOf()]).toEqual(["9.8.7", "9.8.7"]);
    } finally {
      delete g.__OHMAIL_RELEASE__;
    }
  });

  it("is null where no manifest answers, never a placeholder", () => {
    expect(buildReleaseOf(() => "")).toBeNull();
    expect(buildReleaseOf(() => "  ")).toBeNull();
  });
});
