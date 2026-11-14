import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appRelease, releaseFrom } from "../src/net/app-release";

/**
 * THE RELEASE THE PHONE NAMES TO A SERVER is the `expo.version` the build embeds from `app.json`, read lazily so
 * the node-side suite can load the connection layer. Anywhere there is no native config it is unnamed.
 */
describe("the release the phone names", () => {
  it("is the embedded version, trimmed, and nothing that is not text", () => {
    expect(releaseFrom({ default: { expoConfig: { version: "1.0.12" } } })).toBe("1.0.12");
    expect(releaseFrom({ default: { expoConfig: { version: " 1.0.12 " } } })).toBe("1.0.12");
    for (const bad of [null, undefined, {}, { default: {} }, { default: { expoConfig: {} } }, { default: { expoConfig: { version: 7 } } },
      { default: { expoConfig: { version: "  " } } }]) {
      expect(releaseFrom(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("is unnamed where there is no native config, which is every node run", () => {
    expect(appRelease()).toBeUndefined();
    expect(appRelease(), "the answer is cached").toBeUndefined();
  });

  it("app.json carries a release in the grammar the header sends", () => {
    const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as { expo: { version: string } };
    expect(app.expo.version).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
  });
});
