/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DesktopGate } from "../src/DesktopGate.js";
import { cloudSuggestWire } from "../src/cloud-suggest.js";
import { ACCOUNT_ACCESS_PATH } from "../src/DesktopSubscription.js";
import { enableExternalLinks, interceptLinkClicks } from "../../webapp/app/shell/open-external";
import type { EngineStatus } from "../src/bridge-fetch.js";
import type { SuggestBatchControl } from "../../webapp/app/shell/screener-suggest";

/**
 * ═══ A REFUSED ACCOUNT MEETS ONE SCREEN, AND A REFUSAL THAT LIFTS COMES DOWN ═══════════════
 *
 * Two halves of one state, both webapp-only until now.
 *
 * THE CLEAR. The Screener's refusal line is a claim about an account, and on the desktop it had
 * no way down short of a press somebody might never make: `aiAvailable` — the member the shared
 * hook asks to take a stale line down — was a member of the browser's transport and not of this
 * window's. So an account whose AI came back read "managed AI is switched off" until it pressed.
 *
 * THE SCREEN. The browser tab swaps its whole surface for a lock screen when the service answers
 * `402 subscription_required`; the window aliased that client away and met the refusal ONE FAILED
 * WRITE AT A TIME, each pane saying its own thing about somebody's standing.
 *
 * ── WHAT THESE ASSERTIONS ARE DRIVEN AGAINST ────────────────────────────────────────────────
 *
 * The real transport and the real gate, over answers framed EXACTLY as the shell frames one for
 * the bridge — the length-prefixed metadata the window actually parses — never a double that
 * answers differently from the API. The refusals are the API's own envelopes, and every sentence
 * asserted here is read out of the shared catalogue rather than written into this file: what the
 * lock screen says is the service's, and a literal here would be this repository inventing one.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/** One answer, framed exactly as the shell frames one for the bridge. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const LOCK = messages.accessLock as unknown as Record<string, string>;
const AI = messages.aiRefusal as unknown as Record<string, string>;
const MANAGE_URL = "https://account.example/manage?t=abc";

/**
 * THE SERVICE'S OWN REFUSAL ENVELOPE — the shape `packages/api` answers at a locked door, and the
 * only place in this file the lock screen's content comes from. `details` is what the browser's
 * client narrows to `AccessRefusedFacts`, so this is the wire both surfaces read.
 */
function refusal(reason: string, manageUrl?: string): string {
  return JSON.stringify({
    error: {
      code: "subscription_required",
      message: "this account is not active",
      details: { reason, ...(manageUrl ? { manageUrl } : {}) },
    },
  });
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA", hasMore: false, serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 },
});
const MAILBOXES = JSON.stringify({
  items: [{ id: "mbx-1", address: "someone@example.com", status: "connected", lastSyncAt: null }],
});
const CONSENT = JSON.stringify({
  seedConfirmedAt: "2026-01-01T00:00:00.000Z",
  screeningResetAt: null, dormancyDays: 90, screeningBaselineAt: null, autoSuggestAt: null,
  blockRemoteImagesAt: null, loadTrackingPixelsAt: null, blockAutoUnsubscribeAt: null,
  foldersEnabledAt: null, folderMailboxesOff: {}, signatures: {}, themeFace: null,
});
const AWAY = JSON.stringify({
  enabled: false, text: "", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day",
});

const CLOUD_SERVING: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app",
  mailboxId: "mbx-1", credentialState: "ready",
} as EngineStatus;
const LOCAL_SERVING: EngineStatus = {
  state: "serving", mode: "local", address: "someone@example.com",
  mailboxId: "mbx-1", credentialState: "ready",
} as EngineStatus;

/** What the case wants the mailboxes route — any hosted write — to answer. 200 unless locked. */
let mailboxAnswer: { status: number; body: string } = { status: 200, body: MAILBOXES };
/** What `GET /account/access` answers this case. */
let access: { status: number; body: string } = {
  status: 200, body: JSON.stringify({ metered: true, canAddMailbox: true, mailboxes: 1 }),
};
/** Every `engine_request` path the window put on the bridge, in order. */
const enginePaths: string[] = [];
/** Every shell command the window invoked, so a sign-out can be read off the wire. */
const commands: string[] = [];

