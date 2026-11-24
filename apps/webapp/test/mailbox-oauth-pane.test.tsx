/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import {
  ACCOUNT, act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

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

const copy: Record<string, string> = messages.mailboxes;
const microsoft = "/api/mailboxes/oauth/microsoft";
const authorize = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1";
let mockApprovalFailure: boolean;
const approvalUrl = "https://login.microsoftonline.com/organizations/adminconsent?client_id=fixture-app";
const startRefusal = "Connecting a Microsoft mailbox is not available on this deployment yet.";

let mockStartCalls: Array<{ mailboxId?: string; returnTo?: string }>;
let mockCompleteCalls: Array<{ state: string; code: string }>;
let mockStartRefused: boolean;
let mockAvailable: boolean;
let mockDeviceAvailable: boolean;
let mockStartGate: (() => void) | null;
let mockAvailabilityGate: (() => void) | null;
let mockDeviceStarts: number;
let mockDevicePolls: number;
let mockDeviceStartAnswer: Response | null;
let mockDevicePollAnswer: Response | null;
let mockNavigatedTo: string | null;
let restoreLocation: (() => void) | null = null;

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "microsoft", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: "2026-08-10T11:00:00.000Z",
  createdAt: "2026-08-10T10:00:00.000Z", ...over,
});

beforeAll(warmCloudShell);

beforeEach(() => {
  mockApprovalFailure = false;
  mockStartCalls = [];
  mockCompleteCalls = [];
  mockStartRefused = false;
  mockAvailable = true;
  mockDeviceAvailable = false;
  mockStartGate = null;
  mockAvailabilityGate = null;
  mockDeviceStarts = 0;
  mockDevicePolls = 0;
  mockDeviceStartAnswer = null;
  mockDevicePollAnswer = null;
  mockNavigatedTo = null;
  sessionStorage.clear();
});

async function unmount(): Promise<void> {
  if (restoreLocation === null) return;
  restoreLocation();
  restoreLocation = null;
  await teardownConfirmEnv();
  (await import("../app/(product)/mailbox/device-sign-in")).retireDeviceSignIn();
  (await import("../app/api-client")).bindApiOwner(null);
}

afterEach(async () => {
  await unmount();
  window.history.replaceState(null, "", "/");
});

