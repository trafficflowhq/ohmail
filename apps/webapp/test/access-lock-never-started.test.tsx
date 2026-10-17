/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { AccessRefusedFacts, AccountLifecycle } from "../app/api-client";

/**
 * AN ACCOUNT THAT HAS NOT STARTED ITS TRIAL IS NOT A CLOSED ONE. A person who signed up and pressed
 * "Do this later" on the plan step met the lapsed-account wall: "This account is not active",
 * "ohmail has stopped organizing this account", a move to self-hosting. The service answers such an
 * account `closed` with no reason, no closing date and nothing ever paid; the wall now offers the
 * trial, and every other closure keeps the screen it had.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const NEVER_STARTED: AccountLifecycle = {
  state: "closed", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
  erasureAt: null, erasedAt: null, formerlyPaid: false,
};
const facts = (lifecycle: AccountLifecycle): AccessRefusedFacts => ({
  reason: "payment_required", manageUrl: "https://plane.example/manage?token=t", lifecycle, exportPath: "/account/export",
});

let host: HTMLDivElement;
let root: Root;
let minted: unknown[] = [];
let followed: string[] = [];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  minted = [];
  followed = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/account/manage-link")) {
      minted.push(JSON.parse(String(init?.body ?? "{}")));
      return json(200, { url: "https://plane.example/manage?token=fresh" });
    }
    return json(200, {});
  }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    followed.push(this.href);
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(f: AccessRefusedFacts, messages: typeof en = en): Promise<void> {
  const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: messages === de ? "de" : "en", messages, children: h(ThemeProvider, { children: h(AccessLock, { facts: f }) }),
    }));
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = (): string => host.textContent ?? "";
const buttons = (): string[] => [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");

describe("an account that never started its trial", () => {
  it("is offered the trial: 14 days free, no card, Start your trial, Sign out — nothing about stopping or erasure", async () => {
    await mount(facts(NEVER_STARTED));
    expect(host.querySelector("h1")?.textContent).toBe(en.accessLock.neverStartedTitle);
    expect(text()).toContain(en.accessLock.neverStartedLead);
    expect(buttons()).toContain(en.accessLock.startTrial);
    expect(buttons()).toContain(en.accessLock.signOut);
    for (const gone of [en.accessLock.title, en.accessLock.stopped, en.accessLock.mailboxUntouched,
      en.accessLock.erasureUnknown, en.accessLock.moveOut, en.accessLock.subscribeHint]) {
      expect(text(), gone).not.toContain(gone);
    }
  });

  it("Start your trial mints the account page in the screen's language and leaves for it", async () => {
    await mount(facts(NEVER_STARTED));
    const start = [...host.querySelectorAll("button")].find((b) => b.textContent === en.accessLock.startTrial)!;
    await act(async () => { start.click(); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(minted).toEqual([{ lang: "en" }]);
    expect(followed).toEqual(["https://plane.example/manage?token=fresh"]);
  });

  it("German", async () => {
    await mount(facts(NEVER_STARTED), de);
    expect(host.querySelector("h1")?.textContent).toBe(de.accessLock.neverStartedTitle);
    expect(text()).toContain("14 Tage gratis, ohne Karte.");
    expect(text()).not.toContain(de.accessLock.stopped);
  });
});

describe("every other closure keeps its screen (the controls)", () => {
  it("a trial that ended: its date, ohmail stopped, the way to take everything along", async () => {
    await mount(facts({ ...NEVER_STARTED, closedReason: "trial_ended", closedAt: "2026-10-18T14:25:41.000Z", erasureAt: "2026-11-17T14:25:41.000Z" }));
    expect(host.querySelector("h1")?.textContent).toContain("Your trial ended on");
    expect(text()).toContain(en.accessLock.stopped);
    expect(buttons()).toContain(en.accessLock.moveOut);
    expect(buttons()).toContain(en.accessLock.subscribe);
  });

  it("a closure the service could not attribute keeps its erasure clock, so it is not a fresh account", async () => {
    await mount(facts({ ...NEVER_STARTED, erasureAt: "2026-11-17T14:25:41.000Z" }));
    expect(host.querySelector("h1")?.textContent).toBe(en.accessLock.title);
    expect(text()).toContain(en.accessLock.stopped);
    await mount(facts({ ...NEVER_STARTED, closedAt: "2026-10-18T14:25:41.000Z" }));
    expect(host.querySelector("h1")?.textContent).toBe(en.accessLock.title);
  });

  it("an account that once paid is never offered a first trial", async () => {
    await mount(facts({ ...NEVER_STARTED, formerlyPaid: true }));
    expect(host.querySelector("h1")?.textContent).toBe(en.accessLock.title);
    expect(buttons()).toContain(en.accessLock.subscribe);
  });
});
