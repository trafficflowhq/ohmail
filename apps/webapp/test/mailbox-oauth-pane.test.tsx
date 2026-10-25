/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";

/**
 * SETTINGS → MAILBOXES, THE OUTLOOK DOOR — the pane's half of the consent ceremony.
 *
 * Four properties, and each one is about a wrong screen rather than a wrong request:
 *
 *  1. **"Connect Outlook" sits BESIDE the password form**, not inside its provider picker. The
 *     password ceremony asks for an address, a host and a password; this one asks for none of them,
 *     because Microsoft states the address in the token it issues.
 *  2. **An OAUTH row offers "Reconnect Microsoft" and NOT "Edit."** An oauth mailbox's only
 *     credential is a refresh token, so the password form's every field is meaningless for it — and
 *     a PATCH from it would store a typed password beside an `authType: "oauth2"` credential the
 *     dialler then refuses to use.
 *  3. **The RECONNECT names the row it came from**, so the consent screen preselects the right
 *     Microsoft account. It does not choose the row that gets written — the `id_token` does.
 *  4. **THE BOUNCE'S PARAMETERS ARE STRIPPED BEFORE THE CALL.** The authorization code is
 *     single-use and must not be left in an address bar for the length of an IMAP probe.
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

const healthy: SubscriptionStatus = {
  subscription: {
    plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
    currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
  },
  balance: 0,
  plans: {},
  entitlements: {
    mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active",
  },
} as unknown as SubscriptionStatus;

/** `mock`-prefixed: `vi.mock`'s factory is hoisted above the imports. */
let mockListed: MailboxDTO[] = [];
let mockStartCalls: Array<{ mailboxId?: string; returnTo?: string }> = [];
let mockCompleteCalls: Array<{ state: string; code: string }> = [];
let mockStartThrows: unknown = null;
let mockCompleteThrows: unknown = null;
/**
 * IS THE OUTLOOK DOOR ARMED. `true` by default so the door-and-reconnect properties below run
 * against an armed deployment; the gating tests flip it to `false` and assert the buttons vanish.
 */
let mockAvailable = true;
/** The DEVICE door, off by default — the cases that need it arm it and the rest are unchanged. */
let mockDeviceAvailable = false;
/** Held open by a case that needs a start to be IN FLIGHT while somebody presses something else. */
let mockDeviceStartGate: (() => void) | null = null;
let mockStartGate: (() => void) | null = null;
let mockAvailabilityGate: (() => void) | null = null;
let mockDeviceStarts = 0;
/** The URL as it stood when `oauthComplete` was invoked — the strip-before-call assertion. */
let mockSearchAtComplete: string | null = null;
let mockNavigatedTo: string | null = null;

