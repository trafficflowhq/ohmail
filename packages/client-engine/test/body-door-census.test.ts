import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE BODY-DOOR CENSUS — every construction of the stored-body wire routes in CLIENT source is
 * one of the named doors.
 *
 * Bodies terminate in exactly two wire routes (`GET /messages/:id/body`, `GET /messages/bodies`),
 * but the DOORS to them accreted: each surface's reach-past case grew its own fetch, its own
 * narrowing, its own session cache — four idioms over one spine, and a recurring class of
 * "this surface's reach-past case was forgotten" defects, reported three separate times from
 * the field. The doors are now:
 *
 *  · MIRROR-RESIDENT — `HttpAdapter` (single body + the batch route), behind the engine's
 *    `bodyPlan`/`hydrateBody` admission;
 *  · ON-DEMAND — `src/session-body.ts` (`olderBodyVia`, the fetch-shaped transport bind) and the
 *    webapp shell's `older-body.ts` (`CLOUD_OLDER_BODY`, the Cloud client's error contract),
 *    both feeding `createSessionBodyDoor`.
 *
 * This census makes the consolidation stick, the `flag-intent` way: the found set must EQUAL the
 * allowlist, so a new hand-rolled body fetch is red — and so is a scanner regression that stops
 * seeing the doors it is defined by. The next body-touching feature binds a door; it does not
 * build one.
 *
 * Scope: the client trees — this package's src, the shared webapp shell (`apps/webapp/app`),
 * the desktop window (`apps/desktop/src`), mobile (`apps/mobile/src`). The sidecar and the API
 * are the TRANSPORT side of the seam (which store answers), pinned by their own censuses
 * (`client-route-coverage`, `cloud-engine-census`), so they are deliberately out of scope here.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const ROOTS = [
  ["packages", "client-engine", "src"],
  ["apps", "webapp", "app"],
  ["packages", "app-logic", "src"],
  ["apps", "desktop", "src"],
  ["apps", "mobile", "src"],
].map((p) => join(REPO, ...p));

/**
 * A single-body route CONSTRUCTION: an interpolated id between /messages/ and /body, or the
 * route's own name as the wire spells it, quoted, which is how a typed call asks for it.
 */
const SINGLE_BODY = /\/messages\/\$\{[^}]+\}\/body|"GET \/messages\/:id\/body"/;
/** The batch route's literal. */
const BATCH_BODY = "/messages/bodies";

const ALLOWED_SINGLE = new Set([
  ["packages", "client-engine", "src", "session-body.ts"].join(sep),
  ["packages", "client-engine", "src", "adapters", "http-adapter.ts"].join(sep),
  ["apps", "webapp", "app", "shell", "older-body.ts"].join(sep),
]);
const ALLOWED_BATCH = new Set([
  ["packages", "client-engine", "src", "adapters", "http-adapter.ts"].join(sep),
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) yield p;
  }
}

/** Comment lines carry the route in prose constantly; constructions live in code lines. */
function codeLines(src: string): string[] {
  return src.split("\n").filter((line) => {
    const t = line.trimStart();
    return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
  });
}

describe("bodies have TWO wire routes and the named doors only", () => {
  it("every /messages/:id/body construction in client source is one of the three doors", () => {
    const found = new Set<string>();
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (codeLines(readFileSync(file, "utf8")).some((l) => SINGLE_BODY.test(l))) {
          found.add(relative(REPO, file));
        }
      }
    }
    expect([...found].sort()).toEqual([...ALLOWED_SINGLE].sort());
  });

  it("the batch route is the adapter's alone — thread hydration goes through the engine", () => {
    const found = new Set<string>();
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (codeLines(readFileSync(file, "utf8")).some((l) => l.includes(BATCH_BODY))) {
          found.add(relative(REPO, file));
        }
      }
    }
    expect([...found].sort()).toEqual([...ALLOWED_BATCH].sort());
  });
});
