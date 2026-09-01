/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * ═══ "ORGANIZE FROM THIS MACHINE" — THE EXIT FROM A STAND-DOWN ════════════════════════════
 *
 * `QAR-DESKTOP-CANNOT-RECLAIM-MAILBOX`. Measured on the released 0.13.2 AppImage against a real
 * mailbox whose `ohmail/_meta` carried a 25-minute-stale local claim: the install stood down
 * (`verdict=available`, `organized_elsewhere:local`, `heldBy=zorin-9950`) and had **no way back at
 * all**. Three exits were walked and all three are closed:
 *
 *  1. This pane rendered NO control on a `disabled` row.
 *  2. The remedy the pane's own comment named — reconnect the address — goes through the door
 *     chooser and is refused with *"This mailbox is disconnected. Reconnect it before setting new
 *     credentials."*, whose own invariant is that a disabled mailbox holds no credential. The
 *     instruction was circular.
 *  3. The authorized takeover existed on the Cloud webapp only; `en.json` carried no takeover
 *     string for this surface at all.
 *
 * The asymmetry was measured live in one mailbox inside ten minutes: at 15:05 the desktop could
 * not take the stale claim; by 15:14 `ohmail-cloud:production` had. Retire a machine, install on
 * another, and that mailbox could never be organized again without deleting a message from an IMAP
 * folder by hand.
 *
 * `verdict=available` is NOT the defect and is not changed: becoming an organizer always requires
 * an explicit human action, which is exactly why a crashed machine's mailbox is not seized. What
 * was missing is the action. This file is the assertion that it is on screen, that it is offered
 * for a STAND-DOWN and not for a removal, that it is the local door's alone, and that it says what
 * actually has to happen next.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop `!cloud` from the control's guard         → the hosted case goes red (a takeover offered
 *    on a mirror this install does not own, whose route the hosted door does not even serve);
 *  · drop `&& shown.disabledReason`                 → the removal case goes red, which is the one
 *    that matters: a removal is a tombstone and offering to take it over resurrects a mailbox
 *    somebody deliberately took off this machine;
 *  · post to `/mailboxes/:id/takeover` instead      → the route case goes red (that is the
 *    ACCOUNT's ceremony; this door's authority is the machine's own login).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let FACTS: MailboxFacts[] | null = null;
let refreshed = 0;

vi.mock("../../webapp/app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: { key: "quiet", clock: false, settled: true },
    mailboxes: FACTS,
    mirrored: 0,
    freshness: { state: "current" },
    refresh: () => { refreshed += 1; },
  }),
}));

/** Every request the pane put down the pipe, in order — the route is half of what is under test. */
let bridged: { url: string; method: string; body?: string }[] = [];
let bridgeReply: () => Response = () =>
  new Response(JSON.stringify({ outcome: "authorized", previousReason: "organized_elsewhere:local" }),
    { status: 200, headers: { "content-type": "application/json" } });

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async (url: string, init?: { method?: string; body?: string }) => {
    bridged.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
    return bridgeReply();
  },
}));

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: unknown, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/** A mailbox this install stood down from — `disabled` WITH a reason, which is the pause. */
const STOOD_DOWN: MailboxFacts = {
  id: "mbx-stood-down",
  address: "owner@example.test",
  status: "disabled",
  errorCode: null,
  disabledReason: "organized_elsewhere:local",
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-09-01T13:05:00.000Z",
  initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
};

/** The other `disabled`: a REMOVAL. Same status, different fact, and the reason is what says so. */
const REMOVED: MailboxFacts = { ...STOOD_DOWN, id: "mbx-removed", disabledReason: null };

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(door: string | null): Promise<HTMLElement> {
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

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label)) ?? null
  );
}

const organizeButton = (el: HTMLElement) => buttonSaying(el, "Organize from this machine");

beforeEach(() => {
  FACTS = [STOOD_DOWN];
  refreshed = 0;
  bridged = [];
  bridgeReply = () =>
    new Response(JSON.stringify({ outcome: "authorized", previousReason: "organized_elsewhere:local" }),
      { status: 200, headers: { "content-type": "application/json" } });
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async () => null,
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

describe("a stood-down desktop install can ask for its mailbox back", () => {
  it("offers the action on the stood-down row, and the row still says what happened", async () => {
    const el = await render(null);
    expect(el.textContent).toContain("owner@example.test");
    // The state sentence is unchanged — the control is added beside the diagnosis, not instead
    // of it, so the person can still tell WHY before deciding.
    expect(el.textContent).toContain("Handed over to another install");
    expect(organizeButton(el), "a stood-down row still offers nothing to press").not.toBeNull();
  });

  it("pressing it authorizes ONE becoming through the local door, and says what happens next", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });

    // THE ROUTE. The local door's own action, keyed on the mailbox id — not the account's
    // `POST /mailboxes/:id/takeover`, which is a different ceremony with a different authority
    // and is not served on this door at all.
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.url).toBe("/local/organizer/takeover");
    expect(bridged[0]!.method).toBe("POST");
    expect(JSON.parse(bridged[0]!.body!)).toEqual({ mailboxId: "mbx-stood-down" });

    // THE SENTENCE. It is an instruction, not a confirmation: the stamp is durable and the engine
    // reads the lease at launch, so the mailbox moves on the next start and not on this press.
    // And it says the honest caveat — an organizer still renewing keeps the mailbox.
    const text = el.textContent ?? "";
    expect(text).toContain("Quit and reopen ohmail to organize this mailbox from this machine");
    expect(text).toContain("If another install is still active, it keeps the mailbox");

    // The row's own state moved, so the pane re-reads rather than keeping the stand-down on screen.
    expect(refreshed).toBe(1);
    // And it debounces: the authorization is one-shot and a second press is not a second becoming.
    expect(organizeButton(el)!.disabled).toBe(true);
  });

  it("quotes the engine's OWN answer when nothing was written", async () => {
    // `already_organizing`, `removed` and `no_mailbox` are answers about the row rather than
    // refusals of the request — the route returns 200 for all four — and each says its own true
    // thing rather than a generic success.
    bridgeReply = () =>
      new Response(JSON.stringify({ outcome: "already_organizing", previousReason: null }),
        { status: 200, headers: { "content-type": "application/json" } });
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    expect(el.textContent).toContain("This machine already organizes that mailbox");
    expect(el.textContent).not.toContain("Quit and reopen ohmail");
  });

  it("is NOT offered for a REMOVAL — same status, and the reason is the discriminator", async () => {
    FACTS = [REMOVED];
    const el = await render(null);
    expect(el.textContent).toContain("Disconnected");
    expect(organizeButton(el),
      "offering a takeover on a removal resurrects a mailbox somebody took off this machine")
      .toBeNull();
  });

  it("is NOT offered on the HOSTED door — the takeover there is the account's ceremony", async () => {
    const el = await render("cloud");
    expect(el.textContent).toContain("owner@example.test");
    expect(organizeButton(el),
      "the local takeover route is not served on the hosted door; a button for it would 404")
      .toBeNull();
  });

  it("a healthy row still gets Sync now and nothing else", async () => {
    FACTS = [{ ...STOOD_DOWN, id: "mbx-live", status: "connected", disabledReason: null }];
    const el = await render(null);
    expect(buttonSaying(el, "Sync now")).not.toBeNull();
    expect(organizeButton(el)).toBeNull();
  });
});
