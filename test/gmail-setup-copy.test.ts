import { describe, expect, it } from "vitest";
import { GOOGLE_AUTH_HINTS, isGoogleMailHost } from "@trafficflow/core/adapters/imap";
import { GOOGLE_AUTH_REFUSAL } from "@trafficflow/services/mail";
import { AUTH_HINTS, PROVIDERS, authHintPreset } from "@ohmail/client-engine";
import en from "../apps/webapp/messages/en.json";
import de from "../apps/webapp/messages/de.json";
import { EN } from "../apps/mobile/src/copy.en";
import { DE } from "../apps/mobile/src/copy.de";

/**
 * GOOGLE'S REFUSED SIGN-IN IS ONE SET OF SENTENCES ON EVERY SURFACE. The engine's closed hint list
 * (core), its client twin, the server's English (desktop door, Sign in again), the web catalogue
 * (Cloud, self-host, the desktop window) and the phone's deck filled from the provider table must
 * agree word for word, and the German must be written, not copied.
 */

const M = en.mailboxes as unknown as Record<string, string>;
const DM = de.mailboxes as unknown as Record<string, string>;
const preset = authHintPreset();
const names = [preset.label, preset.account!] as const;
/** The phone's deck key for each hint, in `AUTH_HINTS`' order. */
const PHONE = Object.fromEntries(AUTH_HINTS.map((h, i) => [h, ([
  "standaloneAuthAppOnly", "standaloneAuthWebLogin", "standaloneAuthImapDisabled", "standaloneAuthInvalid",
] as const)[i]!])) as Record<(typeof AUTH_HINTS)[number], "standaloneAuthAppOnly" | "standaloneAuthWebLogin" | "standaloneAuthImapDisabled" | "standaloneAuthInvalid">;

describe("Google's refused sign-in, said alike everywhere", () => {
  it("the client's hint list is the engine's", () => {
    expect([...AUTH_HINTS].sort()).toEqual([...GOOGLE_AUTH_HINTS].sort());
    expect(Object.keys(PHONE).sort()).toEqual([...GOOGLE_AUTH_HINTS].sort());
    expect(Object.keys(GOOGLE_AUTH_REFUSAL).sort()).toEqual([...GOOGLE_AUTH_HINTS].sort());
  });

  it("one preset says why, and the engine knows its hosts", () => {
    expect(PROVIDERS.filter((p) => p.authHints === true).map((p) => p.id)).toEqual([preset.id]);
    expect(isGoogleMailHost(preset.imap.host)).toBe(true);
    expect(isGoogleMailHost(preset.smtp.host)).toBe(true);
    expect(preset.account).toBeTruthy();
  });

  for (const hint of GOOGLE_AUTH_HINTS) {
    it(`${hint}: the server, the web and the phone say the same English; the German is its own`, () => {
      const key = `probe_auth_${preset.id}_${hint}`;
      expect(M[key], key).toBe(GOOGLE_AUTH_REFUSAL[hint]);
      expect(EN[PHONE[hint]](...names)).toBe(M[key]);
      expect(DM[key], key).toBeTruthy();
      expect(DM[key]).not.toBe(M[key]);
      expect(DE[PHONE[hint]](...names)).toBe(DM[key]);
    });
  }

  it("the note and its links: the table, the web and the phone", () => {
    const pp = en.providerPicker as unknown as Record<string, string>;
    const dp = de.providerPicker as unknown as Record<string, string>;
    expect(pp[`note_${preset.id}`]).toBe(preset.note);
    expect(EN.standaloneProviderNote(...names)).toBe(preset.note);
    expect(DE.standaloneProviderNote(...names)).toBe(dp[`note_${preset.id}`]);
    expect(pp[`prereq_${preset.id}`]).toBe(preset.prereqLabel);
    expect(EN.standalonePrereqLink).toBe(preset.prereqLabel);
    expect(DE.standalonePrereqLink).toBe(dp[`prereq_${preset.id}`]);
    expect(EN.standaloneProviderHelpLink(preset.account!)).toBe(preset.helpLabel);
    expect(DE.standaloneProviderHelpLink(preset.account!)).toBe(dp[`help_${preset.id}`]);
  });

  it("an account that cannot create an App Password is told it cannot connect yet, and what to do instead", () => {
    const dp = de.providerPicker as unknown as Record<string, string>;
    const en_ = [preset.note, GOOGLE_AUTH_REFUSAL.app_password_required, GOOGLE_AUTH_REFUSAL.invalid,
      EN.standaloneProviderNote(...names), EN.standaloneAuthAppOnly(...names), EN.standaloneAuthInvalid(...names)];
    for (const s of en_) {
      expect(s).toMatch(/Advanced Protection/);
      expect(s).toMatch(/accounts that sign in with security keys only/);
      expect(s).toMatch(/cannot connect (those|it)? ?yet/);
      expect(s).toMatch(/ask your administrator to allow (App Passwords|them), or connect another address\.$/);
    }
    const de_ = [dp[`note_${preset.id}`]!, DM[`probe_auth_${preset.id}_app_password_required`]!, DM[`probe_auth_${preset.id}_invalid`]!,
      DE.standaloneProviderNote(...names), DE.standaloneAuthAppOnly(...names), DE.standaloneAuthInvalid(...names)];
    for (const s of de_) {
      expect(s).toMatch(/Advanced.Protection/);
      expect(s).toMatch(/nur mit Sicherheitsschlüsseln/);
      expect(s).toMatch(/noch nicht verbinden/);
      expect(s).toMatch(/Bitte deine Administratorin oder deinen Administrator, App-Passwörter zu erlauben, oder verbinde eine andere Adresse\.$/);
    }
  });

  it("every claim the sentences make is one the dial keeps", () => {
    // "with or without the spaces" holds because the dial joins a 16-letter App Password.
    for (const s of [preset.note, GOOGLE_AUTH_REFUSAL.app_password_required]) expect(s).toMatch(/with or without the spaces/);
    // Never a promise that it was tested against a real mailbox.
    for (const s of [preset.note, ...Object.values(GOOGLE_AUTH_REFUSAL)]) expect(s).not.toMatch(/tested|verified|guarantee/i);
  });
});
