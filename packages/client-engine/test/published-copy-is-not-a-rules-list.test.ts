import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lineOf, withoutComments } from "../../../scripts/lib/source-scan.mjs";

/* @reads: apps/webapp/app/ apps/mobile/src/
   Walked by path, so a landing selects this file when either root moves. */

/**
 * THE ORGANIZER'S PUBLISHED COPY IS NOT A RULES LIST (ARCH-RULES-PAGE-INVARIANT §0, amended): a
 * press names only local entities. `mailbox_profile` decides whose rules a HELD mailbox's mail is
 * judged by (the consent index and the press readings built on it), and one reader lists it for a
 * reader-only Rules page, `rules-shown.ts`, which hands every row a local id or none (doorless) and
 * lays the device's applied presses over it. Any other surface listing the published copy as rules
 * is the false state VERIFY-026 measured, so every reader is named here with its reason, and the
 * rules page, the phone's UI and `enrich` are refused outright. Read in one pass, comments blanked;
 * a planted view proves the refusal.
 */
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const ROOTS = ["packages/client-engine/src", "apps/webapp/app", "apps/mobile/src"];
const SKIP = new Set(["node_modules", "dist", ".next"]);

/** Every file that reads the published copy, and the consent question it reads it for. */
const ADMITTED: Record<string, string> = {
  "packages/client-engine/src/consent-cutline.ts": "the definition, and the consent index judging a held mailbox's mail",
  "packages/client-engine/src/press-forecast.ts": "a press's forecast through the consent index",
  "packages/client-engine/src/rules-shown.ts": "a reader-only Rules page's list: the copy, local ids or doorless rows, applied presses laid over it",
  "apps/webapp/app/shell/press-verdict.ts": "what a press did, read through `pressOutcome`'s consent reading",
  "apps/webapp/app/shell/sender-screening.ts": "the sender sheet's consent index (where the sender's mail is judged)",
  "apps/mobile/src/state/live.ts": "`pressOutcome`'s `profiles:`, the consent reading of a press",
  "apps/mobile/src/state/sender-stayed.ts": "why a sender stayed: the decided destination through the consent index",
  "apps/webapp/app/shell/AppShell.tsx": "the GET /consent doorbell: each row's id and seq, never its content (RULING-026)",
};
/** Where a published-copy read is refused whatever its reason: the surfaces that list rules. */
const REFUSED_ZONES = [/^apps\/webapp\/app\/views\//, /^apps\/webapp\/app\/shell\/rules-/, /^apps\/mobile\/src\/ui\//];

const READ = /\bmailboxProfiles\s*\(|\.(?:list|get|entries)\s*(?:<[^>()]*>)?\s*\(\s*(?:MAILBOX_PROFILE_TYPE\b|["']mailbox_profile["'])/g;

/** Each read in a source, by line; the definition of `mailboxProfiles` is not a read. */
export function profileReads(src: string): number[] {
  const code = withoutComments(src).replace(/function\s+mailboxProfiles\s*\(/g, (m) => " ".repeat(m.length));
  return [...code.matchAll(READ)].map((m) => lineOf(src, m.index!));
}

function sources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (SKIP.has(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts")) out.push({ rel: relative(REPO, p), src: readFileSync(p, "utf8") });
    }
  };
  for (const r of ROOTS) if (existsSync(join(REPO, r))) walk(join(REPO, r));
  return out;
}
const judge = (files: Array<{ rel: string; src: string }>): string[] => files.flatMap(({ rel, src }) => {
  const at = profileReads(src);
  if (at.length === 0) return [];
  if (REFUSED_ZONES.some((z) => z.test(rel))) return at.map((l) => `${rel}:${l} (a rules surface)`);
  if (rel === "packages/client-engine/src/engine.ts") return at.map((l) => `${rel}:${l} (the engine)`);
  return rel in ADMITTED ? [] : at.map((l) => `${rel}:${l} (not named)`);
});

describe("the organizer's published copy is not a rules list", () => {
  it("refuses a rules surface that reads it, admits a named consent reader, reads prose as nothing (controls)", () => {
    const planted = "const rules = mailboxProfiles(reader).flatMap((p) => p.rules);";
    expect(judge([{ rel: "apps/webapp/app/views/Fixture.tsx", src: planted }])).toEqual(["apps/webapp/app/views/Fixture.tsx:1 (a rules surface)"]);
    expect(judge([{ rel: "apps/webapp/app/views/Fixture.tsx", src: 'reader.list<X>("mailbox_profile")' }])).toHaveLength(1);
    expect(judge([{ rel: "apps/webapp/app/shell/sender-screening.ts", src: planted }])).toEqual([]);
    expect(judge([{ rel: "apps/webapp/app/views/Fixture.tsx", src: "// mailboxProfiles(reader) is not read here" }])).toEqual([]);
  });

  it("every reader in the three roots is named, and no rules surface reads it", () => {
    const files = sources();
    expect(files.length, "the walk read nothing").toBeGreaterThan(200);
    expect(judge(files)).toEqual([]);
    const reading = new Set(files.filter((f) => profileReads(f.src).length > 0).map((f) => f.rel));
    expect(Object.keys(ADMITTED).filter((k) => !reading.has(k)), "a named reader no longer reads it: drop its row").toEqual([]);
  });
});
