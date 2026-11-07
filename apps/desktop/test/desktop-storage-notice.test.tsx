/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { storageFactsOf, type StorageFacts } from "../../webapp/app/shell/storage-state";

/**
 * THE STORAGE CARD AND SETTINGS → STORAGE ON THE CLOUD DOOR. The same card and pane as the browser,
 * their writes over the bridge. A build that may not link out to billing (the Mac App Store) gets the
 * numbers and the fitted plan named, and "Manage your plan at ohmail.app" as plain text: no amount,
 * no purchase button and no link (App Review 3.1.3(f)). A plan change needs a second factor this
 * window cannot assert, so Change plan and Add storage open Settings → Storage in the browser.
 */
const bridge = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  answer: (_path: string, _method: string): Response => new Response("{}", { status: 200 }),
  opened: [] as string[],
}));
vi.mock("../src/bridge-fetch.js", async () => {
  const real = await vi.importActual<typeof import("../src/bridge-fetch.js")>("../src/bridge-fetch.js");
  return {
    ...real,
    bridgeFetch: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      bridge.calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : null });
      return bridge.answer(path, method);
    },
  };
});
vi.mock("../src/native.js", async () => {
  const real = await vi.importActual<typeof import("../src/native.js")>("../src/native.js");
  return { ...real, openWeb: vi.fn(async (place: string) => { bridge.opened.push(place); }) };
});
vi.mock("../../webapp/app/shell/MailStateProvider", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/MailStateProvider")>(
    "../../webapp/app/shell/MailStateProvider",
  );
  return { ...real, useMailboxFacts: () => [{ id: "mb_1", address: "sam@example.com", status: "connected" }] };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

const OFFER = {
  currency: "usd", interval: "month",
  plans: [
    { plan: "solo", mailboxes: 2, roomBytes: 2_000_000_000, amount: 900 },
    { plan: "plus", mailboxes: 5, roomBytes: 5_000_000_000, amount: 1500 },
  ],
  addon: { unitBytes: 10_000_000_000, amount: 1000, maxUnits: 10 },
  current: { plan: "solo", addonUnits: 0, roomBytes: 2_000_000_000, roomFrom: "now" },
  fit: { plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2500, keepsAll: true },
  canChange: true, reason: null,
};
const NEAR = storageFactsOf({
  usedBytes: 3_200_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null,
  withheldOnArrival: 0, emptyingNow: false, planLimitBytes: 2_000_000_000, limitDropsAt: null,
  limitReason: "trial", importing: true, card: "near", mail: true,
  estimate: { expectedBytes: 12_500_000_000, expectedLetters: 500_000, storedLetters: 128_000, avgLetterBytes: 25_000,
    avgMeasured: false, complete: true, at: null },
  mailboxes: [{ id: "mb_1", usedBytes: 3_200_000_000, letters: 500_000, expectedLetters: 500_000, expectedBytes: 12_500_000_000, importing: true }],
  offer: OFFER,
})!;

let host: HTMLDivElement;
let root: Root;
let rereads = 0;

beforeEach(() => {
  bridge.calls = [];
  bridge.opened = [];
  bridge.answer = () => new Response("{}", { status: 200 });
  rereads = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => { root.unmount(); });
  host.remove();
});

async function draw(which: "card" | "pane", facts: StorageFacts, linksOut: boolean): Promise<void> {
  const { DesktopStorageNotice } = await import("../src/DesktopStorageNotice.js");
  const { DesktopStorage } = await import("../src/DesktopSubscription.js");
  const props = { facts, linksOut, reread: () => { rereads += 1; } };
  await act(() => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: h(which === "card" ? DesktopStorageNotice : DesktopStorage, props),
    }));
  });
}
const text = (): string => host.textContent ?? "";
const buttons = (): string[] => [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("the storage card on the Cloud door", () => {
  it("draws the card with the fitted choice, its price and the change buttons", async () => {
    await draw("card", NEAR, true);
    expect(text()).toContain("Storage 80% full");
    expect(text()).toContain("Plus + 10 GB keeps all of it, $25/month.");
    expect(buttons()).toEqual(["Dismiss", "Add storage", "Change plan"]);
  });

  it("the Mac App Store face: the numbers and the fitted plan named, no amount, no button but Dismiss, no link", async () => {
    await draw("card", NEAR, false);
    expect(text()).toContain("Storage 80% full");
    expect(text()).toContain("3.2 GB of 4 GB");
    expect(text()).toContain("Plus + 10 GB keeps all of it.");
    expect(text()).toContain("Manage your plan at ohmail.app");
    expect(text()).not.toMatch(/\$|€|£|\d+\/month/);
    expect(buttons()).toEqual(["Dismiss"]);
    expect(host.querySelectorAll("a")).toHaveLength(0);
  });

  it("Dismiss writes the choice over the bridge and reads the account again", async () => {
    await draw("card", NEAR, true);
    await act(() => { host.querySelector<HTMLButtonElement>("[aria-label=Dismiss]")!.click(); });
    await settle();
    expect(bridge.calls).toEqual([{ path: "/account/storage", method: "PATCH", body: { dismiss: "near" } }]);
    expect(rereads).toBe(1);
    expect(host.querySelector("[data-storage-card]")).toBeNull();
  });

  it("Change plan and Add storage open Settings → Storage in the browser in one press, with no mint", async () => {
    await draw("card", NEAR, true);
    await act(() => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Change plan")!.click(); });
    await settle();
    await act(() => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Add storage")!.click(); });
    await settle();
    expect(bridge.opened).toEqual(["storage", "storage"]);
    expect(bridge.calls).toEqual([]);
  });

  it("a browser that will not open says so, and the press can be tried again", async () => {
    const { openWeb } = await import("../src/native.js");
    vi.mocked(openWeb).mockImplementationOnce(async (place) => { bridge.opened.push(place); throw new Error("no browser"); });
    await draw("pane", NEAR, true);
    await act(() => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Change plan")!.click(); });
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe(en.settings.webNoBrowser);
    await act(() => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Change plan")!.click(); });
    await settle();
    expect(bridge.opened).toEqual(["storage", "storage"]);
    expect(host.querySelector("[role=alert]")).toBeNull();
  });
});

describe("Settings → Storage on the Cloud door", () => {
  it("the pane's numbers on every build; the Mac App Store face has no amount, no change button and no link", async () => {
    await draw("pane", NEAR, false);
    expect(text()).toContain("used, your trial room of 4 GB");
    expect(text()).toContain("Keeps all your mail");
    expect(text()).toContain("Manage your plan at ohmail.app");
    expect(text()).not.toMatch(/\$|€|£/);
    expect(buttons().filter((b) => b === "Change plan" || b === "Add storage")).toEqual([]);
    expect(host.querySelectorAll("a")).toHaveLength(0);
  });

  it("the storage mails switch writes over the bridge", async () => {
    await draw("pane", NEAR, true);
    await act(() => { host.querySelector<HTMLButtonElement>("[role=switch]")!.click(); });
    await settle();
    expect(bridge.calls).toEqual([{ path: "/account/storage", method: "PATCH", body: { mail: false } }]);
    expect(rereads).toBe(1);
  });
});
