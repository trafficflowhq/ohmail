/**
 * WHICH JUNK SENTENCE A SURFACE IS OWED (`junkFolderSaid`), held where the seated places read it
 * (`packages/app/src/search/SearchEmpty.tsx`): the derivation's cases of today's test
 * (`apps/webapp/test/junk-folder-said.test.tsx`), by their names, over the same module, unchanged. They stand here
 * because their first file mounts today's rail and Search, which leave with today's shell.
 */
import { describe, expect, it } from "vitest";
import { junkFolderSaid } from "../../src/lists/folders.js";

describe("junkFolderSaid — which sentence the two surfaces are owed", () => {
  it("names the folder the roster resolved", () => {
    expect(junkFolderSaid([{ status: "connected", junkFolder: "Junk" }])).toEqual({ named: "Junk" });
  });

  it("names the LEAF, so a nested path reads as the folder a person sees", () => {
    expect(junkFolderSaid([{ status: "connected", junkFolder: "INBOX/Spamverdacht" }])).toEqual({
      named: "Spamverdacht",
    });
  });

  it("two mailboxes whose paths differ but whose leaf agrees still get the name", () => {
    expect(
      junkFolderSaid([
        { status: "connected", junkFolder: "Junk" },
        { status: "connected", junkFolder: "INBOX/Junk" },
      ]),
    ).toEqual({ named: "Junk" });
  });

  it("two mailboxes that call it different things get the sentence WITHOUT a name", () => {
    // Gmail beside iCloud. One name here would be wrong for one of the two mailboxes, and a
    // list of names is not a sentence — so the statement stays and the name goes.
    expect(
      junkFolderSaid([
        { status: "connected", junkFolder: "Junk" },
        { status: "connected", junkFolder: "[Gmail]/Spam" },
      ]),
    ).toBe("unnamed");
  });

  it("says NOTHING when no Junk folder was resolved — all three absences alike", () => {
    // No folder, nothing attached yet, and a server older than the field. Every one of them
    // means there is nothing to assert about somebody's mailbox.
    expect(junkFolderSaid([{ status: "connected", junkFolder: null }])).toBeNull();
    expect(junkFolderSaid([{ status: "connected" }])).toBeNull();
    expect(junkFolderSaid([{ status: "connected", junkFolder: "" }])).toBeNull();
    expect(junkFolderSaid([])).toBeNull();
  });

  it("does not speak for a stood-down mailbox — another install's, and the window skips it too", () => {
    expect(junkFolderSaid([{ status: "disabled", junkFolder: "Junk" }])).toBeNull();
    // …and it is the STATUS doing that, not the absence of a second row.
    expect(
      junkFolderSaid([
        { status: "disabled", junkFolder: "Spam" },
        { status: "connected", junkFolder: "Junk" },
      ]),
    ).toEqual({ named: "Junk" });
  });
});
