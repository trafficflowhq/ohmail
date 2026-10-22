/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { AutoActRow } from "../app/shell/AutoActRow";

/**
 * "ACT ON CONFIDENT SUGGESTIONS FOR ME", RENDERED — the ruled words, the stored value,
 * and the two disabled states: automatic suggestions off, and an install that reads mail another
 * install organizes. The desktop's standalone door renders this same row.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const TITLE = "Act on confident suggestions for me";
const DESCRIPTION = "When a suggestion about a waiting sender is at least 90% sure, ohmail files that "
  + "sender where the suggestion says — the Ohbox, News, Receipts, Screened or Spam — and writes the rule "
  + "for you. Each such rule is marked as ohmail's and you can undo it in Settings → Rules. Senders you "
  + "have written to, and sensitive mail, are never filed this way. If a Screened or Spam suggestion is "
  + "about a message whose sender was not confirmed — by your mail provider, or by the signature the "
  + "sender's own domain put on the message — or rests only on the same "
  + "subject from other first-time senders, ohmail files only that message, writes no rule, and lists it "
  + "under Filed automatically, where you can put it back. Off by default.";
/** Where the Rules pane reads a copy without the mark (the desktop's hosted door). */
const UNMARKED = DESCRIPTION.replace(
  "is marked as ohmail's and you can undo it in Settings → Rules.",
  "is listed in Settings → Rules, where you can undo it.",
);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

async function mount(props: Parameters<typeof AutoActRow>[0], locale: "en" | "de" = "en"): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(AutoActRow, props) }),
    }));
  });
}
const sw = (): HTMLButtonElement => host!.querySelector('button[role="switch"]') as HTMLButtonElement;
const why = (): string | null => host!.querySelector("[data-act-why]")?.textContent ?? null;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
};

describe("the act on suggestions' switch", () => {
  it("says what it agrees to, word for word, and writes on a press when suggestions are on", async () => {
    const calls: boolean[] = [];
    await mount({ on: false, suggestOn: true, reader: false, setAutoAct: async (v) => { calls.push(v); return v; } });
    expect(host!.textContent).toContain(TITLE);
    expect(host!.textContent).toContain(DESCRIPTION);
    expect(en.screener.suggest.actDescription).toBe(DESCRIPTION);
    expect(host!.textContent, "no-AI wording within reach of the act").not.toMatch(/no AI/i);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().disabled).toBe(false);
    expect(why()).toBeNull();
    await act(async () => { sw().click(); });
    await flush();
    expect(calls).toEqual([true]);
  });

  it("claims the mark only where the Rules pane shows it", async () => {
    await mount({ on: false, suggestOn: true, reader: false, rulesMarked: false, setAutoAct: async (v) => v });
    expect(host!.textContent).toContain(UNMARKED);
    expect(host!.textContent).not.toContain("marked as ohmail's");
    expect(en.screener.suggest.actDescriptionUnmarked).toBe(UNMARKED);
  });

  it("shows the stored ON and writes OFF", async () => {
    const calls: boolean[] = [];
    await mount({ on: true, suggestOn: true, reader: false, setAutoAct: async (v) => { calls.push(v); return v; } });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    await act(async () => { sw().click(); });
    await flush();
    expect(calls).toEqual([false]);
  });

  it("is disabled with 'Needs automatic suggestions' while those are off", async () => {
    await mount({ on: false, suggestOn: false, reader: false, setAutoAct: async () => { throw new Error("no write"); } });
    expect(sw().disabled).toBe(true);
    expect(why()).toBe("Needs automatic suggestions");
  });

  it("on a reader install it is disabled and sends the person to the organizer", async () => {
    await mount({ on: false, suggestOn: true, reader: true, setAutoAct: async () => { throw new Error("no write"); } });
    expect(sw().disabled).toBe(true);
    expect(why()).toBe("Set this on the install that organizes your mail.");
  });

  it("a refused write says so and leaves the stored value", async () => {
    await mount({ on: false, suggestOn: true, reader: false, setAutoAct: async () => { throw new Error("400"); } });
    await act(async () => { sw().click(); });
    await flush();
    expect(host!.textContent).toContain("That setting did not save. It is unchanged.");
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("renders in German from the German catalogue", async () => {
    await mount({ on: false, suggestOn: false, reader: false, setAutoAct: async (v) => v }, "de");
    expect(host!.textContent).toContain(de.screener.suggest.actTitle);
    expect(host!.textContent).toContain(de.screener.suggest.actDescription);
    expect(why()).toBe(de.screener.suggest.actNeedsSuggest);
    expect(de.screener.suggest.actTitle).not.toBe(TITLE);
  });
});
