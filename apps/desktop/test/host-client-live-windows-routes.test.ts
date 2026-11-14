/**
 * THE PAIRED PAGE's WIRES TO THE JUNK AND TRASH WINDOWS: the routes they ask for are GETs the paired-device route table
 * serves, and the host client's transports spell no request of their own. Moved word for word from
 * `host-client-live-windows.test.tsx`, whose third case reads today's window hooks until the Screener's mount: these
 * two read the route modules and the paired page's transports, which stay.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("the wires a paired device's gate hands the shared shell", () => {

  it("the paths these wires ask for are GETs the paired-device route table serves", () => {
    /* A cross-package read rather than an import: `apps/desktop` does not depend on the api
       package. The GET patterns are collected from the two route modules and the two spreads
       that carry them onto the door, so a renamed route or a dropped spread reddens this. */
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    const local = read("packages/api/src/routes/local.ts");
    expect(local).toContain("...screenerRoutes,");
    expect(local).toContain("...trashRoutes,");

    const gets = new Set<string>();
    for (const rel of ["packages/api/src/routes/screener.ts", "packages/api/src/routes/trash.ts"]) {
      for (const m of read(rel).matchAll(/method:\s*"GET",\s*pattern:\s*"([^"]+)"/g)) {
        gets.add(m[1]!);
      }
    }
    for (const p of [
      "/screener/junk", "/screener/junk/body", "/screener/junk/sweep",
      "/trash/window", "/trash/window/body",
    ]) {
      expect(gets, `${p} is not a GET on the mounted tables`).toContain(p);
    }
    // The positive control: the collection really parsed route objects, and a path nobody serves
    // is refused rather than passed by a permissive match.
    expect(gets.size).toBeGreaterThanOrEqual(5);
    expect(gets.has("/trash/windows")).toBe(false);
  });
});

describe("the host client's transports add no door of their own", () => {
  const src = read("apps/paired-page/src/transports.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("spells no request: no fetch call, no method, no path — every wire is the window's factory", () => {
    // The rule this file's header states, as a census. The narrowing, the paths and the status
    // contracts live once in the window's modules; a request built here would be a second door
    // past the manager's Authorization stamp and its one 401 recovery.
    for (const forbidden of ["fetch(", "method:", "headers:", '"/'] as const) {
      expect(code, `the host client's transports spell ${forbidden}`).not.toContain(forbidden);
    }
    // The positive control: the census reads this file's real code, so the absences are measured.
    expect(code).toContain("junkVia(bearer.fetch)");
    expect(code).toContain("trashVia(bearer.fetch)");
    expect(code).toContain("olderBodyVia(bearer.fetch)");
  });

});
