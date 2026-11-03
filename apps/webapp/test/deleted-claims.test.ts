/**
 * EVERY "NOTHING IS DELETED" CLAIM BECOMES "NEVER ON ITS OWN" (FOLDERS-SPEC.md §16.3).
 *
 * The Delete verb ships (a user-commanded move to the provider's native \Trash), so the
 * ABSOLUTE claim is false the moment a user presses it: something IS deleted — by them. What
 * stays true, and what the copy must now say, is that ohmail deletes nothing ON ITS OWN
 * INITIATIVE. `CLAUDE.md`: claims are contracts; the sweep ships in the same wave as the verb.
 *
 * Found by the sweep and reworded here:
 *   · `screener.empty.spam.hint`               — was "… nothing is deleted unseen."
 *   · `settings.screening.autoApplyDescription` — was "… nothing is deleted." (since removed with
 *                                                  its switch)
 *
 * Audited by the same sweep and LEFT ALONE, because each is scoped and true:
 *   · `host.offWhat`          — pairing: turning the desktop host off deletes nothing about
 *                               the paired DEVICES. True — the off switch performs no delete.
 *   · `settings.storage.cloudBody` ("never deleted for space") — scoped to the storage cap's
 *                               eviction, which `storage-evict` genuinely never applies to
 *                               stored mail. The Delete verb does not make it false: the verb
 *                               is the user's, not a space policy.
 *   · account-deletion / draft-discard copy — statements that something IS deleted, which is
 *                               the opposite claim and exactly as load-bearing.
 *
 * The scan below is what keeps the audit from rotting: a NEW absolute claim anywhere in either
 * catalogue fails the allowlist assertion, so it cannot ship unexamined.
 */
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

/** Every (key-path, sentence) pair in a catalogue. */
function entries(node: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof node === "string") return [[path.join("."), node]];
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      entries(v, [...path, k]),
    );
  }
  return [];
}

/** The absolute claim, in each language's shapes. */
const ABSOLUTE_EN = /nothing is (?:ever )?deleted/i;
const ABSOLUTE_DE = /nichts wird gelöscht|gelöscht wird nichts/i;

describe("the delete-claims sweep", () => {
  it("the reworded sentence says ON ITS OWN, in both languages", () => {
    type Cat = { screener: { empty: { spam: { hint: string } } } };
    const enSpam = (en as unknown as Cat).screener.empty.spam.hint;
    const deSpam = (de as unknown as Cat).screener.empty.spam.hint;

    expect(enSpam).toContain("on its own");
    expect(deSpam).toContain("von sich aus");
    expect(enSpam).not.toMatch(ABSOLUTE_EN);
    expect(deSpam).not.toMatch(ABSOLUTE_DE);
  });

  it("the Junk retention sentence carries NO hard number, in either language", () => {
    // FOLDERS-SPEC.md §16.2: "your mail server may delete junk on its own schedule" — providers
    // differ, and a number here would be a claim about somebody else's cleanup job. Pinned as
    // the absence of any digit, so "within 30 days" cannot creep in through a copy edit.
    type Cat = { screener: { junkRetention: string } };
    const enR = (en as unknown as Cat).screener.junkRetention;
    const deR = (de as unknown as Cat).screener.junkRetention;
    expect(enR.length).toBeGreaterThan(0);
    expect(deR.length).toBeGreaterThan(0);
    expect(enR).not.toMatch(/\d/);
    expect(deR).not.toMatch(/\d/);
  });

  it("no UNAUDITED absolute claim exists anywhere in either catalogue", () => {
    // The allowlist is the audit. A new key matching the absolute shape lands here red and has
    // to be either scoped-and-true (add it WITH its argument, like the entries above) or
    // reworded to "on its own".
    const audited = new Set(["host.offWhat"]);

    const enHits = entries(en).filter(([, v]) => ABSOLUTE_EN.test(v)).map(([k]) => k);
    const deHits = entries(de).filter(([, v]) => ABSOLUTE_DE.test(v)).map(([k]) => k);

    // "never deleted for space" is scoped by its own words, so it does not match the absolute
    // shape — assert that stays true rather than allowlisting it.
    expect(enHits.filter((k) => !audited.has(k))).toEqual([]);
    expect(deHits.filter((k) => !audited.has(k))).toEqual([]);
  });
});
