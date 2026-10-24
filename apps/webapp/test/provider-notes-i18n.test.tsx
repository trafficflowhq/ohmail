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
import { PROTON, PROVIDERS } from "../app/shell/providers";

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
      if (p.prereqUrl) expect(pp(en)[`prereq_${p.id}`], p.id).toBe(p.prereqLabel);
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
      if (p.prereqUrl) {
        expect(pp(de)[`prereq_${p.id}`], p.id).toBeTruthy();
        expect(pp(de)[`prereq_${p.id}`], p.id).not.toBe(p.prereqLabel);
      }
    }
  });

  it("no key for a preset the table does not have", () => {
    const ids = new Set(PROVIDERS.map((p) => p.id));
    for (const m of [en, de]) {
      for (const key of Object.keys(pp(m)).filter((k) => /^(note|help|prereq)_/.test(k))) {
        expect(ids.has(key.replace(/^(note|help|prereq)_/, "")), key).toBe(true);
      }
    }
  });
});

describe("the picker says it in German", () => {
  it("Gmail selected: the German note and both German links, prerequisite first", async () => {
    const { ProviderPicker } = await import("../app/shell/ProviderPicker.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(NextIntlClientProvider, {
        locale: "de", messages: de, timeZone: "UTC",
        children: React.createElement(ProviderPicker, { value: "gmail", onChange: () => {} }),
      }));
    });
    expect(host.textContent ?? "").toContain(pp(de).note_gmail);
    expect([...host.querySelectorAll(".pvp-note a")].map((a) => a.textContent)).toEqual([pp(de).prereq_gmail, pp(de).help_gmail]);
  });

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

describe("Proton: a note behind its own tile, never a choice", () => {
  it("opens the German note, reports nothing, and gives way to a provider chosen after it", async () => {
    const { ProviderPicker } = await import("../app/shell/ProviderPicker.js");
    const seen: string[] = [];
    function Picker() {
      const [value, setValue] = React.useState<string | null>(null);
      return React.createElement(ProviderPicker, { value, onChange: (id: string) => { seen.push(id); setValue(id); } });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(NextIntlClientProvider, { locale: "de", messages: de, timeZone: "UTC", children: React.createElement(Picker) }));
    });
    const proton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(PROTON.label))!;
    const note = pp(de).protonNote!.replace("{other}", pp(de).otherLabel!);
    expect(proton.getAttribute("role")).toBeNull();
    expect(host.querySelectorAll('[role="radio"]').length).toBe(PROVIDERS.length);
    expect(host.textContent).not.toContain(note);

    await act(async () => { proton.click(); });
    expect(proton.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain(note);
    expect(seen).toEqual([]);

    const gmail = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.includes("Gmail"))!;
    await act(async () => { gmail.click(); });
    expect(seen).toEqual(["gmail"]);
    expect(proton.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain(note);
    expect(host.textContent).toContain(pp(de).note_gmail);
  });
});