vi.mock("../app/api-client", async () => {
  // The real module is spread so `ApiError`, `codeOf` and `messageOf` stay genuine — the pane's
  // error rendering decides on `err instanceof ApiError`.
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, accountId: "acct-1" },
        scope: "full",
      }),
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      resync: async () => undefined,
      oauthAvailability: async () => {
        if (mockAvailabilityGate) await new Promise<void>((go) => { mockAvailabilityGate = go; });
        return { available: mockAvailable, device: mockDeviceAvailable };
      },
      deviceOAuthStart: async () => {
        mockDeviceStarts += 1;
        if (mockDeviceStartGate) await new Promise<void>((go) => { mockDeviceStartGate = go; });
        return {
          state: `S${mockDeviceStarts}`,
          userCode: `CODE-${mockDeviceStarts}`,
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        };
      },
      // Never answers: every device case here is about the SCREEN, not about the ceremony ending.
      deviceOAuthPoll: async () => new Promise<never>(() => {}),
      oauthStart: async (b: { mailboxId?: string; returnTo?: string } = {}) => {
        mockStartCalls.push(b);
        if (mockStartGate) await new Promise<void>((go) => { mockStartGate = go; });
        if (mockStartThrows) throw mockStartThrows;
        return { authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1", state: "S" };
      },
      oauthComplete: async (b: { state: string; code: string }) => {
        mockCompleteCalls.push(b);
        mockSearchAtComplete = window.location.search;
        if (mockCompleteThrows) throw mockCompleteThrows;
        return { mailbox: dto({ address: "oauth-user@contoso-com.example", authKind: "oauth" }), created: true, returnTo: null };
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "microsoft", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: "2026-08-10T11:00:00.000Z",
  createdAt: "2026-08-10T10:00:00.000Z", ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function mount(items: MailboxDTO[], search = ""): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
  window.history.replaceState(null, "", `/mailbox${search}#/settings`);
  /*
   * A FRESH PAGE LOAD. The consent return is a module-level one-shot now — that is what makes it
   * independent of whether this pane is ever mounted (`oauth-return.ts`) — so a suite that mounts the
   * pane repeatedly has to say when one landing ends and the next begins. Without this, every case
   * after the first would see the latch already spent and measure nothing.
   */
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
  return host;
}

function byText(el: HTMLElement, text: string): HTMLElement | null {
  return [...el.querySelectorAll("button, a")]
    .find((n) => (n.textContent ?? "").trim() === text) as HTMLElement | undefined ?? null;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

beforeEach(() => {
  mockStartCalls = [];
  mockCompleteCalls = [];
  mockStartThrows = null;
  mockCompleteThrows = null;
  mockAvailable = true;
  mockDeviceAvailable = false;
  mockDeviceStartGate = null;
  mockStartGate = null;
  mockAvailabilityGate = null;
  mockDeviceStarts = 0;
  sessionStorage.clear();
  mockSearchAtComplete = null;
  mockNavigatedTo = null;
  /*
   * ONLY `assign` IS REPLACED, and the REAL `window.location` is kept — which is the difference
   * between this test and a version of it that measured nothing.
   *
   * The first draft replaced the whole `location` object with a literal carrying `search: ""`. Every
   * "coming back from Microsoft" case then failed, because the component read that empty string
   * instead of the query `mount()` had just written with `history.replaceState`; and if the literal
   * had happened to carry the right search, the `stripOAuthParams` assertions would have passed
   * without the strip ever being observable — `replaceState` updates the real location, not a stand-in.
   *
   * jsdom's own `location.assign` is non-configurable, so the object IS replaced — but every property
   * the code reads is a GETTER over `document.URL`, which jsdom updates on `history.replaceState`. The
   * only behaviour that differs from the real thing is the navigation, which is recorded.
   * `mockNavigatedTo` is asserted because "the browser went to Microsoft" IS the button's job; a test
   * that checked only the fetch would pass on a button that does nothing visible.
   */
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      // LIVE GETTERS over `document.URL`, which jsdom keeps in step with `history.replaceState`. A
      // literal `search: ""` here is the version of this test that measured nothing.
      get href() { return document.URL; },
      get search() { return new URL(document.URL).search; },
      get pathname() { return new URL(document.URL).pathname; },
      get hash() { return new URL(document.URL).hash; },
      assign: (url: string) => { mockNavigatedTo = url; },
    },
  });
});

afterEach(async () => { await unmount(); vi.restoreAllMocks(); });

