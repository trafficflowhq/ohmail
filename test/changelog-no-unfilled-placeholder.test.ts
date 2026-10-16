import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * ═══ A PLACEHOLDER MAY WAIT IN [Unreleased]. IT MAY NOT SHIP IN A DATED BLOCK ════════════════
 *
 * Some notes cannot be finished when the code lands. A hosted fix names the day it reached ohmail
 * Cloud, and that day is the DEPLOY's, not the commit's — so the section is written with a
 * `<date>` placeholder and filled when the deploy happens.
 *
 * Both publish gates accept that placeholder, which is correct while the section sits under
 * `## [Unreleased]` and is exactly wrong once a release fold renames that heading to a dated one:
 * the literal text `<date>` would then be published to everybody who reads the changelog. Nothing
 * else notices, because a placeholder is ordinary prose to a prose gate and the section is in the
 * right place as far as the placement checker is concerned.
 *
 * So the rule is positional, and it is the only thing standing between "fill this in at deploy"
 * and a released note with an angle-bracketed hole in it: a placeholder is free under
 * `[Unreleased]` and refused under any heading carrying a date.
 *
 * `readFileSync`, never `grep`: one NUL byte anywhere in the file would make `grep` skip it in
 * silence and this guard would pass by reading nothing.
 */

const CHANGELOG = publicPath("CHANGELOG.md");

/**
 * THE PLACEHOLDER WORDS, A NAMED SET — not "any angle-bracketed lowercase word".
 *
 * The first version of this guard was that wider pattern and it went RED on the shipped file, on
 * `<time>` inside a line of quoted PRODUCT COPY: `"As of <time> · catching up"` (0.12.1). That is
 * a template the UI fills at render, described accurately in a release note — innocent content,
 * and a guard that fires on innocent content is the same defect as one that cannot fire and more
 * expensive, because it discards real work while looking like diligence.
 *
 * So the set is the three values a changelog section genuinely cannot know when it is written,
 * and the quote exemption below covers the case where one of THOSE words is being quoted rather
 * than left to fill.
 */
const PLACEHOLDER_WORDS = ["date", "version", "sha"] as const;
const PLACEHOLDER = new RegExp(`<(?:${PLACEHOLDER_WORDS.join("|")})>`, "g");

/**
 * Is this match inside a double-quoted span on its line — product copy, not a hole to fill?
 *
 * Counting quote characters before the match: an odd count means the match opened inside a quote.
 * Crude, and deliberately so — the alternative is parsing Markdown to find code spans, and the
 * only thing that has ever needed exempting is a quoted UI string on one line.
 */
function insideQuotes(line: string, index: number): boolean {
  let quotes = 0;
  for (let i = 0; i < index; i++) {
    const ch = line[i]!;
    if (ch === '"' || ch === "\u201c" || ch === "\u201d") quotes++;
  }
  return quotes % 2 === 1;
}

/** `## [0.15.0] — 2026-09-09` is dated; `## [Unreleased]` is not. */
function isDatedHeading(line: string): boolean {
  return /^## /.test(line) && /\d{4}-\d{2}-\d{2}/.test(line);
}

/** Every placeholder, with the `## ` heading that encloses it. */
export function placeholdersByBlock(text: string): Array<{ heading: string; line: number; found: string }> {
  const out: Array<{ heading: string; line: number; found: string }> = [];
  let heading = "(above the first heading)";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^## /.test(line)) { heading = line.trim(); continue; }
    for (const m of line.matchAll(PLACEHOLDER)) {
      if (insideQuotes(line, m.index)) continue;
      out.push({ heading, line: i + 1, found: m[0] });
    }
  }
  return out;
}

describe("the changelog carries no unfilled placeholder in a released section", () => {
  const text = readFileSync(CHANGELOG, "utf8");

  it("has no placeholder under any DATED heading", () => {
    const shipped = placeholdersByBlock(text).filter((p) => isDatedHeading(p.heading));
    // The failure names the heading and the line, because the fix is to fill the value in — the
    // deploy date, the version — never to delete the sentence.
    expect(shipped).toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL. A guard that only ever asserts an absence has no evidence it can fire,
   * and this one would pass on a changelog with no placeholders anywhere — including a changelog
   * this test cannot read at all.
   */
  it("FINDS a placeholder that has been moved under a dated heading", () => {
    const fixture = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Still to come",
      "",
      "## [0.15.0] — 2026-09-09",
      "",
      "### A hosted fix",
      "",
      "Fixed on ohmail Cloud on <date>; in the desktop app with this release.",
      "",
    ].join("\n");
    const shipped = placeholdersByBlock(fixture).filter((p) => isDatedHeading(p.heading));
    expect(shipped).toHaveLength(1);
    expect(shipped[0]!.found).toBe("<date>");
    expect(shipped[0]!.heading).toBe("## [0.15.0] — 2026-09-09");
  });

  /**
   * THE EXEMPTION'S OWN CONTROL. A carve-out nobody has watched work is a hole: this asserts the
   * quoted form is spared AND that the same word unquoted on the same heading is caught, so the
   * exemption cannot be widened into "never fires" without this going red.
   */
  it("spares a QUOTED placeholder word in product copy, and still catches an unquoted one", () => {
    const quoted = [
      "## [0.12.1] — 2026-08-30",
      "",
      'The strip says it honestly: "As of <date> · catching up" until the mirror converges.',
      "",
    ].join("\n");
    expect(placeholdersByBlock(quoted).filter((p) => isDatedHeading(p.heading))).toEqual([]);

    const unquoted = [
      "## [0.12.1] — 2026-08-30",
      "",
      "Fixed on ohmail Cloud on <date>.",
      "",
    ].join("\n");
    expect(placeholdersByBlock(unquoted).filter((p) => isDatedHeading(p.heading))).toHaveLength(1);
  });

  it("leaves the same placeholder alone under [Unreleased]", () => {
    const fixture = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "Fixed on ohmail Cloud on <date>; in the desktop app with this release.",
      "",
      "## [0.15.0] — 2026-09-09",
      "",
    ].join("\n");
    expect(placeholdersByBlock(fixture).filter((p) => isDatedHeading(p.heading))).toEqual([]);
    // And it IS seen — the filter is what spares it, not a scanner that missed it.
    expect(placeholdersByBlock(fixture)).toHaveLength(1);
  });

  /**
   * The live file's own state, asserted rather than assumed. While the away-responder fix waited
   * for its hosted deploy this case asserted ONE placeholder under `[Unreleased]`; the deploy
   * happened on 2026-09-09 and the date was filled, so the expectation went to zero — the
   * deliberate edit the earlier wording of this comment announced. The guard's non-vacuity is
   * carried by the fixture case above, which is what makes this flip safe.
   */
  it("carries no placeholder anywhere now that the deploy date is filled", () => {
    expect(placeholdersByBlock(text)).toEqual([]);
  });
});