function fakeShell(status: EngineStatus): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      commands.push(command);
      if (command === "engine_status") return status;
      if (command === "engine_logout") return { ...status, state: "idle", mailboxId: null };
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        enginePaths.push(url);
        if (url === "/health") return encode(200, JSON.stringify({ signedIn: true }));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(mailboxAnswer.status, mailboxAnswer.body);
        if (url.startsWith("/consent")) return encode(200, CONSENT);
        if (url.startsWith("/away-responder")) return encode(200, AWAY);
        if (url === "/account/ai") return encode(200, JSON.stringify({ aiEnabled: true }));
        if (url === ACCOUNT_ACCESS_PATH) return encode(access.status, access.body);
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
let disposeInterceptor: (() => void) | null = null;

async function settle(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

/** Mount the real gate over `status`, with the window's link interceptor armed. */
async function open(status: EngineStatus, locale: "en" | "de" = "en"): Promise<void> {
  fakeShell(status);
  enableExternalLinks();
  disposeInterceptor = interceptLinkClicks(document, { trustSameOrigin: true });
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale,
        messages: (locale === "de" ? de : messages) as never,
        timeZone: "UTC",
        children: h(ThemeProvider, {
          storageKey: "ohmail.theme",
          children: h(ToastHost, null, h(DesktopGate, null)),
        }),
      }),
    );
  });
  await settle();
}

const text = (): string => mountPoint?.textContent ?? "";
const lockCard = (): HTMLElement | null => mountPoint?.querySelector(".gate .gate-card") ?? null;
const manageDoor = (): HTMLAnchorElement | null =>
  (mountPoint?.querySelector(".gate-actions a[href]") as HTMLAnchorElement | null) ?? null;

function byText(selector: string, wanted: string): HTMLElement | null {
  return [...(mountPoint?.querySelectorAll<HTMLElement>(selector) ?? [])]
    .find((el) => (el.textContent ?? "").trim() === wanted) ?? null;
}

afterEach(async () => {
  mailboxAnswer = { status: 200, body: MAILBOXES };
  access = { status: 200, body: JSON.stringify({ metered: true, canAddMailbox: true, mailboxes: 1 }) };
  enginePaths.length = 0;
  commands.length = 0;
  disposeInterceptor?.();
  disposeInterceptor = null;
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
});