describe("Settings → Mailboxes offers Outlook beside the password form", () => {
  it("shows BOTH doors on the empty state, and neither replaces the other", async () => {
    const el = await mount([]);
    expect(byText(el, copy.connect!), "the password ceremony is still offered").toBeTruthy();
    expect(byText(el, copy.oauthConnect!), "Connect Outlook is a second door").toBeTruthy();
  });

  /**
   * SET-L3 — THE PRESS THAT LEAVES THE APP SAYS SO FIRST.
   *
   * "Connect Outlook" used to fire the top-level navigation to Microsoft on the click itself:
   * no sentence about what was about to happen, no word on how this door differs from the
   * password ceremony beside it, no way back. The picker's Microsoft tile already had the
   * honest shape — the sign-in note on screen, then an explicit "Connect with Microsoft" —
   * so the standalone button now runs the same two steps. The RECONNECT button on an oauth
   * row stays a single press: that row already names Microsoft, and the person pressing it
   * came to repair exactly that connection.
   */
  it("pressing it shows the sign-in disclosure first — no request, no navigation yet", async () => {
    const el = await mount([]);
    await click(byText(el, copy.oauthConnect!)!);
    expect(mockStartCalls, "the click itself started the ceremony").toHaveLength(0);
    expect(mockNavigatedTo, "the click itself navigated away").toBeNull();
    // What is about to happen, and which mailboxes this door is for.
    expect(el.textContent).toContain("never sees or stores your Microsoft password");
    expect(el.textContent).toContain(copy.oauthOfferWhich!);
  });

  it("Continue asks the server for an authorize URL and NAVIGATES the top-level document", async () => {
    const el = await mount([]);
    await click(byText(el, copy.oauthConnect!)!);
    await click(byText(el, copy.oauthContinue!)!);
    expect(mockStartCalls).toHaveLength(1);
    // No `mailboxId` on a FIRST connect — there is no row to hint at.
    expect(mockStartCalls[0]!.mailboxId).toBeUndefined();
    expect(mockStartCalls[0]!.returnTo).toBe("/");
    // A top-level navigation and not a fetch: Microsoft's consent screen sets `X-Frame-Options`, so
    // an iframe is impossible, and a popup is blocked in the common case.
    expect(mockNavigatedTo).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1");
  });

  it("Cancel closes the disclosure and both doors are back — nothing was started", async () => {
    const el = await mount([]);
    await click(byText(el, copy.oauthConnect!)!);
    await click(byText(el, copy.cancel!)!);
    expect(el.textContent).not.toContain(copy.oauthOfferWhich!);
    expect(byText(el, copy.connect!), "the password door came back").toBeTruthy();
    expect(byText(el, copy.oauthConnect!), "the Outlook door came back").toBeTruthy();
    expect(mockStartCalls).toHaveLength(0);
    expect(mockNavigatedTo).toBeNull();
  });

  it("renders THE SERVER'S sentence when the deployment has not armed the registration", async () => {
    mockStartThrows = new ApiError(
      503, "oauth_unconfigured",
      "Connecting a Microsoft mailbox is not available on this deployment yet.",
      { gap: "client_secret_missing" },
    );
    const el = await mount([]);
    await click(byText(el, copy.oauthConnect!)!);
    await click(byText(el, copy.oauthContinue!)!);
    // Re-deriving this here is how somebody is told "Microsoft refused you" about a deployment whose
    // operator has not finished pasting in a client secret.
    expect(el.textContent).toContain("not available on this deployment yet");
    expect(mockNavigatedTo, "a refused start must not navigate anywhere").toBeNull();
  });
});

describe("the Outlook door is gated on the deployment's capability, not shown then withdrawn", () => {
  it("shows Connect Outlook when the registration is ARMED, and hides it when it is not", async () => {
    // ARMED — the default. The password door and the Outlook door are both present.
    const armed = await mount([]);
    expect(byText(armed, copy.oauthConnect!), "armed ⇒ the Outlook door is offered").toBeTruthy();

    // DORMANT — the operator has not finished (or has disabled) the Entra registration. `…/start`
    // would answer 503, so the button must be ABSENT rather than a dead press. This is the red-first
    // guard: remove the `oauthAvailable ?` gate in MailboxSection and this expectation fails, because
    // the button renders regardless.
    mockAvailable = false;
    const dormant = await mount([]);
    expect(byText(dormant, copy.oauthConnect!), "dormant ⇒ no button that would 503").toBeNull();
    // …and the PASSWORD door is untouched: it needs no server-side registration, so it stays.
    expect(byText(dormant, copy.connect!), "the password ceremony does not depend on OAuth config").toBeTruthy();
  });

  it("hides an oauth row's Reconnect when the door is shut — and offers no Edit in its place", async () => {
    mockAvailable = false;
    const el = await mount([dto({
      id: "mb-oauth", authKind: "oauth", status: "error", errorCode: "auth",
      errorDetail: "OAUTH_INVALID_GRANT",
    })]);
    // Reconnect would 503 while the registration is dormant, so it is absent…
    expect(byText(el, copy.oauthReconnect!), "a dormant deployment cannot run the reconnect").toBeNull();
    // …and Edit is NOT offered as a fallback: an oauth mailbox has no password, so the form's every
    // field is meaningless and a PATCH from it would corrupt the credential.
    expect(byText(el, copy.edit!), "an oauth row never falls back to the password form").toBeNull();
  });
});

