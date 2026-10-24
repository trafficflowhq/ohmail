/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { ACCOUNT_ACCESS_PATH, MANAGE_LINK_PATH } from "../src/DesktopSubscription.js";
import { enableExternalLinks, interceptLinkClicks } from "../../webapp/app/shell/open-external";
import messages from "../../webapp/messages/en.json";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * ═══ THE SUBSCRIPTION LINK IS MINTED BY THE PRESS, AND OPENED BY A CLICK ═══════════════════
 *
 * The hook behind this pane asked `POST /account/manage-link` in a MOUNT effect, called from
 * `DesktopGate` above every early return — so every launch, and every change of the account
 * door, minted a management link for an account that was reading its mail. Nobody had pressed
 * anything, and on most launches nobody would.
 *
 * The two questions are apart now, and this file drives them through the real gate over a fake
 * bridge, because a hook test cannot see the thing that was actually wrong: WHICH PATHS THE
 * MOUNT PUT ON THE WIRE. The offer (`GET /account/access`) mints nothing; the address is asked
 * for by the press. The shell opens a link only on the person's own click, and the mint answers
 * after a round trip to the engine, past any gesture WebKit still counts, so the press draws the
 * address as a focused link and the person's click (or Enter) on it is the open — the document's
 * link interceptor, armed here exactly as `main.tsx` arms it, turning it into the webview's
 * new-window request.
 *
 * The nav entry belongs to the GATE (`SettingsView` grows it from the prop's presence), so the
 * withdrawal case reads the NAV and not just the pane: a node that rendered nothing would leave
 * "Subscription" standing over an empty pane, which is the shape this pane exists to avoid.
 */

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
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

const MANAGE_URL = "https://account.example/manage?t=abc";

/** What `GET /account/access` answers this case, as a status and a body. */
let access: { status: number; body: string } = {
  status: 200, body: JSON.stringify({ metered: true, canAddMailbox: true, mailboxes: 1 }),
};
/** What `POST /account/manage-link` answers this case. */
let mint: { status: number; body: string } = { status: 200, body: JSON.stringify({ url: MANAGE_URL }) };

/** Every `engine_request` path the window put on the bridge, in order. */
const enginePaths: string[] = [];
/** Every address this window asked the webview to open as a new window, in order. */
const opened: string[] = [];

function fakeShell(status: EngineStatus): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        enginePaths.push(url);
        if (url === "/health") return encode(200, JSON.stringify({ signedIn: true }));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, MAILBOXES);
        if (url.startsWith("/consent")) return encode(200, CONSENT);
        if (url.startsWith("/away-responder")) return encode(200, AWAY);
        if (url === "/account/ai") return encode(200, JSON.stringify({ aiEnabled: true }));
        if (url === ACCOUNT_ACCESS_PATH) return encode(access.status, access.body);
        if (url === MANAGE_LINK_PATH) return encode(mint.status, mint.body);
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
}

beforeEach(() => {
  // The webview's new-window request; the shell answers it with no window.
  vi.spyOn(window, "open").mockImplementation((url?: string | URL) => {
    opened.push(String(url));
    return null;
  });
});

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
let disposeInterceptor: (() => void) | null = null;

