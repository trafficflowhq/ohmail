/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * `/subscribed` — the payment page's way back. PUBLIC: it asks for a session itself, continues to
 * the app when there is one, and says one sentence when there is not (a home-screen app opens the
 * hand-off in a sheet whose cookie jar is not the app's). It never claims the payment went through.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FULL = {
  user: {
    userId: "usr_1", accountId: "acct_1", email: "s@example.invalid", displayName: "S",
    emailVerified: true, twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

let session: () => Response = () => json(FULL, 200);
let confirm: () => Response = () => json({ state: "confirmed" }, 200);
let replaced: string[] = [];
let asked: string[] = [];
let confirmBodies: unknown[] = [];
let search = "";
let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  replaced = [];
  asked = [];
  confirmBodies = [];
  search = "";
  confirm = () => json({ state: "confirmed" }, 200);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://ohmail.app/subscribed", origin: "https://ohmail.app", protocol: "https:",
      hash: "", pathname: "/subscribed", get search() { return search; },
      replace: (u: string) => { replaced.push(u); },
      assign: (u: string) => { replaced.push(`assign:${u}`); },
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    asked.push(new URL(url, "https://ohmail.app").pathname);
    if (url.includes("/auth/session")) return session();
    if (url.includes("/account/checkout/confirm")) {
      confirmBodies.push(JSON.parse(String(init?.body ?? "null")));
      return confirm();
    }
    if (url.includes("/auth/refresh")) return json({ error: { code: "refresh_revoked", message: "no" } }, 401);
    return json({}, 200);
  }));
});

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(messages: typeof en = en, locale = "en"): Promise<void> {
  const { SubscribedRoute } = await import("../app/(product)/subscribed/SubscribedRoute.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale, messages, children: h(SubscribedRoute) }));
  });
  for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); });
}

const text = (): string => host.textContent ?? "";

describe("a full session continues to the app at once", () => {
  it("replaces the location with /?billing=success, so the wall's lift poll arms in this tab", async () => {
    await mount();
    expect(replaced).toEqual(["/?billing=success"]);
    expect(text()).not.toContain(en.subscribed.body);
    expect(text()).toContain(en.subscribed.continuing);
    expect(asked.filter((p) => p.endsWith("/auth/session"))).toHaveLength(1);
    expect(asked.some((p) => p.endsWith("/account/checkout/confirm")), "no session_id, nothing to confirm")
      .toBe(false);
  });

  it("confirms the Checkout it came back from ONCE, before it moves on", async () => {
    search = "?session_id=cs_test_a1B2c3";
    await mount();
    expect(confirmBodies).toEqual([{ sessionId: "cs_test_a1B2c3" }]);
    expect(replaced).toEqual(["/?billing=success"]);
  });

  it("an API that cannot confirm (an older one answers 404) still continues, and the app polls", async () => {
    search = "?session_id=cs_test_a1B2c3";
    confirm = () => json({ error: { code: "not_found", message: "no" } }, 404);
    await mount();
    expect(confirmBodies).toHaveLength(1);
    expect(replaced).toEqual(["/?billing=success"]);
  });
});

describe("no session: one true sentence and the way to the app", () => {
  it("a refused session shows the sentence and the way to /, and navigates nowhere until it is pressed", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    await mount();
    expect(replaced).toEqual([]);
    // The title's closing full stop is the drawn dot.
    expect(text()).toContain(en.subscribed.title.replace(/\.$/, ""));
    expect(text()).toContain(en.subscribed.body);
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === en.subscribed.open);
    await act(async () => { open!.click(); });
    expect(replaced).toEqual(["assign:/"]);
  });

  it("a server that did not answer is not a session either — the sentence, not a spinner for ever", async () => {
    session = () => json({ error: { code: "db_busy", message: "busy", retryable: true } }, 503);
    await mount();
    expect(replaced).toEqual([]);
    expect(text()).toContain(en.subscribed.body);
  });

  it("speaks German where the catalogue is German", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    await mount(de as typeof en, "de");
    expect(text()).toContain("Zurück zu ohmail");
    expect(text()).toContain("ohmail öffnen");
  });

  it("claims nothing about the payment and names no payment processor", () => {
    for (const cat of [en, de]) {
      for (const line of Object.values(cat.subscribed)) expect(line).not.toMatch(/stripe/i);
    }
    expect(en.subscribed.body).toMatch(/as soon as/i);
  });
});

describe("the route is public and on the edge list", () => {
  it("is an own route, matched for the canonical host, and not a credential page", async () => {
    const { OWN_ROUTES } = await import("../routes.mjs");
    expect(OWN_ROUTES.find((r) => r.path === "/subscribed")?.edge).toBe(true);
    const { config } = await import("../middleware.js");
    expect(config.matcher).toContain("/subscribed");
  });
});