describe("an OAUTH row offers a reconnect, and NOT the password form", () => {
  it("replaces Edit with Reconnect Microsoft, and names the row it came from", async () => {
    const el = await mount([dto({
      id: "mb-oauth", authKind: "oauth", status: "error", errorCode: "auth",
      errorDetail: "OAUTH_INVALID_GRANT", failedAt: "2026-08-10T09:00:00.000Z", retryCount: 3,
    })]);

    expect(byText(el, copy.oauthReconnect!)).toBeTruthy();
    // NOT "Edit". The form behind it asks for a password this mailbox does not have, and a PATCH
    // from it would store one beside an `authType: "oauth2"` credential.
    expect(byText(el, copy.edit!), "an oauth mailbox has no password to edit").toBeNull();

    await click(byText(el, copy.oauthReconnect!)!);
    // The id is passed for the `login_hint` ONLY — so the consent screen preselects the right
    // account. Which row gets written is decided by the `id_token`'s address, which is why a person
    // who signs in as somebody else gets that other mailbox rather than this row repointed.
    expect(mockStartCalls[0]!.mailboxId).toBe("mb-oauth");
  });

  it("a PASSWORD row still offers Edit and not the consent flow", async () => {
    const el = await mount([dto({ id: "mb-pass", authKind: "password", status: "error", errorCode: "auth" })]);
    expect(byText(el, copy.edit!)).toBeTruthy();
    expect(byText(el, copy.oauthReconnect!)).toBeNull();
  });

  it("a row from an OLDER API, with no authKind at all, keeps the password door", async () => {
    // Absent is read as `"password"` — the historical behaviour, and the one that OFFERS the form
    // rather than withholding it. The other default would silently remove the only reconnect a
    // password mailbox has, on every row, the moment a client outran its server.
    const el = await mount([dto({ id: "mb-old" })]);
    expect(byText(el, copy.edit!)).toBeTruthy();
    expect(byText(el, copy.oauthReconnect!)).toBeNull();
  });
});

describe("every reason the server can send has a sentence here", () => {
  it("`oauth_<code>` exists in en.json for every member of the client's set", async () => {
    const { OAUTH_REASONS } = await import("../app/(product)/mailbox/oauth-return.js");
    // A member with NO key renders the literal key path at a user, and the unknown-reason fallback
    // cannot catch it — a KNOWN reason never reaches the fallback. This is that pair.
    const missing = [...OAUTH_REASONS].filter((r) => copy[`oauth_${r}`] === undefined);
    expect(missing, "a reason code with no copy").toEqual([]);
    // AND NO SPARE KEYS. An `oauth_*` key with no reason behind it is a second English sentence for a
    // failure the server already words itself — the duplication a narrower taxonomy removed.
    const spare = Object.keys(copy)
      .filter((k) => k.startsWith("oauth_"))
      .filter((k) => !OAUTH_REASONS.has(k.slice("oauth_".length)));
    expect(spare, "an oauth_* key with no reason behind it").toEqual([]);
    // …and the fallback's own key exists, so the unknown path is not itself a key path.
    expect(copy.oauth_consent_failed).toBeTruthy();
  });
});

