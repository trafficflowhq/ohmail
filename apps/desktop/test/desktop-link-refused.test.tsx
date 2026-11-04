/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import { LINK_ASK_EVENT, LINK_REFUSED_EVENT } from "../src/native.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { enableExternalLinks, interceptLinkClicks } from "../../webapp/app/shell/open-external";
import { COPY } from "../../webapp/app/components/MessageBody";
import messages from "../../webapp/messages/en.json";

/**
 * A LINK THE SHELL WILL NOT OPEN IS SAID IN ONE SENTENCE, WHEREVER IT WAS DRAWN. Every link leaves
 * as a new-window request — the app document's turned into one inside the click, a message
 * frame's raised by the webview itself — and the shell refuses either with one event,
 * `link:refused`. The real gate is mounted over a fake shell whose new-window door refuses, and
 * every link must print the same words, once. Mutations watched red: the gate's
 * `onLinkRefused(say)` removed; a second refusal path put back beside the event.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/* ONE SHELL FOR THE FILE: the window registers each shell listener once for its life, so a second
   fake shell would hold no listener at all. */
const callbacks = new Map<number, (payload: unknown) => void>();
const listeners = new Map<string, number>();
let next = 1;
/* The tokens the window sent back to open a held press, and whether the shell still holds one. */
const answered: string[] = [];
let held = true;
host.__TAURI_INTERNALS__ = {
  transformCallback: (cb) => {
    const id = next++;
    callbacks.set(id, cb);
    return id;
  },
  invoke: async (command, payload) => {
    if (command === "engine_status") return { state: "no_key", mode: null, reason: "x" } as unknown as EngineStatus;
    if (command === "plugin:event|listen") listeners.set(String(payload?.event), Number(payload?.handler));
    if (command === "link_ask_open") {
      answered.push(String(payload?.token));
      if (!held) throw "ohmail: that link is no longer waiting";
    }
    return null;
  },
};
enableExternalLinks();
interceptLinkClicks(document, { trustSameOrigin: true });

function emit(event: string, payload: unknown): void {
  const id = listeners.get(event);
  if (id === undefined) throw new Error(`nothing is listening for ${event}`);
  callbacks.get(id)!({ event, id: 1, payload });
}

/* THE SHELL'S NEW-WINDOW DOOR, REFUSING: no window, and its one event carrying the address and why
   (the opener's refusal here; the gate's own are emitted by the rows that need them). */
window.open = ((url?: string | URL) => {
  emit(LINK_REFUSED_EVENT, { url: String(url), why: "opener" });
  return null;
}) as typeof window.open;

/** A refusal as the shell emits it: the address, and why in the log line's word. */
const refusal = (url: string, why = "opener"): { url: string; why: string } => ({ url, why });

type Loose = (props: Record<string, unknown>, ...children: unknown[]) => React.ReactElement;
const looseH = h as unknown as (c: Loose, p: Record<string, unknown> | null, ...k: unknown[]) => React.ReactElement;

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function turns(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

async function render(): Promise<void> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      looseH(
        IntlProvider as unknown as Loose,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        looseH(ThemeProvider as unknown as Loose, { storageKey: "ohmail.theme" },
          looseH(ToastHost as unknown as Loose, null, h(DesktopGate, null))),
      ),
    );
  });
  await turns();
}

/** Click an anchor in the app's own document; the shell's new-window door refuses it. */
async function clickInApp(href: string): Promise<void> {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.textContent = "link";
  mountPoint!.appendChild(a);
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  a.remove();
  await turns(5);
}

const said = (): string => document.body.textContent ?? "";
const sentence = (address: string): string => DOOR_COPY.linkNoBrowser(machineWord(), address);

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
});

