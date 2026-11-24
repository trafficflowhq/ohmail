/** @vitest-environment jsdom */
/**
 * TWO PHONE-WIDTH DECISIONS THAT LIVE IN COMPONENTS, NOT STYLESHEETS (DESIGN-FOLD-WIDTHS §7).
 *
 *  · Write's recipient field is labelled To, accepts multiple recipients and shows no
 *    placeholder at narrow or wide widths, including before layout is measured.
 *  · "Original", the dark toggle, is a header control: a host that passes `adaptSlot` gets the
 *    toggle there, in flow beside its date, and the body's bar no longer carries it. The held
 *    Screener card is that host. The geometry of the slot is measured in
 *    `settings-polish-geometry.test.tsx`; this reads where the toggle is mounted.
 */
import { fireEvent, within } from "@testing-library/react";
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
  const { MailShell } = await import("./_mail-shell.js");
  const { ToastHost } = await import("@ohmail/ui");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(MailShell, { demo: true }) }) }),
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

const toInput = (): HTMLInputElement =>
  within(within(host!).getByRole("region", { name: "New message" }))
    .getByRole("combobox", { name: "To" }) as HTMLInputElement;

/** Give the To input a laid-out width and let the observers read it. */
async function toWidth(px: number): Promise<string> {
  const input = toInput();
  input.getBoundingClientRect = () => ({ width: px, height: 30, top: 0, left: 0, right: px, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
  await act(async () => { for (const f of [...observers]) f(); });
  return input.placeholder;
}

describe("the To placeholder fits its field", () => {
  it("narrow and wide fields omit the hint and accept multiple recipients", async () => {
    stubResizeObserver();
    await mountCompose();
    for (const width of [250, 299, 300, 480]) {
      expect(await toWidth(width), "placeholder at " + width + "px").toBe("");
    }
    const input = toInput();
    await act(async () => {
      fireEvent.change(input, { target: { value: "ada@example.invalid, lin@example.invalid, " } });
    });
    const letter = within(within(host!).getByRole("region", { name: "New message" }));
    expect(letter.getByRole("button", { name: "Remove ada@example.invalid" })).toBeTruthy();
    expect(letter.getByRole("button", { name: "Remove lin@example.invalid" })).toBeTruthy();
  });

  it("without a measurement the labelled To field has no hint", async () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
    await mountCompose();
    expect(toInput().placeholder).toBe("");
  });

  it("a zero measurement leaves the labelled To field without a hint", async () => {
    stubResizeObserver();
    await mountCompose();
    expect(await toWidth(0)).toBe("");
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
  const { MessageBody } = await import("../../../packages/letter-body/src/MessageBody.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  const slot = withSlot ? document.createElement("span") : null;
  if (slot) { slot.className = "hm-adapt"; host.appendChild(slot); }
  root = createRoot(host.appendChild(document.createElement("div")));
  await act(async () => {
    root!.render(h(ThemeProvider, {
      defaultPreference: "dark", storageKey: null,
      children: h(MessageBody, { owner: null, text: "fallback", html: LIGHT_TABLE, ...props, ...(withSlot ? { adaptSlot: slot } : {}) } as never),
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

  it("Sync now stands on the Synced line and Edit and Remove share the row foot", async () => {
    /* Sync now stays with the sync value; Edit and Remove share the actions at the foot of the same row. */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("packages/app/src/mailboxes/pane/RowLines.tsx", "utf8");
    const row = src.slice(src.indexOf('<div className="mbx-row-lines">'), src.indexOf("\n    </div>"));
    const synced = row.match(/<SettingLine\s+label=\{say\(\{ key: "lineSynced" \}\)\}[\s\S]*?<\/SettingLine>/)?.[0];
    expect(synced).toContain('say({ key: "syncNow" })');
    const acts = [...row.matchAll(/<div className="mbx-pane-acts">([\s\S]*?)<\/div>/g)]
      .map(([, content]) => content)
      .find((content) => content?.includes('say({ key: "remove" })'));
    expect(acts).toContain('say({ key: "edit" })');
    expect(row.indexOf(synced!)).toBeLessThan(row.indexOf(acts!));
  });

  it("the held Screener card passes its header slot", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("packages/app/src/screener/held/HeldLetter.tsx", "utf8");
    expect(src).toMatch(/<Body[\s\S]*?onNotice=\{setNotice\}[\s\S]*?onControls=\{setControls\}/);
    expect(src).toMatch(/<HeldHead[\s\S]*?note=\{[\s\S]*?<BlockedImages/);
    expect(src).toMatch(/lead=\{[\s\S]*?<LetterViews[\s\S]*?views=\{views\.map/);
  });
});
