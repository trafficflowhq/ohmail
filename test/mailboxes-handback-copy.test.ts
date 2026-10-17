import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * THE STOP VERB'S (i) AND THE DUAL-MODE CONTRACT SAY THE SAME THING.
 *
 * Settings → Mailboxes offers "Hand the mailbox back — the mail stays where it is." with a
 * gloss stating what follows — on the desktop AND in the browser, from one key; see the
 * one-verb case at the foot of this file. The dual-mode design fixes what follows: on its next
 * cycle the install BECOMES A READER — it keeps reading, moves nothing,
 * screens nothing, its rules are not applied — and NOTHING takes the mailbox over by itself: an
 * explicit press on another install (or adding the mailbox to Cloud) is the only way it changes
 * hands. A sentence that drops one of the consequences under-states the stop; one that promises
 * a hand-over over-states it, in the direction the product is most careful about — an install
 * silently becoming the thing that moves someone's mail.
 *
 * Both catalogues are read, because German ships with English and a German sentence that
 * promises something the English does not is the same defect in another language. The design
 * record's own wording is checked by the process project (`mailboxes-handback-copy.docs.test.ts`).
 *
 * This lives in the root suite rather than beside the pane's tests on purpose: the desktop's test
 * directory is published, and a published test that opens an internal document would fail in the
 * public repository for a reason that has nothing to do with the code.
 *
 * WATCHED RED at authoring time by editing a copy of each catalogue: dropping "screens nothing"
 * reddens the consequence case for that locale alone; replacing "Nothing takes the mailbox over
 * by itself" with "the mailbox is handed over" reddens the promise case alone; removing the
 * "Organize here" clause reddens the press case alone.
 */

