import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutCommentsAndLiterals, lineOf, span } from "../scripts/lib/source-scan.mjs";
import { readSource } from "../apps/worker/test/_start-function.js";
import { isEnginePart, readingTheUnit } from "./support/engine-unit.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY HOST THAT RUNS THE RESURFACING PASS NAMES THE MAILBOXES IT ORGANIZES
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `bubbleUpPass` flips `bubbled_up` to `resurfaced` for the mailboxes its caller passes, and the
 * organizer lease is per mailbox. A host that called it with the account alone flipped rows in a
 * mailbox somebody else organizes — so the scope is not optional and the pass refuses without it.
 * That refusal is only half a guard: a host can be added, or an argument dropped in a refactor,
 * and the pass would then do nothing where it used to do the work. This census is the other half.
 *
 * The call sites are ENUMERATED by parsing for the CALL rather than listed by hand: the source is
 * read through `source-scan.mjs` (comments, strings and templates blanked, positions kept), every
 * `bubbleUpPass(` that is not the declaration is taken with its own argument span, and each must
 * name `mailboxIds`. The count is asserted first, because a census that found nothing passes
 * every assertion under it — the shape a rename would take.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOTS = ["apps/worker/src", "packages/organizer/src", "apps/sidecar/src"];

function sources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".ts") && !isEnginePart(p)) {
        out.push({ file: relative(REPO, p), src: withoutCommentsAndLiterals(readingTheUnit(readSource)(p)) });
      }
    }
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

interface Site { file: string; line: number; args: string; declaration: boolean }

/** Every occurrence of the name followed by an argument list, call or declaration. */
function sites(): Site[] {
  const found: Site[] = [];
  for (const { file, src } of sources()) {
    for (const m of src.matchAll(/\bbubbleUpPass\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const [start, end] = span(src, open);
      found.push({
        file, line: lineOf(src, m.index), args: src.slice(start, end),
        // The one occurrence that is not a caller: the pass declaring its own parameters.
        declaration: /\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index)),
      });
    }
  }
  return found;
}

const SITES = sites();

describe("the hosts of the bubble-up pass", () => {
  it("found the pass and its callers at all", () => {
    // The declaration proves the scan reaches the module it is about; the callers are the subject.
    expect(SITES.filter((s) => s.declaration).map((s) => s.file),
      "`bubbleUpPass` was not declared under the scanned roots — it was renamed or moved, and " +
      "this census now measures nothing").toEqual(["packages/organizer/src/bubble-up-pass.ts"]);
    const callers = SITES.filter((s) => !s.declaration);
    expect(callers.length,
      "no production caller of `bubbleUpPass` was found under " + ROOTS.join(", ")).toBeGreaterThan(2);
  });

  it("gives every call the mailboxes its caller organizes", () => {
    const silent = SITES
      .filter((s) => !s.declaration && !/\bmailboxIds\b/.test(s.args))
      .map((s) => `${s.file}:${s.line}`);
    expect(silent,
      "these call `bubbleUpPass` without a `mailboxIds` scope: the pass flips nothing without one " +
      "(fail-closed), so the mailbox's schedule stops being kept — pass the set this host organizes")
      .toEqual([]);
  });

  it("derives that set rather than spelling one, at every call", () => {
    /* The key alone is not the claim. A host answering `mailboxIds: []` satisfies the case above
       and flips nothing for ever; one answering a hand-written list answers for mailboxes it may
       have handed over since. Both hosts' scopes are functions read AT THE CALL — the sidecar's
       `organizedMailboxIds()` over its live runtimes, the worker's `organizedMailboxIdsOf(rows, …)`
       over the roster rows of that cycle — so the value must start with that derivation. */
    const literal = SITES
      .filter((s) => !s.declaration)
      .filter((s) => !/\bmailboxIds:\s*organizedMailboxIds/.test(s.args))
      .map((s) => `${s.file}:${s.line}`);
    expect(literal,
      "these pass a `mailboxIds` that is not read from what the host organizes at the moment of " +
      "the call — a literal or a cached list answers for a mailbox that may have changed hands")
      .toEqual([]);
  });

  it("names the hosts it covers, so a host that stops calling is visible", () => {
    // Not a hand list standing in for the parse: the parse produced these, and the names are
    // pinned because a host silently dropping the call is the other way this feature dies.
    expect([...new Set(SITES.filter((s) => !s.declaration).map((s) => s.file))].sort()).toEqual([
      "apps/sidecar/src/engine.ts",
      "apps/worker/src/bubble-up-cron.ts",
      "apps/worker/src/index.ts",
    ]);
  });
});
