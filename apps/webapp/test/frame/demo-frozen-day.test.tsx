/** @vitest-environment jsdom */
/**
 * THE DEMO KEEPS ITS FROZEN DAY, as today's did (the switch's point 69): its invented letters are dated around the
 * fixtures' day, and the demo's host says that day is today, so a letter of that day reads as one of today's (its
 * time, never its date) whatever day the page is opened on. Over the real demo entry.
 */
import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../../messages/en.json";
import { act, NOW, setup, teardown, waitFor } from "../_view-shell";

let root: Root | null = null;
beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  resetStorageOwnerForTest();
  await teardown();
});

describe("the demo's day", () => {
  it("the first letter of the fixtures' day reads as today's: its time, not its date", async () => {
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
    const first = (): Element | null => document.querySelector('[role="listbox"] [role="option"]');
    await waitFor(() => first() !== null, "the demo's first row");
    const row = first()!.textContent ?? "";
    expect({ date: row.includes("29 Jul"), time: /\d{1,2}:\d{2}/.test(row) }, `the first row reads: ${row.slice(0, 80)}`)
      .toEqual({ date: false, time: true });
  });
});