async function settle(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

const SETTINGS = messages.settings as unknown as Record<string, string>;

/** Mount the real gate at `#/settings` over `status`, with the window's link interceptor armed. */
async function open(status: EngineStatus): Promise<void> {
  fakeShell(status);
  /* The two calls `main.tsx` makes, and the reason this file can assert the EXIT: the address
     never navigates this window — one capture-phase listener on the document hands it to the
     platform's opener. Disposed in `afterEach`, so a case that does not arm it sees nothing. */
  enableExternalLinks();
  disposeInterceptor = interceptLinkClicks(document, { trustSameOrigin: true });
  window.location.hash = "#/settings";
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    /* The children go in the PROPS rather than as trailing arguments: both providers declare
       `children` as a required prop, and `createElement`'s variadic overload does not satisfy a
       required one — the census file beside this carries that as two pinned type errors. */
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages: messages as never,
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

const nav = (): string[] =>
  [...mountPoint!.querySelectorAll<HTMLElement>(".set-nav button")].map((b) => (b.textContent ?? "").trim());

function byText(selector: string, text: string): HTMLElement | null {
  return [...mountPoint!.querySelectorAll<HTMLElement>(selector)]
    .find((el) => (el.textContent ?? "").trim() === text) ?? null;
}

async function press(el: HTMLElement): Promise<void> {
  await act(async () => { el.click(); });
  await settle(10);
}

/** Open the Subscription pane and answer the Manage control it draws. */
async function manageControl(): Promise<HTMLButtonElement> {
  const entry = byText(".set-nav button", SETTINGS.billing);
  expect(entry, "the Subscription entry is not in the nav, so there is nothing to press").not.toBeNull();
  await press(entry!);
  const btn = byText("button.btn", SETTINGS.subscriptionManage) as HTMLButtonElement | null;
  expect(btn, "the Subscription pane drew no Manage control").not.toBeNull();
  return btn!;
}

afterEach(async () => {
  access = { status: 200, body: JSON.stringify({ metered: true, canAddMailbox: true, mailboxes: 1 }) };
  mint = { status: 200, body: JSON.stringify({ url: MANAGE_URL }) };
  enginePaths.length = 0;
  opened.length = 0;
  disposeInterceptor?.();
  disposeInterceptor = null;
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  vi.restoreAllMocks();
});

describe("the mount", () => {
  it("NOTHING IS MINTED BY THE MOUNT — the offer is a read, and the address is not asked for", async () => {
    /* A mailbox this window has already found open: the first-paint gate asks nothing, so the one
       read left is the offer's. A first launch reads twice — the gate's and the offer's — below. */
    localStorage.setItem("ohmail.access.mbx-1", "open");
    await open(CLOUD_SERVING);

    expect(
      enginePaths.filter((p) => p === MANAGE_LINK_PATH),
      "the window minted a management link nobody pressed for",
    ).toEqual([]);
    expect(
      enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH).length,
      "the offer was read more than once for one door",
    ).toBe(1);
    expect(nav(), "the pane is offered from the access answer").toContain(SETTINGS.billing);
    localStorage.removeItem("ohmail.access.mbx-1");
  });

  it("a FIRST launch on a mailbox asks the account once for its first paint, and once for the offer", async () => {
    localStorage.clear();
    await open(CLOUD_SERVING);
    expect(enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH).length).toBe(2);
    expect(enginePaths.filter((p) => p === MANAGE_LINK_PATH)).toEqual([]);
  });

  it("a host that runs no such program offers nothing, and is never asked for an address", async () => {
    access = { status: 200, body: JSON.stringify({ metered: false }) };
    await open(CLOUD_SERVING);

    expect(nav(), "a host with no program grew a Subscription entry").not.toContain(SETTINGS.billing);
    expect(enginePaths.filter((p) => p === MANAGE_LINK_PATH)).toEqual([]);
  });

  /**
   * THE LOCK'S OWN DOOR. A refused account cannot reach a `read` route — `GET /account/access` is
   * one, and answers 402 — while the mint is the one route the lock leaves open, because the way
   * back to paying may not be behind it. So a 402 is the one non-2xx that means YES: a program
   * exists and it has something to say to this account. Reading it as "no page" would take the
   * row away from the only person who needs it.
   */
  it("a REFUSED account is offered the pane — the way back to paying is not behind the lock", async () => {
    access = { status: 402, body: JSON.stringify({ error: { code: "payment_required" } }) };
    await open(CLOUD_SERVING);

    expect(nav(), "the lock took away the row that unlocks it").toContain(SETTINGS.billing);
  });

  it("a read that refused offers nothing — a failure is not evidence a page exists", async () => {
    access = { status: 503, body: JSON.stringify({ error: { code: "offline_read_only" } }) };
    await open(CLOUD_SERVING);

    expect(nav()).not.toContain(SETTINGS.billing);
  });

  it("the standalone door asks nothing and offers nothing — there is no account to ask about", async () => {
    await open(LOCAL_SERVING);

    expect(
      enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH || p === MANAGE_LINK_PATH),
      "a standalone install asked about a subscription it has no account for",
    ).toEqual([]);
    expect(nav()).not.toContain(SETTINGS.billing);
  });
});

