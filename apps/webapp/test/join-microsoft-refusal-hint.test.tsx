/** @vitest-environment jsdom */
/**
 * A PASSWORD MICROSOFT REFUSED POINTS AT THE SIGN-IN. The generic refusal tells the person to make an
 * app-specific password, which for most Microsoft mailboxes is a dead end. Where this server runs the
 * Microsoft sign-in, a refused password on the Microsoft tile says so and carries the button instead.
 * The refusal is the service's own `launchRefused`, as the API sends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { launchRefused } from "@trafficflow/services/mail";

const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=2";
const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};
const refusedAuth = () => {
  const r = launchRefused("auth", false) as unknown as { httpStatus: number; code: string; message: string; details: unknown };
  return { status: r.httpStatus, body: { error: { code: r.code, message: r.message, details: r.details } } };
};

let available = true;
let starts: unknown[] = [];
let navigated: string | null = null;
let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(window, "location")!;

beforeEach(() => {
  available = true;
  starts = [];
  navigated = null;
  sessionStorage.clear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, FULL);
    if (url.includes("/oauth/microsoft/availability")) return json(200, { available, device: false });
    if (url.includes("/oauth/microsoft/start")) {
      starts.push(JSON.parse(String(init?.body ?? "{}")));
      return json(201, { authorizeUrl: AUTHORIZE, state: "STATE-H" });
    }
    if (url.includes("/mailboxes") && method === "POST") { const r = refusedAuth(); return json(r.status, r.body); }
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() { return document.URL; },
      get origin() { return new URL(document.URL).origin; },
      get search() { return new URL(document.URL).search; },
      get pathname() { return new URL(document.URL).pathname; },
      get hash() { return new URL(document.URL).hash; },
      assign: (url: string) => { navigated = url; },
      replace: () => {},
    },
  });
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, "location", realLocation);
  vi.restoreAllMocks();
});

/** The wizard at its mailbox step, the password refused for `tile` (the Microsoft one by its app-password link). */
async function refusedOn(tile: "Microsoft 365" | "Gmail") {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
  const press = async (label: string) => {
    const b = button(label);
    expect(b, `no "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
  };
  const type = async (id: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`);
    expect(input, `#${id} is not on screen`).toBeTruthy();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const pick = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => (b.textContent ?? "").startsWith(tile));
  await act(async () => { pick!.click(); });
  await settle();
  if (button(en.mailboxes.microsoftUseAppPassword)) await press(en.mailboxes.microsoftUseAppPassword);
  await type("join-mb-address", "pat@outlook.test");
  await type("join-mb-pass", "an-app-password");
  await press(en.join.connectMailbox);
  const refusal = () => host.querySelector(".join-error.at-press")?.textContent ?? null;
  return { host, button, press, refusal };
}

describe("a password refused on the Microsoft tile", () => {
  it("where the sign-in runs: the sign-in sentence and the button, not the app-password advice", async () => {
    const ui = await refusedOn("Microsoft 365");
    expect(ui.refusal()).toBe(en.join.mailboxMicrosoftRefused);
    expect(ui.host.textContent).not.toContain(en.mailboxes.probe_auth);
    expect(ui.button(en.mailboxes.oauthContinue), "the sign-in sits beside the refusal").toBeTruthy();

    await ui.press(en.mailboxes.oauthContinue);
    expect(starts).toEqual([{ returnTo: "/join" }]);
    expect(navigated).toBe(AUTHORIZE);
  });

  it("where it does not: the refusal stays the app-password sentence, with no button", async () => {
    available = false;
    const ui = await refusedOn("Microsoft 365");
    expect(ui.refusal()).toBe(en.mailboxes.probe_auth);
    expect(ui.button(en.mailboxes.oauthContinue)).toBeNull();
  });

  it("another provider's refusal is untouched by the Microsoft door", async () => {
    const ui = await refusedOn("Gmail");
    expect(ui.refusal()).toBe(en.mailboxes.probe_auth);
    expect(ui.button(en.mailboxes.oauthContinue)).toBeNull();
  });
});
