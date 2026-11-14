/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import { parseHash } from "../app/shell/routing";
import { initialPaneFromUrl } from "../app/views/SettingsView";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * LANDING BACK FROM MICROSOFT — the ceremony must finish on ANY screen, not only on the one it
 * hoped to land on.
 *
 * ══ THE PRODUCTION FAILURE THESE GUARD (2026-08-10) ═══════════════════════════════════════════
 *
 * A real Exchange connect: the tenant's admin approved the app, consent succeeded, and the browser
 * came back to the OHBOX with no mailbox added and nothing said. The ceremony row was still
 * `consumed_at IS NULL` — so `POST …/complete` was never CALLED, not called-and-refused.
 *
 * The cause was a coupling, not a bad request: the completion lived in `MailboxSection`'s mount
 * effect, and that component mounts only when the Settings VIEW is open AND the Mailboxes PANE is
 * selected. The view is chosen by the URL FRAGMENT, and the fragment is exactly what a redirect chain
 * may drop — `parseHash("")` is `ohbox`. One missing `#` therefore moved the whole ceremony from
 * "finishing" to "silently abandoned".
 *
 * So the property under test is deliberately stated in terms of what was NOT true in production:
 * **arriving at the bounce URL with no fragment at all completes the ceremony and puts the browser on
 * Settings → Mailboxes**, with no component mounted at the time.
 *
 * The route assertions go through `parseHash` and `initialPaneFromUrl` — the REAL routers — rather
 * than comparing strings, so a URL that merely looks right but routes to the Ohbox fails here.
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
let mockCompleteCalls: Array<{ state: string; code: string }> = [];
let mockCompleteThrows: unknown = null;
let mockCompleteCreated = true;
/** The URL as it stood when `oauthComplete` was invoked — the strip-before-call assertion. */
let mockUrlAtComplete: string | null = null;
let mockListed: MailboxDTO[] = [];

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "microsoft", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: null,
  createdAt: "2026-08-10T10:00:00.000Z", ...over,
});

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true }, scope: "full",
      }),
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      resync: async () => undefined,
      oauthAvailability: async () => ({ available: true }),
      oauthStart: async () => ({ authorizeUrl: "https://login.microsoftonline.com/x", state: "S" }),
      oauthComplete: async (b: { state: string; code: string }) => {
        mockCompleteCalls.push(b);
        mockUrlAtComplete = document.URL;
        if (mockCompleteThrows) throw mockCompleteThrows;
        return {
          mailbox: dto({ address: "mila.brunner@lichtgrat.example" }),
          created: mockCompleteCreated,
          returnTo: null,
        };
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

type ReturnModule = typeof import("../app/(product)/mailbox/oauth-return");

/**
 * A FRESH MODULE PER CASE. The store and its one-shot latch are module state by design — that is
 * what makes the completion independent of any mount — so each case gets its own instance rather
 * than sharing one across the file.
 */
async function landAt(url: string): Promise<ReturnModule> {
  window.history.replaceState(null, "", url);
  vi.resetModules();
  const mod = await import("../app/(product)/mailbox/oauth-return.js");
  mod.resetOAuthReturn();
  return mod;
}

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

/** Mount the pane AFTER the fact, which is the whole point: it renders an outcome it did not cause. */
async function mountPane(): Promise<HTMLDivElement> {
  await unmount();
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

const text = (el: HTMLElement): string => el.textContent ?? "";

beforeEach(() => {
  mockCompleteCalls = [];
  mockCompleteThrows = null;
  mockCompleteCreated = true;
  mockUrlAtComplete = null;
  mockListed = [];
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("the consent return is finished by the LANDING, not by a pane", () => {
  it("completes the ceremony from a URL with NO fragment, and routes to Settings → Mailboxes", async () => {
    // Exactly what production delivered: the query survived every redirect hop, the fragment did not.
    const mod = await landAt("/?settings=mailboxes&oauth=pending&state=STATE1&code=CODE1");

    mod.beginOAuthReturn();
    await settle();

    // 1. THE CALL HAPPENED. Nothing was mounted; no pane exists in this test at all.
    expect(mockCompleteCalls, "POST /complete fired on the landing").toEqual([
      { state: "STATE1", code: "CODE1" },
    ]);

    // 2. THE ROUTE IS CORRECTED — through the real routers, not by matching a string.
    expect(parseHash(window.location.hash).view, "the settings VIEW is open").toBe("settings");
    expect(initialPaneFromUrl(), "on the Mailboxes PANE").toBe("mailboxes");

    // 3. THE SINGLE-USE VALUES ARE GONE, and they were gone BEFORE the POST — an authorization code
    //    must not sit in an address bar for the length of an IMAP probe.
    const q = new URLSearchParams(window.location.search);
    expect(q.get("oauth")).toBeNull();
    expect(q.get("state")).toBeNull();
    expect(q.get("code")).toBeNull();
    expect(mockUrlAtComplete, "stripped before the call, not after").not.toContain("CODE1");
  });

  it("corrects the route even when the bounce landed on a bare `/` with no pane parameter", async () => {
    // The belt to the API's braces: if a future hop ate `?settings=` too, the ceremony parameters
    // alone still say what screen this is.
    const mod = await landAt("/?oauth=pending&state=s2&code=c2");
    mod.beginOAuthReturn();
    await settle();
    expect(mockCompleteCalls).toHaveLength(1);
    expect(parseHash(window.location.hash).view).toBe("settings");
    expect(initialPaneFromUrl()).toBe("mailboxes");
  });

  it("spends the state ONCE, however many times it is asked to", async () => {
    const mod = await landAt("/?oauth=pending&state=s3&code=c3");
    mod.beginOAuthReturn();
    mod.beginOAuthReturn();
    await settle();
    // A second POST would answer 400 about a ceremony that had just succeeded — a confusing refusal
    // for a connect that worked.
    expect(mockCompleteCalls).toHaveLength(1);
  });

  it("is a no-op on every ordinary page load", async () => {
    const mod = await landAt("/#/ohbox");
    expect(mod.beginOAuthReturn()).toBeNull();
    await settle();
    expect(mockCompleteCalls).toHaveLength(0);
    expect(window.location.hash, "the URL is not touched").toBe("#/ohbox");
  });
});

describe("the pane RENDERS the outcome it did not cause", () => {
  it("a successful completion names the mailbox that was connected", async () => {
    const mod = await landAt("/?oauth=pending&state=s4&code=c4");
    mod.beginOAuthReturn();
    await settle();

    const el = await mountPane();
    expect(text(el)).toContain("mila.brunner@lichtgrat.example");
    expect(text(el), "the CONNECTED sentence, not the reconnect one")
      .toContain(copy.oauthConnected!.split("{address}")[1]!.trim());
  });

  it("a REFUSED completion shows the server's own sentence — on the Mailboxes pane, not the Ohbox", async () => {
    mockCompleteThrows = new ApiError(
      400, "oauth_state_expired", "That took too long to complete. Start again from Settings.",
      { reason: "state_expired" },
    );
    const mod = await landAt("/?oauth=pending&state=s5&code=c5");
    mod.beginOAuthReturn();
    await settle();

    // The screen is still the one the sentence belongs on. This is the half that was missing: a
    // failure used to be reported into a pane nobody was looking at.
    expect(parseHash(window.location.hash).view).toBe("settings");
    expect(initialPaneFromUrl()).toBe("mailboxes");

    const el = await mountPane();
    const alert = el.querySelector('[role="alert"]');
    expect(alert, "the refusal is an alert").toBeTruthy();
    expect(text(alert as HTMLElement)).toContain("That took too long to complete");
  });

  it("the bounce's OWN refusal lands on the pane with its own sentence", async () => {
    const mod = await landAt("/?oauth=error&reason=admin_consent_required");
    mod.beginOAuthReturn();
    await settle();

    expect(mockCompleteCalls, "there is nothing to complete").toHaveLength(0);
    expect(parseHash(window.location.hash).view).toBe("settings");
    expect(initialPaneFromUrl()).toBe("mailboxes");

    const el = await mountPane();
    expect(text(el)).toContain(copy.oauth_admin_consent_required!);
    // …and the reason is out of the address bar with the rest of the ceremony.
    expect(new URLSearchParams(window.location.search).get("reason")).toBeNull();
  });

  it("a DECLINED consent is a notice, not an alert — the person said no", async () => {
    const mod = await landAt("/?oauth=error&reason=consent_declined");
    mod.beginOAuthReturn();
    await settle();
    const el = await mountPane();
    expect(el.querySelector('[role="alert"]'), "no alert for somebody's own decision").toBeNull();
    expect(text(el)).toContain(copy.oauth_consent_declined!);
  });
});

describe("the Cloud client's BOOT is what runs the ceremony", () => {
  it("merely loading the client module finishes a ceremony found in the URL — nothing is rendered", async () => {
    // THE WIRING IS THE GUARD. Everything above proves `beginOAuthReturn` does the right thing when
    // it is called; this proves the app CALLS it on a page load, which is the half production was
    // missing. `CloudShell` is the client entry for this route, and importing it is that page load:
    // no root, no render, no pane — and the ceremony still completes.
    //
    // Move the call inside the component (or delete it) and this is the assertion that goes red.
    const mod = await landAt("/?oauth=pending&state=BOOT&code=BOOTCODE");
    expect(mockCompleteCalls, "nothing has happened yet").toHaveLength(0);

    await import("../app/(product)/mailbox/CloudShell.js");
    await settle();

    expect(mockCompleteCalls).toEqual([{ state: "BOOT", code: "BOOTCODE" }]);
    expect(parseHash(window.location.hash).view).toBe("settings");
    expect(initialPaneFromUrl()).toBe("mailboxes");
    // …and the module store is the same one the pane reads, so the answer is not stranded.
    expect(mod.oauthOutcome()?.kind).toBe("connected");
  });
});

describe("the closed set of bounce reasons has copy for every member", () => {
  it("every OAUTH_REASONS member has a `mailboxes.oauth_<code>` key", async () => {
    // A known reason never reaches the fallback, so a missing key renders the literal key path at a
    // user. The set is exported for exactly this pairing.
    const mod = await landAt("/");
    for (const reason of mod.OAUTH_REASONS) {
      expect(copy[`oauth_${reason}`], reason).toBeTruthy();
    }
  });
});