async function mount(items: MailboxDTO[], search = "", isolated = false): Promise<HTMLElement> {
  await unmount();
  installConfirmEnv();
  rememberOwner();
  if (isolated) {
    const { isolateAccountScope } = await import("../app/pending-sign-out-storage");
    document.cookie = "tf_family=fixture-family; Path=/";
    isolateAccountScope(ACCOUNT, "fixture-family");
  }
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  (await import("../app/api-client")).bindApiOwner(null);

  // Keep live history and record the top-level navigation. The provider is never contacted.
  const descriptor = Object.getOwnPropertyDescriptor(window, "location")!;
  const real = window.location;
  restoreLocation = () => { Object.defineProperty(window, "location", descriptor); };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() { return real.href; },
      get search() { return real.search; },
      get pathname() { return real.pathname; },
      get hash() { return real.hash; },
      set hash(value: string) { real.hash = value; },
      get origin() { return real.origin; },
      get protocol() { return real.protocol; },
      get hostname() { return real.hostname; },
      get host() { return real.host; },
      assign: (url: string) => { mockNavigatedTo = url; },
    },
  });

  let availability: Promise<void> | undefined;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/mailboxes" && method === "GET") return Response.json({ items });
    if (path === "/api/account/access") return Response.json({ metered: false });
    if (path === `${microsoft}/availability`) {
      if (mockAvailabilityGate) {
        availability ??= new Promise<void>((go) => {
          mockAvailabilityGate = () => { mockAvailabilityGate = null; go(); };
        });
        await availability;
      }
      const approval = new URL(String(input), window.location.origin).searchParams.has("approval");
      if (approval && mockApprovalFailure) return new Response(null, { status: 503 });
      return Response.json({
        available: mockAvailable,
        device: mockDeviceAvailable,
        ...(approval ? { adminApprovalUrl: approvalUrl } : {}),
      }, { headers: { "X-Ohmail-Account": ACCOUNT } });
    }
    if (path === `${microsoft}/start` && method === "POST") {
      mockStartCalls.push(JSON.parse(String(init?.body)));
      if (mockStartGate) await new Promise<void>((go) => { mockStartGate = go; });
      if (mockStartRefused) {
        return Response.json({ error: { code: "oauth_unconfigured", message: startRefusal } }, { status: 503 });
      }
      return Response.json({ authorizeUrl: authorize, state: "fixture-state" });
    }
    if (path === `${microsoft}/complete` && method === "POST") {
      mockCompleteCalls.push(JSON.parse(String(init?.body)));
      return Response.json({ mailbox: dto({ authKind: "oauth" }), created: true, returnTo: null });
    }
    if (path === `${microsoft}/device/start` && method === "POST") {
      mockDeviceStarts += 1;
      if (mockDeviceStartAnswer) return mockDeviceStartAnswer.clone();
      return Response.json({
        state: "fixture-device",
        userCode: `CODE-${mockDeviceStarts}`,
        verificationUri: "https://microsoft.com/devicelogin",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        intervalMs: 5000,
      });
    }
    if (path === `${microsoft}/device/poll` && method === "POST") {
      mockDevicePolls += 1;
      if (mockDevicePollAnswer) return mockDevicePollAnswer.clone();
      const { state } = JSON.parse(String(init?.body));
      return Response.json({
        status: "pending", retryAfterMs: 5000, userCode: state === "fixture-resume" ? "CODE-OLD" : "CODE-1",
        verificationUri: "https://microsoft.com/devicelogin",
      });
    }
    return fetch(input, init);
  };

  window.history.replaceState(null, "", `/mailbox${search}#/settings/mailboxes`);
  const { resetOAuthReturn, beginOAuthReturn } = await import("../app/(product)/mailbox/oauth-return.js");
  resetOAuthReturn();
  beginOAuthReturn();
  const frame = await mountCloudShell();
  await tick(3000);
  return frame;
}

function byText(el: HTMLElement, name: string): HTMLElement | null {
  return within(el).queryByRole("button", { name }) ?? within(el).queryByRole("link", { name });
}

const pane = (el: HTMLElement) => within(within(el).getByRole("region", { name: messages.settings.mailboxes }));
const connect = (el: HTMLElement) => pane(el).queryByRole("button", { name: copy.connect });
const outlook = (el: HTMLElement) => pane(el).queryByRole("button", { name: copy.oauthConnect });
const continueInSettings = (el: HTMLElement) => pane(el).queryByRole("button", { name: copy.oauthContinue });

async function click(el: HTMLElement | null): Promise<void> {
  expect(el, "the requested control is available").not.toBeNull();
  await act(async () => el!.click());
  await tick(250);
}

const settle = (): Promise<void> => tick(250);
const providerTile = (el: HTMLElement): HTMLElement | null =>
  within(el).queryByRole("button", {
    name: (name) => name === messages.providerPicker.microsoftShort || /Microsoft 365/.test(name),
  });
const password = (el: HTMLElement): HTMLElement | null =>
  el.querySelector('input[type="password"]');

async function closeSetup(el: HTMLElement): Promise<void> {
  const setup = messages.onboarding.setupMenu;
  await click(within(el).queryByRole("button", { name: setup }));
  const menu = within(el).getByRole("menu", { name: setup });
  await click(within(menu).getByRole("menuitem", { name: messages.onboarding.cancel }));
  const confirm = within(el).getByRole("dialog", { name: messages.onboarding.cancel });
  await click(within(confirm).getByRole("button", { name: messages.onboarding.cancelConfirm }));
}