const ROOT = resolve(__dirname, "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

type Catalogue = { mailboxes: Record<string, string> };
const en = JSON.parse(read("apps/webapp/messages/en.json")) as Catalogue;
const de = JSON.parse(read("apps/webapp/messages/de.json")) as Catalogue;

/**
 * The three consequences and the press, per locale, as the WORDS the catalogue uses for them
 * elsewhere — "moves nothing and screens nothing" is `readerReadsOnly`'s phrasing, "rules" is the
 * organizer sentence's — so the gloss cannot drift into a synonym the rest of the pane never uses.
 */
const CONSEQUENCES = {
  en: {
    reads: /\bread(s|ing)\b/,
    movesNothing: /moves nothing/,
    screensNothing: /screens nothing/,
    rules: /\brules\b/,
    nothingByItself: /nothing takes (the mailbox|it) over by itself/i,
    promise: /\b(is|gets|will be) handed over\b|\bhands (it|the mailbox) (over|to)\b|\bthe next install takes\b/i,
  },
  de: {
    reads: /\bl(ie|e)s(t|en)\b/,
    movesNothing: /verschiebt nichts/,
    screensNothing: /sortiert nichts aus/,
    rules: /\bRegeln\b/,
    nothingByItself: /nichts übernimmt (das Postfach|es) von selbst/i,
    promise: /\bwird übergeben\b|\bübergibt (es|das Postfach)\b/i,
  },
} as const;

describe("the stop verb's gloss states the dual-mode transitions", () => {
  for (const [locale, cat] of [["en", en], ["de", de]] as const) {
    const words = CONSEQUENCES[locale];
    const gloss = cat.mailboxes.stopOrganizingHandBackWhat;
    const verb = cat.mailboxes.stopOrganizingHandBack;

    it(`${locale}: the gloss exists beside its verb`, () => {
      expect(typeof gloss, "stopOrganizingHandBackWhat").toBe("string");
      expect(typeof verb, "stopOrganizingHandBack").toBe("string");
      expect(gloss.length).toBeGreaterThan(40);
    });

    it(`${locale}: it names all three consequences — keeps reading, moves nothing, screens nothing — and the rules`, () => {
      expect(gloss, "keeps reading").toMatch(words.reads);
      expect(gloss, "moves nothing").toMatch(words.movesNothing);
      expect(gloss, "screens nothing").toMatch(words.screensNothing);
      expect(gloss, "the rules").toMatch(words.rules);
    });

    it(`${locale}: it says nothing takes the mailbox over by itself, and names the press that does`, () => {
      expect(gloss).toMatch(words.nothingByItself);
      // The press is the catalogue's own label for it, so a renamed verb reddens here.
      expect(gloss).toContain(cat.mailboxes.organizeHere);
    });

    it(`${locale}: neither the verb nor its gloss promises a hand-over that happens`, () => {
      expect(verb).not.toMatch(words.promise);
      expect(gloss).not.toMatch(words.promise);
      // And the verb hands the mailbox BACK, to be taken — never "over".
      if (locale === "en") expect(verb.toLowerCase()).not.toContain("over");
    });
  }
});

/**
 * ── ONE ACT, ONE SENTENCE, ON BOTH PANES ────────────────────────────────────────────────────
 *
 * The browser pane said "Stop organizing here, keep the mail" and the desktop said "Stop
 * organizing — hand the mailbox back". Same act, same consequence, two sentences — so a person
 * who has both installs met two names for one thing, and the board and the documents used a third
 * (the desktop's verb phrase), which is why that phrase won and the browser's reassurance became
 * its second clause.
 *
 * IT IS ONE KEY, NOT TWO KEYS WITH EQUAL TEXT, and that is the whole fix: two keys holding the
 * same sentence is the state that diverged in the first place. `mailbox-reachable.test.ts` already
 * argues this for the pane's HEADING in as many words — both panes read the same key on the hosted
 * door "so a desktop install on that door and a browser tab cannot end up calling the same thing
 * by two names". The retired key is deleted rather than left as a synonym nobody reads: an
 * unreferenced key is exactly what a later edit reaches for.
 *
 * The reassurance clause is asserted separately from the verb phrase, because the two halves can
 * be lost independently — a shortened verb keeps the promise and drops the comfort, and a rewrite
 * of the comfort can quietly drop the act.
 */
describe("the stop verb is one sentence, read by both panes", () => {
  const BROWSER_PANE = "apps/webapp/app/(product)/mailbox/MailboxSection.tsx";
  const DESKTOP_PANE = "apps/desktop/src/DesktopMailboxes.tsx";

  it("the retired browser-only key is gone from both catalogues", () => {
    for (const [locale, cat] of [["en", en], ["de", de]] as const) {
      expect(cat.mailboxes.stopOrganizing, `${locale}.json still carries the retired key`)
        .toBeUndefined();
    }
  });

  it("both panes render the SAME key", () => {
    for (const pane of [BROWSER_PANE, DESKTOP_PANE]) {
      const src = read(pane);
      expect(src, `${pane} does not read the shared stop verb`)
        .toMatch(/t\("stopOrganizingHandBack"\)/);
      // …and neither reaches for the retired one, under any spelling of the call.
      expect(src, `${pane} still reads the retired key`)
        .not.toMatch(/["']stopOrganizing["']/);
    }
  });

  /**
   * THE CONFIRMATION NAMES THE ACT IT CONFIRMS.
   *
   * The verb became "Hand the mailbox back" and its confirmation still read "Stop organizing", so
   * the press and the button that carries it out had different names — the same defect this
   * describe block exists for, one control further along. The shape comes from the sibling pair
   * already in the catalogue: `releaseClaim` "Give up the claim, keep the mail" is confirmed by
   * `releaseClaimConfirm` "Give up the claim" — the verb phrase without the reassurance clause.
   *
   * Asserted as a RELATIONSHIP (the confirm is the verb's act, minus the reassurance) rather than
   * as a blessed sentence, so a reworded verb has to bring its confirmation with it.
   */
  it("the confirmation says the act, without the reassurance clause", () => {
    const HALVES = {
      en: { act: /hand the mailbox back/i, calm: /the mail stays where it is/i },
      de: { act: /Postfach zurückgeben/i, calm: /die Mails bleiben, wo sie sind/i },
    } as const;
    for (const [locale, cat] of [["en", en], ["de", de]] as const) {
      const confirm = cat.mailboxes.stopOrganizingConfirm;
      expect(typeof confirm, `${locale}.json has no stopOrganizingConfirm`).toBe("string");
      expect(confirm, `${locale}: the confirmation does not name the act`)
        .toMatch(HALVES[locale].act);
      expect(confirm, `${locale}: the confirmation repeats the reassurance`)
        .not.toMatch(HALVES[locale].calm);
      // And it is SHORTER than the verb — a confirmation that restates the whole sentence is the
      // other way to get this wrong.
      expect(confirm.length, `${locale}: the confirmation is not shorter than the verb`)
        .toBeLessThan(cat.mailboxes.stopOrganizingHandBack.length);
    }
  });

  it("the sentence carries the act AND the reassurance, in both languages", () => {
    const HALVES = {
      en: { act: /hand the mailbox back/i, calm: /the mail stays where it is/i },
      de: { act: /Postfach zurückgeben/i, calm: /die Mails bleiben, wo sie sind/i },
    } as const;
    for (const [locale, cat] of [["en", en], ["de", de]] as const) {
      const verb = cat.mailboxes.stopOrganizingHandBack;
      expect(typeof verb, `${locale}.json has no stopOrganizingHandBack`).toBe("string");
      expect(verb, `${locale}: the verb lost the act`).toMatch(HALVES[locale].act);
      expect(verb, `${locale}: the verb lost the reassurance`).toMatch(HALVES[locale].calm);
    }
  });
});
