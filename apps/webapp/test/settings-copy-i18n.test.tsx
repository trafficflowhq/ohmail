/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { PROVIDERS, providerById, providerLabel } from "../app/shell/providers";

/**
 * THE SETTINGS COPY A GERMAN PASS CAUGHT IN ENGLISH — and the trial row that claimed a renewal.
 *
 * Sightings from one review, pinned together because they are one defect class: a sentence
 * hardcoded past the catalogue.
 *
 *  · About's two headings were literals ("Published by" over a German page). The publisher FACTS
 *    below them are deliberately verbatim — they are the imprint's legal text — so this file
 *    asserts both directions: the chrome translates, the facts do not.
 *  · The generic provider label ("Any other IMAP mailbox") was read straight off the preset
 *    table by both render sites, so it stayed English in the picker and in the connected-mailbox
 *    row. Both go through `providerLabel` now; the picker is mounted, the helper is pinned pure.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (l: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(HERE, "..", "messages", `${l}.json`), "utf8"));
const EN = read("en");
const DE = read("de");

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    assertPasskey: async () => ({}),
    auth: {
      session: async () => ({
        user: {
          userId: "u1", accountId: "acct-1", email: "person@example.test",
          displayName: "Person", emailVerified: true,
          twofaEnrolled: { webauthn: true, totp: true, recoveryCodes: true },
        },
        scope: "full",
      }),
    },
    billing: {
      subscription: async () => { throw new Error("no pane here reads a subscription"); },
      checkout: async () => ({ url: "https://example.test" }),
      portal: async () => ({ url: "https://example.test" }),
    },
    aiSettings: {
      get: async () => ({ aiEnabled: true }),
      set: async () => ({ aiEnabled: true }),
    },
    mailboxes: {
      list: async () => ({ items: [] }),
    },
  };
});

/* ── mounting ────────────────────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function mount(locale: "en" | "de", node: React.ReactNode): Promise<HTMLDivElement> {
  await unmount();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const messages = (locale === "de" ? DE : EN) as never;
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale, messages, children: node }));
  });
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
  return host;
}

afterEach(async () => { await unmount(); });

describe("About — the chrome translates, the imprint facts do not", () => {
  it("a German session gets German headings and link labels over the verbatim publisher block", async () => {
    const { AboutSection } = await import("../app/(product)/mailbox/AboutSection.js");
    const el = await mount("de", h(AboutSection));
    const text = el.textContent ?? "";

    expect(text).toContain("Herausgeber");
    expect(text).toContain("Was mit deinen Mails passiert");
    expect(text).toContain("Datenschutz");
    expect(text).toContain("Auftragsverarbeiter");
    expect(text).toContain("Impressum");
    expect(text).not.toContain("Published by");
    expect(text).not.toContain("What happens to your mail");

    // The legal facts are the imprint's own text and stay verbatim in every language.
    expect(text).toContain("TrafficFlow GmbH");
    expect(text).toContain("Staubstrasse 1, 8038 Zürich, Switzerland");
  });

  it("and English still reads English", async () => {
    const { AboutSection } = await import("../app/(product)/mailbox/AboutSection.js");
    const el = await mount("en", h(AboutSection));
    expect(el.textContent).toContain("Published by");
    expect(el.textContent).toContain("What happens to your mail");
  });
});

describe("the generic provider label — the one preset label that is prose", () => {
  it("the picker's manual tile is German in a German session", async () => {
    const { ProviderPicker } = await import("../app/shell/ProviderPicker.js");
    const el = await mount("de", h(ProviderPicker, { value: null, onChange: () => {} }));
    expect(el.textContent).toContain("Jedes andere IMAP-Postfach");
    expect(el.textContent).not.toContain("Any other IMAP mailbox");
    // The brand tiles are names, not prose, and keep their string in every language.
    expect(el.textContent).toContain("Gmail");
  });

  it("providerLabel translates exactly the manual entry — brands render verbatim", () => {
    const t = (key: "otherLabel"): string => (key === "otherLabel" ? "ÜBERSETZT" : key);
    expect(providerLabel(providerById("imap"), t)).toBe("ÜBERSETZT");
    for (const p of PROVIDERS.filter((x) => !x.manual)) {
      expect(providerLabel(p, t)).toBe(p.label);
    }
  });
});

/**
 * ── A ROW THE SHARED FILE DRAWS ON EVERY SURFACE MAY NOT NAME ONE SURFACE ──────────────────
 *
 * Settings → General's first four rows are drawn by `SettingsView` DIRECTLY rather than injected
 * by a host, and each of their comments says why: both surfaces have a language, a theme, a face
 * and a picture-quality dial, and none of the four needs a server. So the same sentence renders in
 * a browser tab and in the desktop window, and "compressed in this browser" was false in the
 * second — which is how it was reported, from a walk of the desktop app.
 *
 * This is NOT a sweep over the catalogue, deliberately. Most of the strings that name a browser
 * name it correctly: signing out talks about the mail cached in this browser, and there is no
 * cached mail anywhere else. What cannot be right is a HOST-INDEPENDENT row naming a host, so the
 * rule is scoped to exactly the rows the shared file draws itself — the positive control below is
 * a host-injected sentence that says "this browser" and must stay legal.
 */
describe("the settings rows every surface gets do not name one surface", () => {
  /** `SettingsView`'s own General section: LanguageRow, theme, FaceRow, ImageQualityRow. */
  const SHARED_ROW_HINTS = [
    "languageHint", "languageHintLocal", "themeHint", "faceHint", "imageQualityHint",
  ] as const;
  /** A browser, spelled the ways this catalogue spells it, in both languages. */
  const NAMES_A_BROWSER = /this browser|dieser Browser|diesem Browser|browser tab/i;

  it.each(SHARED_ROW_HINTS)("settings.%s", (key) => {
    for (const [lang, cat] of [["en", EN], ["de", DE]] as const) {
      const s = (cat.settings as Record<string, string>)[key];
      expect(typeof s, `settings.${key} is missing from ${lang}.json`).toBe("string");
      expect(
        NAMES_A_BROWSER.test(s),
        `${lang}.json settings.${key} names a browser, and this row renders in the desktop `
          + `window too — SettingsView draws it directly, not through a host. Name the device, `
          + `or move the row behind a host that only the browser supplies.\n  ${s}`,
      ).toBe(false);
    }
  });

  it("POSITIVE CONTROL — the rule bites, and a host-injected sentence stays legal", () => {
    // Without the first half a typo in the pattern would make every case above pass on anything.
    expect(NAMES_A_BROWSER.test(
      "JPEG and PNG attachments are compressed in this browser before they're sent",
    )).toBe(true);
    expect(NAMES_A_BROWSER.test(
      "JPEG- und PNG-Anhänge werden in diesem Browser vor dem Senden komprimiert",
    )).toBe(true);
    // …and the second half is what keeps this from becoming a catalogue-wide ban: Sign out is
    // injected by the Cloud host alone and is talking about a real browser-only fact.
    const signOut = (EN.account as Record<string, string>).signOutBody;
    expect(typeof signOut).toBe("string");
    expect(NAMES_A_BROWSER.test(signOut), "the control's own premise moved").toBe(true);
    expect(SHARED_ROW_HINTS as readonly string[]).not.toContain("signOutBody");
  });
});
