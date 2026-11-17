import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * THE OHBOX TIDY PASS OPENS NO IMAP CONNECTION, AND STAYS INSIDE db + core.
 *
 * Both are about what this pass CALLS rather than what it computes, so both are source scans — a
 * behavioural test cannot see a code path it never enters, and the dangerous paths here are the
 * ones a future edit would add.
 *
 * The "Organize-in-place" invariant: organization lands in real IMAP folders, but only the worker's `reconcileFolders`
 * opens a connection to apply it — it holds the mailbox's adapter and its organizer lease, and a
 * bulk mover opening its own connection would be a second organizer for one mailbox, the exact
 * thing `ohmail/_meta`'s lease exists to make impossible. This pass writes `folder_state` desired
 * state, a `change_log` move and an `audit_log` inverse, and stops.
 */

const PASS = fileURLToPath(new URL("../src/ohbox-tidy.ts", import.meta.url));

/** The organizer's package, where the shared rule write moved (ruling:organizer-cut). */
const ORGANIZER = new URL("../../../packages/organizer/", import.meta.url);
const ORGANIZER_EXPORTS = (JSON.parse(readFileSync(new URL("package.json", ORGANIZER), "utf8")) as {
  exports: Record<string, { "ohmail-source": string }>;
}).exports;

/** The file an `@ohmail/organizer/<entry>` specifier names, read through the package's own manifest; else undefined. */
function organizerFile(spec: string): string | undefined {
  if (!spec.startsWith("@ohmail/organizer/")) return undefined;
  const entry = ORGANIZER_EXPORTS[`./${spec.slice("@ohmail/organizer/".length)}`];
  return entry === undefined ? undefined : fileURLToPath(new URL(entry["ohmail-source"], ORGANIZER));
}

/** Every module specifier a file imports — the import machinery, not the prose. */
function importsOf(file: string): string[] {
  const body = readFileSync(file, "utf8");
  return [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

/**
 * THE PASS AND EVERY LOCAL MODULE IT PULLS IN. A relative sibling is not a third party — it is
 * this pass's own code in another file — so the rule has to reach through it, or moving one line
 * into a sibling is how a future edit dodges the import boundary without naming anything forbidden. Each entry
 * carries the file that named the specifier, so a refusal says WHERE.
 */
function packageImportsOf(entry: string): Array<{ file: string; spec: string }> {
  const seen = new Set<string>();
  const out: Array<{ file: string; spec: string }> = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else if (organizerFile(spec) !== undefined) stack.push(organizerFile(spec)!);
      else out.push({ file: basename(file), spec });
    }
  }
  return out;
}

describe("the ohbox-tidy pass opens no IMAP connection", () => {
  it("names neither imapflow nor an IMAP adapter", () => {
    // `@trafficflow/core/adapters/imap` is the only door to `imapflow` in this workspace, so naming
    // either is the whole violation surface. Matched on the IMPORT, not the word: this file's prose
    // discusses IMAP, and a guard a deleted comment satisfies is not a guard.
    for (const { file, spec } of packageImportsOf(PASS)) {
      expect(spec, `${file} imports ${spec}`).not.toMatch(/imapflow/);
      expect(spec, `${file} imports ${spec}`).not.toMatch(/adapters\/imap/);
    }
  });

  it("imports only the database and the shared library — the no-IMAP rule is satisfied, not dodged", () => {
    // `apps/worker/test/deps.test.ts` forbids the SERVICES package under `apps/worker/src` — it is
    // an API-host concern and is not installed in the worker's image. Asserted here too, at the file
    // level, because staying inside db + core is the reason this pass can live on the worker rather
    // than becoming an operator one-shot. The forbidden package specifier is never a literal in this
    // file, so it is not swept into `deps.test.ts`'s frozen census of tests that genuinely import it.
    const allowed = ["drizzle-orm", "@trafficflow/db", "@trafficflow/core"];
    // A RELATIVE SIBLING IS NOT A PACKAGE, AND IT IS NOT A HOLE EITHER. `./rule-pass.js` is the
    // shared write two passes make; admitting the specifier alone would let the ban be dodged by
    // one hop, so the sibling's OWN imports are asked the same question. One hop is enough here
    // because `rule-pass.ts` imports no sibling of its own — a chain would need a walk, and the
    // `scans a sibling at all` case below refuses an admission that measured nothing.
    const check = (file: string, who: string): string[] => {
      const out: string[] = [];
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".") || organizerFile(spec) !== undefined) { out.push(spec); continue; }
        const ok = allowed.some((a) => spec === a || spec.startsWith(`${a}/`));
        expect(ok, `${who} imports ${spec}, which is outside db + core`).toBe(true);
      }
      return out;
    };
    const siblings = check(PASS, "ohbox-tidy.ts");
    for (const rel of siblings) {
      const target = organizerFile(rel) ?? fileURLToPath(new URL(rel.replace(/\.js$/, ".ts"), pathToFileURL(PASS)));
      expect(check(target, rel).length, `${rel} reaches a sibling of its own`).toBe(0);
    }
    // The admission measured something: this pass really does reach a sibling.
    expect(siblings).toEqual(["@ohmail/organizer/rule-pass"]);
  });
});
