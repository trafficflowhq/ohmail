/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import { KeymapProvider } from "../../../test/support/keymap-provider";

/**
 * "ONE COULD EVEN DIVE INTO THE SETTINGS LIKE THIS" — the zone model inside Settings.
 *
 * The same spatial grammar as the mail surface (`zone-nav.tsx`), with this view's own
 * geography: the settings NAV is the list zone (↓/↑ rove real focus over its buttons, Enter
 * is the browser's own button activation), the pane column is the reader zone (→ lands
 * focus on a named region, ↓/↑ scroll the view's scroller), Escape/← walk back — pane to
 * nav, nav to rail.
 *
 * Real focus is the mechanism AND the assertion: every move below is measured on
 * `document.activeElement`, which is exactly what a screen reader announces. The rail is
 * static DOM in the `.rail` vocabulary, as in `zone-nav.test.tsx` — the contract is the
 * selector, not the component.
 *
 * And the no-registry case is load-bearing, not hypothetical: every OTHER SettingsView
 * suite mounts this view with no `KeymapProvider` at all. Those suites passing is the proof
 * that the zone model degrades to absent rather than throwing — the contract
 * `useOptionalKeyBindings` (keymap.tsx) states.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let rail: HTMLElement | null = null;

function mountRail(): void {
  rail = document.createElement("nav");
  rail.className = "rail";
  rail.innerHTML =
    '<button type="button" class="ritem">Ohbox</button>' +
    '<button type="button" class="ritem on">Settings</button>';
  document.body.appendChild(rail);
}

const BASE: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
};

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mountRail();
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(
          ThemeProvider,
          null,
          h(ToastHost, null, h(KeymapProvider, null, h(SettingsView, BASE))),
        ),
      } as never),
    );
  });
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
};

const focused = (): Element | null => document.activeElement;
const navButtons = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".set-nav button")];

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  rail?.remove();
  host = null;
  root = null;
  rail = null;
});

describe("the zone model inside Settings", () => {
  it("↓ enters the nav on its active pane and ↓/↑ rove it, clamped at both ends", async () => {
    await mount();
    const items = navButtons();
    expect(items.length, "fixture: the nav must hold rows to rove").toBeGreaterThan(2);
    expect(items[0]!.classList.contains("on"), "fixture: General is the resting pane").toBe(true);

    await key("ArrowDown");
    expect(focused(), "↓ did not enter the settings nav at the active pane").toBe(items[0]);
    await key("ArrowDown");
    expect(focused()).toBe(items[1]);
    await key("ArrowUp");
    expect(focused()).toBe(items[0]);
    await key("ArrowUp");
    expect(focused(), "↑ at the top of the nav lost the row").toBe(items[0]);
  });

  it("→ dives into the pane column — a named, focusable region — and ↓/↑ scroll the view", async () => {
    await mount();
    await key("ArrowDown");
    await key("ArrowRight");

    const pane = host!.querySelector<HTMLElement>(".set-pane-col")!;
    expect(focused(), "→ from the nav did not land on the pane column").toBe(pane);
    expect(pane.getAttribute("role")).toBe("region");
    expect(pane.getAttribute("tabindex")).toBe("-1");

    const { READER_SCROLL_STEP } = await import("@ohmail/app-logic/keys/zone-nav");
    const scroller = host!.querySelector<HTMLElement>(".view-settings .scroller")!;
    expect(scroller.scrollTop).toBe(0);
    await key("ArrowDown");
    expect(scroller.scrollTop, "↓ in the pane did not scroll the settings scroller")
      .toBe(READER_SCROLL_STEP);
    await key("ArrowUp");
    expect(scroller.scrollTop).toBe(0);
  });

  it("Escape walks back left: pane → nav → rail; ← from the nav reaches the rail too", async () => {
    await mount();
    await key("ArrowDown");
    await key("ArrowRight");
    expect(focused()).toBe(host!.querySelector(".set-pane-col"));

    await key("Escape");
    expect(focused(), "Escape in the pane did not return to the active nav row")
      .toBe(host!.querySelector(".set-nav button.on"));

    await key("Escape");
    expect(
      (focused() as HTMLElement | null)?.closest?.(".rail"),
      "Escape in the nav did not reach the rail",
    ).toBeTruthy();
    expect(focused(), "the rail entry did not land on the active rail row")
      .toBe(rail!.querySelector(".ritem.on"));

    // → returns from the rail; the nav's active row is where the list zone stands.
    await key("ArrowRight");
    expect(focused()).toBe(host!.querySelector(".set-nav button.on"));
    await key("ArrowLeft");
    expect((focused() as HTMLElement | null)?.closest?.(".rail")).toBeTruthy();
  });

  it("arrows never touch a settings input", async () => {
    await mount();
    const input = document.createElement("input");
    host!.querySelector(".set-pane-col")!.appendChild(input);
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(focused(), "↑ moved focus out of a text field inside a pane").toBe(input);
    expect(host!.querySelector<HTMLElement>(".view-settings .scroller")!.scrollTop).toBe(0);
    input.remove();
  });
});
