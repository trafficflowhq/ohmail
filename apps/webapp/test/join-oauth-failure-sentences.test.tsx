/** @vitest-environment jsdom */
/**
 * A MICROSOFT SIGN-IN THAT FAILED IS SAID IN THE WIZARD'S OWN WORDS. The server words its `complete`
 * refusals for Settings ("Start again from Settings."), and none of that may show inside /join: for each
 * reason the server names, the wizard's mailbox step says its own sentence, with the Microsoft tile picked
 * again. A refusal outside that set keeps the server's sentence. Driven end to end: the wizard's start,
 * the bounce finished by the shell's module, then the wizard at /join.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { launchRefused } from "@trafficflow/services/mail";

const ADDRESS = "mila.brunner@lichtgrat.example";
const SESSION = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
  },
  scope: "full",
};
const MAILBOX = { id: "mb1", provider: "microsoft", address: ADDRESS, displayName: null, status: "connected", lastSyncAt: null, createdAt: null, organizeConsentedAt: null };
const envelope = (status: number, code: string, message: string, details: unknown) =>
  ({ status, body: { error: { code, message, details } } });

/** `complete`'s refusals as `packages/api/src/routes/mailbox-oauth.ts` words them. */
const SERVER: Record<string, { status: number; body: { error: { message: string } } }> = {
  state_invalid: envelope(400, "oauth_state_invalid", "That Outlook connection link is no longer valid. Start again from Settings.", { reason: "state_invalid" }),
  state_expired: envelope(400, "oauth_state_expired", "That took too long to complete. Start again from Settings.", { reason: "state_expired" }),
  account_mismatch: envelope(403, "forbidden", "That Outlook connection was started by a different account.", { reason: "account_mismatch" }),
  provider_unavailable: envelope(503, "upstream_unavailable", "Microsoft could not be reached. Try connecting again in a moment.", { reason: "provider_unavailable" }),
  exchange_failed: envelope(502, "oauth_exchange_failed", "That Outlook connection could not be completed. Start again from Settings.", { reason: "exchange_failed" }),
  no_refresh_token: envelope(502, "oauth_no_refresh_token", "Microsoft did not grant long-term access, so this mailbox cannot be kept in sync. An operator has to add the offline_access permission.", { reason: "no_refresh_token" }),
  no_address: envelope(502, "oauth_no_address", "Microsoft did not say which mailbox was connected, so nothing was saved.", { reason: "no_address" }),
  oauth_unconfigured: envelope(503, "oauth_unconfigured", "Connecting a Microsoft mailbox is not available on this deployment yet.", { gap: "disabled", source: "row" }),
};

let complete: { status: number; body: unknown } = { status: 201, body: {} };
let listed: unknown[] = [];
let originalFetch: typeof globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(window, "location")!;
let unmount: (() => Promise<void>) | null = null;

beforeEach(() => {
  complete = { status: 201, body: { mailbox: MAILBOX, created: true, returnTo: "/join" } };
  listed = [];
  sessionStorage.clear();
  document.cookie = "tf_owner=a1; path=/";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, SESSION);
    if (url.includes("/oauth/microsoft/availability")) return json(200, { available: true, device: false });
    if (url.includes("/oauth/microsoft/start")) return json(201, { authorizeUrl: "https://login.microsoftonline.com/x", state: "STATE-F" });
    if (url.includes("/oauth/microsoft/complete")) return json(complete.status, complete.body);
    if (url.includes("/mailboxes") && method === "GET") return json(200, { items: listed });
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
      assign: () => {},
      replace: () => {},
    },
  });
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, "location", realLocation);
  document.cookie = "tf_owner=; path=/; max-age=0";
  vi.restoreAllMocks();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** The wizard's start, then Microsoft's bounce finished by the shell's module load. */
async function signInReturns(search: string): Promise<void> {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  const { startMicrosoftSignIn } = await import("../app/(product)/mailbox/microsoft-door.js");
  await startMicrosoftSignIn({ landing: "join", owner: () => "a1" });
  window.history.replaceState(null, "", `/?settings=mailboxes&${search}#/settings`);
  vi.resetModules();
  await import("../app/(product)/mailbox/CloudShell.js");
  await settle();
}

/** /join, loaded fresh, as the bounce's `location.replace` opens it. */
async function wizard() {
  window.history.replaceState(null, "", "/join");
  vi.resetModules();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  const picked = () => host.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? null;
  const alert = () => host.querySelector('[role="alert"]')?.textContent ?? null;
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
  return { host, picked, alert, button };
}

const copy = en.join as unknown as Record<string, string>;

describe("the wizard words a failed Microsoft sign-in itself", () => {
  for (const reason of Object.keys(SERVER)) {
    it(`${reason}: the wizard's sentence, the Microsoft tile again, never "Start again from Settings"`, async () => {
      complete = SERVER[reason]!;
      await signInReturns("oauth=pending&state=STATE-F&code=CODE-F");
      const ui = await wizard();
      expect(ui.alert()).toBe(copy[`mailboxOauth_${reason}`]);
      expect(ui.picked()).toMatch(/^Microsoft 365/);
      expect(ui.button(en.mailboxes.oauthContinue), "the way to try again").toBeTruthy();
      expect(ui.host.textContent).not.toContain("Start again from Settings");
      expect(ui.host.textContent).not.toContain(SERVER[reason]!.body.error.message);
    });
  }

  it("a refusal outside that set keeps the server's own sentence", async () => {
    const r = launchRefused("auth", false) as unknown as { httpStatus: number; code: string; message: string; details: unknown };
    complete = envelope(r.httpStatus, r.code, r.message, r.details);
    await signInReturns("oauth=pending&state=STATE-F&code=CODE-F");
    const ui = await wizard();
    expect(ui.alert()).toBe(r.message);
  });

  it("a declined consent is said, and not as an alert", async () => {
    await signInReturns("oauth=error&reason=consent_declined");
    const ui = await wizard();
    expect(ui.alert()).toBeNull();
    expect(ui.host.querySelector('[role="status"]')?.textContent).toBe(en.mailboxes.oauth_consent_declined);
  });

  it("the bounce's own refusal uses its sentence, which names no other screen", async () => {
    await signInReturns("oauth=error&reason=admin_consent_required");
    const ui = await wizard();
    expect(ui.alert()).toBe(en.mailboxes.oauth_admin_consent_required);
  });

  it("said once: a reload of /join shows the step without it", async () => {
    complete = SERVER.state_expired!;
    await signInReturns("oauth=pending&state=STATE-F&code=CODE-F");
    const first = await wizard();
    expect(first.alert()).toBe(copy.mailboxOauth_state_expired);
    await unmount!();
    unmount = null;
    const again = await wizard();
    expect(again.alert()).toBeNull();
  });

  it("a connected sign-in ends on the done step, with the address read back from the server", async () => {
    await signInReturns("oauth=pending&state=STATE-F&code=CODE-F");
    listed = [MAILBOX];
    const ui = await wizard();
    expect(ui.host.querySelector("h1")?.textContent).toBe(en.join.step_connected_title);
    expect(ui.host.textContent).toContain(en.join.mailboxConnected.replace("{address}", ADDRESS));
  });
});