/** The minted address, drawn as the link the person presses, or null. */
const mintedLink = (): HTMLAnchorElement | null =>
  mountPoint!.querySelector<HTMLAnchorElement>(`a[href="${MANAGE_URL}"]`);

/** The person's click on a drawn link, through the window's own interceptor. */
async function follow(a: HTMLAnchorElement): Promise<void> {
  await act(async () => {
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle(10);
}

describe("the press", () => {
  it("mints ONCE, draws the address as a focused link, and opens nothing until it is clicked", async () => {
    await open(CLOUD_SERVING);
    const btn = await manageControl();
    await press(btn);

    expect(
      enginePaths.filter((p) => p === MANAGE_LINK_PATH).length,
      "one press is one mint",
    ).toBe(1);
    const link = mintedLink();
    expect(link, "the press drew no link to the minted address").not.toBeNull();
    expect(link!.target).toBe("_blank");
    expect(link!.rel).toBe("noopener noreferrer");
    expect(document.activeElement, "the drawn link does not have the focus, so Enter does not open it")
      .toBe(link);
    expect(opened, "the press opened the page itself, with no click of its own behind it").toEqual([]);
    expect(nav(), "the pane went away on a good answer").toContain(SETTINGS.billing);

    await follow(link!);
    expect(
      opened,
      "the click on the minted link opened nothing — the defect this pane is about",
    ).toEqual([MANAGE_URL]);
  });

  it("a second going mints a second address — a link is minted for the going, not cached", async () => {
    await open(CLOUD_SERVING);
    await press(await manageControl());
    await follow(mintedLink()!);
    // Followed, the link gives the control back.
    const again = byText("button.btn", SETTINGS.subscriptionManage) as HTMLButtonElement | null;
    expect(again, "the Manage control did not come back after the link was followed").not.toBeNull();
    await press(again!);
    await follow(mintedLink()!);

    expect(enginePaths.filter((p) => p === MANAGE_LINK_PATH).length).toBe(2);
    expect(opened).toHaveLength(2);
  });

  it("a REFUSED mint says so on the pane, and leaves the control pressable", async () => {
    mint = { status: 500, body: JSON.stringify({ error: { code: "upstream_fault" } }) };
    await open(CLOUD_SERVING);
    const btn = await manageControl();
    await press(btn);

    expect(
      byText("p.acct-warn", SETTINGS.subscriptionManageFailed),
      "the press was refused and the pane said nothing",
    ).not.toBeNull();
    expect(opened, "a refused mint opened something").toEqual([]);
    expect(btn.disabled, "the control stayed disabled after a refusal").toBe(false);
    expect(nav(), "a refusal is not evidence there is no page").toContain(SETTINGS.billing);
  });

  it("a 404 at the press withdraws the pane AND the nav entry", async () => {
    mint = { status: 404, body: JSON.stringify({ error: { code: "no_manage_surface" } }) };
    await open(CLOUD_SERVING);
    const btn = await manageControl();
    await press(btn);

    expect(nav(), "the entry survived a 404 — it opens onto nothing now").not.toContain(SETTINGS.billing);
    expect(byText("button.btn", SETTINGS.subscriptionManage), "the pane is still drawn").toBeNull();
    expect(opened).toEqual([]);
  });

  it("an answer with nowhere to go withdraws too — a 200 naming no place is the same fact", async () => {
    mint = { status: 200, body: JSON.stringify({ url: "" }) };
    await open(CLOUD_SERVING);
    const btn = await manageControl();
    await press(btn);

    expect(nav()).not.toContain(SETTINGS.billing);
    expect(opened, "an empty address was handed to the opener").toEqual([]);
  });
});

/* A TRANSIENT NEVER REMOVES THE PANE FOR THE SESSION: a read that failed leaves the offer
   UNKNOWN, and the next return to the window asks once more; an answered offer asks nothing
   until the quiet floor has passed. */
describe("the offer after a failed read", () => {
  const reads = (): number => enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH).length;
  async function backToTheWindow(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
  }
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    localStorage.removeItem("ohmail.access.mbx-1");
  });

  it("a failed first read, then a return: exactly one more read, and the pane is offered", async () => {
    localStorage.setItem("ohmail.access.mbx-1", "open");
    access = { status: 503, body: JSON.stringify({ error: { code: "unavailable" } }) };
    await open(CLOUD_SERVING);
    expect(nav(), "premise: a failed read offers nothing").not.toContain(SETTINGS.billing);
    const before = reads();
    access = { status: 200, body: JSON.stringify({ metered: true, canAddMailbox: true, mailboxes: 1 }) };
    await backToTheWindow();
    expect(reads() - before, "the return asked once").toBe(1);
    expect(nav(), "the answer on the return did not bring the pane").toContain(SETTINGS.billing);
    // Answered now: another return asks nothing.
    await backToTheWindow();
    expect(reads() - before).toBe(1);
  });

  it("an answered metered:false, then a return: zero reads, and no pane", async () => {
    localStorage.setItem("ohmail.access.mbx-1", "open");
    access = { status: 200, body: JSON.stringify({ metered: false }) };
    await open(CLOUD_SERVING);
    const before = reads();
    await backToTheWindow();
    expect(reads() - before, "an answered offer asked again").toBe(0);
    expect(nav()).not.toContain(SETTINGS.billing);
  });
});

