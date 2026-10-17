import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * NO SENTENCE REFUSES A VERB ON A STORE ROW — delete, move and tag
 * on a History or Search row go through the one door as on any row, so no copy may say that one
 * did not happen because this device lacks the row. Both web catalogues and both phone decks, as
 * raw text: a refusal that pairs a verb with the row's absence here, and the deleted key by name.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A verb refused because the row is not here — English and German. */
const REFUSED_FOR_ABSENCE = new RegExp([
  String.raw`\b(nothing|not|n't|cannot|can't)\b[^.\n"]{0,40}\b(mov|delet|tagg?)(e|ed|ing)?\b[^.\n"]*?`
    + String.raw`(no longer here|not (on|in) (this|the) (device|phone|browser)|isn't here|only (on|in) your (server|mailbox))`,
  String.raw`\b(nichts|nicht)\b[^.\n"]{0,40}(verschoben|gelöscht|markiert)[^.\n"]*?(nicht mehr da|nicht auf diesem (Gerät|Telefon|Handy))`,
].join("|"), "i");

const FILES = [
  "../messages/en.json", "../messages/de.json",
  "../../mobile/src/copy.en.ts", "../../mobile/src/copy.de.ts",
];

describe("a verb on a History or Search row is never refused for the row's absence", () => {
  for (const file of FILES) {
    it(`${file.replace(/^(\.\.\/)+/, "")}: no refusal sentence of that class`, () => {
      const hits = read(file).split("\n").filter((line) => REFUSED_FOR_ABSENCE.test(line));
      expect(hits).toEqual([]);
    });
  }

  it("the refusal the store rows used to get stays deleted", () => {
    for (const file of ["../messages/en.json", "../messages/de.json"]) {
      const j = JSON.parse(read(file)) as Record<string, Record<string, unknown>>;
      expect(j.ohbox!.moveGone, `${file} ohbox.moveGone`).toBeUndefined();
    }
  });

  it("the census reads the class it refuses — its own positive control", () => {
    expect("Nothing moved — that message is no longer here.").toMatch(REFUSED_FOR_ABSENCE);
    expect("Nichts verschoben — diese Nachricht ist nicht mehr da.").toMatch(REFUSED_FOR_ABSENCE);
    expect("This message can't be deleted — it is not on this device.").toMatch(REFUSED_FOR_ABSENCE);
    // …and not the sentences that are true of mail that has really gone.
    expect("That message is no longer here.").not.toMatch(REFUSED_FOR_ABSENCE);
    expect("That message is no longer here, so no rule was made for its sender.").not.toMatch(REFUSED_FOR_ABSENCE);
  });
});