describe("the Microsoft PROVIDER TILE reaches the consent flow, not the app-password form", () => {
  // The entry point people actually find is the provider grid, not the standalone button beside it.
  // Picking Microsoft there, on an armed deployment, must BE the consent ceremony — the defect this
  // guards is a tile that dropped the person into an app-password form for a tenant that cannot use
  // one. Open the form and select the Microsoft tile the way the picker renders it (a radio whose
  // label the tile carries, not a bare text button).
  async function openAndPickMicrosoft(el: HTMLElement): Promise<HTMLElement> {
    await click(byText(el, copy.connect!)!);
    const tile = [...el.querySelectorAll('button[role="radio"]')]
      .find((b) => (b.textContent ?? "").includes("Microsoft 365")) as HTMLElement | undefined;
    expect(tile, "the Microsoft tile is in the provider grid").toBeTruthy();
    await click(tile!);
    return el;
  }

  const APP_PW_REQUIREMENT = "requires security defaults to be off"; // the preset's app-password note
  const APP_PW_CLAIM = "You will need an app password"; // the exact stale claim, absent when armed

  it("armed door: Microsoft tile → Continue starts the consent ceremony and NAVIGATES", async () => {
    mockAvailable = true;
    const el = await mount([]);
    await openAndPickMicrosoft(el);

    // The primary action is the sign-in, not "Continue" into a form. Its red-first: strip the
    // `microsoftOauth` branch and this button reads "Continue" and does nothing on the top level.
    const go = byText(el, copy.oauthContinue!);
    expect(go, "the primary action is Connect with Microsoft").toBeTruthy();
    // No app-password form is present — the address is asked first, but there is no password to type.
    expect(el.querySelector("#mb-pass"), "the armed Microsoft path shows no password field").toBeNull();

    // The false claim is GONE, and the honest sign-in sentence is what shows instead.
    expect(el.textContent, "the stale app-password claim is absent when OAuth is available").not.toContain(APP_PW_CLAIM);
    expect(el.textContent).not.toContain(APP_PW_REQUIREMENT);
    expect(el.textContent).toContain("never sees or stores your Microsoft password");

    await click(go!);
    // It IS the consent ceremony: the same `/start` → authorizeUrl → top-level navigation the
    // standalone button runs, with no `mailboxId` (a first connect has no row to hint at).
    expect(mockStartCalls).toHaveLength(1);
    expect(mockStartCalls[0]!.mailboxId).toBeUndefined();
    expect(mockStartCalls[0]!.returnTo).toBe("/");
    expect(mockNavigatedTo).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1");
  });

  it("shut door: Microsoft tile falls back to the app-password form, and does NOT navigate", async () => {
    mockAvailable = false;
    const el = await mount([]);
    await openAndPickMicrosoft(el);

    // No armed registration ⇒ the app-password path is the only one that can work, so it is shown:
    // the fields render and the preset's app-password note (help link and all) is honest here.
    expect(el.querySelector("#mb-pass"), "the shut-door Microsoft path shows the password field").toBeTruthy();
    expect(el.textContent).toContain(APP_PW_REQUIREMENT);
    // The primary action is the ordinary Continue, and nothing has navigated to Microsoft.
    expect(byText(el, copy.continue!), "the fallback keeps the ordinary Continue").toBeTruthy();
    expect(byText(el, copy.oauthContinue!), "no sign-in action when the door is shut").toBeNull();
    expect(mockStartCalls, "a shut door never starts a ceremony").toHaveLength(0);
    expect(mockNavigatedTo).toBeNull();
  });

  it("the app-password escape hatch is secondary, and reveals the form on an armed deployment", async () => {
    mockAvailable = true;
    const el = await mount([]);
    await openAndPickMicrosoft(el);
    // Armed: no fields yet, but the explicit escape hatch is offered…
    expect(el.querySelector("#mb-pass")).toBeNull();
    const useAppPw = byText(el, copy.microsoftUseAppPassword!);
    expect(useAppPw, "an armed deployment still offers the app-password escape hatch").toBeTruthy();
    // …and taking it reveals the app-password form, for a tenant that blocks the sign-in.
    await click(useAppPw!);
    expect(el.querySelector("#mb-pass"), "the escape hatch reveals the password field").toBeTruthy();
    expect(byText(el, copy.oauthContinue!), "the escape hatch drops the sign-in action").toBeNull();
  });
});

