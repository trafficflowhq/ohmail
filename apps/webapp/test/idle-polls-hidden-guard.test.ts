import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/* The one-pass scanner: comments and string bodies blanked in place, so a poll that merely
   MENTIONS the guard in its docblock cannot pass for one that asks it, and `file:line` stays
   true. */
import * as scan from "../../../scripts/lib/source-scan.mjs";

/**
 * ═══ NOBODY IS LOOKING, SO NOTHING IS OWED ════════════════════════════════════════════════
 *
 * Three standing polls run in the shell — the mailbox facts, the desktop's freshness read and
 * the build watch. One asked `document.visibilityState` inline, two asked nothing, and a hidden
 * window went on asking every five, thirty and sixty seconds behind everything else on the
 * machine. They now ask one guard, `documentHidden()`.
 *
 * A CENSUS AND NOT THREE TESTS: the failure was a poll that nobody thought of, so what is held
 * here is EVERY `setInterval` in those files. One that does not ask the guard is red unless it
 * is named below with the reason it issues no request — and an exemption that stops matching is
 * red too, because a rule kept alive by a stale entry is a rule about nothing.
 *
 * MUTATION-PROVEN AT AUTHORING TIME (applied, watched red, restored, `cmp`-verified):
 *   · the guard removed from the build watch alone — 1 of 5 red, the case naming
 *     `build-watch.ts:133`; the census's own four structural cases stay green.
 *   · the guard removed from the freshness poll — 1 of 5 red, naming `MailStateProvider.tsx`.
 */

const root = new URL("../", import.meta.url);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

const GUARD = "documentHidden()";

/** Where the standing polls live. Every `setInterval` in these files is censused. */
const POLL_FILES = ["app/shell/MailStateProvider.tsx", "../../packages/app-logic/src/doors/build-watch.ts"];

/**
 * The intervals that issue no request, by a token in their own callback. A beat that moves a
 * clock costs a render and nothing else, and stopping it while hidden would freeze the elapsed
 * minutes a return to the tab has to be right about.
 */
const NO_REQUEST: Array<{ token: string; why: string }> = [
  { token: "setBeat(Date.now())", why: "the strip's clock — a render, no request" },
];

interface Site { file: string; line: number; body: string }

/** Every `setInterval(` in one file, with the text of the call it makes. */
function intervalSites(file: string): Site[] {
  const src = scan.withoutCommentsAndLiterals(read(file));
  const out: Site[] = [];
  for (let at = src.indexOf("setInterval("); at !== -1; at = src.indexOf("setInterval(", at + 1)) {
    const open = src.indexOf("(", at);
    const { start, end, closed } = scan.bracketSpan(src, open, "(", ")");
    expect(closed, `${file}: an unclosed setInterval( at line ${scan.lineOf(src, at)}`).toBe(true);
    out.push({ file, line: scan.lineOf(src, at), body: src.slice(start, end) });
  }
  return out;
}

const SITES = POLL_FILES.flatMap(intervalSites);

describe("every standing poll asks the one guard", () => {
  it("the census finds the intervals it exists to hold", () => {
    // A census that found nothing would pass every case below it.
    expect(SITES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SITES.map((s) => s.file)).size).toBe(POLL_FILES.length);
  });

  it("each one asks the guard, or is named as issuing no request", () => {
    const unguarded = SITES
      .filter((s) => !s.body.includes(GUARD))
      .filter((s) => !NO_REQUEST.some((e) => s.body.includes(e.token)))
      .map((s) => `${s.file}:${s.line}`);
    expect(unguarded).toEqual([]);
  });

  it("no exemption outlives what it exempts", () => {
    for (const e of NO_REQUEST) {
      expect(SITES.some((s) => s.body.includes(e.token)), `${e.token} (${e.why})`).toBe(true);
    }
  });

  it("ONE guard: the three callers import it and nobody spells it a second way", () => {
    for (const file of POLL_FILES) {
      expect(read(file)).toMatch(/from "(?:@ohmail\/app-logic|\.\.)\/session\/document-hidden(?:\.js)?"/);
    }
    /* The inline spelling the guard replaced may not come back beside it. `=== "visible"` is a
       different question — the build watch asks the moment a tab RETURNS, which is when a newer
       build is worth saying — so only the guard's own question is refused here. */
    for (const file of POLL_FILES) {
      const src = scan.withoutCommentsAndLiterals(read(file));
      expect(/visibilityState\s*===\s*.hidden/.test(src), file).toBe(false);
      expect(/document\.hidden/.test(src), file).toBe(false);
    }
  });

  it("THE POSITIVE ARM: the same reader refuses a poll that asks nothing", () => {
    // The checker is driven over a source it must refuse, so a green above is a reading about
    // the product rather than about a checker that cannot fail.
    const fixture = scan.withoutCommentsAndLiterals(
      "const id = setInterval(() => { void read(); }, FACTS_POLL_MS);",
    );
    const open = fixture.indexOf("(", fixture.indexOf("setInterval("));
    const { start, end } = scan.bracketSpan(fixture, open, "(", ")");
    const body = fixture.slice(start, end);
    expect(body.includes(GUARD)).toBe(false);
    expect(NO_REQUEST.some((e) => body.includes(e.token))).toBe(false);
  });
});
