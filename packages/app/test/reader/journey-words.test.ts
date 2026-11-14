import { describe, expect, it } from "vitest";
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import readerDe from "../../messages/reader.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };

/**
 * THE PANEL'S NAMES ARE THE ONES THE JOURNEYS FIND IT BY. The journeys name the reading column's buttons by the
 * Ohbox's words; the reader may not read the Ohbox's namespace, so its own keys say the same, in both languages.
 */
const PAIRS = [
  ["verb.reply", "actionReply"],
  ["verb.markUnread", "actionMarkUnread"],
  ["verb.markRead", "actionMarkRead"],
  ["verb.more", "actionMore"],
  ["verb.aside", "actionSetAside"],
  ["verb.later", "actionLater"],
] as const;

const at = (tree: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);

describe("the reading column's journey names", () => {
  for (const [lang, reader, ohbox] of [
    ["en", readerEn, ohboxEn],
    ["de", readerDe, ohboxDe],
  ] as const) {
    it(`say what the Ohbox says, in ${lang}`, () => {
      for (const [mine, theirs] of PAIRS) expect(at(reader.reader, mine)).toBe(at(ohbox.ohbox, theirs));
    });
  }
});
