import { describe, expect, it } from "vitest";
import { fragmentOf, routeOf } from "@ohmail/app/frame/route";
import { canonicalHash, parseHash, type Route as OldRoute } from "../../app/shell/routing";

/**
 * Two parsers read one fragment until the last old view goes: the frame's and the old shell's. They must
 * name the same place and write the same address for every fragment a person or a link can bring.
 */
const HEADS = [
  "", "#", "#/", "#/ohbox", "#/reads", "#/receipts", "#/history", "#/search", "#/compose", "#/drafts", "#/trash",
  "#/screener", "#/screener/waiting", "#/screener/screened", "#/screener/spam", "#/screener/x", "#/triage",
  "#/triage/reply", "#/triage/aside", "#/triage/resurface", "#/triage/x", "#/tag/t-1", "#/tag/", "#/tag/a/b",
  "#/folder/f-1", "#/folder/", "#/address/lena%40example.com", "#/address/%E0%A4%A", "#/address/",
  "#/settings", "#/settings/general", "#/settings/mailboxes", "#/settings/billing", "#/settings/nowhere",
  "#/first-run", "#/first-run/again", "#/first-run/add", "#/first-run/x", "#/nowhere", "ohbox", "#ohbox",
];
const TAILS = ["", "/m/a1", "/m/", "?mailbox=mb-1", "?mailbox=%20", "/m/a1?mailbox=mb-1", "?x=1"];
const CORPUS = HEADS.flatMap((head) => TAILS.map((tail) => head + tail));

/** The old route's fields, written in the frame's words. */
function said(old: OldRoute) {
  const place = {
    ohbox: "ohbox", reads: "news", receipts: "receipts", screener: "screener", history: "history", search: "search",
    compose: "write", drafts: "drafts", trash: "trash", settings: "settings", tag: "tags", folder: "folder", address: "address",
    triage: { reply: "later", aside: "parked", resurface: "resurface" }[old.triagePile],
  }[old.view];
  const sub =
    old.view === "tag" ? old.tagId
    : old.view === "folder" ? old.folderId
    : old.view === "address" ? old.address
    : old.view === "screener" ? (old.screenerSegment === "waiting" ? null : old.screenerSegment)
    : old.view === "settings" ? old.settingsPane
    : null;
  return { place, sub, open: old.messageId, firstRun: old.firstRun };
}

describe("the frame's route and the old shell's agree", () => {
  it("on the place, its word, the open letter and the first run, for every fragment of the corpus", () => {
    for (const fragment of CORPUS) {
      const route = routeOf(fragment);
      expect({ place: route.place, sub: route.sub, open: route.open, firstRun: route.stage?.id === "firstRun" }, fragment)
        .toEqual(said(parseHash(fragment)));
    }
  });

  it("on the address each writes back", () => {
    for (const fragment of CORPUS) expect(fragmentOf(routeOf(fragment)), fragment).toBe(canonicalHash(parseHash(fragment)));
  });
});
