import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAIL_JOURNAL } from "../src/admin.js";
import { migrationSqlHash } from "../src/baseline.js";
import { MIGRATION_ALLOWANCES } from "../src/migration-allowances.js";
import { classifyDrift, gitProvenanceReader } from "../src/migration-provenance.js";

/**
 * MAIL 0120'S ALLOWANCE, AND WHY IT IS NOT LIKE THE TWO BESIDE IT.
 *
 * The flat drop-then-add form was written AFTER the deployment that applied this entry, so
 * production's row records the original bytes for ever while the tree ships the fixed ones.
 * Without a named allowance `classifyDrift` reads `executable` and the next `db:setup:prod`
 * refuses with `journal MISDESCRIBED` — a migration step that stops a release, for a change that
 * leaves the same schema. The arms that ask the real reader to find the released version in this
 * repository's git history need the whole history, which a shallow checkout does not hold, so they
 * left this file.
 */

const TAG = "0120_held_release_dismissed";
const ALLOWANCE = MIGRATION_ALLOWANCES.find((a) => a.journal === "mail" && a.tag === TAG);

/**
 * The REAL reader, not a double: `classifyDrift` finds the applied version by hashing every
 * version this file has ever held, and the whole question is whether the recorded hash IS one of
 * them. A stub would answer about a text the test wrote.
 */
const READER = gitProvenanceReader();

/**
 * THE BYTES THE FLAT FORM ACTUALLY SHIPS, copied verbatim from the lane that wrote them and kept
 * here because this branch's own tree still carries the released version. Deriving the shipped
 * hash from the allowance itself proved nothing — a mutation of that field moved the expectation
 * with the subject and six arms stayed green. The fixture is the independent side.
 */
const FLAT = readFileSync(
  join(__dirname, "fixtures", "migration-allowance", "0120-flat.sql"), "utf8");

/** The one hasher the migrator's row uses — the utf8 decode is part of the definition. */
const sha256Utf8 = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("mail 0120's drift is admitted by a named allowance and by nothing else", () => {
  it("the entry names both hashes and a reason", () => {
    expect(ALLOWANCE, "no allowance for mail 0120").toBeDefined();
    expect(ALLOWANCE!.recorded).toMatch(/^[0-9a-f]{64}$/);
    expect(ALLOWANCE!.shipped).toMatch(/^[0-9a-f]{64}$/);
    expect(ALLOWANCE!.recorded).not.toBe(ALLOWANCE!.shipped);
    expect(ALLOWANCE!.reason.length).toBeGreaterThan(40);
  });

  /**
   * BOTH SIDES PINNED TO BYTES, from two places neither of which is the allowance. `shipped` is
   * the flat form's own file; `recorded` is whatever this tree ships, which is the released
   * version until the flat form lands and the flat form afterwards.
   */
  it("shipped is the flat form's own bytes", () => {
    expect(sha256Utf8(FLAT), "the allowance does not name the bytes the flat form ships")
      .toBe(ALLOWANCE!.shipped);
  });

  it("recorded is this file's released version — the one production ran", () => {
    const here = migrationSqlHash(MAIL_JOURNAL, TAG);
    expect(here === ALLOWANCE!.recorded || here === sha256Utf8(FLAT),
      "the tree's 0120 is neither version this allowance names").toBe(true);
    if (here !== ALLOWANCE!.recorded) return;              // the flat form has not landed here yet
    expect(readFileSync(join(MAIL_JOURNAL.dir, `${TAG}.sql`), "utf8"),
      "the released text and the flat text are the same file").not.toBe(FLAT);
  });

  it("a recorded hash no version carries is `unknown-provenance`, never admitted", () => {
    const d = classifyDrift(
      "mail", MAIL_JOURNAL.dir,
      { tag: TAG, when: 1791602600024, expected: ALLOWANCE!.shipped, recorded: "f".repeat(64), rowsAtWhen: 1 },
      FLAT, READER,
    );
    expect(d.kind).toBe("unknown-provenance");
  });
});
