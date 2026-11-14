import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NOTHING IN 1.0 SENDS "THIS APP IS TOO OLD" OR "THE SERVER IS BEING UPDATED". Every client of this release
 * understands the two answers (`426 client_too_old`, `503 server_updating`); no server of this release sends
 * either. The 2.0 server and the closed window of the switch-over will, and a 1.0 server that did would
 * tell every app already in the field to update. So the four places a server is composed (the route table,
 * the hosted host, the self-host server, the desktop and phone engine) may not contain either word, in code
 * or in a comment. The stub server of the client suites is the only place that sends them, and it is a test.
 *
 * The scan is a plain read of every source file under the four roots, so a planted
 * `errorResponse("client_too_old", 426, …)` anywhere there turns it red. A guard for an absence goes green
 * when the thing it watches is deleted, so the control below plants one in memory and asserts the scan finds it.
 */
const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The four server roots, with the floor each must clear: a root that stops being walked reads 0, not clean. */
const ROOTS: readonly { dir: string; atLeast: number }[] = [
  // Counts when written: 112, 7, 8 and 97. Each floor sits below its count and above zero.
  { dir: "packages/api/src", atLeast: 90 },
  { dir: "apps/api-vercel/src", atLeast: 5 },
  { dir: "apps/server/src", atLeast: 5 },
  { dir: "apps/sidecar/src", atLeast: 70 },
];

export const THE_TWO_WORDS: readonly RegExp[] = [/client_too_old/, /server_updating/];

/** Every source file under `dir`, at any depth. Not `.d.ts`, which declares and sends nothing. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") out.push(...walk(p));
    } else if (/\.(?:ts|tsx|mts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The words the source carries, as `file:line word`. Pure, so the control can run it on a planted file. */
export function sentWords(source: string, file: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((text, i) => {
    for (const word of THE_TWO_WORDS) {
      const hit = word.exec(text);
      if (hit !== null) found.push(`${file}:${i + 1} ${hit[0]}`);
    }
  });
  return found;
}

describe("1.0 sends neither update answer", () => {
  it("no server source of this release names either, in code or in a comment", () => {
    const found: string[] = [];
    for (const { dir, atLeast } of ROOTS) {
      const files = walk(join(REPO, dir));
      expect(files.length, `${dir} was walked and held ${files.length} files, under its floor of ${atLeast}`).toBeGreaterThanOrEqual(atLeast);
      for (const file of files) found.push(...sentWords(readFileSync(file, "utf8"), relative(REPO, file)));
    }
    expect(found, "a server of this release names an update answer; only the 2.0 server may send one").toEqual([]);
  });

  it("CONTROL: the scan finds a planted send, in code and in a comment, and passes a clean file", () => {
    const planted = [
      'import { errorResponse } from "../responses.js";',
      'export const refuse = () => errorResponse("client_too_old", 426, "update ohmail");',
      "// while it is being updated: server_updating",
    ].join("\n");
    expect(sentWords(planted, "packages/api/src/routes/planted.ts")).toEqual([
      "packages/api/src/routes/planted.ts:2 client_too_old",
      "packages/api/src/routes/planted.ts:3 server_updating",
    ]);
    expect(sentWords('export const answer = errorResponse("db_busy", 503, "busy");', "clean.ts")).toEqual([]);
  });
});
