/**
 * SETTINGS › ABOUT › HELP & CONTACT, on the phone. Write to us opens the phone's own composer
 * addressed to support, with a subject and the diagnostics block in the body; with no mailbox to
 * send from it is a mailto: carrying the same two. The block's facts come from the diagnostic
 * file's own inputs (the build, the platform, the mailbox rows) and hold no address or host;
 * the composer's strip takes the block out in one press and can put it back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { diagStrip, phoneSupportMail } from "../src/ui/help-contact";

const DEPS = { platform: { os: "android", osVersion: 35 }, build: { version: "0.30.3", commit: "0123456789abcdef0123456789abcdef01234567" } };
const ROWS = [
  { id: "3f1c2b9a-0d4e-4c55-9a7b-1b2c3d4e5f60", address: "juno@fjordpost.example", status: "error", errorCode: "connect", junkFolder: "Rechnungen" },
];

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the phone's mail to support", () => {
  it("is addressed to support, with the subject and the block in the body", () => {
    const m = phoneSupportMail({ mailboxes: ROWS, accountId: "acct-7Q3M9K" }, DEPS);
    expect(m.to).toBe("support@ohmail.app");
    expect(m.subject).toBe("Help with ohmail");
    expect(m.body).toBe(`\n\n${m.diag}`);
    expect(m.diag.split("\n")).toEqual([
      "— Diagnostics (ohmail) —",
      "App: ohmail phone 0.30.3 · build 012345678",
      "Platform: android 35",
      "Account: acct-7Q3M9K",
      "Mailbox: imap · Last sync error: connect",
    ]);
  });

  it("holds no address, host or folder from the fixture account", () => {
    const { diag } = phoneSupportMail({ mailboxes: ROWS, accountId: "juno@fjordpost.example" }, DEPS);
    for (const leak of ["juno", "fjordpost", "Rechnungen", "@"]) expect(diag).not.toContain(leak);
    expect(diag).toContain("Account: none");
  });

  it("the mailto fallback carries the same subject and block", () => {
    const m = phoneSupportMail({ mailboxes: [], accountId: null }, DEPS);
    expect(m.mailto.startsWith("mailto:support@ohmail.app?subject=Help%20with%20ohmail&body=")).toBe(true);
    expect(decodeURIComponent(m.mailto.split("&body=")[1]!).replace(/\r\n/g, "\n")).toBe(m.body);
    expect(m.diag).toContain("Mailbox: none");
  });

  it("Remove takes the block out in one press; Add back puts it at the end", () => {
    const { diag } = phoneSupportMail({ mailboxes: ROWS, accountId: null }, DEPS);
    const removed = diagStrip(`The sync stops.\n\n${diag}`, diag);
    expect(removed).toEqual({ k: "present", next: "The sync stops." });
    expect(diagStrip("The sync stops.", diag)).toEqual({ k: "removed", next: `The sync stops.\n\n${diag}` });
  });

  it("speaks German", () => {
    setActiveLocale("de");
    const m = phoneSupportMail({ mailboxes: ROWS, accountId: null }, DEPS);
    expect(m.subject).toBe("Hilfe zu ohmail");
    expect(m.diag).toContain("Postfach: imap · Letzter Sync-Fehler: connect");
    expect(m.diag).toContain("Konto: keiner");
  });
});
