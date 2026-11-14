import { describe, expect, it } from "vitest";
import { moveTargetsOf } from "@ohmail/app-logic/reader";

describe("where a letter may be moved", () => {
  it("every place but the one it stands in, in the menu's order", () => {
    expect(moveTargetsOf({ folder: "INBOX" })).toEqual(["reads", "receipts", "screened", "spam"]);
    expect(moveTargetsOf({ folder: "ohmail/News" })).toEqual(["ohbox", "receipts", "screened", "spam"]);
    expect(moveTargetsOf({ folder: "ohmail/Quarantine" })).toEqual([
      "ohbox",
      "reads",
      "receipts",
      "screened",
    ]);
  });

  it("a letter in the Screener offers every place", () => {
    expect(moveTargetsOf({ folder: "ohmail/Screener" })).toEqual([
      "ohbox",
      "reads",
      "receipts",
      "screened",
      "spam",
    ]);
  });
});