describe("a refused link says one sentence, wherever it was drawn", () => {
  it("a link in the app's own document the shell refused is said, once", async () => {
    await render();
    await clickInApp("https://example.test/app-doc");
    expect(said()).toContain(sentence("https://example.test/app-doc"));
    expect(said().split(sentence("https://example.test/app-doc")).length - 1, "the refusal was said twice").toBe(1);
  });

  it("the shell's event is the one refusal path the window keeps", () => {
    const gate = readFileSync(resolve(__dirname, "../src/DesktopGate.tsx"), "utf8");
    expect(gate, "the gate still registers a refusal sink of the window's own").not.toMatch(/setOpenFailureSink/);
    expect(gate).toMatch(/void onLinkRefused\(say\);/);
  });

  it("a message frame's link the shell refused is said in the same words", async () => {
    await render();
    expect(listeners.has(LINK_REFUSED_EVENT), "the gate never listened for the shell's refusal").toBe(true);
    await act(async () => { emit(LINK_REFUSED_EVENT, refusal("https://example.test/frame")); });
    await turns(5);
    expect(said()).toContain(sentence("https://example.test/frame"));
  });

  it("a long address is cut the same way on both doors", async () => {
    await render();
    const inApp = `https://example.test/app/${"p".repeat(200)}`;
    const inFrame = `https://example.test/frame/${"p".repeat(200)}`;
    await clickInApp(inApp);
    expect(said()).toContain(sentence(`${inApp.slice(0, 80)}…`));
    await act(async () => { emit(LINK_REFUSED_EVENT, refusal(inFrame)); });
    await turns(5);
    expect(said(), "the frame's refusal was not cut the same way").toContain(sentence(`${inFrame.slice(0, 80)}…`));
    expect(said()).not.toContain(inFrame);
  });

  it("a payload that is not an address says nothing", async () => {
    await render();
    const before = said();
    await act(async () => {
      emit(LINK_REFUSED_EVENT, refusal(""));
      emit(LINK_REFUSED_EVENT, 7);
      emit(LINK_REFUSED_EVENT, refusal(`https://example.test/${"x".repeat(4096)}`));
      // No why, or one the shell never writes: whose refusal it was is not known.
      emit(LINK_REFUSED_EVENT, "https://example.test/bare");
      emit(LINK_REFUSED_EVENT, refusal("https://example.test/odd", "other"));
    });
    await turns(5);
    expect(said()).toBe(before);
  });
});

/**
 * THE TOAST SAYS WHOSE REFUSAL IT WAS. ohmail's own gate (an address of the wrong shape, one no
 * surface drew, a press the webview did not count as the person's) is not this computer refusing to
 * open a browser, and saying so sent the person after the wrong cause. Mutations watched red: every
 * refusal in the computer's words (the gate row); every refusal in ohmail's (the opener row); the
 * gate's toast without its Copy address (the copy row).
 */
describe("a refused link says whose refusal it was", () => {
  const copyButtons = (): HTMLButtonElement[] =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === DOOR_COPY.linkCopyAddress);

  it("ohmail's own gate refusals say ohmail could not open the link", async () => {
    await render();
    for (const why of ["shape", "unrendered", "gesture"]) {
      const url = `https://example.test/${why}`;
      await act(async () => { emit(LINK_REFUSED_EVENT, refusal(url, why)); });
      await turns(5);
      expect(said(), `a ${why} refusal`).toContain(DOOR_COPY.linkNotOpened(url));
      expect(said(), `a ${why} refusal blamed the computer`).not.toContain(sentence(url));
      expect(copyButtons().length, `a ${why} refusal offers no way to copy its address`).toBe(1);
    }
  });

  it("the computer's opener refusing keeps the computer's words", async () => {
    await render();
    await act(async () => { emit(LINK_REFUSED_EVENT, refusal("https://example.test/opener", "opener")); });
    await turns(5);
    expect(said()).toContain(sentence("https://example.test/opener"));
    expect(said()).not.toContain(DOOR_COPY.linkNotOpened("https://example.test/opener"));
    expect(copyButtons().length).toBe(1);
  });

  it("a long address the gate refused is cut as the opener's is", async () => {
    await render();
    const long = `https://example.test/gate/${"p".repeat(200)}`;
    await act(async () => { emit(LINK_REFUSED_EVENT, refusal(long, "unrendered")); });
    await turns(5);
    expect(said()).toContain(DOOR_COPY.linkNotOpened(`${long.slice(0, 80)}…`));
    expect(said()).not.toContain(long);
  });
});

/**
 * THE REFUSED ADDRESS IS COPIED WHOLE, WITH ONE PRESS. The toast shows a cut address, which a person
 * cannot paste anywhere; its one action copies the full address, written inside the press, and the
 * toast says "copied" only once the write fulfilled. Mutations watched red: the action removed; the
 * cut address copied; the sentence said before the write settled; a refused write said as copied.
 */
