/**
 * SETTINGS → THE MAILBOX'S SERVERS — the sheet's decisions, its request and the words a refusal
 * comes back with. The engine's side of the same press (dialled before kept, a refused half keeps
 * the working settings, the claim kept on the same mailbox) is measured on the phone's composition
 * in `apps/sidecar/test/phone-server-settings-in-place.test.ts`; nothing here doubles it.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DECKS } from "../src/copy";
import { changeServerSettings, serverChangeRefusal } from "../src/net/mailboxes";
import {
  refusalField,
  serverChangeOf,
  serverFieldsFrom,
  serverSettingsRefusal,
  setTyped,
} from "../src/ui/standalone-form";

const SETTINGS = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app/settings.tsx"), "utf8");
const AT = {
  imap: { host: "imap.example.test", port: 993, secure: true },
  smtp: { host: "smtp.example.test", port: 587, secure: false },
};

describe("the sheet's fields and what it refuses before anything dials", () => {
  it("is prefilled from what the engine says, every server field counted as typed", () => {
    const f = serverFieldsFrom(AT);
    expect([f.imapHost, f.imapPort, f.imapTls, f.smtpHost, f.smtpPort]).toEqual(
      ["imap.example.test", "993", true, "smtp.example.test", "587"]);
    expect(f.password).toBe("");
    expect([...f.typed].sort()).toEqual(["imapHost", "imapPort", "smtpHost", "smtpPort"]);
    expect(serverFieldsFrom({ ...AT, smtp: null }).smtpHost).toBe("");
  });

  it("refuses a blank host, an outgoing server removed here, and the port rule", () => {
    const f = serverFieldsFrom(AT);
    expect(serverSettingsRefusal(setTyped(f, "imapHost", " "), true)?.say).toBe("standaloneNoHost");
    expect(serverSettingsRefusal(setTyped(f, "smtpHost", ""), true)?.say).toBe("standaloneNoSmtpHost");
    expect(serverSettingsRefusal(setTyped(f, "smtpPort", "587465"), true)?.say).toBe("standaloneNoSmtpPort");
    expect(serverSettingsRefusal(setTyped(f, "smtpHost", ""), false), "no outgoing server to keep").toBeNull();
    expect(serverSettingsRefusal(f, true)).toBeNull();
  });

  it("sends both TLS modes from their ports, as the Connect form does", () => {
    const f = setTyped(setTyped(serverFieldsFrom(AT), "smtpPort", "465"), "imapPort", "143");
    expect(serverChangeOf(f)).toEqual({
      imap: { host: "imap.example.test", port: 143, secure: false },
      smtp: { host: "smtp.example.test", port: 465, secure: true },
    });
  });
});

describe("changeServerSettings — the request", () => {
  const session = (res: Partial<Response>) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => res as Response);
    return { s: { profile: { origin: "https://srv.test", accountId: "a" }, fetch } as never, fetch };
  };

  it("sends both blocks with the password, and the outgoing host on the incoming block", async () => {
    const { s, fetch } = session({ ok: true, status: 200 });
    const out = await changeServerSettings(s, "m1", { ...AT, password: "pw-sheet-password-password" });
    expect(out).toEqual({ kind: "kept" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toMatch(/\/local\/mailboxes\/m1$/);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      imap: { host: "imap.example.test", port: 993, secure: true, pass: "pw-sheet-password-password", smtpHost: "smtp.example.test" },
      smtp: { host: "smtp.example.test", port: 587, secure: false, pass: "pw-sheet-password-password" },
    });
  });

  it("names no outgoing server where the mailbox has none", async () => {
    const { s, fetch } = session({ ok: true, status: 200 });
    await changeServerSettings(s, "m1", { imap: AT.imap, smtp: null, password: "pw-sheet-password-password" });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      imap: { host: "imap.example.test", port: 993, secure: true, pass: "pw-sheet-password-password" },
    });
  });
});

describe("a refused change is worded for the field it is about", () => {
  const probe = (transport: string, reason: string, tls?: { kind: string }) =>
    serverChangeRefusal(422, {
      code: "mailbox_probe_failed", message: "x", details: { transport, reason, ...(tls !== undefined ? { tls } : {}) },
    });

  it("each probe answer has its sentence and its field", () => {
    expect(probe("smtp", "auth").say).toBe("standaloneSmtpSignInRefused");
    expect(probe("smtp", "tls").say).toBe("standaloneSmtpNoEncryption");
    expect(probe("smtp", "connect").say).toBe("standaloneSmtpUnreachable");
    expect(probe("imap", "auth").say).toBe("standaloneSignInRefused");
    // The probe's `tls` with no detail is the desktop's certificate sentence (`PROBE_REFUSAL.tls`).
    expect(probe("imap", "tls").say).toBe("standaloneCertificateRefused");
    expect(probe("imap", "timeout").say).toBe("serverSettingsImapUnreachable");
    expect(refusalField(probe("imap", "connect"))).toBe("imapHost");
    expect(refusalField(probe("smtp", "connect"))).toBe("smtpHost");
  });

  /* Once the phone's dial says the certificate, the change sheet must not call it
     "no encrypted connection" — only a server offering no TLS at all is that. */
  it("a certificate the probe refused is the certificate's sentence, on the host field", () => {
    for (const kind of ["generic", "untrusted", "self_signed", "hostname_mismatch", "expired", "not_yet_valid"]) {
      expect(probe("imap", "tls", { kind }).say, kind).toBe("standaloneCertificateRefused");
      expect(refusalField(probe("imap", "tls", { kind })), kind).toBe("imapHost");
    }
    // CONTROL: no TLS and no STARTTLS is still "no encryption", and the outgoing half is unchanged.
    expect(probe("imap", "tls", { kind: "tls_unavailable" }).say).toBe("standaloneNoEncryption");
    expect(probe("smtp", "tls", { kind: "untrusted" }).say).toBe("standaloneSmtpNoEncryption");
  });

  it("a new host on a phone that organizes names the way through", () => {
    const r = serverChangeRefusal(409, { code: "organizer_host_change_refused" });
    expect(r.say).toBe("serverSettingsHostWhileOrganizing");
    expect(refusalField(r)).toBe("imapHost");
  });

  it("a new server another install holds is refused naming the holder, on the host field", () => {
    const held = serverChangeRefusal(409, {
      code: "organizer_host_change_refused", details: { holder: { name: "Office desktop", kind: "local" } },
    });
    expect(held).toEqual({ say: "serverSettingsHostHeld", args: ["Office desktop"] });
    expect(refusalField(held)).toBe("imapHost");
    const unnamed = serverChangeRefusal(409, {
      code: "organizer_host_change_refused", details: { holder: { name: " ", kind: "local" } },
    });
    expect(unnamed.say).toBe("serverSettingsHostHeldUnnamed");
    expect(refusalField(unnamed)).toBe("imapHost");
    for (const deck of Object.values(DECKS)) {
      expect(deck.serverSettingsHostHeld("Office desktop")).toContain("Office desktop");
      expect(typeof deck.serverSettingsHostHeldUnnamed).toBe("string");
    }
  });

  it("anything else quotes the engine's own words, or keeps its number", () => {
    expect(serverChangeRefusal(400, { code: "validation_failed", message: "no good" })).toEqual(
      { say: "serverSettingsRefused", args: ["no good"] });
    expect(serverChangeRefusal(500, undefined)).toEqual({ say: "serverSettingsRefused", args: ["500"] });
  });
});

describe("the sheet, as Settings renders it", () => {
  it("offers the verb on the door in this process and selects both ports on focus", () => {
    expect(SETTINGS).toContain("label={Copy.serverSettings}");
    expect(SETTINGS.match(/selectTextOnFocus: true/g)?.length, "both port fields").toBe(2);
    for (const f of ["imapHost", "imapPort", "smtpHost", "smtpPort", "password"]) {
      expect(SETTINGS).toContain(`{...serverWears("${f}")}`);
    }
  });

  it("every new sentence is in both languages", () => {
    for (const deck of Object.values(DECKS)) {
      for (const k of ["serverSettings", "serverSettingsLead", "serverSettingsSaved", "serverSettingsImapUnreachable",
        "serverSettingsHostWhileOrganizing", "serverSettingsNoPassword", "standaloneNoSmtpHost"] as const) {
        expect(typeof deck[k], k).toBe("string");
      }
      expect(deck.serverSettingsRefused("x")).toContain("x");
    }
  });
});
