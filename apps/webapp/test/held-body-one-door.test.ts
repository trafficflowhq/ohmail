import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE HELD PREVIEW AND THE READER CALL ONE DOOR, in the new shell: moved out of `screener-held-body-door.test.tsx`
 * (whose other cases mount today's Screener view) and re-pointed to the current source. Today's shell declared one `bodyOfMessage` and handed it to the chrome every drawn
 * body read; the new tree's one function is the reader's `useLetterBody` (`app-logic/src/reader/open-conversation.ts`),
 * the only place a letter's body is read off the engine's mirror, and both the reader's letter and the Screener's
 * held letter draw through it.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TREE = ["packages/app-logic/src", "packages/app/src"];

/** The new tree's source files, comments blanked, by their path from the repository's root. */
function newTree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name))
        out.set(
          relative(REPO, full).split("\\").join("/"),
          readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 "),
        );
    }
  };
  for (const root of TREE) walk(join(REPO, root));
  return out;
}

describe("the held preview and the reader call one door", () => {
  it("the shell hands the chrome the one function every drawn body reads", () => {
    const tree = newTree();
    const DOOR = "packages/app-logic/src/reader/open-conversation.ts";
    const declared = [...tree].filter(([, src]) => /\bfunction useLetterBody\s*\(/.test(src)).map(([rel]) => rel);
    expect(declared, "a second body door was declared").toEqual([DOOR]);
    const reads = [...tree].filter(([, src]) => /(?:^|[^\w.])bodyOf\s*\(\s*engine\b/m.test(src)).map(([rel]) => rel);
    expect(reads, "a letter's body is read off the mirror past the one door").toEqual([DOOR]);
    for (const rel of ["packages/app/src/reader/Letter.tsx", "packages/app/src/screener/held/HeldLetter.tsx"]) {
      expect(tree.get(rel), `${rel} does not draw through the one door`).toMatch(/useLetterBody\s*\(/);
    }
  });
});
