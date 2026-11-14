import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COPY_CENSUS_ROOTS,
  isProse,
  scanCopy,
  scanKeyReads,
  type CopyFinding,
} from "./copy-census.scan.js";
import { EXEMPT, UNTRANSLATED } from "./copy-census.ledger.js";

/**
 * ═══ EVERY WORD ON SCREEN COMES FROM THE CATALOGUE ════════════════════════════════════════
 *
 * The gap this closes, exactly: with Language = Deutsch the Screener drew a German rail, German
 * filter chips and an ENGLISH decision bar — "Receipts", "Screen out", "this sender", "whole
 * domain", "Becomes a rule — future mail from … files automatically." The words were literals in
 * `packages/ui/src/composites/DecisionBar.tsx`, which is the one place in this tree that cannot
 * read `messages/*.json`. The German for four of them was already in the catalogue; nothing
 * connected the two, and nothing could tell.
 *
 * Twelve other composites had the same shape, and three of them were worse than a literal in the
 * markup — an English DEFAULT on an optional prop (`doneLabel = "Done → next"`,
 * `placeholder = "Type a command…"`, `label = "Verification code"`), which compiles, renders, and
 * is wrong only in the locale nobody on the team reads.
 *
 * So: `packages/ui` composites take their words as props; the shell and views resolve them; and
 * this file is what stops the next one. `pnpm typecheck` cannot see a string, and neither can a
 * suite that renders in English.
 *
 * The scan is `./copy-census.scan.ts`; the dispositions are `./copy-census.ledger.ts`. Both
 * directions are enforced, so the ledger cannot rot and the scan cannot be quietly narrowed.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const findings: CopyFinding[] = scanCopy(REPO);
const distinct = (rows: CopyFinding[]): Set<string> => new Set(rows.map((r) => r.text));
const byFile = new Map<string, CopyFinding[]>();
for (const f of findings) {
  const rows = byFile.get(f.file) ?? [];
  rows.push(f);
  byFile.set(f.file, rows);
}

describe("the copy census — the scan itself", () => {
  /**
   * A SCAN OVER NOTHING FINDS NOTHING AND PASSES, which is the failure mode every census in this
   * repo has had to be defended against. The floor is deliberately far below the real number:
   * it catches a broken walk, not a lane that closed strings.
   */
  it("reads the interface sources, and says so with a number", () => {
    expect(COPY_CENSUS_ROOTS.length).toBe(6);
    expect(findings.length).toBeGreaterThan(50);
    expect(byFile.size).toBeGreaterThan(5);
  });

  /** The prose rule, pinned by example — it is what decides whether a finding exists at all. */
  it("prose is a phrase or a label; class names, DOM tokens and keys are not", () => {
    for (const yes of ["Screen out", "whole domain", "Stop", "Suggestions", "Becomes a rule"]) {
      expect(isProse(yes), `${yes} should be prose`).toBe(true);
    }
    for (const no of ["scn-bulk", "status", "ohbox", "aria-live", "px", "j k"]) {
      expect(isProse(no), `${no} should not be prose`).toBe(false);
    }
  });
});

describe("every user-visible string is either in the catalogue or dispositioned", () => {
  it("no interface source writes a word that no ledger row accounts for", () => {
    const unaccounted: string[] = [];
    for (const [file, rows] of byFile) {
      if (file in UNTRANSLATED) continue;
      const allowed = new Set((EXEMPT[file] ?? []).map((e) => e.text));
      for (const text of distinct(rows)) {
        if (!allowed.has(text)) {
          const at = rows.find((r) => r.text === text)!;
          unaccounted.push(`${file}:${at.line} [${at.kind}] ${JSON.stringify(text)}`);
        }
      }
    }
    expect(
      unaccounted,
      "a component is writing its own words. Move them to `apps/webapp/messages/{en,de}.json` "
        + "and pass them in as props — or, if the string is a brand, a keycap or code, add a row "
        + "to `copy-census.ledger.ts` saying which.",
    ).toEqual([]);
  });

  it("no ledger exemption has rotted — every row still matches a live string", () => {
    const stale: string[] = [];
    for (const [file, rows] of Object.entries(EXEMPT)) {
      const live = distinct(byFile.get(file) ?? []);
      for (const row of rows) {
        if (!live.has(row.text)) stale.push(`${file}: ${JSON.stringify(row.text)}`);
      }
    }
    expect(stale, "these exemptions name strings that are gone — delete the rows").toEqual([]);
  });

  it("every exemption gives a reason", () => {
    for (const [file, rows] of Object.entries(EXEMPT)) {
      for (const row of rows) {
        expect(row.why.length, `${file}: ${row.text} has no reason`).toBeGreaterThan(10);
      }
    }
  });
});

