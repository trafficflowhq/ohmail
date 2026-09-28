/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import { LINK_REFUSED_EVENT } from "../src/native.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { enableExternalLinks, interceptLinkClicks } from "../../webapp/app/shell/open-external";
import messages from "../../webapp/messages/en.json";

/**
 * A LINK THE SHELL WILL NOT OPEN IS SAID IN ONE SENTENCE, WHICHEVER DOOR IT CAME THROUGH. A link
 * in the app's own document is refused by the opener command; a link in a message frame reaches
 * the shell as a new-window request and is refused there (`link:refused`). The real gate is
 * mounted over a fake shell and both routes must print the same words. Mutations watched red:
 * the gate's `onLinkRefused(say)` removed; the event registered with a second wording.
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
host.__TAURI_INTERNALS__ = {
  transformCallback: (cb) => {
    const id = next++;
    callbacks.set(id, cb);
    return id;
  },
  invoke: async (command, payload) => {
    if (command === "engine_status") return { state: "no_key", mode: null, reason: "x" } as unknown as EngineStatus;
    if (command === "plugin:event|listen") listeners.set(String(payload?.event), Number(payload?.handler));
    if (command === "open_external") throw new Error("ohmail: this computer would not open a browser (exit 3)");
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

/** Click an anchor in the app's own document; the opener command refuses it. */
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

describe("a refused link says one sentence on both doors", () => {
  it("the app document's refusal is said (the positive control)", async () => {
    await render();
    await clickInApp("https://example.test/app-doc");
    expect(said()).toContain(sentence("https://example.test/app-doc"));
  });

  it("a message frame's link the shell refused is said in the same words", async () => {
    await render();
    expect(listeners.has(LINK_REFUSED_EVENT), "the gate never listened for the shell's refusal").toBe(true);
    await act(async () => { emit(LINK_REFUSED_EVENT, "https://example.test/frame"); });
    await turns(5);
    expect(said()).toContain(sentence("https://example.test/frame"));
  });

  it("a long address is cut the same way on both doors", async () => {
    await render();
    const inApp = `https://example.test/app/${"p".repeat(200)}`;
    const inFrame = `https://example.test/frame/${"p".repeat(200)}`;
    await clickInApp(inApp);
    expect(said()).toContain(sentence(`${inApp.slice(0, 80)}…`));
    await act(async () => { emit(LINK_REFUSED_EVENT, inFrame); });
    await turns(5);
    expect(said(), "the frame's refusal was not cut the same way").toContain(sentence(`${inFrame.slice(0, 80)}…`));
    expect(said()).not.toContain(inFrame);
  });

  it("a payload that is not an address says nothing", async () => {
    await render();
    const before = said();
    await act(async () => {
      emit(LINK_REFUSED_EVENT, "");
      emit(LINK_REFUSED_EVENT, 7);
      emit(LINK_REFUSED_EVENT, `https://example.test/${"x".repeat(4096)}`);
    });
    await turns(5);
    expect(said()).toBe(before);
  });
});
