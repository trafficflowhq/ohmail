/** @vitest-environment jsdom */
/**
 * THE DEMO SAYS IT IS THE DEMO, ONCE HYDRATED. The served document of the demo is the product's empty gate (the frame
 * lays out by the window, which a server does not know), so the ribbon is the hydrated half: over the real demo entry
 * the frame draws it, over a live host it does not, and Dismiss takes it away for the tab. The server half (the gate
 * names the demo the server decided) is `demo-host.test.ts` and the e2e's document probes.
 */
import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../../messages/en.json";
import { act, click, engineOver, NOW, setup, shell, storeWith, teardown, waitFor } from "../_view-shell";

/** The ribbon's own sentence, as the catalogue says it (its `<b>` drawn as a node, so read without it). */
const SAYS_DEMO = "Invented mail. Nothing leaves this tab.";
let root: Root | null = null;

const says = (): boolean => (document.body.textContent ?? "").includes(SAYS_DEMO);
/** The element that holds the ribbon's sentence and its one button. */
const ribbon = (): HTMLElement | null => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.textContent ?? "").includes(SAYS_DEMO)) return n.parentElement?.parentElement ?? null;
  }
  return null;
};

async function demo(): Promise<void> {
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { DemoShell } = await import("../../app/(product)/demo/DemoShell");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW } as never,
      h(ThemeProvider as never, { storageKey: null } as never,
        h(ToastHost as never, null, h(DemoShell, { serverDemo: true, says: { service: "managed", sendCeiling: "strict" } })))));
  });
}

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  try { window.sessionStorage.clear(); } catch { /* blocked */ }
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  resetStorageOwnerForTest();
  await teardown();
});

describe("the demo's ribbon, after hydration", () => {
  it("is drawn over the demo, and Dismiss takes it away for the tab", async () => {
    await demo();
    await waitFor(says, "the demo's ribbon");
    await click(within(ribbon()!).getByRole("button", { name: "Dismiss" }), "the ribbon's Dismiss");
    await waitFor(() => !says(), "the ribbon gone after Dismiss");

    // Dismissed for the tab: the demo mounted again in it draws the frame without the ribbon.
    await act(async () => { root!.unmount(); });
    root = null;
    document.body.innerHTML = "";
    await demo();
    await waitFor(() => (document.body.textContent ?? "").includes("Ohbox"), "the demo's frame again");
    expect(says(), "the ribbon came back in the tab it was dismissed in").toBe(false);
  });

  it("is not drawn over a live host", async () => {
    const store = await storeWith([]);
    const el = await shell(store, engineOver(store));
    await waitFor(() => (el.textContent ?? "").includes("Ohbox"), "the live frame");
    expect(says(), "a live host drew the demo's ribbon").toBe(false);
  });
});
