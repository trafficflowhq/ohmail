import { describe, expect, it } from "vitest";
import { mailboxLabelResolver } from "@ohmail/app-logic/reader";

describe("the label form is the mailbox's own label or nothing, never its address", () => {
  it("a labelled mailbox answers its label; an unlabelled one answers null where the plain form answers the address", () => {
    const of = mailboxLabelResolver([
      { id: "mb", address: "work@home.example", displayName: "Work" },
      { id: "mb-2", address: "me@home.example", displayName: null },
    ]);
    expect([of("mb", "label"), of("mb-2", "label")]).toEqual(["Work", null]);
    expect(of("mb-2")).toBe("me@home.example");
  });
});
