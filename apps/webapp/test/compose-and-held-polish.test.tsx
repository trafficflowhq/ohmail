/** @vitest-environment jsdom */
/**
 * TWO PHONE-WIDTH DECISIONS THAT LIVE IN COMPONENTS, NOT STYLESHEETS (DESIGN-FOLD-WIDTHS §7).
 *
 *  · under 300px of To input the placeholder is the bare example address; the long hint was
 *    sliced mid-letter against Cc/Bcc at every phone width. `ComposeView` measures the input; with
 *    no measurement (no ResizeObserver, no layout) the long hint stays.
 *  · "Original", the dark toggle, is a header control: a host that passes `adaptSlot` gets the
 *    toggle there, in flow beside its date, and the body's bar no longer carries it. The held
 *    Screener card is that host. The geometry of the slot is measured in
 *    `settings-polish-geometry.test.tsx`; this reads where the toggle is mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let observers: Array<() => void> = [];
const realRO = globalThis.ResizeObserver;

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
  vi.restoreAllMocks();
});

/** A ResizeObserver whose callbacks the test fires itself, after it has given the input a width. */
function stubResizeObserver(): void {
  observers = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    private cb: () => void;
    constructor(cb: () => void) { this.cb = cb; observers.push(cb); }
    observe(): void {} unobserve(): void {}
    disconnect(): void { observers = observers.filter((f) => f !== this.cb); }
  };
}

async function mountCompose(): Promise<void> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ToastHost } = await import("@ohmail/ui");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(AppShell, { demo: true }) }) }),
    }));
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

/** Give the To input a laid-out width and let the observers read it. */
async function toWidth(px: number): Promise<string> {
  const input = host!.querySelector<HTMLInputElement>("#compose-to")!;
  input.getBoundingClientRect = () => ({ width: px, height: 30, top: 0, left: 0, right: px, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
  await act(async () => { for (const f of [...observers]) f(); });
  return input.placeholder;
}

describe("the To placeholder fits its field", () => {
  it("under 300px the bare example address; from 300px the full hint", async () => {
    stubResizeObserver();
    await mountCompose();
    expect(await toWidth(250), "a 250px field still carries the long hint").toBe(messages.compose.toPlaceholderShort);
    expect(await toWidth(299)).toBe(messages.compose.toPlaceholderShort);
    expect(await toWidth(300)).toBe(messages.compose.toPlaceholder);
    expect(await toWidth(480)).toBe(messages.compose.toPlaceholder);
  });

  it("with no measurement the long hint stands — nothing is assumed", async () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
    await mountCompose();
    expect(host!.querySelector<HTMLInputElement>("#compose-to")!.placeholder).toBe(messages.compose.toPlaceholder);
  });

  it("a zero reading is not a width: the long hint stays", async () => {
    stubResizeObserver();
    await mountCompose();
    expect(await toWidth(0)).toBe(messages.compose.toPlaceholder);
  });

  it("the short hint is the address alone in both catalogues", async () => {
    const de = (await import("../messages/de.json")).default as typeof messages;
    expect(messages.compose.toPlaceholderShort).toBe("name@example.com");
    expect(de.compose.toPlaceholderShort).toBe("name@beispiel.example");
    expect(de.compose.toPlaceholder.startsWith(de.compose.toPlaceholderShort)).toBe(true);
  });
});

/* ══ ══════════════════════════════════════════════════════════════════════════════════════ */

const LIGHT_TABLE = '<body><table bgcolor="#ffffff" width="600"><tr><td>Newsletter</td></tr></table></body>';

async function renderBody(props: Record<string, unknown>, withSlot: boolean): Promise<{ slot: HTMLElement | null }> {
  const { MessageBody } = await import("../app/components/MessageBody.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  const slot = withSlot ? document.createElement("span") : null;
  if (slot) { slot.className = "hm-adapt"; host.appendChild(slot); }
  root = createRoot(host.appendChild(document.createElement("div")));
  await act(async () => {
    root!.render(h(ThemeProvider, {
      defaultPreference: "dark", storageKey: null,
      children: h(MessageBody, { text: "fallback", html: LIGHT_TABLE, ...props, ...(withSlot ? { adaptSlot: slot } : {}) } as never),
    }));
  });
  return { slot };
}
const toggleIn = (scope: ParentNode | null): HTMLButtonElement | undefined =>
  [...(scope?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Original" || b.textContent === "Adapt to dark") as HTMLButtonElement | undefined;

describe("the dark toggle stands in the host's header when the host offers a slot", () => {
  it("with a slot: the toggle is in the slot, and no bar carries it", async () => {
    const { slot } = await renderBody({ onNotice: () => {} }, true);
    expect(toggleIn(slot), "the toggle did not reach the header slot").toBeTruthy();
    expect(toggleIn(host!.querySelector(".mb-bar")), "the bar still carries the toggle").toBeUndefined();
    expect(host!.querySelector(".mb-bar"), "a bar with nothing left in it was drawn").toBeNull();
  });

  it("the toggle in the slot still flips the message", async () => {
    const { slot } = await renderBody({ onNotice: () => {} }, true);
    await act(async () => { toggleIn(slot)!.click(); });
    expect(toggleIn(slot)!.textContent).toBe("Adapt to dark");
    expect(toggleIn(slot)!.getAttribute("aria-pressed")).toBe("true");
  });

  it("POSITIVE CONTROL: without a slot the bar keeps the toggle, as every other host has it", async () => {
    await renderBody({ onNotice: () => {} }, false);
    expect(toggleIn(host!.querySelector(".mb-bar"))).toBeTruthy();
  });

  it("the mailbox row's verbs are ONE item of its state column", async () => {
    /* The geometry file measures the shape over this markup; this holds that the component renders it. */
    const { readFileSync, existsSync } = await import("node:fs");
    const rel = "app/(product)/mailbox/MailboxSection.tsx";
    const src = readFileSync(existsSync(`apps/webapp/${rel}`) ? `apps/webapp/${rel}` : rel, "utf8");
    const verbs = /<span className="mbx-verbs">([\s\S]*?)<\/span>\s*\)\}\s*<\/div>/.exec(src)?.[1] ?? "";
    expect(verbs, "the verbs are not wrapped in .mbx-verbs").not.toBe("");
    expect(verbs).toContain('t("syncNow")');
    expect(verbs).toContain('t("remove")');
  });

  it("the held Screener card passes its header slot", async () => {
    const { readFileSync } = await import("node:fs");
    const { existsSync } = await import("node:fs");
    const rel = "app/views/ScreenerView.tsx";
    const src = readFileSync(existsSync(`apps/webapp/${rel}`) ? `apps/webapp/${rel}` : rel, "utf8");
    expect(src).toMatch(/<span className="t num">\{time \?\? ""\}<\/span>\s*<span className="hm-adapt" ref=\{setAdaptSlot\} \/>/);
    expect(src).toContain("adaptSlot={adaptSlot}");
  });
});
