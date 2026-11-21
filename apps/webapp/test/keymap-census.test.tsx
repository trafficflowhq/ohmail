/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { NONE } from "@ohmail/app/host";
import { WEB_PANE_PARTS } from "../app/(product)/mailbox/pane-parts";
import { chordKeys, modGlyph } from "@ohmail/app-logic/keys/keymap";

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

/** The mounted mail shell on the demo fixture, with the web Account entry. */
async function shell(): Promise<void> {
  const { MailShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { account } = WEB_PANE_PARTS;
  if (account === NONE) throw new Error("the web app did not supply Account settings");

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
          children: h(ToastHost, { children: h(MailShell, { demo: true, accountDoors: account }) }),
        }),
      }),
    );
  });
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
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

/** Move focus out of the composition field so typing ? invokes the shortcut sheet. */
function focusWriteControl(): void {
  screen.getByRole("button", { name: messages.write.marks.bold }).focus();
}

/** Each shortcut sentence can carry more than one chord. */
function sheetRows(): Array<{ label: string; chords: string[] }> {
  const sheet = within(screen.getByRole("dialog", { name: messages.shortcuts.title }));
  return sheet.getAllByRole("paragraph").map((row) => {
    const label = row.querySelector(".oh-keyhelp-label")?.textContent ?? "";
    const chords = [...row.querySelectorAll(".oh-keyhelp-chord")].map(
      (chord) => [...chord.querySelectorAll("kbd")].map((key) => key.textContent ?? "").join(""),
    );
    return { label, chords };
  });
}

/* The modifier's cap is the PLATFORM's (`modGlyph`) — jsdom announces no Mac, so the sheet
   prints Ctrl here, and the expectation is spelled with the same function the sheet uses. */
const cap = (chord: string): string => chordKeys(chord, modGlyph()).join("");

/** Assert every chord in `expected` has a row in the open sheet, naming the missing one. */
function expectListed(expected: string[]): void {
  const caps = new Set(sheetRows().flatMap((row) => row.chords));
  const missing = expected.filter((chord) => !caps.has(cap(chord)));
  expect(missing, `shortcuts missing from the sheet: ${missing.join(", ")}`).toEqual([]);
}

describe("the keymap census — the one table, surface by surface", () => {
  it("the Ohbox sheet carries the whole global grammar", async () => {
    await shell();
    await key("j");
    await key("j");
    await key("Enter");
    await key("x");
    await key("?");

    expectListed([
      // go — places: the g leader, complete
      "g o", "g r", "g e", "g s",
      "g l", "g p", "g b", "g d", "g h", "g ,",
      "/", "mod+k",
      // the numbered rail (derived from menu order; the demo world has at least four piles)
      "1", "2", "3", "4",
      // focus — the tiles: arrows and their vim twins
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "h", "l",
      // act on the open message — `⇧F` is Forward, beside the two reply verbs. `f` is the Reply
      // Run across mail; the shifted variant is the convention `⇧R`/`⇧U` set, and the
      // pill's own Forward keycap is generated from this same registry entry.
      "r", "shift+r", "shift+f", "a", "e", "b", "s", "m", "d",
      "t", "x", "u", "shift+i", "shift+u",
      // list & app
      "j", "k", "Enter", "c", "?", "Escape",
    ]);
    const caps = sheetRows().flatMap((row) => row.chords);
    expect(sheetRows().find(({ label }) => label === messages.triage.keyReplyRun)?.chords).toContain(cap("f"));
    // The design lists Pull new mail, and the mail rail binds it to the Pull action.
    expect(sheetRows().filter(({ label }) => label === messages.shortcuts.pull).map(({ chords }) => chords))
      .toEqual([[cap("p")]]);
    expect(caps).not.toContain(cap("w"));

    await key("Escape");
    await key("x");
    await key("r");
    focusWriteControl();
    await key("?");
    expectListed(["mod+Enter"]);
  });

  it("one row per sentence: a place with two chords is listed once, wearing both", async () => {
    // `1` and `g o` both go to the Ohbox. The digit binding borrows the `g` chord's sentence
    // so the sheet folds the two into one row instead of listing every destination twice under
    // two spellings — and a chord folded into a shared row is still a chord the sheet lists.
    await shell();
    await key("?");
    const rows = sheetRows();
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
    await shell();
    await go("#/screener");
    await key("j");
    await key("?");

    expectListed([
      "]", // advance from Waiting to Screened out
      "o", "r", "c", "n", "x", // the five destinations
      "shift+o", "shift+r", "shift+c", // the read twins (demoting ones have none)
      "a", "s", "j", "k", "Enter", "Escape",
    ]);
    // `s` is one sender here as in the reader; no key decides every waiting sender.
    const labels = sheetRows();
    expect(labels.find((r) => r.chords.includes(cap("s")))?.label).toBe(messages.shortcuts.screen);
    expect(labels.map((r) => r.label)).not.toContain("Mark every waiting sender spam");

    await key("Escape");
    await go("#/screener/screened");
    await key("?");
    expectListed(["["]); // the previous section is reachable from Screened out
  });

  it("the Compose sheet carries send, schedule and the send-later digits", async () => {
    await shell();
    await go("#/compose");
    focusWriteControl();
    await key("?");

    expectListed(["mod+Enter", "1", "2", "3", "4", "Escape"]);
    const rows = sheetRows();
    expect(rows).toContainEqual({ label: messages.write.keys.send, chords: [cap("mod+Enter")] });
    // A rail digit in the same sheet cannot stand for a Send later preset.
    const schedule = [
      ["mod+Enter", messages.compose.keySchedule],
      ["1", messages.compose.keyLaterTonight],
      ["2", messages.compose.keyLaterTomorrow],
      ["3", messages.compose.keyLaterMonday],
      ["4", messages.compose.keyLaterPick],
    ] as const;
    const missing = schedule.filter(([chord, label]) =>
      !rows.some((row) => row.label === label && row.chords.includes(cap(chord))),
    );
    expect(missing, "the sheet does not identify the Send later chords").toEqual([]);
  });

  it("the collision policy holds — no Super, no Alt, no F-keys, anywhere on the sheet", async () => {
    await shell();
    for (const hash of ["", "#/screener", "#/compose"]) {
      if (hash) await go(hash);
      if (hash === "#/compose") focusWriteControl();
      await key("?");
      for (const caps of sheetRows().flatMap((row) => row.chords)) {
        expect(caps, "an F-key is advertised").not.toMatch(/F\d+/);
        expect(caps, "an Alt chord is advertised").not.toMatch(/alt/i);
        expect(caps, "a Super chord is advertised").not.toMatch(/super|meta|⊞|win/i);
      }
      await key("Escape");
    }
  });
});
