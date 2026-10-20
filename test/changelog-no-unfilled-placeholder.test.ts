import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fold, isDatedHeading, PLACEHOLDER_WORDS, placeholdersByBlock, readFragments } from "../scripts/changelog-fold.mjs";
import { publicPath } from "./support/public-root.mjs";

/**
 * ═══ A PLACEHOLDER MAY WAIT IN AN UNRELEASED ENTRY. IT MAY NOT SHIP IN A DATED BLOCK ═════════
 *
 * Unreleased entries are files in changelog.d/ now (scripts/changelog-fold.mjs); the reasoning below
 * holds for them, and the fold refuses a placeholder before it writes the dated block.
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

/*
 * The detector lives in scripts/changelog-fold.mjs, which refuses the same placeholder at the release
 * fold. THE WORDS ARE A NAMED SET, not "any angle-bracketed word": the wider pattern went red on
 * `"As of <time> · catching up"`, quoted product copy in 0.12.1. A placeholder inside double quotes on
 * its line is copy and is spared.
 */

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

  /* Entries wait in changelog.d/ now, so that is where a placeholder waits, and the release fold is
   * what turns it into a dated block: it must refuse there, before anything is written. */
  it("may wait in a fragment, and --release refuses it", () => {
    expect([...PLACEHOLDER_WORDS]).toEqual(["date", "version", "sha"]);
    const root = mkdtempSync(join(tmpdir(), "changelog-placeholder-"));
    try {
      mkdirSync(join(root, "changelog.d"));
      writeFileSync(join(root, "changelog.d", "hosted-fix.md"), "### A hosted fix\n\nFixed on ohmail Cloud on <date>.\n");
      const { fragments, problems } = readFragments(root);
      expect(problems).toEqual([]);
      const changelog = [
        "# Changelog", "", "## [Unreleased]", "", "See [changelog.d/](changelog.d/).", "", "### Still to come", "",
        "## [0.15.0] — 2026-09-09", "", "### Earlier", "", "Text.", "",
        "[Unreleased]: https://github.com/trafficflowhq/ohmail/compare/v0.15.0...HEAD", "",
      ].join("\n");
      expect(() => fold(changelog, fragments, "0.15.1", "2026-09-10")).toThrow("changelog.d/hosted-fix.md:3: an unfilled <date>");
      const filled = [{ ...fragments[0]!, body: "Fixed on ohmail Cloud on 2026-09-10." }];
      const out = fold(changelog, filled, "0.15.1", "2026-09-10");
      expect(placeholdersByBlock(out).filter((p) => isDatedHeading(p.heading))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
