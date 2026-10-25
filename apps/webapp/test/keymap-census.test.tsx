/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { chordKeys, modGlyph } from "../app/shell/keymap";

/**
 * THE KEYMAP CENSUS (ohmarchy Phase 1) — the one-table grammar, asserted through the sheet.
 *
 * The `?` sheet is GENERATED from the registry by the dispatcher's own precedence walk, so
 * the sheet's rows ARE the keymap: a binding deleted anywhere in the shell disappears from
 * the sheet, and this census goes red naming the chord. That is the mutation contract the
 * plan demands ("removing a binding reddens the sheet test"), and it is why the census reads
 * the RENDERED sheet on the REAL shell rather than importing any table of its own — a
 * hand-kept expected-list is half the trap, and the other half (the app silently losing a
 * key) is exactly what the expectations below exist to catch.
 *
 * Three surfaces, because the sheet answers "what will this key do HERE": the Ohbox carries
 * the global grammar plus the list/message verbs; the Screener its decision letters and the
 * section walk; Compose its send/schedule chords and the send-later digits.
 *
 * The COLLISION POLICY is asserted too (the prototype's, verbatim): nothing on Super,
 * no Alt chords, no F-keys — every listed cap is a bare key, a ⇧/⌘ chord, or a two-key
 * `g` sequence. `chordMatches` already refuses `altKey` events by construction; this half
 * keeps anyone from ADVERTISING such a chord through the sheet.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** The shipped shell on the fixture world, wrapped exactly as the desktop entry wraps it. */
async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

const go = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
};

/**
 * Every chord the open sheet lists, as `chordKeys(...).join("")` — the sheet's own notation.
 * A row may carry more than one chord (`1 · g o` both go to the Ohbox), so the unit is the
 * `.ks-chord` span, never the row: a chord folded into a shared row is still listed.
 */
function sheetCaps(container: HTMLElement): string[] {
  const sheet = container.querySelector(".ks");
  expect(sheet, "the ? sheet is not open").toBeTruthy();
  return [...sheet!.querySelectorAll(".ks-chord")].map(
    (el) => [...el.querySelectorAll("kbd")].map((k) => k.textContent ?? "").join(""),
  );
}

/* The modifier's cap is the PLATFORM's (`modGlyph`) — jsdom announces no Mac, so the sheet
   prints Ctrl here, and the expectation is spelled with the same function the sheet uses. */
const cap = (chord: string): string => chordKeys(chord, modGlyph()).join("");

/** Assert every chord in `expected` has a row in the open sheet, naming the missing one. */
function expectListed(container: HTMLElement, expected: string[]): void {
  const caps = new Set(sheetCaps(container));
  for (const chord of expected) {
    expect(caps.has(cap(chord)), `the sheet no longer lists \`${chord}\``).toBe(true);
  }
}

