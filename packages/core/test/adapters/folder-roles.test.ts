import { describe, it, expect } from "vitest";
import { decideFolderRole, nameRoleOf, type RoleContext, type RoleFolder } from "../../src/adapters/folder-roles.js";

/**
 * THE ROLE PRECEDENCE ohmail owns: the server's flag, then the stored folder, then a name tied
 * as 0.25.8 tied it (the pinned table by path, then the belts in LIST order). Each deciding line was mutated and watched red here or in
 * `imap.localized-roles.test.ts` (2026-10-02).
 */
const f = (path: string, ...flags: string[]): RoleFolder => ({ path, flags: new Set(flags) });
const SPECIAL_USE: RoleContext = { serverFlags: true };
const decide = (role: Parameters<typeof decideFolderRole>[0], list: RoleFolder[], stored?: string | null, ctx = SPECIAL_USE) =>
  decideFolderRole(role, list, stored, ctx);

describe("decideFolderRole", () => {
  it("the server's flag beats the stored folder and every name", () => {
    const list = [f("Sent"), f("Gesendete Elemente", "\\Sent")];
    expect(decide("sent", list, "Sent")).toEqual({ path: "Gesendete Elemente", by: "server", candidates: [] });
  });

  it("two flagged folders keep the stored one, else the first by path", () => {
    const list = [f("Sent Items", "\\Sent"), f("Sent", "\\Sent")];
    expect(decide("sent", list, "Sent Items").path).toBe("Sent Items");
    expect(decide("sent", list, null).path).toBe("Sent");
  });

  it("the stored folder beats a name — a role does not move because a table did", () => {
    const list = [f("Sent"), f("Gesendete Elemente")];
    expect(decide("sent", list, "Gesendete Elemente")).toEqual({ path: "Gesendete Elemente", by: "stored", candidates: [] });
  });

  it("two table names: the first by path, imapflow 1.5.0's sort — never no answer", () => {
    expect(decide("trash", [f("Trash"), f("Deleted Items")], null))
      .toEqual({ path: "Deleted Items", by: "name", candidates: ["Deleted Items", "Trash"] });
    expect(decide("junk", [f("Spam"), f("Junk")], undefined).path).toBe("Junk");
  });

  it("the table answers before the belts, and the belts tie by path", () => {
    expect(decide("trash", [f("Papierkorb"), f("Trash")], null).path).toBe("Trash");
    expect(decide("trash", [f("Recycle Bin"), f("Papierkorb")], null).path).toBe("Papierkorb");
    expect(decide("sent", [f("Sent Mail"), f("INBOX/Sent Messages")], null).path).toBe("INBOX/Sent Messages");
  });

  it("one name is taken when nothing else answers", () => {
    expect(decide("trash", [f("Papierkorb"), f("Archiv")], null))
      .toEqual({ path: "Papierkorb", by: "name", candidates: ["Papierkorb"] });
  });

  it("a stored folder that is gone, unselectable or flagged for another role is skipped", () => {
    expect(decide("trash", [f("Trash")], "Papierkorb").path).toBe("Trash");
    expect(decide("trash", [f("Papierkorb", "\\Noselect"), f("Trash")], "Papierkorb").path).toBe("Trash");
    expect(decide("trash", [f("Papierkorb", "\\Junk"), f("Trash")], "Papierkorb").path).toBe("Trash");
  });

  it("INBOX is never a role, flagged or stored", () => {
    expect(decide("sent", [f("INBOX", "\\Sent"), f("Envoyés")], null).path).toBe("Envoyés");
    expect(decide("sent", [f("INBOX"), f("Archiv")], "INBOX").path).toBeNull();
    expect(decide("trash", [f("inbox", "\\Trash")], "inbox").path).toBeNull();
  });

  it("a folder flagged for another role is never a name candidate", () => {
    expect(decide("trash", [f("Trash", "\\Junk"), f("Papierkorb")], null).path).toBe("Papierkorb");
  });

  it("a bare `Bin` is the Trash exactly where imapflow 1.5.0's table made it one in 0.25.8", () => {
    expect(decide("trash", [f("Bin")], null).path).toBe("Bin");
    expect(decide("trash", [f("Kunden/Bin")], null).path).toBeNull();
  });

  it("the ohmail namespace, \\Noselect and \\NonExistent are never a role", () => {
    const list = [f("ohmail/Trash"), f("INBOX/Trash", "\\Noselect"), f("Trash", "\\NonExistent")];
    expect(decide("trash", list, null).path).toBeNull();
    expect(decide("trash", [f("ohmail/Bin", "\\Trash")], null).path).toBeNull();
  });
});

