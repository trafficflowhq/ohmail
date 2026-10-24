/** @vitest-environment jsdom */
/**
 * /JOIN OFFERS THE MICROSOFT SIGN-IN THE SERVER CAN RUN. The wizard's mailbox step offered a Microsoft
 * address only an IMAP password, which Microsoft refuses; the working sign-in lived in Settings alone.
 * Here the real wizard over a fetch double: the availability the server states decides the door, the
 * press asks whose browser this is first, and the account and the landing it records are the ones the
 * return honours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1";
const session = (accountId: string) => ({
  user: {
    userId: `u-${accountId}`, accountId, email: `${accountId}@family.example`, displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
});

let door: { status: number; body: unknown } = { status: 200, body: { available: true, device: false } };
let sessionAccount = "a1";
let calls: Array<{ url: string; method: string; body: unknown }> = [];
let navigated: string | null = null;
let replaced: string | null = null;

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(window, "location")!;

beforeEach(() => {
  door = { status: 200, body: { available: true, device: false } };
  sessionAccount = "a1";
  calls = [];
  navigated = null;
  replaced = null;
  sessionStorage.clear();
  document.cookie = "tf_owner=; path=/; max-age=0";
  window.history.replaceState(null, "", "/join");
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, session(sessionAccount));
    if (url.includes("/mailboxes/oauth/microsoft/availability")) return json(door.status, door.body);
    if (url.includes("/mailboxes/oauth/microsoft/start")) return json(201, { authorizeUrl: AUTHORIZE, state: "STATE-J" });
    if (url.includes("/mailboxes/oauth/microsoft/complete")) {
      return json(403, { error: { code: "forbidden", message: "That Outlook connection was started by a different account.", details: { reason: "account_mismatch" } } });
    }
    if (url.includes("/mailboxes") && method === "POST") return json(201, {});
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
  // The navigation is recorded; every read is the real URL `history.replaceState` keeps.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() { return document.URL; },
      get origin() { return new URL(document.URL).origin; },
      get search() { return new URL(document.URL).search; },
      get pathname() { return new URL(document.URL).pathname; },
      get hash() { return new URL(document.URL).hash; },
      assign: (url: string) => { navigated = url; },
      replace: (url: string) => { replaced = url; },
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

async function atTheMailboxStep() {
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
  expect(host.querySelector("h1")?.textContent).toBe(en.join.step_mailbox_title);
  const pick = async (startsWith: string) => {
    const tile = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => (b.textContent ?? "").startsWith(startsWith));
    expect(tile, `no ${startsWith} tile`).toBeTruthy();
    await act(async () => { tile!.click(); });
    await settle();
  };
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
  const press = async (label: string) => {
    const b = button(label);
    expect(b, `no "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
  };
  return { host, pick, button, press, settle };
}

describe("the wizard's Microsoft tile, where the server can run the sign-in", () => {
  it("offers Connect with Microsoft as the main button, the sign-in note, and the password behind a link", async () => {
    const ui = await atTheMailboxStep();
    await ui.pick("Microsoft 365");
    expect(ui.button(en.mailboxes.oauthContinue), "the main button is the sign-in").toBeTruthy();
    expect(ui.button(en.join.connectMailbox), "no password connect on the sign-in path").toBeNull();
    expect(ui.host.textContent).toContain(en.mailboxes.microsoftOauthNote);
    expect(ui.host.textContent, "the app-password note is not the instruction here").not.toContain(en.providerPicker.note_microsoft);
    expect(ui.host.querySelector("#join-mb-pass"), "no password field until asked for").toBeNull();
    // The sign-in note names no personal account type: whether those can sign in is the registration's to say.
    expect(en.mailboxes.microsoftOauthNote).not.toMatch(/outlook\.com|hotmail|live\.com|personal/i);

    await ui.press(en.mailboxes.microsoftUseAppPassword);
    expect(ui.host.querySelector("#join-mb-pass"), "the link reveals the password form").toBeTruthy();
    expect(ui.button(en.join.connectMailbox)).toBeTruthy();
    expect(ui.button(en.mailboxes.oauthContinue)).toBeNull();
  });

  it("the press asks whose browser this is, then leaves for Microsoft with /join as the way back", async () => {
    const ui = await atTheMailboxStep();
    await ui.pick("Microsoft 365");
    calls = [];
    await ui.press(en.mailboxes.oauthContinue);
    const start = calls.findIndex((c) => c.url.includes("/oauth/microsoft/start"));
    expect(start, "no start was asked for").toBeGreaterThan(-1);
    expect(calls.slice(0, start).some((c) => c.url.includes("/auth/session")), "the account was not checked first").toBe(true);
    expect(calls[start]!.body).toEqual({ returnTo: "/join" });
    expect(navigated).toBe(AUTHORIZE);
  });

  it("a browser now signed in as somebody else starts nothing and says so", async () => {
    const ui = await atTheMailboxStep();
    await ui.pick("Microsoft 365");
    sessionAccount = "b2";
    await ui.press(en.mailboxes.oauthContinue);
    expect(calls.some((c) => c.url.includes("/oauth/microsoft/start"))).toBe(false);
    expect(navigated).toBeNull();
    expect(ui.host.textContent).toContain(en.join.accountChanged.replace("{email}", "b2@family.example"));
  });

  it("the account recorded at the press is the one the return completes for", async () => {
    const ui = await atTheMailboxStep();
    await ui.pick("Microsoft 365");
    await ui.press(en.mailboxes.oauthContinue);
    expect(navigated).toBe(AUTHORIZE);
    await unmount!();
    unmount = null;

    // Another tab signs in as somebody else before Microsoft sends this one back.
    document.cookie = "tf_owner=b2; path=/";
    window.history.replaceState(null, "", "/?settings=mailboxes&oauth=pending&state=STATE-J&code=CODE-J#/settings");
    vi.resetModules();
    const mod = await import("../app/(product)/mailbox/oauth-return.js");
    mod.beginOAuthReturn();
    await ui.settle();

    // Sent under the other account, the server would spend the state and refuse: nothing goes out.
    expect(calls.some((c) => c.url.includes("/oauth/microsoft/complete")), "the completion left under another account").toBe(false);
    expect(replaced).toBe("/join");
    expect(mod.takeJoinOAuthOutcome()).toEqual({ kind: "failed", reason: "account_mismatch" });
  });
});

describe("where the server cannot run the redirect sign-in", () => {
  it("no door: the Microsoft tile keeps the app-password form and its note", async () => {
    door = { status: 200, body: { available: false, device: false } };
    const ui = await atTheMailboxStep();
    await ui.pick("Microsoft 365");
    expect(ui.host.textContent).toContain(en.providerPicker.note_microsoft);
    expect(ui.host.querySelector("#join-mb-pass")).toBeTruthy();
    expect(ui.button(en.mailboxes.oauthContinue)).toBeNull();
  });

  it("an unreadable availability is a shut door, never a button that fails", async () => {
    door = { status: 503, body: { error: { code: "db_busy", message: "busy" } } };
    const ui = await atTheMailboxStep();
    await ui.pick("Microsoft 365");
    expect(ui.button(en.mailboxes.oauthContinue)).toBeNull();
    expect(ui.host.querySelector("#join-mb-pass")).toBeTruthy();
  });

  it("device-code only: the tile points to Settings → Mailboxes after setup", async () => {
    door = { status: 200, body: { available: false, device: true } };
    const ui = await atTheMailboxStep();
    await ui.pick("Microsoft 365");
    expect(ui.host.textContent).toContain(en.join.mailboxMicrosoftAfterSetup);
    expect(ui.button(en.mailboxes.oauthContinue)).toBeNull();
    expect(ui.host.querySelector("#join-mb-pass"), "the app password still works here").toBeTruthy();
  });
});
