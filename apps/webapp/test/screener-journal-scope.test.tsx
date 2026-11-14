/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { UNDO_MS } from "@ohmail/app-logic/press";
import { SCREENER_INTENTS_PREFIX, screenerIntentsKey } from "@ohmail/app-logic/screener/screener-intents";
import { resetStorageOwnerForTest, storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../messages/en.json";

/**
 * THE SHELL HANDS THE SCREENER ITS OWN SCOPE.
 *
 * The Screener's state keeps a decision in a journal from the press until its Undo window has closed, and the
 * journal's key names the scope the hook was handed. The hook's own tests hand it a scope themselves, so none of
 * them sees which one the shell hands it: a shell that handed another account's would journal this account's
 * decision under that account's key, and replay it there on that account's next visit. This file mounts the shell
 * for one account, decides on one sender with the key the Screener offers, and reads whose journal holds it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "acc-A1234";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
}
const tick = async (ms: number): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await settle();
};
const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settle(2);
};

/** Today's views over a live engine, as a host mounts them for the account the marker names. */
async function mountScreener(): Promise<void> {
  window.location.hash = "#/screener";
  const { AppShell } = await import("./_todays-shell.js");
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), storePolicy: { mode: "full" } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell as never, { demo: false, engine } as never) }),
        } as never),
      }),
    );
  });
  await settle();
}

/** Every Screener journal this browser holds, by key, with how many decisions each one names. */
function journals(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)!;
    if (!k.startsWith(SCREENER_INTENTS_PREFIX)) continue;
    const held = JSON.parse(window.localStorage.getItem(k) ?? "[]") as unknown;
    out[k] = Array.isArray(held) ? held.length : Object.keys(held as object).length;
  }
  return out;
}
const decides = (): EngineMutation[] => sent.filter((m) => m.kind === "screener_decide");

beforeAll(async () => { await import("./_todays-shell.js"); }, 120_000);

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
  sent = [];
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  resetStorageOwnerForTest();
  window.localStorage.clear();
});

describe("a Screener decision pressed in the shell is journalled under the scope of the shell's own mount", () => {
  it("holds the decision in this account's journal through its Undo window, and in no other journal", async () => {
    await mountScreener();
    await tick(2000);
    expect(storageOwner(), "the mount is this account's").toBe(ACCOUNT);
    expect(host!.querySelector(".view-screener"), "the Screener is on screen").not.toBeNull();
    expect(journals(), "a journal before any press").toEqual({});

    await key("r");

    expect(decides(), "nothing reaches the wire inside the Undo window").toEqual([]);
    expect(journals(), "the decision stands in this account's journal and in no other")
      .toEqual({ [screenerIntentsKey(ACCOUNT)]: 1 });

    await tick(UNDO_MS + 2000);

    expect(decides(), "the decision went out once its window closed").toHaveLength(1);
    const left = journals();
    expect(Object.keys(left).filter((k) => k !== screenerIntentsKey(ACCOUNT)), "another journal was written").toEqual([]);
    expect(left[screenerIntentsKey(ACCOUNT)] ?? 0, "the sent decision is spent in its own journal").toBe(0);
  });
});