describe("every key the code reads is in BOTH catalogues", () => {
  /**
   * THE SUITE DOES NOT FAIL ON A MISSING KEY, which is why this is here rather than left to the
   * render tests. `use-intl` reports `MISSING_MESSAGE` through its error channel and renders the
   * dotted key; every assertion about structure still passes. Measured on 2026-09-03: a missing
   * `palette.ariaLabel` produced thousands of stderr lines across the webapp suite and exit code 0,
   * while the shell was drawing `palette.ariaLabel` as the palette's accessible name.
   *
   * BOTH catalogues, not just English: `fillFrom` covers a German gap with the English sentence,
   * so a key missing from `de.json` alone renders English rather than a raw key — quieter, and
   * exactly the half-English screen this lane exists to end.
   */
  const KEY_ROOTS = ["apps/webapp/app/shell", "apps/webapp/app/views", "apps/webapp/app/letter-body", "packages/app-logic/src", "apps/desktop/src"];
  const cat = (lang: "en" | "de"): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(REPO, `apps/webapp/messages/${lang}.json`), "utf8"));
  const EN = cat("en");
  const DE = cat("de");
  const at = (root: Record<string, unknown>, dotted: string): unknown =>
    dotted.split(".").reduce<unknown>(
      (o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      root,
    );

  const reads = scanKeyReads(REPO, KEY_ROOTS);

  it("finds the reads at all", () => {
    expect(reads.length).toBeGreaterThan(500);
  });

  /**
   * THE OTHER DIRECTION, FOR ONE KEY. `screening.ruleRetro` ("· applies to the N messages already
   * here") shipped in both catalogues and was rendered by nothing — and a string with no consumer
   * is also the shape a needle-based test reads as covered. It went rather than gaining a surface:
   * the toggle's own note already states the count. The live sibling keeps this honest — without
   * it the case passes on a scan that sees nothing in this namespace at all.
   */
  it("the retro recommendation nobody rendered is gone, and its live sibling is not", () => {
    expect(at(EN, "screening.ruleRetro"), "a string with no surface is back in en.json").toBeUndefined();
    expect(at(DE, "screening.ruleRetro"), "a string with no surface is back in de.json").toBeUndefined();
    expect(reads.some((r) => r.dotted === "screening.ruleRetro")).toBe(false);
    expect(typeof at(EN, "screening.retroToggle")).toBe("string");
    expect(typeof at(DE, "screening.retroToggle")).toBe("string");
    expect(reads.some((r) => r.dotted === "screening.retroToggle")).toBe(true);
  });

  it("no `t(\"…\")` names a key the catalogues have not got", () => {
    const missing = reads
      .filter((r) => typeof at(EN, r.dotted) !== "string" || typeof at(DE, r.dotted) !== "string")
      .map((r) => `${r.file}:${r.line}  ${r.dotted}`
        + `  en=${typeof at(EN, r.dotted)} de=${typeof at(DE, r.dotted)}`);
    expect(
      [...new Set(missing)],
      "these render as the raw dotted key. Add them to messages/en.json AND messages/de.json.",
    ).toEqual([]);
  });
});

describe("the desktop window's untranslated panes — ratcheted, not waived", () => {
  /**
   * The count is EXACT in both directions on purpose. A lane translating a pane has to edit the
   * number down in the same commit, and a lane adding an English literal to one of these files
   * goes red — so "these are known" cannot quietly become "these grew".
   */
  it("each recorded pane holds exactly the number of strings the ledger claims", () => {
    const drift: string[] = [];
    for (const [file, row] of Object.entries(UNTRANSLATED)) {
      const live = distinct(byFile.get(file) ?? []).size;
      if (live !== row.count) drift.push(`${file}: ledger says ${row.count}, scan found ${live}`);
    }
    expect(
      drift,
      "a recorded pane changed. Fewer: edit the count down. More: a new English literal was added "
        + "to a file that is already an open German gap.",
    ).toEqual([]);
  });

  it("every recorded pane still exists and still has strings", () => {
    for (const file of Object.keys(UNTRANSLATED)) {
      expect(byFile.has(file), `${file} is in the ledger but the scan found nothing there`).toBe(true);
    }
  });

  it("a pane is either untranslated or exempted, never both", () => {
    for (const file of Object.keys(UNTRANSLATED)) {
      expect(EXEMPT[file], `${file} is in both tables`).toBeUndefined();
    }
  });
});