describe("nameRoleOf — the pinned table and the belts, at guess depth only", () => {
  it("reads top level and one level under a server prefix", () => {
    expect(nameRoleOf("Sent")).toBe("sent");
    expect(nameRoleOf("INBOX/Sent")).toBe("sent");
    expect(nameRoleOf("[Gmail]/Gesendete Elemente")).toBe("sent");
    expect(nameRoleOf("[Gmail]/Sent Mail")).toBeNull(); // 0.25.8's Sent belt took INBOX/ only
    expect(nameRoleOf("Gesendete Elemente")).toBe("sent");
    expect(nameRoleOf("Posta indesiderata")).toBe("junk");
    expect(nameRoleOf("Entwürfe")).toBe("drafts");
    expect(nameRoleOf("Sent‎")).toBe("sent");
  });

  it("never a folder in the person's own tree", () => {
    expect(nameRoleOf("Kunden/Papierkorb")).toBeNull();
    expect(nameRoleOf("Projekte/Sent")).toBeNull();
    expect(nameRoleOf("INBOX/Kunden/Trash")).toBeNull();
  });

  it("names imapflow 1.7.8 added are not ohmail's until a product change adds them", () => {
    for (const n of ["Gesendet", "Gelöscht", "Cestino", "Corbeille", "Indésirables", "Indesiderata", "Posta inviata", "Tramess"]) {
      expect(nameRoleOf(n)).toBeNull();
    }
  });
});

describe("what the session lets the decision read", () => {
  const NO_CAPABILITY: RoleContext = { serverFlags: false };

  it("role attributes without SPECIAL-USE, XLIST or IMAP4rev2 are not read: names decide, as on 0.25.8", () => {
    // Exchange's shape: `Sent Items` flagged \Sent beside a `Sent` another client made.
    const list = [f("Sent Items", "\\Sent"), f("Sent"), f("Junk Email", "\\Junk"), f("Junk")];
    expect(decide("sent", list, null, NO_CAPABILITY).path).toBe("Sent");
    expect(decide("junk", list, null, NO_CAPABILITY).path).toBe("Junk");
    expect(decide("sent", list, "Sent", NO_CAPABILITY)).toEqual({ path: "Sent", by: "stored", candidates: [] });
    expect(decide("sent", list, null).path).toBe("Sent Items");
  });

  it("name-pattern ties go by path segment, never by the library's list order", () => {
    expect(decide("trash", [f("Papierkorb"), f("Gelöschte Nachrichten")], null).path).toBe("Gelöschte Nachrichten");
    expect(decide("junk", [f("Unerwünscht"), f("Bulk Mail")], null).path).toBe("Bulk Mail");
  });

  it("a personal NAMESPACE prefix is a place a name may be read, beside the fixed ones", () => {
    const list = [f("Mail/Sent"), f("Mail/Papierkorb"), f("Projekte/Trash")];
    const ns: RoleContext = { serverFlags: false, guessParents: ["Mail"] };
    expect(decide("sent", list, null, ns).path).toBe("Mail/Sent");
    expect(decide("trash", list, null, ns).path).toBe("Mail/Papierkorb");
    expect(decide("sent", list, null, { serverFlags: false }).path).toBeNull();
    expect(nameRoleOf("Mail/Sent", ["Mail"])).toBe("sent");
    expect(nameRoleOf("Mail/Archiv/Sent", ["Mail"])).toBeNull();
  });
});
