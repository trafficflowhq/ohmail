/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { FixturesAdapter, MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { LOCALE_STORAGE_KEY, readStoredLocale, type AppLocale } from "../../webapp/app/shell/locale";
import type { ConsentTransport } from "../../webapp/app/shell/consent-state";
import { CONSENT_PATH, CONSENT_SETTINGS_PATH, consentVia } from "../src/consent-wire.js";

/**
 * THE DESKTOP'S LANGUAGE IS THE INSTALL'S, on the hosted door too. `DesktopLocale` writes the
 * language to this machine and nowhere else (the row says "Applies to this install."), while the
 * shared shell adopts the language the forwarded `GET /consent` carries. With the account on
 * German every press of English was put back by that adoption, and a relaunch put German back
 * again. The account's language now fills an install that has none and never overrides one it
 * has. Mutation: drop the stored-choice refusal in `DesktopLocale`'s adoption and the first two
 * cases go red.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-08-02T09:00:00.000Z";
/** The hosted account's language, as the engine's forward of `GET /consent` answers it. */
let accountLocale: AppLocale | null;
let wire: Array<{ method: string; path: string }>;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let DesktopLocale: (p: { children: React.ReactNode }) => React.ReactElement;

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/** The hosted door's consent wire: the real ten calls over a scripted engine forward. */
const hosted: ConsentTransport = {
  ...consentVia(async (path, init) => {
    wire.push({ method: init?.method ?? "GET", path });
    if (path === CONSENT_PATH) {
      return json({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
        counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
        locale: accountLocale,
      });
    }
    return json({});
  }),
  foldersStorable: true,
};

/** The lazy Settings pane is real module I/O under vitest: resolved here, then the act rounds commit it. */
async function advance(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  await import("../../webapp/app/views/SettingsView.js");
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

async function launch(): Promise<HTMLDivElement> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store: new MemoryMirrorStore(), storePolicy: { mode: "full" } });
  const { AppShell } = await import("../../webapp/app/shell/AppShell");
  window.location.hash = "#/settings/general";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(DesktopLocale, {
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(AppShell as never, { demo: false, engine, consentTransport: hosted } as never) }),
      }),
    }));
  });
  await advance();
  return host;
}

const pressed = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".lang-seg button[aria-pressed='true']")].map((n) => n.textContent ?? "");
const install = (el: HTMLElement): Record<string, unknown> => ({
  lang: document.documentElement.lang, stored: readStoredLocale(), pressed: pressed(el),
});

beforeAll(async () => {
  // The window reads its language once, at module load, the way a launch does: an empty install.
  window.localStorage.clear();
  ({ DesktopLocale } = await import("../src/DesktopLocale.js"));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
  globalThis.fetch = vi.fn(async () => json({})) as unknown as typeof fetch;
  wire = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the desktop's language, on the hosted door with the account on German", () => {
  it("one press of English takes, and stays pressed", async () => {
    window.localStorage.clear();
    accountLocale = "de";
    const el = await launch();
    expect(install(el), "an empty install should wear the account's language").toEqual({
      lang: "de", stored: "de", pressed: ["Deutsch"],
    });
    const english = [...el.querySelectorAll<HTMLButtonElement>(".lang-seg button")].find((b) => b.textContent === "English");
    expect(english, "no language row on the desktop's General pane").toBeTruthy();
    await act(async () => { english!.click(); });
    await advance();
    expect(install(el), "the account's German put the press back").toEqual({ lang: "en", stored: "en", pressed: ["English"] });
    expect(wire.filter((w) => w.method !== "GET" || w.path === CONSENT_SETTINGS_PATH), "the desktop wrote the account").toEqual([]);
  });

  it("and a relaunch keeps it: the install's English outranks the account's German", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    accountLocale = "de";
    const el = await launch();
    expect(wire.some((w) => w.path === CONSENT_PATH), "the account's language was never read").toBe(true);
    expect(install(el)).toEqual({ lang: "en", stored: "en", pressed: ["English"] });
  });

  it("CONTROL: an install that holds no language still takes the account's", async () => {
    window.localStorage.clear();
    accountLocale = "de";
    const el = await launch();
    expect(install(el)).toEqual({ lang: "de", stored: "de", pressed: ["Deutsch"] });
  });
});
