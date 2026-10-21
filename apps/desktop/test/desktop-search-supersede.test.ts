import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(HERE, p), "utf8");

/**
 * THE WINDOW'S ENGINE ASKS UNDER A SEARCH LANE, and no other engine does. The behaviour is
 * `apps/sidecar/test/search-supersede.test.ts`; this holds the option on the engine the window
 * runs on (the same source-shaped reading as `desktop-mirror-is-windowed.test.ts`), and off on the
 * paired device's, the web's and the phone's, whose wire must not change.
 */
describe("the search lane option", () => {
  it("createLocalEngine turns it on", () => {
    const src = read("../src/bridge-fetch.ts");
    const call = src.slice(src.indexOf("export function createLocalEngine"));
    expect(call.slice(0, call.indexOf("\n}"))).toContain("searchSupersede: true");
  });

  it("CONTROL: the paired device's, the web's and the phone's engines leave it off", () => {
    for (const p of ["../src/host-client/host-engine.ts", "../../webapp/app/shell/engine-config.ts", "../../mobile/src/engine/boot.ts"]) {
      expect(read(p), p).not.toContain("searchSupersede");
    }
  });
});
