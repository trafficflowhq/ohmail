/** @vitest-environment jsdom */
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { RulesView } from "../app/views/RulesView";

/**
 * AT PHONE WIDTH THE RULES LIST SCROLLS WITH THE PAGE. It was a bounded scroller below the pills
 * that did not chain: at 360 it showed one rule of 169, and a thumb on the list moved only that
 * slot. The list is the page there now, so scrolling the page brings every rule into the window.
 * Mutation: the window handed the list's own box at phone width → the phone case red.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const ISO = "2026-09-27T09:00:00.000Z";
const none = () => {};

const rule = (i: number): RuleDTO => ({
  id: `r${i}`, kind: "sender", match: `sender${String(i).padStart(3, "0")}@rules.invalid`, destination: "INBOX",
  priority: 0, provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: new Date(Date.parse(ISO) - (i + 1) * 60_000).toISOString(), updatedAt: ISO,
} as unknown as RuleDTO);

let roots: Root[] = [];
let phone = false;
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (q: string) => ({
      matches: phone && /max-width:\s*640px/.test(q), media: q,
      addEventListener: none, removeEventListener: none, addListener: none, removeListener: none,
      onchange: null, dispatchEvent: () => false,
    }),
  });
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  vi.spyOn(console, "error").mockImplementation(none);
});
afterEach(async () => {
  for (const r of roots) await act(() => { r.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  phone = false;
  vi.restoreAllMocks();
});

/** The Rules pane inside a page that scrolls, as Settings holds it. */
async function mountInPage(): Promise<{ page: HTMLElement; list: HTMLElement }> {
  const page = document.createElement("div");
  page.className = "scroller";
  page.style.overflowY = "auto";
  document.body.appendChild(page);
  const root = createRoot(page);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date(ISO),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, {
          children: h(RulesView, {
            rules: Array.from({ length: 169 }, (_, i) => rule(i)),
            onRevoke: async () => ({ status: "confirmed" as const }),
            onRetarget: async () => ({ status: "confirmed" as const }),
            pastMail: () => null,
          } as never),
        }),
      }),
    }));
  });
  return { page, list: page.querySelector<HTMLElement>(".rules-scroll")! };
}

async function scroll(el: HTMLElement, px: number): Promise<void> {
  el.scrollTop = px;
  await act(async () => {
    el.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
}

const mounted = (el: HTMLElement, id: string): boolean => el.querySelector(`[data-rule-id="${id}"]`) != null;

describe("the Rules list and the scroll a thumb moves", () => {
  it("at phone width the page's own scroll brings the hundredth rule into the list", async () => {
    phone = true;
    const { page } = await mountInPage();
    expect(mounted(page, "r100"), "premise: the list is a window").toBe(false);
    await scroll(page, 100 * 64);
    expect(mounted(page, "r100"), "scrolling the page left the list where it was").toBe(true);
  });

  it("above phone width the list keeps its own box and its own scroll (the control)", async () => {
    const { page, list } = await mountInPage();
    await scroll(page, 100 * 64);
    expect(mounted(page, "r100"), "the page's scroll moved a list that has its own").toBe(false);
    await scroll(list, 100 * 64);
    expect(mounted(page, "r100")).toBe(true);
  });
});
