/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { createEngine } from "../app/shell/engine-config.js";
import { confirmSyncOwner } from "@ohmail/app-logic/session/sync-scheduler";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A RELEASE PRESSED BEFORE THE ACCOUNT IS CONFIRMED WAITS FOR IT, AND SAYS SO.
 *
 * A tab opens its mirror before the server has confirmed whose it is: reads run, writes wait. The
 * release press used to refuse in that window with "could not release", a sentence about a
 * failure that had not happened, and worked on the next press. It now waits for the confirm and
 * says the mailbox is still loading. Driven through the engine the shell builds, on a named mirror.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-28T09:00:00.000Z");

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const GROUPS = [{ ruleId: "r1", kind: "sender", match: "a@one.test", destination: "INBOX", count: 3 }];
let calls: string[] = [];
const toasts: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  toasts.length = 0;
  localStorage.clear();
  document.cookie = `tf_owner=${ACCOUNT}; path=/`;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/screener/unscreened") {
      return Promise.resolve(method === "POST"
        ? json(200, { screened: [{ address: "b@two.test", count: 2, newestAt: NOW.toISOString() }], total: 2 })
        : json(200, { groups: [{ address: "b@two.test", count: 2, newestAt: NOW.toISOString() }], total: 2, max: 200 }));
    }
    if (url === "/api/screener/held-releases") {
      return Promise.resolve(method === "POST"
        ? json(200, { released: GROUPS, total: 3 })
        : json(200, { groups: GROUPS, total: 3, max: 200, fingerprint: "fp", dismissed: false }));
    }
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
  document.cookie = "tf_owner=; max-age=0; path=/";
});
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(engine: OhmailEngine): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, ((m: string) => { toasts.push(m); }) as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (seg: string, id: string | null) => setSel((m) => ({ ...m, [seg]: id })),
      hydrateBody: () => {}, full: false, onFull: () => {},
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

const releaseButton = (): HTMLElement => {
  const hits = [...host!.querySelectorAll<HTMLElement>(".scn-held button")]
    .filter((b) => (b.textContent ?? "").trim() === "Release 3");
  if (hits.length !== 1) throw new Error(`${hits.length} buttons read "Release 3"`);
  return hits[0]!;
};

describe("a release pressed during the warm open", () => {
  it("waits for the account's confirm, says the mailbox is still loading, then releases", async () => {
    const engine = createEngine(false, ARMED, ACCOUNT);
    await mount(engine);
    await act(async () => { releaseButton().click(); });
    await flush();

    expect(toasts, "the press refused in the warm open").not.toContain(messages.screener.heldReleaseFailed);
    expect(toasts).toContain(messages.screener.heldReleaseWaiting);
    expect(calls, "the press left before the account was confirmed").not.toContain("POST /api/screener/held-releases");

    await act(async () => { confirmSyncOwner(engine, ACCOUNT); });
    await flush();
    expect(calls).toContain("POST /api/screener/held-releases");
    expect(toasts.at(-1)).toBe("Released 3. Your rules file them on the next pass.");
  });

  it("a confirmed account presses at once, with no loading sentence", async () => {
    const engine = createEngine(false, ARMED, ACCOUNT);
    confirmSyncOwner(engine, ACCOUNT);
    await mount(engine);
    await act(async () => { releaseButton().click(); });
    await flush();
    expect(calls).toContain("POST /api/screener/held-releases");
    expect(toasts).toEqual(["Released 3. Your rules file them on the next pass."]);
  });

  it("the undecided-sender press waits the same way", async () => {
    const engine = createEngine(false, ARMED, ACCOUNT);
    await mount(engine);
    const screen = [...host!.querySelectorAll<HTMLElement>(".scn-unscreened button")]
      .filter((b) => (b.textContent ?? "").trim() === "Screen 2");
    expect(screen).toHaveLength(1);
    await act(async () => { screen[0]!.click(); });
    await flush();
    expect(toasts).toContain(messages.screener.unscreenedWaiting);
    expect(toasts).not.toContain(messages.screener.unscreenedFailed);
    expect(calls).not.toContain("POST /api/screener/unscreened");
    await act(async () => { confirmSyncOwner(engine, ACCOUNT); });
    await flush();
    expect(calls).toContain("POST /api/screener/unscreened");
    expect(toasts.at(-1)).toBe("Screened 2. Your organizer moves them on the next pass.");
  });

  it("the German catalogue carries the sentence", () => {
    for (const key of ["heldReleaseWaiting", "unscreenedWaiting"] as const) {
      expect(typeof de.screener[key]).toBe("string");
      expect(de.screener[key]).not.toBe(messages.screener[key]);
    }
  });
});