describe("a refused link's address is copied whole with one press", () => {
  const LONG = `https://vercel.example/acme-team/~/settings/billing?${"q".repeat(120)}#spend-management`;
  const written: string[] = [];
  let settle: ((ok: boolean) => void) | null = null;
  const copyButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === DOOR_COPY.linkCopyAddress);

  beforeEach(() => {
    written.length = 0;
    settle = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return new Promise<void>((resolve, reject) => {
            settle = (ok) => (ok ? resolve() : reject(new Error("the clipboard refused")));
          });
        },
      },
    });
  });

  afterEach(() => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  async function refuse(url: string): Promise<HTMLButtonElement> {
    await render();
    await act(async () => { emit(LINK_REFUSED_EVENT, refusal(url)); });
    await turns(5);
    const button = copyButton();
    expect(button, "the refusal offers no way to copy its address").toBeDefined();
    return button!;
  }

  it("copies the full, uncut address inside the press", async () => {
    const button = await refuse(LONG);
    expect(said()).toContain(sentence(`${LONG.slice(0, 80)}…`));
    expect(said(), "the uncut address was drawn").not.toContain(LONG);
    await act(async () => {
      button.click();
      expect(written, "the write waited for a later turn").toEqual([LONG]);
    });
    await act(async () => { settle!(true); });
    await turns(5);
    expect(said()).toContain(DOOR_COPY.linkAddressCopied);
  });

  it("says copied only after the write fulfils", async () => {
    const button = await refuse("https://example.test/held");
    await act(async () => { button.click(); });
    await turns(5);
    expect(written).toEqual(["https://example.test/held"]);
    expect(said(), "copied was said before the write settled").not.toContain(DOOR_COPY.linkAddressCopied);
    await act(async () => { settle!(true); });
    await turns(5);
    expect(said()).toContain(DOOR_COPY.linkAddressCopied);
  });

  it("a refused write says the address was not copied", async () => {
    const button = await refuse("https://example.test/refused");
    await act(async () => { button.click(); });
    await act(async () => { settle!(false); });
    await turns(5);
    expect(said()).toContain(DOOR_COPY.linkAddressNotCopied);
    expect(said()).not.toContain(DOOR_COPY.linkAddressCopied);
  });
});

/**
 * A MARKED LINK'S PRESS IS ASKED ABOUT IN THE WINDOW. The shell holds the press of a link whose
 * label names another site and hands the window a token and the address (`link:ask`); the window
 * names where it goes and sends back only the token, on Open. Mutations watched red: the gate's
 * `onLinkAsk` removed (nothing asks); Open sending the address or nothing (the token rows); Cancel
 * or Escape answering the shell (the empty rows); the focus on Open (the focus row); the payload
 * taken unchecked (the malformed rows); a stale answer swallowed (the toast).
 */
describe("a marked link the shell holds is asked about in the window", () => {
  const TOKEN = "0123abcd".repeat(4);
  const ASK = { token: TOKEN, url: "https://evil.example/login?x=1" };
  const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const button = (label: string): HTMLButtonElement =>
    [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  const ask = async (payload: unknown): Promise<void> => {
    await act(async () => { emit(LINK_ASK_EVENT, payload); });
    await turns(5);
  };

  afterEach(() => {
    answered.length = 0;
    held = true;
  });

  it("names where the link goes, starts on Cancel, and opens only by sending the token back", async () => {
    await render();
    expect(listeners.has(LINK_ASK_EVENT), "the gate never listened for the shell's ask").toBe(true);
    await ask(ASK);
    expect(dialog(), "a held press asked nothing").not.toBeNull();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialog()!.textContent).toContain(COPY.linkAskTitle);
    expect(dialog()!.textContent).toContain(COPY.linkAskGoes("evil.example"));
    expect(document.activeElement, "the ask did not start on Cancel").toBe(button(COPY.linkAskCancel));
    await act(async () => { button(COPY.linkAskOpen("evil.example")).click(); });
    await turns(5);
    expect(answered).toEqual([TOKEN]);
    expect(dialog()).toBeNull();
  });

  it("Cancel and Escape close it and answer the shell nothing", async () => {
    await render();
    await ask(ASK);
    await act(async () => { button(COPY.linkAskCancel).click(); });
    await turns(2);
    expect(dialog()).toBeNull();
    await ask(ASK);
    let reached = 0;
    const behind = (e: KeyboardEvent): void => { if (e.key === "Escape") reached += 1; };
    document.addEventListener("keydown", behind);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.activeElement!.dispatchEvent(escape); });
    await turns(2);
    document.removeEventListener("keydown", behind);
    expect(dialog()).toBeNull();
    expect([escape.defaultPrevented, reached], "Escape went on past the ask").toEqual([true, 0]);
    expect(answered).toEqual([]);
  });

  it("a press the shell no longer holds says so", async () => {
    await render();
    held = false;
    await ask(ASK);
    await act(async () => { button(COPY.linkAskOpen("evil.example")).click(); });
    await turns(5);
    expect(answered).toEqual([TOKEN]);
    expect(said()).toContain(COPY.linkAskGone);
  });

  it("a payload that is not an ask shows nothing", async () => {
    await render();
    for (const bad of [
      { token: "0123", url: ASK.url },
      { token: TOKEN.toUpperCase(), url: ASK.url },
      { token: TOKEN, url: "javascript:alert(1)" },
      { token: TOKEN, url: `https://example.test/${"x".repeat(4096)}` },
      { token: TOKEN },
      ASK.url,
      7,
    ]) await ask(bad);
    expect(dialog()).toBeNull();
    expect(answered).toEqual([]);
  });
});
