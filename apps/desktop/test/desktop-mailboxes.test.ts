/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * ═══ SETTINGS → MAILBOXES ON A DESKTOP INSTALL SIGNED IN TO A HOSTED ACCOUNT ═══════════════
 *
 * What was reported: the rows are there, nothing can be changed, and the pane says neither why
 * nor where to go instead. The list was correct and the silence was the defect.
 *
 * Why there is no edit control to add. The three routes that change a hosted mailbox —
 * `POST /mailboxes`, `PATCH /mailboxes/:id`, `DELETE /mailboxes/:id` — are step-up gated: the
 * account wants a second factor asserted within the last few minutes before it will store a
 * mailbox password. A browser tab can produce one, because it can put a password field on screen
 * and run a passkey against a real origin. A desktop install cannot: its session carries one such
 * assertion, stamped when the sign-in code was claimed, and nothing rotates that stamp forward.
 * The transport is not the obstacle — the engine's write-through proxy would carry the request and
 * the account would answer 403 — which is exactly why a control here would be a button that works
 * for five minutes and refuses for the life of the install.
 *
 * So the hosted door gets the list, one sentence, and a door to the browser. This file is the
 * assertion that all three are on screen, that the door is the app's own named-place mechanism,
 * and that the STANDALONE door — whose mailbox is configured on this machine and needs no account
 * at all — is not sent anywhere.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop the `cloud ?` guard around the hand-off row  → the standalone case goes red (a local
 *    install told to manage its own mailbox on a website it has no account on);
 *  · render the row on the local door only              → the hosted case goes red;
 *  · call `openWeb("account")` instead of `"mailboxes"` → the key case goes red;
 *  · replace `openWeb(…)` with `window.open(…)`         → the command case goes red, which is the
 *    one that matters: `window.open` is not granted to this window and a URL in the page is the
 *    thing the whole named-place table exists to prevent.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/**
 * The mailbox facts, supplied by replacing the hook rather than by standing up the provider.
 *
 * `MailStateProvider` is the shell's 30-second poller over `GET /mailboxes` and reads two further
 * contexts of its own; none of that is what this pane does. The pane reads ONE value, and this is
 * that value. Held in a mutable binding so each case can set it before mounting.
 */
let FACTS: MailboxFacts[] | null = null;
/** How many times the pane asked the shared poller to re-read. */
let refreshed = 0;

vi.mock("../../webapp/app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: { clock: false },
    mailboxes: FACTS,
    refresh: () => { refreshed += 1; },
  }),
}));

/** What the bridge answered, per request. Set by the cases that press "Sync now". */
let bridgeReply: () => Response = () => new Response(null, { status: 202 });
/** Every request the pane put down the pipe, in order. */
let bridged: { url: string; method: string }[] = [];

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async (url: string, init?: { method?: string }) => {
    bridged.push({ url, method: init?.method ?? "GET" });
    return bridgeReply();
  },
}));

/** Every command the window sent the shell, in order. The bridge is not otherwise exercised. */
let invoked: { command: string; payload?: Record<string, unknown> }[] = [];

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: unknown, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const MAILBOX: MailboxFacts = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-08-07T09:00:00.000Z",
  initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
};

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(door: string | null): Promise<HTMLElement> {
  /* Imported inside, so the module graph is built after `vi.mock` is registered. */
  const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(
          ThemeProvider,
          { storageKey: "ohmail.theme" },
          h(ToastHost, null, h(DesktopMailboxes, { door })),
        ),
      ),
    );
  });
  return mountPoint;
}

/** A button by its label, so a second control cannot be mistaken for the one under test. */
function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label)) ?? null
  );
}

const openButton = (el: HTMLElement) => buttonSaying(el, "Open ohmail.app");

