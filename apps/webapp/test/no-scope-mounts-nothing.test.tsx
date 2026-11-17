/** @vitest-environment jsdom */
/**
 * A HOST WITH NO SCOPE MOUNTS NOTHING OF TODAY'S VIEWS, and so nothing is kept under the key spaces that name nobody:
 * no frame, no list, no composer, and no key ending in `local` or `anon`, no bare look key, no reply key that names no
 * account. Through the harness, handed `scope: null` with no storage owner named.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../messages/en.json";
import { act, consentTransport, engineOver, msg, NOW, S, setup, storeWith, teardown } from "./_view-shell.js";

/** The key spaces a surface with no account keeps under: each a key's spelling of nobody. */
const NAMES_NOBODY = (key: string): boolean =>
  /\.(local|anon)$/.test(key)
  || /\.local\./.test(key)
  || key === "ohmail.ui.reader.afterVerb"
  || key === "ohmail.ui.compose.imageQuality"
  || key.startsWith("ohmail.ui.reply:")
  || key.startsWith("ohmail.ui.replymeta:");
const keysOf = (store: Storage): string[] => Object.keys(store);

async function mountUnder(scope: string | null, hash: string): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const store = await storeWith([msg("m1")]);
  const engine = engineOver(store);
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: React.createElement(ThemeProvider, { children: React.createElement(ToastHost, {
        children: React.createElement(AppShell as never, {
          scope, demo: false, engine, consentTransport, mailboxFacts: async () => [],
        } as never),
      }) }),
    } as never));
  });
  /* Four seconds of timers: autosaves, journals and looks would have landed by then. */
  for (let i = 0; i < 40; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  return container;
}

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  window.sessionStorage.clear();
});
afterEach(async () => {
  await teardown();
  resetStorageOwnerForTest();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("a host with no scope", () => {
  /** What a mount under a scope draws at the list, then at the composer, each mount alone. */
  async function drawnUnder(scope: string | null): Promise<{ frame: boolean; list: boolean; composer: boolean }> {
    const atList = await mountUnder(scope, "#/ohbox");
    const list = { frame: atList.querySelector(".fr-frame") !== null, list: atList.querySelector(".view-ohbox") !== null };
    for (const root of S.roots.splice(0)) await act(async () => { root.unmount(); });
    const atComposer = await mountUnder(scope, "#/compose");
    const composer = atComposer.querySelector('input[aria-label="Subject"]') !== null;
    const frame = list.frame || atComposer.querySelector(".fr-frame") !== null;
    for (const root of S.roots.splice(0)) await act(async () => { root.unmount(); });
    return { frame, list: list.list, composer };
  }

  it("draws nothing of today's views, at the list and at the composer, and keeps nothing under a key that names nobody", async () => {
    const drawn = await drawnUnder(null);
    expect({
      ...drawn,
      local: keysOf(window.localStorage).filter(NAMES_NOBODY),
      session: keysOf(window.sessionStorage).filter(NAMES_NOBODY),
    }).toEqual({ frame: false, list: false, composer: false, local: [], session: [] });
  }, 30_000);

  it("CONTROL: a host that names an account draws the list and the composer", async () => {
    expect(await drawnUnder("acc-control")).toEqual({ frame: true, list: true, composer: true });
  }, 30_000);
});
