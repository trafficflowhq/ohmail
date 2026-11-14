import { describe, expect, it } from "vitest";
import frameDe from "../messages/frame.de.json" with { type: "json" };
import frameEn from "../messages/frame.en.json" with { type: "json" };
import readerDe from "../messages/reader.de.json" with { type: "json" };
import readerEn from "../messages/reader.en.json" with { type: "json" };
import searchDe from "../messages/search.de.json" with { type: "json" };
import searchEn from "../messages/search.en.json" with { type: "json" };

describe("the away-answer mark", () => {
  /**
   * BOTH CATALOGUES CARRY ALL THREE KEYS, in the shape the component reads them. The copy census
   * already refuses a key the code names and a catalogue lacks; this is the other half — the
   * `<stamp>` TAG, which is what puts the separator in the catalogue rather than in the markup.
   * A value that lost the tag would render the whole line as flat text and the media rule would
   * have nothing to hide, silently.
   */
  it("both catalogues carry the label, the composed line with its `<stamp>` tag, and the aria form", () => {
    for (const [name, cat] of [
      ["en", readerEn],
      ["de", readerDe],
    ] as const) {
      const m = cat.message;
      expect(m.awayAnswered, `${name} label`).toBeTruthy();
      expect(m.awayAnsweredAt, `${name} composed`).toContain("<stamp>");
      expect(m.awayAnsweredAt, `${name} composed`).toContain("{label}");
      expect(m.awayAnsweredAt, `${name} composed`).toContain("{when}");
      expect(m.awayAnsweredAria, `${name} aria`).toContain("{whenLong}");
    }
  });
});

describe("the in-pane error card", () => {
  it("both catalogues carry the press's words", () => {
    const en = frameEn.viewError;
    const deKeys = frameDe.viewError;
    expect(en.copyDetails).toBe("Copy details");
    expect(en.copied).toBe("Copied");
    expect(deKeys.copyDetails).toBe("Details kopieren");
    expect(deKeys.copied).toBe("Kopiert");
  });
});

describe("the sentences exist in both catalogues", () => {
  it("every key is in en and de", () => {
    for (const m of [searchEn, searchDe]) {
      const search = m.search as Record<string, string>;
      for (const key of [
        "scopeSynced",
        "scopeSyncedAtLeast",
        "scopeSyncedAbout",
        "syncing",
        "similarHintSynced",
      ]) {
        expect(search[key], key).toBeTypeOf("string");
      }
    }
  });
});