describe("coming back from Microsoft", () => {
  it("finishes the ceremony from THIS origin and strips the parameters BEFORE the call", async () => {
    const el = await mount([], "?settings=mailboxes&oauth=pending&state=STATE-1&code=CODE-1");
    expect(mockCompleteCalls).toEqual([{ state: "STATE-1", code: "CODE-1" }]);
    // THE STRIP HAPPENS FIRST. The authorization code is single-use, and leaving it in the address
    // bar for the length of an IMAP probe is the window in which somebody copies the URL. Move
    // `stripOAuthParams()` after the await and this is the assertion that fails.
    expect(mockSearchAtComplete).not.toContain("code=CODE-1");
    expect(mockSearchAtComplete).not.toContain("state=STATE-1");
    expect(window.location.search).not.toContain("oauth=");
    // …and the hash survives, because it is what keeps the settings view open.
    expect(window.location.hash).toBe("#/settings");
    expect(el.textContent).toContain("oauth-user@contoso-com.example");
  });

  it("runs the completion ONCE — a spent state must not be re-POSTed", async () => {
    await mount([], "?oauth=pending&state=STATE-1&code=CODE-1");
    await settle();
    await settle();
    // The effect has no dependency that can change, deliberately: a second call would answer 400 and
    // put a refusal on screen for a ceremony that had in fact succeeded.
    expect(mockCompleteCalls).toHaveLength(1);
  });

  it("an ADMIN-CONSENT refusal names both causes and reads as an alert", async () => {
    const el = await mount([], "?oauth=error&reason=admin_consent_required");
    expect(mockCompleteCalls).toHaveLength(0);
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("administrator");
    // We cannot reliably tell "never consented" from "this tenant does not let people consent" —
    // Microsoft signals both the same way — so the copy names both and the remedy they share.
    expect(alert?.textContent).toContain("approve apps themselves");
  });

  it("a DECLINED consent is a status, not an alert — the person said no", async () => {
    const el = await mount([], "?oauth=error&reason=consent_declined");
    expect(el.querySelector('[role="alert"]'), "somebody's own decision is not an error").toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toContain("cancelled");
  });

  it("a reason this build does not know still gets a sentence", async () => {
    // The same posture `standDownToken` and `blockedUnknown` take: a server that grows a fifth
    // reason must not render a literal key path at a user. `state_expired` is deliberately in this
    // case rather than in the one above: it is a `complete` refusal and arrives as a JSON error with
    // the server's own sentence, so it has no client key and must not be given one.
    for (const unknown of ["some_future_reason", "state_expired", "account_mismatch"]) {
      const el = await mount([], `?oauth=error&reason=${unknown}`);
      expect(el.textContent).toContain(copy.oauth_consent_failed!);
      expect(el.textContent).not.toContain(unknown);
    }
  });

  it("a bounce with `pending` but no code is treated as an invalid link, not as a completion", async () => {
    const el = await mount([], "?oauth=pending&state=STATE-1");
    expect(mockCompleteCalls).toHaveLength(0);
    expect(el.textContent).toContain(copy.oauth_state_invalid!);
  });

  it("no `oauth` parameter at all does nothing", async () => {
    const el = await mount([dto()], "?settings=mailboxes");
    expect(mockCompleteCalls).toHaveLength(0);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});

/**
 * A CONSENT THAT HAS STARTED RETIRES THE FORM THAT STARTED IT.
 *
 * Three readings of one rule, each measured failing:
 *  · the device code and the connect form used to render TOGETHER, with Continue live again — a
 *    second press starts a second grant on the server and drops the handle to the first;
 *  · Cancel and the provider picker stayed live over a start in flight, so its answer navigated
 *    to Microsoft (or rendered a code) over whatever the person had moved to;
 *  · a persisted ceremony restored underneath an already-open form, because the restore effect
 *    read neither stage nor form.
 *
 * HOW TO WATCH THESE FAIL — all three were run, restored `cmp`-proved:
 *  · drop `setStage("list")` from `startDeviceFlow` → case 1 fails with the picker still there;
 *  · drop the `seq !== oauthSeq.current` guard from `startOutlook`'s success → case 2 fails with
 *    the browser at Microsoft's sign-in page after Cancel;
 *  · drop `stage !== "list"` from the restore effect → case 3 fails with a code under the form.
 */
describe("a started Microsoft ceremony retires the form", () => {
  /** The Microsoft tile in the connect form's picker. */
  const microsoftTile = (el: HTMLElement): HTMLElement =>
    [...el.querySelectorAll("button[role=radio]")]
      .find((n) => (n.textContent ?? "").includes("Microsoft")) as HTMLElement;

  it("the device code cannot render beside the connect form, and Continue is gone with it", async () => {
    // The self-hosted shape: no Entra registration of the operator's own, the device door armed.
    mockAvailable = false;
    mockDeviceAvailable = true;
    const el = await mount([]);

    await click(byText(el, copy.connect!)!);
    await click(microsoftTile(el));
    await click(byText(el, copy.oauthContinue!)!);

    expect(el.textContent, "the code the person has to type is not on screen").toContain("CODE-1");
    expect(el.querySelector(".pvp"), "the connect form stood beside the code").toBeNull();
    expect(byText(el, copy.oauthContinue!), "Continue came back over a live ceremony").toBeNull();
    // …and there is nothing left to press twice: one grant, one handle.
    expect(mockDeviceStarts).toBe(1);
  });

  it("a start the person cancelled never leaves the origin", async () => {
    mockStartGate = () => {};
    const el = await mount([]);
    await click(byText(el, copy.oauthConnect!)!);
    await click(byText(el, copy.oauthContinue!)!);
    expect(mockStartCalls.length, "the start did not go out").toBe(1);

    // The offer's Cancel, pressed while the server is still answering.
    await click(byText(el, copy.cancel!)!);
    const release = mockStartGate as unknown as () => void;
    release();
    await settle();

    expect(mockNavigatedTo, "a cancelled consent navigated to Microsoft anyway").toBeNull();
  });

  it("a persisted ceremony waits for the list rather than restoring under the form", async () => {
    mockAvailable = false;
    mockDeviceAvailable = true;
    // The armed-door read lands LATE, which is the order the defect needs: both facts the restore
    // waits on can arrive after somebody has opened the form.
    mockAvailabilityGate = () => {};
    sessionStorage.setItem("ohmail.deviceCeremony", JSON.stringify({
      state: "S-old", userCode: "CODE-OLD", verificationUri: "https://microsoft.com/devicelogin",
      expiresAt: Date.now() + 900_000, retryAfterMs: 0, accountId: "acct-1",
    }));
    const el = await mount([]);

    await click(byText(el, copy.connect!)!);
    expect(el.querySelector(".pvp"), "the form did not open").toBeTruthy();

    (mockAvailabilityGate as unknown as () => void)();
    await settle();
    expect(el.textContent, "a live code restored under an open form").not.toContain("CODE-OLD");
    expect(el.querySelector(".pvp"), "the form was taken away instead").toBeTruthy();

    // AND THE RECORD IS NOT SPENT — leaving the form restores it, which is what makes the skip a
    // deferral rather than a loss.
    await click(byText(el, copy.cancel!)!);
    expect(el.textContent, "the ceremony was dropped rather than deferred").toContain("CODE-OLD");
  });
});