describe("Settings → Mailboxes offers Outlook beside the password form", () => {
  it("shows BOTH doors on the empty state, and neither replaces the other", async () => {
    const el = await mount([]);
    expect(connect(el), "the password ceremony is still offered").toBeTruthy();
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
    expect(connect(el), "the password door came back").toBeTruthy();
    expect(byText(el, copy.oauthConnect!), "the Outlook door came back").toBeTruthy();
    expect(mockStartCalls).toHaveLength(0);
    expect(mockNavigatedTo).toBeNull();
  });

  it("renders THE SERVER'S sentence when the deployment has not armed the registration", async () => {
    mockStartRefused = true;
    const el = await mount([]);
    await click(outlook(el));
    await click(continueInSettings(el));
    expect(mockStartCalls).toHaveLength(1);
    expect(providerTile(el)).toBeNull();
    // This redirect refusal names the deployment configuration.
    expect(pane(el).getByRole("alert").textContent).toContain(startRefusal);
    expect(mockNavigatedTo, "a refused start must not navigate anywhere").toBeNull();
  });

  it("the provider picker reports the server's registration refusal", async () => {
    mockStartRefused = true;
    const el = await mount([]);
    await click(connect(el));
    await click(providerTile(el));
    await click(byText(el, copy.oauthContinue!));
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
    expect(connect(dormant), "the password ceremony does not depend on OAuth config").toBeTruthy();
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
    await click(connect(el)!);
    await click(providerTile(el));
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
    expect(password(el), "the armed Microsoft path shows no password field").toBeNull();

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
    expect(password(el), "the shut-door Microsoft path shows the password field").toBeTruthy();
    expect(el.textContent).toContain(APP_PW_REQUIREMENT);
    // The primary action is the ordinary Continue, and nothing has navigated to Microsoft.
    expect(byText(el, messages.onboarding.connect), "the fallback keeps the ordinary connect action").toBeTruthy();
    expect(byText(el, copy.oauthContinue!), "no sign-in action when the door is shut").toBeNull();
    expect(mockStartCalls, "a shut door never starts a ceremony").toHaveLength(0);
    expect(mockNavigatedTo).toBeNull();
  });

  it("the app-password escape hatch is secondary, and reveals the form on an armed deployment", async () => {
    mockAvailable = true;
    const el = await mount([]);
    await openAndPickMicrosoft(el);
    // Armed: no fields yet, but the explicit escape hatch is offered…
    expect(password(el)).toBeNull();
    const useAppPw = byText(el, copy.microsoftUseAppPassword!);
    expect(useAppPw, "an armed deployment still offers the app-password escape hatch").toBeTruthy();
    // …and taking it reveals the app-password form, for a tenant that blocks the sign-in.
    await click(useAppPw!);
    expect(password(el), "the escape hatch reveals the password field").toBeTruthy();
    expect(byText(el, copy.oauthContinue!), "the escape hatch drops the sign-in action").toBeNull();
  });
});

