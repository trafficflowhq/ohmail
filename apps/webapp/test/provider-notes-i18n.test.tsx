/** @vitest-environment jsdom */
/**
 * THE PROVIDER NOTES IN THE SCREEN'S LANGUAGE. The picker rendered the engine table's English note and
 * help label in every language, so a German signup was told how to make a Gmail app password in English.
 * The picker now reads `providerPicker.note_<id>` and `help_<id>` from the catalogue. The English entries
 * are the engine table's own words, held equal here so the two cannot drift; the German ones are written,
 * one for every provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { PROVIDERS } from "../app/shell/providers";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const pp = (m: typeof en): Record<string, string> => m.providerPicker as unknown as Record<string, string>;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the catalogue carries every preset's note and help label", () => {
  it("English is the engine table's own words, preset by preset", () => {
    for (const p of PROVIDERS) {
      expect(pp(en)[`note_${p.id}`], p.id).toBe(p.note);
      if (p.helpUrl) expect(pp(en)[`help_${p.id}`], p.id).toBe(p.helpLabel);
    }
  });

  it("German is written for every one, not copied", () => {
    for (const p of PROVIDERS) {
      const note = pp(de)[`note_${p.id}`];
      expect(note, p.id).toBeTruthy();
      expect(note, p.id).not.toBe(p.note);
      if (p.helpUrl) {
        expect(pp(de)[`help_${p.id}`], p.id).toBeTruthy();
        expect(pp(de)[`help_${p.id}`], p.id).not.toBe(p.helpLabel);
      }
    }
  });

  it("no key for a preset the table does not have", () => {
    const ids = new Set(PROVIDERS.map((p) => p.id));
    for (const m of [en, de]) {
      for (const key of Object.keys(pp(m)).filter((k) => /^(note|help)_/.test(k))) {
        expect(ids.has(key.replace(/^(note|help)_/, "")), key).toBe(true);
      }
    }
  });
});

describe("the picker says it in German", () => {
  it("GMX selected: the German note and the German help label", async () => {
    const { ProviderPicker } = await import("../app/shell/ProviderPicker.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(NextIntlClientProvider, {
        locale: "de", messages: de, timeZone: "UTC",
        children: React.createElement(ProviderPicker, { value: "gmx", onChange: () => {} }),
      }));
    });
    const text = host.textContent ?? "";
    expect(text).toContain(pp(de).note_gmx);
    expect(text).toContain(pp(de).help_gmx);
    expect(text).not.toContain("GMX ships with IMAP switched OFF");
  });
});
