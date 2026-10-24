/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { SubscriptionStatus } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";

/**
 * EVERY START WRITES ITS OWN LANDING. A sign-in started in /join and abandoned at Microsoft leaves its
 * `join` behind in the tab; a later sign-in started from Settings → Mailboxes must still come back to
 * Settings, whether Microsoft answers with a code (whose state names the ceremony) or with an error
 * (which names nothing). The Settings press here is the real pane's.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const copy = messages.mailboxes as unknown as Record<string, string>;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};
const healthy = {
  subscription: { plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500, currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null },
  balance: 0, plans: {},
  entitlements: { mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active" },
} as unknown as SubscriptionStatus;

/** `mock`-prefixed: `vi.mock`'s factory is hoisted above the imports. */
let mockStates: string[] = [];
let mockCompleteCalls: Array<{ state: string; code: string }> = [];
let mockNavigatedTo: string | null = null;
let mockReplacedWith: string | null = null;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({ user: { email: "person@example.test", emailVerified: true, accountId: "acct-1" }, scope: "full" }),
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: [] }),
      resync: async () => undefined,
      oauthAvailability: async () => ({ available: true, device: false }),
      oauthStart: async () => ({ authorizeUrl: "https://login.microsoftonline.com/x", state: mockStates.shift() ?? "S-LAST" }),
      oauthComplete: async (b: { state: string; code: string }) => {
        mockCompleteCalls.push(b);
        return {
          mailbox: { id: "mb1", provider: "microsoft", address: "person@contoso-com.example", displayName: null, status: "connected", lastSyncAt: null, createdAt: null },
          created: true, returnTo: "/",
        };
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const realLocation = Object.getOwnPropertyDescriptor(window, "location")!;

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

function byText(el: HTMLElement, text: string): HTMLElement | null {
  return [...el.querySelectorAll("button, a")].find((n) => (n.textContent ?? "").trim() === text) as HTMLElement | undefined ?? null;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

/** A wizard start the person walked away from at Microsoft's page. */
async function abandonedWizardStart(): Promise<void> {
  const { startMicrosoftSignIn } = await import("../app/(product)/mailbox/microsoft-door.js");
  await startMicrosoftSignIn({ landing: "join", owner: () => "acct-1" });
  expect(mockNavigatedTo).not.toBeNull();
  mockNavigatedTo = null;
}

/** The same tab, later: Settings → Mailboxes → Connect Outlook → Connect with Microsoft. */
async function settingsStart(): Promise<void> {
  window.history.replaceState(null, "", "/mailbox#/settings");
  const { resetOAuthReturn } = await import("../app/(product)/mailbox/oauth-return.js");
  resetOAuthReturn();
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
  });
  await settle();
  await click(byText(host, copy.oauthConnect!)!);
  await click(byText(host, copy.oauthContinue!)!);
  expect(mockNavigatedTo, "the Settings press did not leave for Microsoft").not.toBeNull();
  await act(async () => { root!.unmount(); });
  root = null;
  host.remove();
  host = null;
}

/** Microsoft sends the browser back; the shell's landing runs once for the load. */
async function returnTo(search: string): Promise<void> {
  window.history.replaceState(null, "", `/?settings=mailboxes&${search}#/settings`);
  const mod = await import("../app/(product)/mailbox/oauth-return.js");
  mod.resetOAuthReturn();
  mod.beginOAuthReturn();
  await settle();
}

beforeEach(() => {
  mockStates = ["J-1", "S-2"];
  mockCompleteCalls = [];
  mockNavigatedTo = null;
  mockReplacedWith = null;
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() { return document.URL; },
      get origin() { return new URL(document.URL).origin; },
      get search() { return new URL(document.URL).search; },
      get pathname() { return new URL(document.URL).pathname; },
      get hash() { return new URL(document.URL).hash; },
      assign: (url: string) => { mockNavigatedTo = url; },
      replace: (url: string) => { mockReplacedWith = url; },
    },
  });
});

afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  Object.defineProperty(window, "location", realLocation);
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

const landedInSettings = (): void => {
  expect(mockReplacedWith, "a stale wizard landing took the browser to /join").toBeNull();
  expect(window.location.hash).toBe("#/settings");
  expect(new URLSearchParams(window.location.search).get("settings")).toBe("mailboxes");
};

describe("a landing left behind by an abandoned wizard start", () => {
  it("never redirects a later Settings sign-in that comes back with a code", async () => {
    await abandonedWizardStart();
    await settingsStart();
    await returnTo("oauth=pending&state=S-2&code=C-2");
    expect(mockCompleteCalls).toEqual([{ state: "S-2", code: "C-2" }]);
    landedInSettings();
  });

  it("never redirects a later Settings sign-in that comes back with an error, which names no ceremony", async () => {
    await abandonedWizardStart();
    await settingsStart();
    await returnTo("oauth=error&reason=consent_declined");
    expect(mockCompleteCalls).toHaveLength(0);
    landedInSettings();
  });

  it("a return for another ceremony than the tab's last start is not taken to /join", async () => {
    await abandonedWizardStart();
    await returnTo("oauth=pending&state=OTHER&code=C-3");
    expect(mockCompleteCalls).toEqual([{ state: "OTHER", code: "C-3" }]);
    landedInSettings();
  });
});