beforeEach(() => {
  FACTS = [MAILBOX];
  refreshed = 0;
  bridged = [];
  bridgeReply = () => new Response(null, { status: 202 });
  invoked = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      invoked.push({ command, ...(payload ? { payload } : {}) });
      return null;
    },
  };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("the desktop mailbox pane on the hosted door", () => {
  it("lists the mailboxes, says where they are managed, and offers the way there", async () => {
    const el = await render("cloud");
    const text = el.textContent ?? "";

    // THE LIST — the pane's original and still primary job.
    expect(text).toContain("someone@example.test");
    expect(text).toContain("Up to date");
    // It names the hosted mode with the SAME words a browser tab uses.
    expect(text).toContain("Cloud mailboxes");

    // THE NOTE. Not an apology and not a shrug: it says where, and it says why.
    expect(text).toContain("Mailboxes are managed in ohmail on the web");
    expect(text).toMatch(/second factor/);

    // THE AFFORDANCE.
    expect(openButton(el), "no way out to the browser").not.toBeNull();
  });

  it("the button opens the browser through the shell's named-place command", async () => {
    const el = await render("cloud");
    await act(async () => { openButton(el)!.click(); });

    // ONE command, and it carries a KEY. A `url` in this payload would mean the page decides
    // where the user's real browser goes, which is what the table on the Rust side exists to
    // prevent; the address for `mailboxes` is written there and nowhere in this bundle.
    expect(invoked).toEqual([{ command: "open_link", payload: { key: "mailboxes" } }]);
  });

  it("a refusal to open a browser is said on the pane, not swallowed", async () => {
    host.__TAURI_INTERNALS__!.invoke = async () => {
      throw new Error("no browser on this machine");
    };
    const el = await render("cloud");
    await act(async () => { openButton(el)!.click(); });
    expect(el.textContent ?? "").toContain("would not open a browser");
  });

  it("an account with no mailbox yet is pointed at the web, not at the Desktop pane", async () => {
    // The old empty-state sentence sent everybody to "the Desktop settings pane", which is where
    // a STANDALONE install picks a mail server. On the hosted door that pane switches doors; the
    // mailbox belongs to the account.
    FACTS = [];
    const text = (await render("cloud")).textContent ?? "";
    expect(text).toContain("Connecting one happens in ohmail on the web");
    expect(text).not.toContain("Desktop settings pane");
  });

  /**
   * ── THE ONE MUTATION THAT IS NOT STEP-UP GATED ───────────────────────────────────────────
   *
   * `POST /mailboxes/:id/resync` is the single writing route in `mailboxRoutes` with no `stepUp`
   * option, which is why it is the single thing this pane can change on a hosted account. It goes
   * down the pipe like every other request this window makes; the engine's proxy relays it with
   * the install's bearer. The webview opens nothing.
   */
  it("Sync now round-trips over the bridge and re-reads the shared facts", async () => {
    const el = await render("cloud");
    await act(async () => { buttonSaying(el, "Sync now")!.click(); });

    expect(bridged).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
    // The strip at the foot of the rail reads the same route on a slower clock; the pane pushes it.
    expect(refreshed).toBe(1);
    // The row says what it did, and cannot be pressed again while it is pending.
    expect(buttonSaying(el, "Sync queued")?.disabled).toBe(true);
    // …and NOTHING left the webview to do it. The command channel was never touched.
    expect(invoked).toEqual([]);
  });

  it("a refused resync says the ENGINE'S sentence and lets the row be pressed again", async () => {
    // The offline refusal, which is the one that actually happens: writes are paused, reads keep
    // serving. A second taxonomy composed in the pane is how somebody offline is told their
    // mailbox is broken, so the message is carried out of the body untouched.
    bridgeReply = () =>
      new Response(
        JSON.stringify({ error: { code: "offline_read_only", message: "this install is offline" } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    const el = await render("cloud");
    await act(async () => { buttonSaying(el, "Sync now")!.click(); });

    expect(el.textContent ?? "").toContain("this install is offline");
    // A row left disabled after a refusal is a control nobody can retry.
    expect(buttonSaying(el, "Sync now")?.disabled).toBe(false);
    expect(refreshed).toBe(0);
  });

  it("a DISCONNECTED mailbox is not offered a resync", async () => {
    // Nothing is opening it, so a pass over it is not a thing that can be asked for.
    FACTS = [{ ...MAILBOX, status: "disabled", disabledReason: null }];
    const el = await render("cloud");
    expect(buttonSaying(el, "Sync now")).toBeNull();
    expect(el.textContent ?? "").toContain("Disconnected");
  });

  it("says nothing at all until the engine has answered", async () => {
    // `null` is "we could not ask", never "there are none" — the distinction the probe is written
    // to preserve. Neither the empty-state sentence nor the hand-off may appear here.
    FACTS = null;
    const el = await render("cloud");
    const text = el.textContent ?? "";
    expect(text).toContain("Asking the mail engine");
    expect(text).not.toContain("Mailboxes are managed in ohmail on the web");
    expect(openButton(el)).toBeNull();
  });
});

describe("the desktop mailbox pane on the standalone door", () => {
  it("is untouched: the list, the local heading, and NO hand-off to a website", async () => {
    const el = await render("local");
    const text = el.textContent ?? "";

    expect(text).toContain("someone@example.test");
    expect(text).toContain("Local mailboxes on this computer");

    // A standalone install has no ohmail account. Sending it to a page it cannot sign in to would
    // be worse than saying nothing, and its mailbox is edited on this machine — the door chooser
    // writes it through the shell and sends the password over this same bridge, with no factor and
    // no server involved.
    expect(text).not.toContain("Mailboxes are managed in ohmail on the web");
    expect(openButton(el)).toBeNull();
  });

  it("keeps the resync, which the local engine serves out of its own route table", async () => {
    const el = await render("local");
    await act(async () => { buttonSaying(el, "Sync now")!.click(); });
    expect(bridged).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
    expect(invoked).toEqual([]);
  });

  it("keeps its own empty state, which names the local way to fix it", async () => {
    FACTS = [];
    const text = (await render("local")).textContent ?? "";
    expect(text).toContain("Desktop settings pane");
  });

  it("an install that has not chosen a door yet is treated as standalone, not hosted", async () => {
    // `door` is `status?.mode ?? null`. Only the string "cloud" earns the hand-off; anything else
    // — null, an unset mode, a mode a newer engine invented — must not put a link to a hosted
    // account in front of somebody who may not have one.
    const el = await render(null);
    expect(el.textContent ?? "").not.toContain("Mailboxes are managed in ohmail on the web");
    expect(openButton(el)).toBeNull();
  });
});
