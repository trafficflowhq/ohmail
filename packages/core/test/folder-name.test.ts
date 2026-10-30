import { describe, it, expect } from "vitest";
import { FOLDER_PATH_MAX, RESERVED_FOLDER_LEAF, folderNameError } from "../src/types.js";
import { PASSIVE_EXCLUDED_LEAF } from "../src/adapters/imap-types.js";

/**
 * THE FOLDER-NAME VALIDATOR (FOLDERS-SPEC.md stage 2) — the ONE set of rules both the client's
 * pre-wire sentence and the server's refusal run. Table-pinned, because every code is a
 * catalogue key in two languages and a drifted code is a silent English sentence in a German
 * interface (the locale guard's argument, one layer down).
 */
describe("folderNameError", () => {
  it("answers null for names a mailbox accepts, including nested paths and unicode", () => {
    for (const name of [
      "Projects", "Projects/Acme", "Steuern 2026", "Rechnungen/Q3", "Zürich Klub",
      "a_b", "Ötzi/フォルダ", "x".repeat(FOLDER_PATH_MAX),
      // A personal-namespace server files user folders under the INBOX prefix — these paths
      // are where such a mailbox's folders genuinely live, and a rename re-spells them whole.
      "INBOX/Beweis", "INBOX/Projects/Acme",
    ]) {
      expect(folderNameError(name), name).toBeNull();
    }
  });

  it("refuses by CLOSED code — the table both catalogues carry", () => {
    const cases: Array<[string, string]> = [
      ["", "empty"], ["/", "empty"], ["a//b", "empty"], ["/a", "empty"], ["a/", "empty"],
      [" padded", "spaces"], ["padded ", "spaces"], ["a/ b", "spaces"],
      ["tab\there", "control"],
      ["ratio%", "wildcard"], ["glob*", "wildcard"],
      ["x".repeat(FOLDER_PATH_MAX + 1), "long"],
      // The reserved families: the mailbox's own belts (any depth), INBOX, the ohmail
      // namespace, and the organized six as full paths.
      ["Trash", "reserved"], ["Projects/Spam", "reserved"], ["Papierkorb", "reserved"],
      ["Drafts", "reserved"], ["INBOX", "reserved"], ["inbox", "reserved"],
      ["ohmail", "reserved"], ["ohmail/Anything", "reserved"], ["a/ohmail/b", "reserved"],
      ["ohmail/Reads", "reserved"],
    ];
    for (const [name, code] of cases) {
      expect(folderNameError(name), JSON.stringify(name)).toBe(code);
    }
  });

  it("the passive belt IS the reserved list — one regex, two names, zero drift", () => {
    expect(PASSIVE_EXCLUDED_LEAF).toBe(RESERVED_FOLDER_LEAF);
  });
});

/**
 * THE NEWS PILE'S RESOLVER (0.22, `ohmail/Reads` → `ohmail/News`): News-first, Reads-fallback,
 * canonical for creation. The four listing shapes here are the four mailbox shapes the organizer
 * meets; the leaf-identity case pins that the browser-safe subpath hands out the same functions,
 * not a copy that can drift.
 */
describe("pileFolder and the News spellings", () => {
  it("resolves the four mailbox shapes: news-only, reads-only, both, neither", async () => {
    const { pileFolder, NEWS_FOLDER, LEGACY_NEWS_FOLDER } = await import("../src/types.js");
    expect(pileFolder(NEWS_FOLDER, ["INBOX", "ohmail/News"])).toBe("ohmail/News");
    expect(pileFolder(NEWS_FOLDER, ["INBOX", "ohmail/Reads"])).toBe(LEGACY_NEWS_FOLDER);
    // BOTH present: the canonical wins — the merge empties the legacy folder behind it.
    expect(pileFolder(NEWS_FOLDER, ["INBOX", "ohmail/Reads", "ohmail/News"])).toBe("ohmail/News");
    // NEITHER: the canonical name, which is what a CREATE makes.
    expect(pileFolder(NEWS_FOLDER, ["INBOX"])).toBe("ohmail/News");
  });

  it("every other pile resolves to itself whatever the listing", async () => {
    const { pileFolder } = await import("../src/types.js");
    for (const pile of ["INBOX", "ohmail/Screener", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"] as const) {
      expect(pileFolder(pile, ["ohmail/Reads"])).toBe(pile);
      expect(pileFolder(pile, [])).toBe(pile);
    }
  });

  it("canonicalDestination folds the legacy spelling and nothing else; isNewsFolder knows both", async () => {
    const { canonicalDestination, isNewsFolder, LEGACY_NEWS_FOLDER } = await import("../src/types.js");
    expect(canonicalDestination(LEGACY_NEWS_FOLDER)).toBe("ohmail/News");
    expect(canonicalDestination("ohmail/News")).toBe("ohmail/News");
    expect(canonicalDestination("INBOX")).toBe("INBOX");
    expect(canonicalDestination("Archive/2026")).toBe("Archive/2026");
    expect(isNewsFolder("ohmail/News")).toBe(true);
    expect(isNewsFolder(LEGACY_NEWS_FOLDER)).toBe(true);
    expect(isNewsFolder("ohmail/Receipts")).toBe(false);
  });

  it("the browser-safe leaves re-export the SAME functions — no copy to drift", async () => {
    const types = await import("../src/types.js");
    const leaf = await import("../src/folder-name.js");
    const dests = await import("../src/destinations.js");
    expect(leaf.pileFolder).toBe(types.pileFolder);
    expect(leaf.canonicalDestination).toBe(types.canonicalDestination);
    expect(dests.pileFolder).toBe(types.pileFolder);
    expect(leaf.NEWS_FOLDER).toBe(types.NEWS_FOLDER);
    expect(leaf.LEGACY_NEWS_FOLDER).toBe(types.LEGACY_NEWS_FOLDER);
  });
});

/** The Sent folder a mailbox recorded at attach (`mailboxes.sent_folder`) counts beside the Sent-shaped names. */
describe("isSentFolderOf", () => {
  it("the recorded path is Sent, exactly and only when recorded; INBOX never is", async () => {
    const { isSentFolderOf } = await import("../src/types.js");
    for (const p of ["Envoyés", "INBOX.Verzonden", "INBOX/Verzonden"]) {
      expect(isSentFolderOf(p, p), p).toBe(true);
      expect(isSentFolderOf(p, null), p).toBe(false);
      expect(isSentFolderOf(p, ""), p).toBe(false);
      expect(isSentFolderOf(p, undefined), p).toBe(false);
    }
    expect(isSentFolderOf("envoyés", "Envoyés")).toBe(false);
    expect(isSentFolderOf("INBOX.Verzonden", "INBOX/Verzonden")).toBe(false);
    expect(isSentFolderOf("INBOX", "INBOX")).toBe(false);
    expect(isSentFolderOf("inbox", "inbox")).toBe(false);
    expect(isSentFolderOf("Sent", null)).toBe(true);
    expect(isSentFolderOf("Sent", "Envoyés")).toBe(true);
  });

  it("the browser-safe leaf hands out the same function", async () => {
    const types = await import("../src/types.js");
    const leaf = await import("../src/folder-name.js");
    expect(leaf.isSentFolderOf).toBe(types.isSentFolderOf);
  });
});