describe("the emptied-text notice on the Cloud door", () => {
  const EMPTIED = {
    usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 80_000,
    firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: "2019-04",
  };
  const withStorage = (storage: unknown, state = "trialing"): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({
      metered: true, access: "open", canAddMailbox: true, mailboxes: 1,
      lifecycle: { state, closedReason: null }, storage,
    }),
  });
  const notice = (): HTMLElement | null => mountPoint!.querySelector("[data-storage-notice]");

  it("the same access read draws it, with the plan sentence and a way to the Subscription pane", async () => {
    globalThis.localStorage.clear();
    access = withStorage(EMPTIED);
    await open(CLOUD_SERVING);
    expect(notice()?.textContent).toContain("no longer stores the text of your 80,000 oldest letters");
    expect(notice()?.textContent).toContain("A bigger plan keeps more text from now on.");
    expect(notice()?.querySelector("a")?.getAttribute("href")).toBe("#/settings/billing");
    // The first paint's read and the offer's, as on any first launch: the notice asks nothing of its own.
    expect(enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH)).toHaveLength(2);
  });

  it("the cap is crossed while the window is open: a return after the quiet floor draws it", async () => {
    globalThis.localStorage.clear();
    localStorage.setItem("ohmail.access.mbx-1", "open");
    access = withStorage({ ...EMPTIED, usedBytes: 1_990_000_000, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null });
    await open(CLOUD_SERVING);
    expect(notice()).toBeNull();
    const before = enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH).length;
    access = withStorage(EMPTIED, "active");
    const start = Date.now();
    const backAt = async (ms: number): Promise<void> => {
      vi.spyOn(Date, "now").mockReturnValue(start + ms);
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      await settle(20);
    };
    await backAt(60_000);
    expect(enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH).length - before, "a return inside the floor asked").toBe(0);
    await backAt(16 * 60_000);
    expect(enginePaths.filter((p) => p === ACCOUNT_ACCESS_PATH).length - before).toBe(1);
    expect(notice()?.textContent).toContain("no longer stores the text of your 80,000 oldest letters");
    globalThis.localStorage.clear();
  });

  it("put away, it stays away on the next launch", async () => {
    globalThis.localStorage.clear();
    access = withStorage(EMPTIED, "active");
    await open(CLOUD_SERVING);
    await press(byText("button", "Dismiss")!);
    expect(notice()).toBeNull();
    await act(async () => { root!.unmount(); });
    mountPoint!.remove();
    await open(CLOUD_SERVING);
    expect(notice()).toBeNull();
    globalThis.localStorage.clear();
  });

  it("a standalone install and an answer with nothing emptied draw nothing", async () => {
    globalThis.localStorage.clear();
    access = withStorage(EMPTIED);
    await open(LOCAL_SERVING);
    expect(notice()).toBeNull();
    await act(async () => { root!.unmount(); });
    mountPoint!.remove();
    access = withStorage({ ...EMPTIED, emptiedForSpace: 0 });
    await open(CLOUD_SERVING);
    expect(notice()).toBeNull();
  });
});
