/** @vitest-environment jsdom */
/**
 * EVERY PRESS THAT MINTS THE ACCOUNT PAGE NAMES THE SCREEN'S LANGUAGE. The wall already sent it; the
 * lifecycle strip's Subscribe and Settings' Manage did not, so a German screen opened an account page
 * in the browser's language. The plan step's own mint is held in `join-plan-hint.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

let host: HTMLDivElement;
let root: Root;
let access: Record<string, unknown> = {};
/** Each mint's body; answered with a refusal, so no press leaves the document. */
let mints: string[] = [];
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  globalThis.sessionStorage.clear();
  mints = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/account/manage-link")) {
      mints.push(String(init?.body ?? ""));
      return json(503, { error: { code: "unavailable" } });
    }
    if (u.includes("/account/access")) return json(200, access);
    if (u.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  globalThis.fetch = realFetch;
  globalThis.sessionStorage.clear();
});

async function mount(locale: "en" | "de", node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, children: h(ThemeProvider, { children: node }),
    }));
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

async function press(label: string): Promise<void> {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent === label);
  expect(b, `no button labelled ${label}`).toBeDefined();
  await act(async () => { b!.click(); });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

const TRIAL = {
  metered: true, access: "open", canAddMailbox: true, mailboxes: 1,
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: new Date(Date.now() + 36 * 3_600_000).toISOString() },
};

describe("the account page is asked for in the screen's language", () => {
  for (const [locale, messages] of [["en", en], ["de", de]] as const) {
    it(`${locale}: the lifecycle strip's Subscribe`, async () => {
      access = TRIAL;
      const { LifecycleBanner } = await import("../app/(product)/mailbox/LifecycleBanner");
      await mount(locale, h(LifecycleBanner));
      await press(messages.accountLifecycle.subscribe);
      expect(mints).toEqual([JSON.stringify({ lang: locale })]);
    });

    it(`${locale}: Settings' Manage`, async () => {
      const { SubscriptionSection } = await import("../app/(product)/mailbox/SubscriptionSection");
      await mount(locale, h(SubscriptionSection, { onNowhere: () => {} }));
      await press(messages.settings.subscriptionManage);
      expect(mints).toEqual([JSON.stringify({ lang: locale })]);
    });
  }
});