describe("the window's refused-account screen", () => {
  it("swaps the whole surface for ONE screen when the service refuses the account", async () => {
    mailboxAnswer = { status: 402, body: refusal("payment_required", MANAGE_URL) };
    await open(CLOUD_SERVING);

    // The screen is here, and it is the CATALOGUE's sentences — not a literal in this repository.
    expect(lockCard(), "a refused account got no lock screen").not.toBeNull();
    expect(text()).toContain(LOCK.title);
    expect(text()).toContain(LOCK.kept);
    // And the mail surface is GONE. This is the half the row is about: the window used to keep
    // running and hand the refusal to whichever pane happened to make the next write.
    expect(mountPoint!.querySelector(".set-nav"), "the settings nav survived the lock").toBeNull();
    expect(mountPoint!.querySelector(".rail"), "the mail rail survived the lock").toBeNull();
  });

  it("says what the API said — the suspended arm is the service's word, not a second taxonomy", async () => {
    mailboxAnswer = { status: 402, body: refusal("suspended") };
    await open(CLOUD_SERVING);

    expect(text()).toContain(LOCK.suspendedTitle);
    expect(text()).not.toContain(LOCK.title);
  });

  it("renders the way back ONLY from the address the service supplied, and never invents one", async () => {
    mailboxAnswer = { status: 402, body: refusal("payment_required", MANAGE_URL) };
    await open(CLOUD_SERVING);

    const door = manageDoor();
    expect(door, "the service supplied an address and the screen offered no way to it").not.toBeNull();
    expect(door!.getAttribute("href")).toBe(MANAGE_URL);
    expect(door!.textContent?.trim()).toBe(LOCK.manage);
  });

  it("offers no way back when the service supplied none — a door to nowhere is worse than none", async () => {
    mailboxAnswer = { status: 402, body: refusal("payment_required") };
    await open(CLOUD_SERVING);

    expect(lockCard(), "no lock screen was drawn at all").not.toBeNull();
    expect(manageDoor(), "the window invented an address the service did not supply").toBeNull();
    /* AND NO CONTROL AT ALL, not merely no working one. Read by TEXT rather than by `a[href]`:
       an anchor rendered without an address is still a control a person sees and presses, and an
       assertion that only refuses the working form is one a mutation walks straight through —
       which this one did, green, until it was read this way. */
    expect(
      byText(".gate-actions a", LOCK.manage),
      "a dead control stands where the service supplied nowhere to go",
    ).toBeNull();
    expect(text(), "the way-back label is on screen with no way back").not.toContain(LOCK.manage);
    // The other door is never behind the lock: this may be a shared machine.
    expect(byText("button", LOCK.signOut), "a lock with no way out is a trap").not.toBeNull();
  });

  it("leaves by this window's own door — the sign-out is `engine_logout`, not a browser client", async () => {
    mailboxAnswer = { status: 402, body: refusal("payment_required") };
    await open(CLOUD_SERVING);

    const out = byText("button", LOCK.signOut);
    expect(out).not.toBeNull();
    await act(async () => { out!.click(); });
    await settle(10);

    expect(commands, "the lock screen did not end the session on this door").toContain("engine_logout");
  });

  it("is the CATALOGUE's screen in every language — nothing here is written in English by hand", async () => {
    mailboxAnswer = { status: 402, body: refusal("payment_required") };
    await open(CLOUD_SERVING, "de");

    const DE = de.accessLock as unknown as Record<string, string>;
    expect(text()).toContain(DE.title);
    expect(text()).toContain(DE.kept);
    // The namespace is genuinely reaching the window: a raw key here is what a missing entry in
    // `WINDOW_ONLY_NAMESPACES` renders, and it would pass an English-only read.
    expect(text()).not.toContain("accessLock.");
  });

  it("a 402 that is not THIS code is a refused request, not a refused account", async () => {
    // The lock is about the ACCOUNT. `insufficient_credits` is also a 402 and is about one ask —
    // locking on the status alone would take somebody's mail away over a spend they can retry.
    mailboxAnswer = {
      status: 402,
      body: JSON.stringify({ error: { code: "insufficient_credits", message: "no credits" } }),
    };
    await open(CLOUD_SERVING);

    expect(lockCard(), "the window locked the account over a refused request").toBeNull();
  });

  it("a standalone install never locks — it has no hosted account to be refused", async () => {
    mailboxAnswer = { status: 402, body: refusal("payment_required", MANAGE_URL) };
    await open(LOCAL_SERVING);

    expect(lockCard(), "an install with no hosted account met an account refusal").toBeNull();
  });
});

/**
 * ── THE CLEAR, DRIVEN THROUGH THE SHARED HOOK ON THE REAL TRANSPORT ─────────────────────────
 *
 * The hook is the browser's; the transport under it is this window's, over the bridge. What is
 * worth proving is exactly what the row names: the line comes down when the account says AI is
 * back, and it comes down WITHOUT a press.
 */
