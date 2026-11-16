/** @vitest-environment jsdom */
/**
 * THE DEMO WRITES IN ITS OWN PARTITION. The landing embeds the demo on the same origin, so a letter typed in the
 * invented world must never land in a key a real mount reads: not the visitor's account's, and not the keys every
 * mount without an owner shares (`local`). Over the real demo entry: the words typed in its composer are kept only
 * under the demo's partition (`demo-host.test.ts` holds the scope the demo's host names for the frame: the same partition).
 */
import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_STORAGE_OWNER, resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../../messages/en.json";
import { act, NOW, setup, teardown, waitFor } from "../_view-shell";

const WORDS = "Typed in the demo";
let root: Root | null = null;

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  window.location.hash = "#/compose";
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  resetStorageOwnerForTest();
  await teardown();
});

describe("the demo's partition", () => {
  it("keeps a letter typed in the demo under the demo's own partition and nowhere else", async () => {
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
    const subject = () => document.querySelector<HTMLInputElement>('input[aria-label="Subject"]');
    await waitFor(() => subject() !== null, "the demo's composer");
    await act(async () => { fireEvent.change(subject()!, { target: { value: WORDS } }); });
    const holding = () => Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? "").includes(WORDS));
    await waitFor(() => holding().length > 0, "the demo's words kept");
    expect(holding().filter((k) => !k.includes(DEMO_STORAGE_OWNER)), "the demo's words outside its partition").toEqual([]);
  });
});
