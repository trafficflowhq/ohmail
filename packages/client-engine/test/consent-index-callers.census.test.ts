import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY CONSENT INDEX IN CLIENT SOURCE IS BUILT PER MAILBOX, OR NAMED AS LOCAL-ONLY. A mailbox
 * this install only reads is judged by its organizer's document, and an index built from the local
 * rule entities alone judges it by rules the organizer never saw — the defect this closes, and it
 * ships again from any caller the fix did not reach. So each `consentIndex(` / `decidedDestination(`
 * CALL is read: two arguments (the mailbox profiles, or the mailbox) or a named local-only site.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const ROOTS = ["packages/client-engine/src", "apps/webapp/app", "apps/desktop/src", "apps/mobile/src", "apps/mobile/app"];
const SKIP = new Set(["node_modules", "dist", ".next", "coverage"]);

/** The one-argument sites, each with why its rules are the local ones by construction. */
const LOCAL_ONLY: Record<string, string> = {
  "packages/client-engine/src/consent-cutline.ts|consentIndex|p.rules":
    "the per-mailbox index itself, built from one document's rules",
  "packages/client-engine/src/engine.ts|consentIndex|rulesList(this.read())":
    "the held-release bell: that offer is served only for mailboxes this install organizes",
  "packages/client-engine/src/engine.ts|decidedDestination|index, address":
    "the same bell, over the same local index",
  "apps/webapp/app/shell/sender-screening.ts|consentIndex|[...wide, mine]":
    "a press planner asking the order of two rules the press itself writes",
  "apps/webapp/app/shell/sender-screening.ts|decidedDestination|consentIndex([...wide, mine]), match":
    "the same planner",
  "apps/mobile/src/state/live.ts|consentIndex|[...wide, mine]": "the phone's twin of that planner",
  "apps/mobile/src/state/live.ts|decidedDestination|consentIndex([...wide, mine]), match": "the same",
};

/** The two-argument sites — a total table, so a scanner that stops seeing calls goes red too. */
const PER_MAILBOX: Record<string, number> = {
  "packages/client-engine/src/consent-cutline.ts|consentIndex": 1,
  "packages/client-engine/src/consent-cutline.ts|decidedDestination": 4,
  "packages/client-engine/src/press-forecast.ts|consentIndex": 3,
  "packages/client-engine/src/press-outcome.ts|consentIndex": 1,
  "apps/webapp/app/shell/sender-screening.ts|consentIndex": 1,
  "apps/webapp/app/shell/sender-screening.ts|decidedDestination": 1,
  // The phone's twin of the web sheet's ruled place (`sender-stayed.ts#stayedAsk`), per mailbox too.
  "apps/mobile/src/state/sender-stayed.ts|consentIndex": 1,
  "apps/mobile/src/state/sender-stayed.ts|decidedDestination": 1,
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) yield p;
  }
}

/** Top-level commas of an argument span, so `f(a, g(b, c))` is two arguments. */
function args(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map((a) => a.replace(/\s+/g, " ").trim()).filter((a) => a !== "");
}

interface Call { file: string; fn: string; line: number; argv: string[] }

function calls(): Call[] {
  const out: Call[] = [];
  for (const root of ROOTS.map((r) => join(REPO, r)).filter(existsSync)) {
    for (const path of walk(root)) {
      const src = readFileSync(path, "utf8");
      const blank = withoutCommentsAndLiterals(src);
      for (const hit of blank.matchAll(/\b(consentIndex|decidedDestination)\s*\(/g)) {
        const before = blank.slice(Math.max(0, hit.index! - 20), hit.index!);
        if (/function\s*$/.test(before)) continue;
        const open = hit.index! + hit[0].length - 1;
        const s = bracketSpan(blank, open);
        expect(s.closed, `${relative(REPO, path)}:${lineOf(src, open)} runs away`).toBe(true);
        // Arguments read off the SOURCE at the blanked span, so a spread of a literal still reads.
        out.push({ file: relative(REPO, path), fn: hit[1]!, line: lineOf(src, open), argv: args(src.slice(s.start, s.end)) });
      }
    }
  }
  return out;
}

describe("a consent index names the mailbox it judges", () => {
  const found = calls();

  it("every one-argument site is a named local-only site, and every named one still exists", () => {
    const single = found.filter((c) => c.argv.length === 1 || (c.fn === "decidedDestination" && c.argv.length === 2));
    const keys = single.map((c) => `${c.file}|${c.fn}|${c.argv.join(", ")}`);
    for (const [i, k] of keys.entries()) {
      expect(LOCAL_ONLY[k], `${single[i]!.file}:${single[i]!.line} judges every mailbox by the local rules`).toBeDefined();
    }
    expect([...new Set(keys)].sort()).toEqual(Object.keys(LOCAL_ONLY).sort());
  });

  it("the per-mailbox sites are exactly the table's", () => {
    const counts: Record<string, number> = {};
    for (const c of found) {
      const wide = c.fn === "consentIndex" ? c.argv.length === 2 : c.argv.length === 3;
      if (wide) counts[`${c.file}|${c.fn}`] = (counts[`${c.file}|${c.fn}`] ?? 0) + 1;
    }
    expect(counts).toEqual(PER_MAILBOX);
  });

  it("the partition's own index is the per-mailbox one", () => {
    const partition = found.filter((c) => c.file.endsWith("consent-cutline.ts") && c.fn === "consentIndex" && c.argv.length === 2);
    expect(partition.map((c) => c.argv[1])).toEqual(["mailboxProfiles(reader)"]);
  });
});
