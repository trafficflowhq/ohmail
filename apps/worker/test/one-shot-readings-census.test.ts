import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { withoutComments, span, lineOf } from "../../../scripts/lib/source-scan.mjs";
import { readSource } from "./_start-function.js";

/**
 * EVERY ROLE CHANGE NAMES THE READING IT DECIDED FROM.
 *
 * `spendOneShot` treats an absent `asRead` as the old unconditional clear — the backstop posture
 * `fence` already documents for its own absence, which is what keeps every test caller working.
 * That makes the omission silent in production, where it IS the defect: a write that cannot date
 * its own decision erases a Stop pressed during it. So every call site in `apps/worker/src` is
 * counted, by the CALL and with comments stripped, and a new one reddens this rather than shipping
 * the unconditional clear back in.
 */

const SRC = join(__dirname, "..", "src");
/** The organizer's package, where the worker's passes that moved out of it stand (ruling:organizer-cut). */
const ORG_SRC = join(__dirname, "..", "..", "..", "packages", "organizer", "src");
const WRITERS = ["clearOrganizerStandDown", "markMailboxStoodDown"] as const;

interface Site { file: string; fn: string; line: number; args: string }

/** Every call to either writer under `apps/worker/src`, its own definitions excluded. */
function sites(): Site[] {
  const found: Site[] = [];
  for (const [dir, file] of [SRC, ORG_SRC].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => [d, f] as const))) {
    const src = withoutComments(readSource(join(dir, file)));
    for (const fn of WRITERS) {
      const needle = `${fn}(`;
      for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
        // The DEFINITION is `export async function <fn>(`, not a call. Everything else is one.
        if (/function\s+$/.test(src.slice(Math.max(0, at - 24), at))) continue;
        const [s, e] = span(src, at + needle.length - 1);
        found.push({ file, fn, line: lineOf(src, at), args: src.slice(s, e) });
      }
    }
  }
  return found;
}

describe("the two role-changing writes decide from a named reading", () => {
  const all = sites();

  it("both writers are reached, and only from the two passes that own them", () => {
    // The bound on the list below: a third caller is a deliberate act and arrives with its own
    // reading, not with the unconditional clear the absent option still spells.
    expect([...new Set(all.map((s) => s.file))].sort()).toEqual(["index.ts", "reconcile-cron.ts"]);
    expect([...new Set(all.map((s) => s.fn))].sort()).toEqual([...WRITERS].sort());
    expect(all.length, "a call site appeared or vanished").toBe(4);
  });

  for (const fn of WRITERS) {
    it(`every ${fn} call says what it read`, () => {
      const calls = all.filter((s) => s.fn === fn);
      expect(calls.length, `${fn} is not called the way this census reads it`).toBe(2);
      for (const c of calls) {
        expect(c.args, `${c.file}:${c.line} spends the one-shots without saying what it read`)
          .toMatch(/\basRead:/);
      }
    });
  }
});
