/**
 * The list-foot tails must not make a claim the app cannot keep.
 *
 * `ohboxTail` and `receiptsTail` once ended with "Search reaches the rest/older ones on your
 * server." — search over the synced mirror does not exist yet, so a paired user was told
 * search reaches server mail while it did not. The tails now state only what is on screen;
 * these tests pin the exact sentences so a server-search promise cannot ride back in on a
 * copy edit before the feature exists.
 */
import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";

describe("list tails state only what is on screen", () => {
  it("ohboxTail counts, and promises nothing about server search", () => {
    expect(Copy.ohboxTail(3)).toBe("All 3 accepted messages shown.");
    expect(Copy.ohboxTail(1)).toBe("All 1 accepted message shown.");
    expect(Copy.ohboxTail(3)).not.toContain("Search");
  });

  it("receiptsTail counts, and promises nothing about server search", () => {
    expect(Copy.receiptsTail(2)).toBe("All 2 receipts shown.");
    expect(Copy.receiptsTail(1)).toBe("All 1 receipt shown.");
    expect(Copy.receiptsTail(2)).not.toContain("Search");
  });

  it("no copy line outside the search screen over-promises search — and the screen states its scope", () => {
    // The search screen owns its scope statements. Elsewhere, the service's hidden-folder
    // wording follows web parity, and About names the feature without describing its scope.
    const EXEMPT = new Set(["foldersUseOff", "aboutLiveHere"]);
    // The folder button appears when server Search is available and opens Search for that
    // folder. Match its navigation label verbatim to catch any added scope claim.
    const olderSearchLabel = "Older in Search";
    const offenders = Object.entries(Copy)
      .filter(([k, v]) =>
        typeof v === "string" && /search/i.test(v as string) && !EXEMPT.has(k) && !k.startsWith("search"))
      .filter(([k, v]) => v !== "Search" && !(k === "folderOlderSearch" && v === olderSearchLabel))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
    // The exemption is not a dead rule — the sentence really is the catalogue's and mentions search.
    expect(Copy.foldersUseOff).toContain("search");
    expect(Copy.folderOlderSearch).toBe(olderSearchLabel);
    // The screen's verdict states what it searched (ARCHIVE-024): the whole mailbox.
    expect(Copy.searchWholeSearching).toContain("whole mailbox");
    expect(Copy.searchWhole(3)).toContain("whole mailbox");
    // About says search is live, beside writing new mail (`about-states-what-ships.test.ts`).
    expect(Copy.aboutLive("srv")).toContain("search are live");
    expect(Copy.aboutLiveHere).toContain("search are live");
  });
});

describe("the spam segment's empty hint keeps its claims scoped (FOLDERS-SPEC.md §16.1/§16.3)", () => {
  it("names where confirmed spam goes, and claims deletion-restraint only for ohmail's own conduct", () => {
    // The pre-junk sentence — "never deleted unseen" — became false when the spam verdict
    // started writing into the provider's Junk folder (its cleanup schedule, not ours). The
    // claims-sweep rule: every "nothing is deleted" claim is scoped "never ON ITS OWN".
    expect(Copy.spamEmptyHint).toBe(
      "Suspected spam waits here for your eyes — ohmail never deletes it on its own. Mail you confirm as spam moves to your mail server's own Junk folder, or stays held here when your mailbox has none.",
    );
    expect(Copy.spamEmptyHint).not.toMatch(/deleted unseen/i);
  });
});
