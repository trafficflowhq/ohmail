/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { LOCALE_STORAGE_KEY, readStoredLocale, type AppLocale } from "../../webapp/app/shell/locale";
import { within } from "@testing-library/react";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame.js";
import { linkSlot } from "../src/link-in.js";
import { encodeDesktopAnswer } from "./_install-pane.js";
import { stubDom } from "../../webapp/test/_draft-shell.js";
import messages from "../../webapp/messages/en.json";
import { CONSENT_PATH, CONSENT_SETTINGS_PATH } from "../src/consent-wire.js";

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

const noChange = () => undefined;

function bridge() {
  vi.stubGlobal("__TAURI_INTERNALS__", {
    transformCallback: () => 1,
    invoke: async (command: string, payload?: Record<string, unknown>) => {
      if (command !== "engine_request") return null;
      const path = String(payload?.url ?? "").split("?")[0]!;
      if (path === CONSENT_PATH || path === CONSENT_SETTINGS_PATH) {
        wire.push({ method: String(payload?.method ?? "GET"), path });
      }
      if (path === CONSENT_PATH) return encodeDesktopAnswer({
        body: {
          seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
          counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
          locale: accountLocale,
        },
      });
      if (path === "/mailboxes") return encodeDesktopAnswer({ body: { items: [] } });
      return encodeDesktopAnswer({ body: {}, status: 404 });
    },
  });
}

/** Let the native bridge replies and the Settings frame settle. */
async function advance(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

async function launch(): Promise<HTMLDivElement> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store: new MemoryMirrorStore(), storePolicy: { mode: "full" } });
  bridge();
  const props: DesktopFrameProps = {
    engine, status: { state: "serving", mode: "cloud" }, session: "live", sessionRefused: false,
    sealFailed: false, paired: false, hostLabel: null, freshness: null, account: "account",
    storage: null, mayLinkOut: false, manageOffered: false, withdrawManage: noChange,
    rereadAccess: noChange, reuseSweeps: [], recheckSweeps: async () => undefined, ai: null,
    setAi: noChange, onStatus: noChange, openOverlay: noChange, takeOver: noChange,
    firstRunOpen: false, firstRun: undefined, takesMailLinks: true, scope: "account",
    onUnread: noChange, liveBody: async () => ({ kind: "refused", reason: "gone" }),
    links: linkSlot(), connection: { read: () => null, subscribe: () => noChange },
  };
  window.location.hash = "#/settings/general";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(DesktopLocale, {
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(DesktopFrame, props) }),
      }),
    }));
  });
  await advance();
  return host;
}

const languageWords: readonly string[] = [messages.settings.languageName.en, messages.settings.languageName.de];
const pressed = (el: HTMLElement): string[] =>
  within(el).getAllByRole("button", { name: (name) => languageWords.includes(name), pressed: true })
    .map((button) => button.textContent ?? "");
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
  stubDom();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  wire = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    const english = within(el).getByRole("button", { name: messages.settings.languageName.en });
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
