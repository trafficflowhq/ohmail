/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * "Sync now" is a press, not a one-shot. `POST /mailboxes/:id/resync` answers 202 and nothing
 * else, so the queued mark means "a press this pane has made that has not been answered" and
 * BOTH answers end it. Nothing else writes it: a cycle nobody asked for may not take the
 * affordance away, so "syncing" is a state the row says rather than a lock on the control.
 *
 * Rationing the server is not this button's job — the engine already limits a forced dial.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, blockedReason: null, mailboxCount: 1, settled: true,
} as unknown as MailState;

/** What the pane is showing, and every resync it asked for. */
const served: { items: MailboxDTO[] } = { items: [] };
const resyncs: string[] = [];
/** Armed by the refusal case: what the next `resync` throws. */
let refuseWith: Error | null = null;
/** The shell strip's re-read, which the pane pushes after an accepted press. */
let mailStateRefreshes = 0;

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
  messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
  auth: {
    session: async () => ({
      user: { email: "owner@example.test", emailVerified: true }, scope: "full",
    }),
  },
  billing: {
    subscription: async () => ({
      subscription: {
        plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
        currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
      },
      balance: 0,
      plans: {},
      entitlements: {
        mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active",
      },
    }),
  },
  mailboxes: {
    list: async () => ({ items: served.items.map((m) => ({ ...m })) }),
    create: async () => served.items[0]!,
    resync: async (id: string) => {
      resyncs.push(id);
      if (refuseWith) {
        const err = refuseWith;
        refuseWith = null;
        throw err;
      }
    },
    oauthAvailability: async () => ({ available: false }),
  },
}));

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: QUIET,
    refresh: () => { mailStateRefreshes += 1; },
  }),
}));

const mailbox = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: "2026-09-10T09:00:00.000Z",
  ...over,
} as MailboxDTO);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function mount(): Promise<HTMLElement> {
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

/** Let the mount's effects and their microtasks land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

/** A button by its label, so a second control cannot be mistaken for the one under test. */
function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label)) ?? null
  );
}

const press = async (el: HTMLElement): Promise<void> => {
  const button = buttonSaying(el, "Sync now");
  if (!button) throw new Error("the pane is not offering Sync now on this row");
  await act(async () => { button.click(); });
  await settle();
};

beforeEach(() => {
  served.items = [mailbox()];
  resyncs.length = 0;
  refuseWith = null;
  mailStateRefreshes = 0;
});
afterEach(async () => { await unmount(); vi.useRealTimers(); });

describe("Sync now can be pressed again once the server has the press", () => {
  it("AN ACCEPTED PRESS leaves the control live, and a second press is delivered", async () => {
    const el = await mount();
    await press(el);

    expect(resyncs, "the first press never reached the server").toEqual(["mb1"]);
    expect(mailStateRefreshes, "the strip was not told").toBe(1);
    /* The row's own line, not the label: the label never changes here, so a check written
       against it could not fire. */
    expect(
      el.textContent ?? "",
      "the row is still saying the press is queued after the server answered it",
    ).not.toContain("Sync queued");
    expect(
      buttonSaying(el, "Sync now")?.disabled,
      "the button is still disabled after the server accepted the press, so this control can be "
      + "used once per visit to Settings",
    ).toBe(false);

    await press(el);
    expect(
      resyncs,
      "the second press never reached the server — the button was still marked from the first, "
      + "which makes this control one press per visit to Settings",
    ).toEqual(["mb1", "mb1"]);
  });

  it("A REFUSED PRESS says the server's sentence and still lets the row be pressed again", async () => {
    /* The arm the pane's comment already claimed, now watched. */
    refuseWith = Object.assign(new Error("this mailbox is not syncing right now"), {
      code: "sync_paused",
    });
    const el = await mount();
    await press(el);

    expect(el.textContent ?? "").toContain("this mailbox is not syncing right now");
    expect(buttonSaying(el, "Sync now")?.disabled).toBe(false);

    await press(el);
    expect(resyncs, "the retry after a refusal was swallowed").toEqual(["mb1", "mb1"]);
  });

  it("A MAILBOX MID-FIRST-SYNC still offers the press — syncing is a state, not a lock", async () => {
    /* `queued` is the ONLY thing that disables this control, and this case is what keeps a sync
       state from being wired into it. */
    served.items = [mailbox({ lastSyncAt: null })];
    const el = await mount();

    expect(el.textContent ?? "", "the fixture does not put the row mid-first-sync")
      .toContain("No mail yet");
    expect(
      buttonSaying(el, "Sync now")?.disabled,
      "a cycle nobody asked for took the control away",
    ).toBe(false);
  });
});
