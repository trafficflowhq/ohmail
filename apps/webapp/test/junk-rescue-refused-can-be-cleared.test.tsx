/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { OhmailEngine, MemoryMirrorStore } from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A "NOT JUNK" THE MAIL SERVER REFUSED CAN BE LEFT IN JUNK.
 *
 * The refused row said "Your mail server wouldn't move this one. Try again." and offered only the
 * two presses that try again, so the sentence stayed for as long as the message was in Junk. The
 * row now offers to leave it there; the press clears the command on the server and the row goes
 * back to saying who filed it. Driven through the window's own hook and the Cloud client.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

const NOW = new Date("2026-09-28T09:00:00.000Z");
const RESCUE = "5b3a3c7e-3f5e-4b53-9f3a-0b8f5c3a9d11";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: string[] = [];
let dismissAnswer: () => Response = () => json(200, { dismissed: true });
const toasts: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  toasts.length = 0;
  dismissAnswer = () => json(200, { dismissed: true });
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "GET" && url === "/api/screener/junk") {
      return Promise.resolve(json(200, {
        mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "ok" }],
        items: [{
          mailboxId: "mb1", uidValidity: "7", uid: 5, subject: "Invoice", from: { name: null, address: "s5@example.invalid" },
          date: "2026-09-27T08:00:00.000Z", messageIdHeader: "<m5@x>", seen: false, origin: "provider",
          rescue: "refused", rescueId: RESCUE,
        }],
        nextCursor: null,
      }));
    }
    if (url.startsWith("/api/screener/junk/body")) return Promise.resolve(json(200, { subject: "Invoice", text: "Pay now." }));
    if (url === "/api/screener/junk/sweep") return Promise.resolve(json(200, { mailboxes: [], movable: 0, pending: false }));
    if (method === "DELETE" && url === `/api/screener/junk/rescue/${RESCUE}`) return Promise.resolve(dismissAnswer());
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
});
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { useJunkWindow } = await import("../app/shell/junk-window.js");
  const { cloudWire } = await import("../app/(product)/mailbox/junk-wire.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    } as never,
  });
  const toast = (m: string) => { toasts.push(m); };
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, toast as never, useScreenerText());
    const junk = useJunkWindow(true, toast as never, cloudWire, useTranslations("screener") as never);
    return h(ScreenerView, {
      owed: false, state, segment: "spam", settled: true,
      selection: { waiting: null, screened: null, spam: null } as never,
      onSelect: () => {}, hydrateBody: () => {}, full: false, onFull: () => {}, junk,
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
    }));
  });
  await flush();
  await settleFirstPaint();
  await flush();
}

const buttons = (label: string): HTMLButtonElement[] =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")].filter((b) => (b.textContent ?? "").trim() === label);

describe("a refused Not junk", () => {
  it("offers to leave the message in Junk, and the press clears the refusal", async () => {
    await mount();
    expect(host!.textContent).toContain(messages.screener.junkRescueRefused);
    const leave = buttons(messages.screener.junkRescueDismiss);
    expect(leave, "the refused row offers no way to leave it").toHaveLength(1);

    await act(async () => { leave[0]!.click(); });
    await flush();
    expect(calls).toContain(`DELETE /api/screener/junk/rescue/${RESCUE}`);
    expect(toasts).toContain(messages.screener.junkRescueDismissed);
    expect(host!.textContent).not.toContain(messages.screener.junkRescueRefused);
    expect(buttons(messages.screener.junkRescueDismiss)).toHaveLength(0);
    // The message is still in Junk: the row stays, saying who filed it.
    expect(host!.textContent).toContain("Invoice");
  });

  it("a refusal of the clear says so and keeps the row as it was", async () => {
    dismissAnswer = () => json(409, { error: { code: "conflict", message: "still being made" } });
    await mount();
    await act(async () => { buttons(messages.screener.junkRescueDismiss)[0]!.click(); });
    await flush();
    expect(toasts).toContain(messages.screener.junkRescueDismissFailed);
    expect(host!.textContent).toContain(messages.screener.junkRescueRefused);
  });

  it("a command already gone counts as cleared", async () => {
    dismissAnswer = () => json(404, { error: { code: "not_found", message: "no refused move to clear" } });
    await mount();
    await act(async () => { buttons(messages.screener.junkRescueDismiss)[0]!.click(); });
    await flush();
    expect(toasts).toContain(messages.screener.junkRescueDismissed);
    expect(host!.textContent).not.toContain(messages.screener.junkRescueRefused);
  });

  it("the German catalogue carries the three sentences", () => {
    for (const key of ["junkRescueDismiss", "junkRescueDismissed", "junkRescueDismissFailed"] as const) {
      expect(typeof de.screener[key]).toBe("string");
      expect(de.screener[key]).not.toBe(messages.screener[key]);
    }
  });
});
