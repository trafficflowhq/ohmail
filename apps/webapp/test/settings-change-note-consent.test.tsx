/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { TravelledChangeWire } from "../app/shell/travelled-change";

/**
 * THE CONSENT HOOK CARRIES A READER'S CHANGE, AND THE HOSTED TRANSPORT ITS FORMATTING: moved word for word out of
 * `settings-change-note.test.tsx`, whose other cases draw today's away row, dormancy dial and signature editors (they
 * wait for Settings' panes). These two run only the consent hook the ground calls and the hosted consent transport.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const REFUSED: TravelledChangeWire = { state: "refused", holder: "work-laptop", refusal: "unreadable" };

let host: HTMLDivElement;
let root: Root | null = null;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
async function mount(node: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: node }) }),
    }));
  });
  await flush();
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  vi.useRealTimers();
});

describe("the consent hook carries both", () => {
  it("from the read and from a write's echo, and a write that stayed here clears the dial's", async () => {
    let echo: Record<string, unknown> = { screeningScope: "all_time", dormancyChange: { state: "asked", holder: null, refusal: null } };
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = (init?.method ?? "GET") === "PATCH" ? echo : {
        seedConfirmedAt: null, screeningResetAt: null, dormancyDays: 60, signatures: {},
        dormancyChange: REFUSED, signatureChanges: { "m-1": REFUSED },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { useConsentState } = await import("@ohmail/app-logic/consent/consent-state");
    const { CLOUD_CONSENT } = await import("../app/(product)/mailbox/consent-over-api");
    let hook: ReturnType<typeof useConsentState> | null = null;
    function Harness() { hook = useConsentState(true, null, CLOUD_CONSENT); return null; }
    await mount(h(Harness));
    expect(hook!.dormancyChange, "the read's refusal was dropped").toEqual(REFUSED);
    expect(hook!.signatureChanges).toEqual({ "m-1": REFUSED });
    await act(async () => { await hook!.setDormancyDays(undefined, "all_time"); });
    expect(hook!.dormancyChange?.state).toBe("asked");
    echo = { dormancyDays: 90 };
    await act(async () => { await hook!.setDormancyDays(90, "window"); });
    expect(hook!.dormancyChange).toBeNull();
    echo = { signatures: {}, signatureChanges: { "m-1": { state: "asked", holder: null, refusal: null } } };
    await act(async () => { await hook!.setMailboxSignature("m-1", "Anna"); });
    expect(hook!.signatureChanges["m-1"]?.state, "the signature's echo was dropped").toBe("asked");
  });
});

describe("the signature editors on a reader", () => {
  it("the hosted transport sends the formatting, not a clear", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") bodies.push(String(init!.body));
      return new Response(JSON.stringify({ seedConfirmedAt: null, screeningResetAt: null, dormancyDays: 60, signatures: {} }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { useConsentState } = await import("@ohmail/app-logic/consent/consent-state");
    const { CLOUD_CONSENT } = await import("../app/(product)/mailbox/consent-over-api");
    let hook: ReturnType<typeof useConsentState> | null = null;
    function Harness() { hook = useConsentState(true, null, CLOUD_CONSENT); return null; }
    await mount(h(Harness));
    await act(async () => { await hook!.setMailboxSignature("m-1", null, "<p><strong>Anna</strong></p>"); });
    expect(bodies, "a formatted signature was sent as a clear").toEqual([
      JSON.stringify({ signaturesHtml: { "m-1": "<p><strong>Anna</strong></p>" } }),
    ]);
  });
});