describe("the window's Screener refusal clears when access returns", () => {
  let suggestRoot: Root | null = null;
  let suggestHost: HTMLDivElement | null = null;

  afterEach(async () => {
    if (suggestRoot) await act(async () => { suggestRoot!.unmount(); });
    suggestHost?.remove();
    suggestRoot = null;
    suggestHost = null;
    delete host.__TAURI_INTERNALS__;
  });

  const SENDER = "stranger@example.com";

  /** The engine this window talks to: the suggest route refuses, the access route is the case's. */
  function engineRefusingSuggest(): void {
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, payload) => {
        if (command !== "engine_request") return null;
        const url = String(payload?.url ?? "");
        enginePaths.push(url);
        if (url === ACCOUNT_ACCESS_PATH) return encode(access.status, access.body);
        if (url.startsWith("/screener?") || url === "/screener") {
          return encode(200, JSON.stringify({
            items: [], nextCursor: null,
            suggestable: { senders: [SENDER], credits: 1, maxPerRequest: 50 },
          }));
        }
        /* THE SERVICE'S OWN REFUSAL — `ai_disabled` is the account's switch, which an access
           read describes, so it is one of the two the clear is allowed to lift. */
        return encode(409, JSON.stringify({
          error: { code: "ai_disabled", message: "managed AI is switched off for this account" },
        }));
      },
    };
  }

  async function mountProbe(): Promise<() => SuggestBatchControl> {
    const { useScreenerSuggestions } = await import("../../webapp/app/shell/screener-suggest.js");
    let control: SuggestBatchControl | null = null;
    function Probe(): null {
      const s = useScreenerSuggestions({
        active: true, toast: (() => {}) as never, wire: cloudSuggestWire,
      });
      control = s.forSenders([SENDER]);
      return null;
    }
    suggestHost = document.createElement("div");
    document.body.appendChild(suggestHost);
    suggestRoot = createRoot(suggestHost);
    await act(async () => {
      suggestRoot!.render(h(NextIntlClientProvider, {
        locale: "en", messages: messages as never, timeZone: "UTC", children: h(Probe),
      }));
    });
    await settle(6);
    return () => control!;
  }

  /** Price, then buy — the two presses that reach the wire and end in the refusal. */
  async function press(control: () => SuggestBatchControl): Promise<void> {
    await act(async () => { control().open(); });
    await settle(6);
    await act(async () => { control().confirm(); });
    await settle(6);
  }

  it("takes the line down when the account says AI is back — with no second press", async () => {
    engineRefusingSuggest();
    access = { status: 200, body: JSON.stringify({ metered: true, aiEnabled: false }) };
    const control = await mountProbe();
    await press(control);

    // The line is up, in the reader's language, and it is the account's switch.
    expect(control().notice, "the refusal never reached the control").toBe(AI.aiDisabled);

    // THE ACCOUNT CHANGES ITS MIND — and the window is shown again, which is the event the clear
    // is armed on. No press anywhere in this block.
    access = { status: 200, body: JSON.stringify({ metered: true, aiEnabled: true }) };
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(6);

    expect(control().notice, "the refusal stood after access returned").toBeNull();
    expect(
      enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH).length,
      "the window never asked the account whether AI was back",
    ).toBeGreaterThan(0);
  });

  it("keeps the line up while the account confirms it — `false` is an answer, not a clear", async () => {
    engineRefusingSuggest();
    access = { status: 200, body: JSON.stringify({ metered: true, aiEnabled: false }) };
    const control = await mountProbe();
    await press(control);
    expect(control().notice).toBe(AI.aiDisabled);

    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle(6);
    expect(control().notice, "a confirmed refusal was cleared").toBe(AI.aiDisabled);
  });

  it("clears nothing on an answer it could not read — the third state is not a `no` and not a `yes`", async () => {
    engineRefusingSuggest();
    // A SERVER THAT DID NOT SAY. `metered` absent read as "no program here, AI is on" would clear
    // a true refusal on a body of `{}` — the exact reading the browser's transport refuses.
    access = { status: 200, body: JSON.stringify({}) };
    const control = await mountProbe();
    await press(control);
    expect(control().notice).toBe(AI.aiDisabled);

    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle(6);
    expect(control().notice, "a line came down on an answer nobody gave").toBe(AI.aiDisabled);
  });

  it("reads the account's verdict strictly, and a failed read tells it nothing", async () => {
    // The member itself, on the four answers it has to tell apart. Driven on the real bridge.
    engineRefusingSuggest();

    access = { status: 200, body: JSON.stringify({ metered: true, aiEnabled: true }) };
    expect(await cloudSuggestWire.aiAvailable!()).toBe(true);

    access = { status: 200, body: JSON.stringify({ metered: true, aiEnabled: false }) };
    expect(await cloudSuggestWire.aiAvailable!()).toBe(false);

    // An UNMETERED host meters nothing and gates nothing.
    access = { status: 200, body: JSON.stringify({ metered: false }) };
    expect(await cloudSuggestWire.aiAvailable!()).toBe(true);

    // An older server that omits the word, and a read the door refused: both are "I cannot tell".
    access = { status: 200, body: JSON.stringify({ metered: true }) };
    expect(await cloudSuggestWire.aiAvailable!()).toBeNull();
    access = { status: 503, body: JSON.stringify({ error: { code: "db_busy" } }) };
    expect(await cloudSuggestWire.aiAvailable!()).toBeNull();
  });
});
