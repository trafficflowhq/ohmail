import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * EVERY `updateLocator` CALL SITE SAYS WHERE THE MESSAGE WAS.
 *
 * The third argument is not for the write — the repository ignores it. It is for the known-set
 * memo, which holds the projection that call moves a row of and is handed a row id the projection
 * does not carry. Without it the memo cannot find the entry and throws the whole mailbox away:
 * measured at one full re-read per cycle for every cycle of an import, which on an organizer is
 * every cycle there is.
 *
 * So the default is safe and the omission is REFUSED here rather than discovered as a performance
 * row a second time. A new call site that genuinely cannot name the old locator belongs in
 * {@link EXEMPT} with the reason written, not left silent.
 */

/** Files scanned, and the reason the set is this one: these are the writers of the projection. */
const SITES = [
  "packages/core/src/pipeline.ts",
  "packages/organizer/src/junk-filing.ts",
];

/** Call sites that may omit `from`, each with the reason. Empty, and that is the finding. */
const EXEMPT: ReadonlyArray<{ file: string; line: number; why: string }> = [];

/** The calls in `src`, by file and line, with the argument count each one passes. */
function callsIn(file: string): Array<{ line: number; args: number; text: string }> {
  const src = withoutComments(readFileSync(join(process.cwd(), file), "utf8"));
  const out: Array<{ line: number; args: number; text: string }> = [];
  const needle = ".updateLocator(";
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    const open = i + needle.length - 1;
    const bs = bracketSpan(src, open);
    if (!bs.closed) continue;
    const inner = src.slice(bs.start, bs.end);
    // Top-level commas only: an argument may itself be a call or an object.
    let depth = 0;
    let args = 1;
    for (const ch of inner) {
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 0) args += 1;
    }
    out.push({ line: lineOf(src, i), args, text: inner.trim().slice(0, 90) });
  }
  return out;
}

describe("the locator move tells the memo where the message was", () => {
  it("finds the call sites at all — a scanner that matches nothing is green for nothing", () => {
    const found = SITES.flatMap((f) => callsIn(f).map((c) => ({ file: f, ...c })));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(found.map((c) => ({ file: c.file, line: c.line, args: c.args }))));
    expect(found.length, "no `updateLocator` call was found in the files this census names")
      .toBeGreaterThanOrEqual(5);
  });

  it("refuses a call site that omits the old locator", () => {
    const bad: string[] = [];
    for (const file of SITES) {
      for (const c of callsIn(file)) {
        if (c.args >= 3) continue;
        if (EXEMPT.some((e) => e.file === file && e.line === c.line)) continue;
        bad.push(`${file}:${c.line} passes ${c.args} argument(s) — ${c.text}`);
      }
    }
    expect(bad, "a locator move that does not say where the message was drops the known-set memo, "
      + "and on an organizer that is one full projection re-read per cycle of every import")
      .toEqual([]);
  });

  it("counts the arguments the way the sites are written, not by counting commas blindly", () => {
    // THE EXTRACTOR'S OWN CONTROL. A nested call and an object literal both carry commas that are
    // not argument separators; a census that counted those would pass a two-argument site.
    const fixture = "await r.updateLocator(p.messageId, f(a, b), { folder: x, ref: y });";
    let depth = 0;
    let args = 1;
    const bs = bracketSpan(fixture, fixture.indexOf("("));
    for (const ch of fixture.slice(bs.start, bs.end)) {
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 0) args += 1;
    }
    expect(args).toBe(3);
  });
});
