/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import { fillFrom } from "../app/shell/locale";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE PREFILLED DEFAULT FOLLOWS THE APP'S LANGUAGE — and saving it still means "no words of mine".
 *
 * The bar editor prefills the box with the product default as editable text. That default is a
 * SERVER constant, `DEFAULT_OHBOX_BAR`, delivered as `defaultBar` on `GET /account/screening` — so
 * a German reader with no stored bar was reading three English sentences in the one control that
 * asks them to write in their own words. The fix is display-only: the box renders the catalogue's
 * `settings.screening.defaultBar`, whose English half is byte-identical to the constant (bound by
 * `test/ohbox-default-bar-l10n.test.ts`) and whose German half is a twin.
 *
 * ── WHY THIS FILE EXISTS AT ALL, WHICH IS THE SAVE BUTTON AND NOT THE WORDS ─────────────────────
 *
 * Localising a prefill is two lines. Localising it SAFELY is this file. "Save" is inert until the
 * draft differs from the effective value, and the effective value used to be `stored ?? defaultBar`
 * — the English constant. Swap the prefill to German under that comparison and every German account
 * opens Settings with Save already armed, one press from converting a default account into a
 * CUSTOM-BAR account holding a sentence no classifier run has ever been tested against.
 *
 * So the rule the cases below pin is: a draft equal to EITHER language's default is "unchanged",
 * and any save of one writes `null` — the instruction "use the default" — rather than the twin's
 * text. An untouched German account keeps `ohbox_bar` NULL, and the classifier keeps receiving the
 * tested English constant. Nothing on the wire or in the engine changed, and nothing may.
 *
 * A reader who EDITS the prefill stores their own German words like anyone else; the last case
 * proves that too, because "never store the twin" must not become "never store German".
 */

// See `screening-section.test.tsx` for why React is published as a global and why API_BASE is set
// before the module under test (and its `api-client`) is imported.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/** German as the app builds it: the translation filled over English, exactly like `LocaleShell`. */
const GERMAN = fillFrom(
  en as unknown as Record<string, unknown>,
  de as unknown as Record<string, unknown>,
) as unknown as typeof en;

/**
 * What the SERVER sends as `defaultBar`. Taken from the English catalogue rather than retyped,
 * because the two are byte-identical by assertion — retyping it here would make this file a second
 * copy that can rot on its own.
 */
const SERVER_DEFAULT = en.settings.screening.defaultBar;
const GERMAN_DEFAULT = GERMAN.settings.screening.defaultBar;

interface Wire {
  ohboxPolicy: "people_only" | "people_and_replied" | null;
  ohboxBar: string | null;
  defaultBar: string;
}

let stored: Wire;
let patchBodies: Array<{ ohboxBar?: unknown }>;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(typeof input === "string" ? input : input).replace(/^\/api/, "");
    if (path === "/account/screening") {
      if ((init?.method ?? "GET") === "PATCH") {
        const body = JSON.parse(init!.body as string) as { ohboxBar?: unknown };
        patchBodies.push(body);
        if ("ohboxBar" in body) stored = { ...stored, ohboxBar: body.ohboxBar as string | null };
        return json(stored);
      }
      return json(stored);
    }
    return json({});
  }) as typeof fetch;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

/** Render (or re-render, for the language switch) the pane under one catalogue. */
async function show(locale: "en" | "de"): Promise<void> {
  const { ScreeningSection } = await import("../app/shell/ScreeningSection.js");
  const messages = locale === "de" ? GERMAN : en;
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages, timeZone: "UTC",
        children: h(ThemeProvider, { storageKey: null, children: h(ScreeningSection) }),
      }),
    );
  });
  await flush();
}

const textarea = (): HTMLTextAreaElement =>
  host!.querySelector(".set-screening-textarea") as HTMLTextAreaElement;