describe("the keymap census — the one table, surface by surface", () => {
  it("the Ohbox sheet carries the whole global grammar", async () => {
    const container = await shell();
    await key("?");

    expectListed(container, [
      // go — places: the g leader, complete
      "g o", "g r", "g e", "g s",
      "g l", "g p", "g b", "g d", "g h", "g ,",
      "/", "mod+k",
      // the numbered rail (derived from menu order; the demo world has at least four piles)
      "1", "2", "3", "4",
      // focus — the tiles: arrows and their vim twins
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "h", "l",
      // act on the open message — `⇧F` is Forward, beside the two reply verbs. `f` is the Reply
      // Run and stays where it is; the shifted variant is the convention `⇧R`/`⇧U` set, and the
      // pill's own Forward keycap is generated from this same registry entry.
      "r", "shift+r", "shift+f", "mod+Enter", "a", "e", "b", "s", "m", "d",
      "t", "x", "u", "shift+i", "shift+u",
      // list & app — `w` is the layout cycle (classic ⇄ Zero, OHMARCHY-PLAN §3b),
      // registered unconditionally so the sheet documents it on every face
      "j", "k", "Enter", "c", "f", "p", "w", "?", "Escape",
    ]);
  });

  it("one row per sentence: a place with two chords is listed once, wearing both", async () => {
    // `1` and `g o` both go to the Ohbox. The digit binding borrows the `g` chord's sentence
    // so the sheet folds the two into one row instead of listing every destination twice under
    // two spellings — and a chord folded into a shared row is still a chord the sheet lists.
    const container = await shell();
    await key("?");
    const rows = [...container.querySelectorAll(".ks li")].map((li) => ({
      label: li.querySelector(".ks-lab")!.textContent ?? "",
      chords: [...li.querySelectorAll(".ks-chord")].map((c) => [...c.querySelectorAll("kbd")].map((k) => k.textContent).join("")),
    }));
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size, `a sentence is listed twice: ${labels.filter((l, i) => labels.indexOf(l) !== i).join(" · ")}`).toBe(labels.length);
    const ohbox = rows.find((r) => r.chords.includes(cap("g o")));
    expect(ohbox, "no row carries `g o`").toBeTruthy();
    expect(ohbox!.chords).toContain(cap("1"));
    // The place the rail does not have is not offered: no chord leads to "Triage".
    expect(labels.some((l) => /triage/i.test(l))).toBe(false);
  });

  it("the modifier's cap is the platform's — Ctrl where there is no ⌘", () => {
    const stub = (platform: string, ua: string) => {
      Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
      Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
    };
    const was = { platform: navigator.platform, ua: navigator.userAgent };
    try {
      stub("Linux x86_64", "Mozilla/5.0 (X" + "11; Linux x86_64) AppleWebKit/537.36");
      expect(modGlyph()).toBe("Ctrl");
      expect(chordKeys("mod+k", modGlyph())).toEqual(["Ctrl", "k"]);
      stub("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
      expect(modGlyph()).toBe("Ctrl");
      stub("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
      expect(modGlyph()).toBe("⌘");
      expect(chordKeys("mod+Enter", modGlyph())).toEqual(["⌘", "↵"]);
    } finally {
      stub(was.platform, was.ua);
    }
  });

  it("the Screener sheet carries the decision letters and the section walk", async () => {
    const container = await shell();
    await go("#/screener");
    await key("?");

    expectListed(container, [
      "[", "]", // sections — waiting · screened out · junk
      "o", "r", "c", "n", "x", // the five destinations
      "shift+o", "shift+r", "shift+c", // the read twins (demoting ones have none)
      "a", "s", "j", "k", "Enter", "Escape",
    ]);
    // `s` is one sender here as in the reader; no key decides every waiting sender.
    const labels = [...container.querySelectorAll(".ks li")].map((li) => ({
      label: li.querySelector(".ks-lab")!.textContent ?? "",
      caps: [...li.querySelectorAll(".ks-chord")].map((c) => [...c.querySelectorAll("kbd")].map((k) => k.textContent).join("")),
    }));
    expect(labels.find((r) => r.caps.includes(cap("s")))?.label).toBe(messages.shortcuts.screen);
    expect(labels.map((r) => r.label)).not.toContain("Mark every waiting sender spam");
  });

  it("the Compose sheet carries send, schedule and the send-later digits", async () => {
    const container = await shell();
    await go("#/compose");
    await key("?");

    expectListed(container, [
      "mod+Enter", // send (and, with the picker open, schedule — two entries, one cap)
      "1", "2", "3", "4", // the send-later presets
      "Escape",
    ]);
  });

  it("the collision policy holds — no Super, no Alt, no F-keys, anywhere on the sheet", async () => {
    const container = await shell();
    for (const hash of ["", "#/screener", "#/compose"]) {
      if (hash) await go(hash);
      await key("?");
      for (const caps of sheetCaps(container)) {
        expect(caps, "an F-key is advertised").not.toMatch(/F\d+/);
        expect(caps, "an Alt chord is advertised").not.toMatch(/alt/i);
        expect(caps, "a Super chord is advertised").not.toMatch(/super|meta|⊞|win/i);
      }
      await key("Escape");
    }
  });
});
