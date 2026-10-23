/**
 * THE APP PASSWORD NOTE, BEFORE THE PRESS, AND SIGN IN AGAIN SAID FOR IT. The phone said nothing to
 * a mailbox whose provider takes only an App Password: no note, no link, and a refusal that sent a
 * person back to retype the account password that can never work. The decisions are
 * `standalone-form.ts`'s; the provider's names and pages are the table's, so no provider word,
 * host or address is written in this tree (`privacy.test.ts`).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { authHintPreset } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { EMPTY_STANDALONE, appPasswordNote, connectionLineHere, signInAgainSaid, withAddress } from "../src/ui/standalone-form";

const preset = authHintPreset();
/** An address on the preset's own domain, spelled from its incoming host. */
const address = `someone@${preset.imap.host.replace(/^imap\./, "")}`;
const picker = (lang: "en" | "de"): Record<string, string> =>
  (JSON.parse(readFileSync(new URL(`../../webapp/messages/${lang}.json`, import.meta.url), "utf8")) as {
    providerPicker: Record<string, string>;
  }).providerPicker;
const mailboxes = (lang: "en" | "de"): Record<string, string> =>
  (JSON.parse(readFileSync(new URL(`../../webapp/messages/${lang}.json`, import.meta.url), "utf8")) as {
    mailboxes: Record<string, string>;
  }).mailboxes;

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the note under the password field", () => {
  it("by the typed address, before anything is pressed, with the two pages", () => {
    const note = appPasswordNote(withAddress(EMPTY_STANDALONE, address));
    expect(note?.text).toBe(preset.note);
    expect(note?.links.map((l) => l.url)).toEqual([preset.prereqUrl, preset.helpUrl]);
  });

  it("by a typed incoming host, for an address on its own domain", () => {
    const note = appPasswordNote({ address: "someone@example.test", imapHost: preset.imap.host });
    expect(note?.text).toBe(preset.note);
  });

  it("the web picker's words in both languages, and its link labels", () => {
    for (const lang of ["en", "de"] as const) {
      setActiveLocale(lang);
      const note = appPasswordNote({ address, imapHost: "" })!;
      expect(note.text, lang).toBe(picker(lang)[`note_${preset.id}`]);
      expect(note.links.map((l) => l.label), lang).toEqual([picker(lang)[`prereq_${preset.id}`], picker(lang)[`help_${preset.id}`]]);
    }
  });

  it("control: nothing for another mailbox", () => {
    expect(appPasswordNote({ address: "someone@example.test", imapHost: "imap.example.test" })).toBeNull();
    expect(appPasswordNote(EMPTY_STANDALONE)).toBeNull();
  });
});

describe("sign in again, on such a mailbox", () => {
  it("asks for a new App Password, and the refused connection says why", () => {
    for (const lang of ["en", "de"] as const) {
      setActiveLocale(lang);
      expect(signInAgainSaid(address).field, lang).toBe(Copy.signInAgainFieldProvider);
      expect(signInAgainSaid(address).lead, lang).not.toBe(Copy.signInAgainLead);
      expect(connectionLineHere(address, Copy.connectionSignInRefused), lang)
        .toBe(mailboxes(lang)[`desktopStateSignInRefused_${preset.id}`]);
    }
  });

  it("control: another mailbox's sheet and line are as they were", () => {
    expect(signInAgainSaid("someone@example.test")).toEqual({ lead: Copy.signInAgainLead, field: Copy.signInAgainField });
    expect(connectionLineHere("someone@example.test", Copy.connectionSignInRefused)).toBe(Copy.connectionSignInRefused);
    expect(connectionLineHere(address, Copy.connectionCertificateRefused)).toBe(Copy.connectionCertificateRefused);
  });
});