describe("coming back from Microsoft", () => {
  it("an ADMIN-CONSENT refusal asks for one approval and offers the link to copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const el = await mount([], "?oauth=error&reason=admin_consent_required");
      expect(mockCompleteCalls).toHaveLength(0);
      expect(pane(el).getByRole("alert").textContent).toBe("Your organisation’s administrator needs to approve ohmail once.");
      expect(pane(el).getByText("Your administrator opens this link once and approves ohmail for the organisation.")).toBeTruthy();
      await click(pane(el).getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith(approvalUrl);
    } finally {
      if (clipboard) Object.defineProperty(window.navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(window.navigator, "clipboard");
    }
  });

  it("asks for approval in Microsoft Entra when the approval link read fails", async () => {
    mockApprovalFailure = true;
    const el = await mount([], "?oauth=error&reason=admin_consent_required");
    expect(pane(el).getByRole("status").textContent).toBe("Ask your administrator to approve ohmail in Microsoft Entra");
    expect(pane(el).queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("a DECLINED consent is a status, not an alert — the person said no", async () => {
    const el = await mount([], "?oauth=error&reason=consent_declined");
    expect(pane(el).queryByRole("alert"), "somebody's own decision is not an error").toBeNull();
    expect(pane(el).getByRole("status").textContent).toContain("cancelled");
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
    expect(pane(el).queryByRole("alert")).toBeNull();
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
  it("the device code cannot render beside the connect form, and Continue is gone with it", async () => {
    // The self-hosted shape: no Entra registration of the operator's own, the device door armed.
    mockAvailable = false;
    mockDeviceAvailable = true;
    const el = await mount([]);

    const echoedStart = "Start response included a synthetic sign-in value.";
    mockDeviceStartAnswer = Response.json({
      error: { code: "oauth_device_unconfigured", message: echoedStart },
    }, { status: 503 });

    await click(outlook(el));
    await click(continueInSettings(el));
    const refusal = pane(el).getByRole("alert").textContent;
    expect(refusal?.includes(echoedStart), "the Settings start alert must use catalogue copy").toBe(false);
    expect(refusal).toBe(copy.device_unconfigured);
    expect(sessionStorage.getItem("ohmail.oauth.device")).toBeNull();

    const unconfigured = mockDeviceStartAnswer;
    mockDeviceStartAnswer = Response.json({
      error: { code: "unknown_device_refusal", message: echoedStart },
    }, { status: 503 });
    await click(continueInSettings(el));
    expect(pane(el).getByRole("alert").textContent).toBe(copy.oauth_consent_failed);
    expect(sessionStorage.getItem("ohmail.oauth.device")).toBeNull();
    await click(pane(el).queryByRole("button", { name: copy.cancel }));

    mockDeviceStartAnswer = unconfigured;
    await click(connect(el)!);
    await click(providerTile(el));
    await click(byText(el, copy.oauthContinue!)!);
    expect(el.textContent?.includes(echoedStart), "the provider picker must also use catalogue copy").toBe(false);
    expect(within(el).getByRole("alert").textContent).toBe(copy.device_unconfigured);
    expect(sessionStorage.getItem("ohmail.oauth.device")).toBeNull();

    mockDeviceStartAnswer = null;
    mockDeviceStarts = 0;
    await click(byText(el, copy.oauthContinue!)!);

    expect(el.textContent, "the code the person has to type is not on screen").toContain("CODE-1");
    expect(providerTile(el), "the connect form stood beside the code").toBeNull();
    expect(byText(el, copy.oauthContinue!), "Continue came back over a live ceremony").toBeNull();
    // …and there is nothing left to press twice: one grant, one handle.
    expect(mockDeviceStarts).toBe(1);
    const stored = JSON.parse(sessionStorage.getItem("ohmail.oauth.device") ?? "null");
    expect(stored).toEqual({ handle: "fixture-device", deadline: expect.any(Number), account: ACCOUNT });
    expect(mockDevicePolls).toBe(1);

    const echoedPoll = "Poll response repeated CODE-1.";
    mockDevicePollAnswer = Response.json(
      { error: { code: "upstream_unavailable", message: echoedPoll } }, { status: 503 },
    );
    await tick(4_000);
    expect(mockDevicePolls).toBe(1);
    await tick(1_000);
    expect(mockDevicePolls).toBe(2);
    expect(el.textContent?.includes(echoedPoll), "the retry notice must use catalogue copy").toBe(false);
    expect(pane(el).getByText(copy.device_poll_retry!)).toBeTruthy();
    expect(pane(el).getAllByText("CODE-1", { exact: true })).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem("ohmail.oauth.device") ?? "null")).toEqual(stored);

    // A terminal refusal replaces the code with a catalogue message that outlives it.
    mockDevicePollAnswer = Response.json(
      { error: { code: "oauth_device_state_invalid", message: echoedPoll } }, { status: 400 },
    );
    await tick(5_000);
    expect(mockDevicePolls).toBe(3);
    expect(el.textContent?.includes("CODE-1"), "the alert must not repeat the retired code").toBe(false);
    expect(pane(el).getByRole("alert").textContent).toBe(copy.device_state_invalid);
    expect(sessionStorage.getItem("ohmail.oauth.device")).toBeNull();
    await tick(6_000);
    expect(mockDevicePolls).toBe(3);
    expect(pane(el).getByRole("alert").textContent).toBe(copy.device_state_invalid);
  });

  it("a start the person cancelled never leaves the origin", async () => {
    mockStartGate = () => {};
    const el = await mount([]);
    await click(outlook(el));
    await click(continueInSettings(el));
    expect(mockStartCalls.length, "the start did not go out").toBe(1);

    // Cancel the Settings disclosure before releasing the provider's answer.
    await click(pane(el).queryByRole("button", { name: copy.cancel }));
    expect(continueInSettings(el)).toBeNull();
    expect(outlook(el)).toBeTruthy();
    expect(connect(el)).toBeTruthy();
    const release = mockStartGate as unknown as () => void;
    release();
    await settle();

    expect(mockStartCalls).toHaveLength(1);
    expect(mockNavigatedTo, "a cancelled consent navigated to Microsoft anyway").toBeNull();
  });

  it("a provider picker start cancelled during Setup never leaves the origin", async () => {
    mockStartGate = () => {};
    const el = await mount([]);
    await click(connect(el));
    await click(providerTile(el));
    await click(byText(el, copy.oauthContinue!));
    expect(mockStartCalls.length, "the start did not go out").toBe(1);

    // Leave the setup step while the provider's start is still answering.
    await closeSetup(el);
    const release = mockStartGate as unknown as () => void;
    release();
    await settle();

    expect(mockStartCalls).toHaveLength(1);
    expect(mockNavigatedTo, "a cancelled consent navigated to Microsoft anyway").toBeNull();
  });

  it("a persisted ceremony waits for the list rather than restoring under the form", async () => {
    mockAvailable = false;
    mockDeviceAvailable = true;
    // The armed-door read lands LATE, which is the order the defect needs: both facts the restore
    // waits on can arrive after somebody has opened the form.
    mockAvailabilityGate = () => {};
    sessionStorage.setItem("ohmail.oauth.device", JSON.stringify({
      handle: "fixture-resume", deadline: Date.parse(ISO) + 900_000, account: ACCOUNT,
    }));
    const el = await mount([]);

    await click(connect(el)!);
    expect(providerTile(el), "the form did not open").toBeTruthy();

    (mockAvailabilityGate as unknown as () => void)();
    await settle();
    expect(el.textContent, "a live code restored under an open form").not.toContain("CODE-OLD");
    expect(providerTile(el), "the form was taken away instead").toBeTruthy();

    // AND THE RECORD IS NOT SPENT — leaving the form restores it, which is what makes the skip a
    // deferral rather than a loss.
    await closeSetup(el);
    expect(el.textContent, "the ceremony was dropped rather than deferred").toContain("CODE-OLD");

    // A later reload in the same tab must not paint or poll a different account's record.
    await unmount();
    mockDevicePolls = 0;
    sessionStorage.setItem("ohmail.oauth.device", JSON.stringify({
      handle: "fixture-resume", deadline: Date.parse(ISO) + 900_000, account: "other-fixture-account",
    }));
    sessionStorage.setItem("ohmail.deviceCeremony", JSON.stringify({ userCode: "CODE-OLD" }));
    const other = await mount([]);
    expect(other.textContent).not.toContain("CODE-OLD");
    expect(mockDevicePolls).toBe(0);
    expect(sessionStorage.getItem("ohmail.oauth.device")).toBeNull();
    expect(sessionStorage.getItem("ohmail.deviceCeremony")).toBeNull();
  });
});


it("Outlook starts a device code under the authenticated account when draft storage is isolated", async () => {
  mockAvailable = false;
  mockDeviceAvailable = true;
  const el = await mount([], "", true);
  await click(outlook(el));
  await click(continueInSettings(el));
  expect(mockDeviceStarts).toBe(1);
  expect(mockDevicePolls).toBe(1);
  expect(JSON.parse(sessionStorage.getItem("ohmail.oauth.device") ?? "null")?.account).toBe(ACCOUNT);
});
