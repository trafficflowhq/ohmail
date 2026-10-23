import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { mailboxErrorKey } from "../app/shell/mailbox-error-key";
import { probeCopyKey, refusalAuthHint } from "../app/shell/local-server-host";

/**
 * A GOOGLE MAILBOX'S REFUSED PASSWORD IS SAID AS AN APP PASSWORD — the two key choosers. The row's
 * `err_auth_gmail` (a changed Google password ends every App Password) and the probe's
 * `probe_auth_gmail_<hint>`; every other code, detail and door keeps its key.
 */

describe("mailboxErrorKey with appPassword", () => {
  it("auth on an App Password mailbox is err_auth_gmail; every other code is as before", () => {
    expect(mailboxErrorKey("auth", null, undefined, undefined, false, { appPassword: true })).toEqual({ key: "err_auth_gmail" });
    expect(mailboxErrorKey("connect", null, undefined, undefined, false, { appPassword: true })).toEqual({ key: "err_connect" });
    expect(mailboxErrorKey("auth", null)).toEqual({ key: "err_auth" });
    expect(mailboxErrorKey("auth", null, undefined, undefined, false, {})).toEqual({ key: "err_auth" });
  });

  it("a detail token and a local server still outrank it", () => {
    expect(mailboxErrorKey("auth", "MAILBOX_CREDENTIAL_UNREADABLE", undefined, undefined, false, { appPassword: true }))
      .toEqual({ key: "err_credential_unreadable" });
    expect(mailboxErrorKey("auth", null, undefined, undefined, true, { appPassword: true })).toEqual({ key: "err_auth_local" });
  });

  it("the key has its sentence in both languages", () => {
    expect((en.mailboxes as Record<string, string>).err_auth_gmail).toMatch(/App Password/);
    expect((de.mailboxes as Record<string, string>).err_auth_gmail).toMatch(/App-Passw/);
  });
});

describe("probeCopyKey and refusalAuthHint", () => {
  const refusal = (details: unknown) => ({ code: "mailbox_probe_failed", details });

  it("a hinted incoming auth refusal from a remote server is Google's key", () => {
    expect(probeCopyKey("auth", false, "imap", "web_login")).toBe("probe_auth_gmail_web_login");
    expect(refusalAuthHint(refusal({ reason: "auth", authHint: "invalid" }))).toBe("invalid");
  });

  it("control: no hint, the outgoing leg, a local server and other reasons keep their keys", () => {
    expect(probeCopyKey("auth", false, "imap", null)).toBe("probe_auth");
    expect(probeCopyKey("auth", false, "smtp", "invalid")).toBe("probe_auth");
    expect(probeCopyKey("auth", true, "imap", "invalid")).toBe("probe_auth_local");
    expect(probeCopyKey("connect", false, "imap", "invalid")).toBe("probe_connect");
    for (const bad of [refusal({ authHint: "toString" }), refusal({ authHint: 1 }), refusal(null), { code: "other", details: { authHint: "invalid" } }, null]) {
      expect(refusalAuthHint(bad)).toBeNull();
    }
  });
});