const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  Array.from(host!.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
const saveButton = (locale: "en" | "de"): HTMLButtonElement =>
  buttonNamed((locale === "de" ? GERMAN : en).settings.screening.save)!;

/** Type into the controlled textarea the way React reads it — set the value, then dispatch input. */
async function typeInto(value: string): Promise<void> {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

const press = async (button: HTMLButtonElement): Promise<void> => {
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

beforeEach(() => {
  patchBodies = [];
  stored = {
    ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: SERVER_DEFAULT,
  };
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe("the prefilled default, in the reader's language", () => {
  it("is the ENGLISH constant under English — byte for byte what the server sent", async () => {
    await show("en");
    expect(textarea().value).toBe(SERVER_DEFAULT);
    expect(textarea().placeholder).toBe(SERVER_DEFAULT);
  });

  it("is the GERMAN twin under German, for an account that has never set a bar", async () => {
    await show("de");
    // Not the English sentence the wire carried — this is the whole point of the slice.
    expect(textarea().value).not.toBe(SERVER_DEFAULT);
    expect(textarea().value).toBe(GERMAN_DEFAULT);
    expect(textarea().placeholder).toBe(GERMAN_DEFAULT);
    // …and it is real German, not a key that failed to resolve.
    expect(textarea().value).toContain("Ohbox");
    expect(textarea().value).not.toContain("settings.screening");
  });

  it("still shows the account's OWN words in German when a bar IS stored", async () => {
    stored.ohboxBar = "Nur meine Kundschaft und die Schule der Kinder.";
    await show("de");
    expect(textarea().value).toBe("Nur meine Kundschaft und die Schule der Kinder.");
  });
});

describe("an untouched prefill writes NOTHING — in either language", () => {
  it("leaves Save inert under English, and PATCHes nothing on open", async () => {
    await show("en");
    expect(saveButton("en").disabled).toBe(true);
    expect(patchBodies).toEqual([]);
  });

  /**
   * THE TRAP THIS SLICE WAS WRITTEN AROUND.
   *
   * Under the old comparison the effective value is the server's English constant, so a German
   * prefill differs from it on the very first frame: Save arms with nobody having typed, and one
   * press turns a default account into a custom-bar account. Save must be dead here.
   */
  it("leaves Save inert under GERMAN, where the box and the wire hold different sentences", async () => {
    await show("de");
    expect(textarea().value).not.toBe(stored.defaultBar);
    expect(
      saveButton("de").disabled,
      "Save armed on an untouched German prefill — opening Settings would offer to store the twin",
    ).toBe(true);
    expect(patchBodies).toEqual([]);
  });

  it("treats EITHER language's default as unchanged — pasting the English one into a German box", async () => {
    await show("de");
    await typeInto(SERVER_DEFAULT);
    expect(saveButton("de").disabled).toBe(true);
  });

  /**
   * The pane is re-rendered, not remounted, when the language is switched (`LocaleShell` swaps the
   * provider's messages under the same tree), so the draft survives the switch. An untouched prefill
   * has to follow the language across it; anything somebody has typed must not.
   */
  it("re-seeds an untouched prefill when the language changes under it", async () => {
    await show("de");
    expect(textarea().value).toBe(GERMAN_DEFAULT);
    await show("en");
    expect(textarea().value).toBe(SERVER_DEFAULT);
    expect(saveButton("en").disabled).toBe(true);
    expect(patchBodies).toEqual([]);
  });

  it("leaves a draft somebody TYPED alone when the language changes under it", async () => {
    await show("de");
    await typeInto("Nur Post von Menschen, die ich kenne.");
    await show("en");
    expect(textarea().value).toBe("Nur Post von Menschen, die ich kenne.");
    expect(saveButton("en").disabled).toBe(false);
  });
});

describe("what a save actually writes", () => {
  it("stores the German words a reader TYPED, exactly as typed", async () => {
    await show("de");
    await typeInto("Halte meine Ohbox frei für meine Kundschaft und die Schule der Kinder.");
    expect(saveButton("de").disabled).toBe(false);
    await press(saveButton("de"));
    expect(patchBodies).toEqual([
      { ohboxBar: "Halte meine Ohbox frei für meine Kundschaft und die Schule der Kinder." },
    ]);
  });

  /**
   * NULL, NEVER THE TWIN. Somebody with a stored bar who types the German default back over it is
   * saying "use the default", and that is `null` — the state in which the classifier receives the
   * English constant it was tested against. Storing the twin's text instead would put untested
   * German into the model's user turn, which is the one outcome this slice must not produce.
   */
  it("writes null — not the twin's text — when the draft IS the German default", async () => {
    stored.ohboxBar = "Nur meine Kundschaft.";
    await show("de");
    await typeInto(GERMAN_DEFAULT);
    expect(saveButton("de").disabled).toBe(false);
    await press(saveButton("de"));
    expect(patchBodies).toEqual([{ ohboxBar: null }]);
    // And the box comes back to the twin, because that is what NULL now renders as.
    expect(textarea().value).toBe(GERMAN_DEFAULT);
  });

  it("writes null for the ENGLISH default too, typed over a stored bar", async () => {
    stored.ohboxBar = "Only my clients.";
    await show("en");
    await typeInto(SERVER_DEFAULT);
    await press(saveButton("en"));
    expect(patchBodies).toEqual([{ ohboxBar: null }]);
  });

  it("re-seeds the box in GERMAN after 'use the default' reverts a stored bar", async () => {
    stored.ohboxBar = "Nur meine Kundschaft.";
    await show("de");
    await press(buttonNamed(GERMAN.settings.screening.reset)!);
    expect(patchBodies).toEqual([{ ohboxBar: null }]);
    expect(textarea().value).toBe(GERMAN_DEFAULT);
    expect(saveButton("de").disabled).toBe(true);
  });
});
