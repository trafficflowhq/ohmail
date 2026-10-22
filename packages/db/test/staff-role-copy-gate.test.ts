import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { STAFF_ROLE_LIVE_IN_PRODUCTION } from "../src/staff-grants.js";

/**
 * THE COPY-VS-PROVISIONING COUPLING, AS A BUILD FAILURE.
 *
 * The FAQ and the privacy policy tell customers, honestly, that the column-restricted Postgres
 * role is *built and tested but not yet live* and that today's isolation is an APPLICATION
 * property, not a database one. That is true while `scripts/harden-staff-role.sql` remains a
 * hand-run script nothing has run on the hosted service — and it becomes FALSE-BY-UNDERSTATEMENT
 * the day `ohmail_admin` is provisioned there: the protection is then database-enforced and the
 * copy still disclaims it.
 *
 * Nothing in the tree forced the copy edit; it was manual discipline, and "Claims are contracts"
 * (CLAUDE.md) does not run on discipline. This test makes the two move together. The single bit
 * of shared truth is {@link STAFF_ROLE_LIVE_IN_PRODUCTION} — the provisioning DECLARATION — and
 * the coupling is BIDIRECTIONAL, so neither the flag nor the copy can move without the other:
 *
 *  · flag `false` (today) ⇒ BOTH copy sites must STILL carry the honest disclaimers. This half
 *    stops the copy being edited to claim database enforcement the database is not yet giving.
 *  · flag `true`  ⇒ the disclaimers must be GONE from both sites. This half is the one a review finding is
 *    about: the provisioning commit cannot be green until the copy stops understating.
 *
 * `provision-staff-role.ts` refuses `--apply` while the flag is `false`, so the production run
 * itself is gated on the flag; this test gates the flag on the copy. Together the copy edit is a
 * precondition of provisioning, enforced by the build rather than remembered.
 *
 * The privacy policy is the hosted service's document and is not in this repository, so its half of
 * the coupling is not checked here; the FAQ answer is, and the live branch's positive control reads
 * it alone. {@link copyBreaches} is the whole rule as one function, driven below over planted copy in
 * both states of the flag.
 *
 * German is DELIBERATELY NOT CHECKED: the i18n slice owns `en.json`'s catalog translations, and
 * coupling the gate to `de.json` would make this test the thing that blocks a translation. The
 * English source is the claim of record; the translation follows it.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const EN_JSON = join(REPO, "apps", "webapp", "messages", "en.json");

/**
 * The phrases that are TRUE ONLY WHILE THE ROLE IS NOT LIVE. Each must be present when the flag
 * is `false` and absent when it is `true`. Chosen to be the load-bearing disclaimers, not
 * incidental words: each one is a sentence a provisioned role makes false.
 */
const DISCLAIMERS: ReadonlyArray<readonly [string, string]> = [
  ["en.json a5 — 'not yet live'", "built and tested but not yet live"],
  ["en.json a5 — 'does not yet refuse those columns'", "does not yet refuse those columns"],
];

function corpusFor(_label: string): string {
  const en = JSON.parse(readFileSync(EN_JSON, "utf8")) as { faq: { a5: string } };
  return en.faq.a5;
}

/** Does the copy name the database as what enforces the restriction? The wording is the author's. */
const claimsDb = (copy: string): boolean => {
  const s = copy.toLowerCase();
  return /database[^.]*\b(enforc|refus|reject)/.test(s) || /\b(enforc|refus|reject)[^.]*database/.test(s);
};

/** What the FAQ answer gets wrong for a flag value; empty when copy and flag agree. */
function copyBreaches(live: boolean, a5: string): string[] {
  const out: string[] = [];
  for (const [label, phrase] of DISCLAIMERS) {
    if (!live && !a5.includes(phrase)) out.push(`not live, but ${label} is gone`);
    if (live && a5.includes(phrase)) out.push(`live, but ${label} still says it`);
  }
  if (live && !claimsDb(a5)) out.push("live, but the copy does not name the database as the enforcer");
  return out;
}

describe("staff-role provisioning is coupled to the customer-facing copy", () => {
  it("the flag exists and is a boolean — the single bit of shared truth", () => {
    expect(typeof STAFF_ROLE_LIVE_IN_PRODUCTION).toBe("boolean");
  });

  if (!STAFF_ROLE_LIVE_IN_PRODUCTION) {
    // ── NOT LIVE (today): every disclaimer must STILL be present. ─────────────────────────
    it.each(DISCLAIMERS)(
      "while ohmail_admin is NOT live, the copy still discloses it: %s",
      (label, phrase) => {
        expect(
          corpusFor(label).includes(phrase),
          `STAFF_ROLE_LIVE_IN_PRODUCTION is false, but ${label} no longer carries its honest ` +
            `disclaimer ("${phrase}"). Either the copy was changed to over-claim database ` +
            `enforcement, or the flag should have been flipped to true in the same change.`,
        ).toBe(true);
      },
    );
  } else {
    // ── LIVE: every disclaimer must be GONE — the half. ────────────────────────────
    it.each(DISCLAIMERS)(
      "ohmail_admin is LIVE, so the copy must no longer understate it: %s",
      (label, phrase) => {
        expect(
          corpusFor(label).includes(phrase),
          `STAFF_ROLE_LIVE_IN_PRODUCTION is true (the role is provisioned), but ${label} still ` +
            `says "${phrase}". That statement is now false-by-understatement — the protection is ` +
            `database-enforced. Update the copy to say so in this same commit ("Claims are ` +
            `contracts").`,
        ).toBe(false);
      },
    );

    it("and the copy now asserts DATABASE enforcement", () => {
      // A positive control so 'live' cannot be satisfied by simply DELETING the disclaimer and
      // saying nothing. The exact wording is the copy author's; this only requires that the
      // database is named as the enforcer.
      expect(
        claimsDb(corpusFor("en.json a5")),
        "the role is live but the FAQ answer does not name the database as the enforcer — a live " +
          "protection the copy is silent about is the same contract gap in the other direction.",
      ).toBe(true);
    });
  }

  it("one rule for both states of the flag, on planted copy, and the live copy passes it", () => {
    const disclaims = `It is ${DISCLAIMERS[0]![1]}, and it ${DISCLAIMERS[1]![1]}.`;
    const enforced = "The database refuses them: the console reads through a column-restricted role.";
    const silent = "Our tools do not display message content.";
    expect(copyBreaches(false, disclaims)).toEqual([]);
    expect(copyBreaches(false, enforced)).toHaveLength(DISCLAIMERS.length);
    expect(copyBreaches(true, enforced)).toEqual([]);
    expect(copyBreaches(true, `${enforced} ${disclaims}`)).toHaveLength(DISCLAIMERS.length);
    expect(copyBreaches(true, silent)).toEqual(["live, but the copy does not name the database as the enforcer"]);
    expect(copyBreaches(STAFF_ROLE_LIVE_IN_PRODUCTION, corpusFor("en.json a5"))).toEqual([]);
  });
});
