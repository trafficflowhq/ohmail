/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, OrganizerPeek, SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A MAILBOX WHOSE ONLY ORGANIZER STOPPED IS ORGANIZED BY NOBODY, ON THE MAILBOXES PANE TOO.
 * Measured on a self-hosted rc: a reader row whose holder stopped renewing two days earlier read
 * "ohmail on your own machine has claimed this mailbox", and the takeover promised "That install
 * stops the next time it checks". The row and the takeover's effect line now ask the refusal's
 * decider (`holderIsLive`), and a live holder keeps both sentences — the controls below.
 */

const copy = en.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const QUIET = { mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null } } as unknown as MailState;
const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];
let mockPeek: OrganizerPeek = { state: "none", holders: [], unreadable: 0 };

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, accountId: "acc1" }, scope: "full",
      }),
    },
    billing: { subscription: async () => ({ entitlements: null, subscription: healthy }) },
    mailboxes: { list: async () => ({ items: mockListed }), organizer: async () => mockPeek },
  };
});
vi.mock("../app/shell/MailStateProvider", () => ({ useMailState: () => ({ state: QUIET, refresh: () => {} }) }));

/** A reader row whose holder is named; `organizerState` says whether it still renews. */
const reader = (state: "held" | "stopped"): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test", displayName: null, status: "connected",
  lastSyncAt: "2026-09-26T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "reader", organizerState: state,
  organizedBy: { kind: "local", name: "Studio laptop", since: "2026-09-01T08:00:00.000Z" },
  organizeConsentedAt: "2026-08-01T10:05:00.000Z", organizerReleasedAt: null,
} as MailboxDTO);

const peekOf = (active: boolean): OrganizerPeek => ({
  state: active ? "held" : "stopped", unreadable: 0,
  holders: [{ kind: "local", displayName: "Studio laptop", heartbeatAt: "2026-09-24T08:00:00.000Z", active }],
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
async function mount(locale: "en" | "de", row: MailboxDTO): Promise<HTMLDivElement> {
  await unmount();
  mockListed = [row];
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "en" ? en : de) as never, children: h(MailboxSection),
    }));
  });
  await settle();
  return host;
}
async function check(el: HTMLElement, label: string): Promise<void> {
  const b = [...el.querySelectorAll("button")].filter((n) => (n.textContent ?? "").trim() === label);
  expect(b.length, `exactly one "${label}"`).toBe(1);
  await act(async () => { b[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

beforeEach(() => { mockListed = []; mockPeek = { state: "none", holders: [], unreadable: 0 }; });
afterEach(async () => { await unmount(); });

describe("the row: a holder that stopped is nobody", () => {
  it("says nothing organizes the mailbox, in both languages, and never that the laptop claimed it", async () => {
    for (const [locale, c] of [["en", copy], ["de", copyDe]] as const) {
      const said = (await mount(locale, reader("stopped"))).textContent ?? "";
      expect(said, `${locale}: the lapsed sentence`).toContain(c.standDownLapsed!);
      expect(said, `${locale}: the lapsed way out`).toContain(c.standDownHowLapsed!);
      expect(said, `${locale}: a stopped laptop still reads as the claimant`).not.toContain(c.standDown_organized_elsewhere_local!);
      expect(said).not.toContain(c.standDownHow!);
    }
  });

  it("control — a holder that still renews keeps the claimed sentence", async () => {
    const said = (await mount("en", reader("held"))).textContent ?? "";
    expect(said).toContain(copy.standDown_organized_elsewhere_local!);
    expect(said).toContain(copy.standDownHow!);
    expect(said).not.toContain(copy.standDownLapsed!);
  });
});

describe("the takeover: a holder that stopped is promised nothing", () => {
  it("over a stopped holder the effect line says only what taking over does here", async () => {
    mockPeek = peekOf(false);
    const el = await mount("en", reader("stopped"));
    await check(el, copy.organizerCheck!);
    const said = el.textContent ?? "";
    expect(said).toContain(copy.organizerEffectLapsed!);
    expect(said, "a stopped install was promised it stops at its next check").not.toContain(copy.organizerEffect!);
  });

  it("control — over a live holder the effect line says it stops at its next check", async () => {
    mockPeek = peekOf(true);
    const el = await mount("en", reader("held"));
    await check(el, copy.organizerCheck!);
    const said = el.textContent ?? "";
    expect(said).toContain(copy.organizerEffect!);
    expect(said).not.toContain(copy.organizerEffectLapsed!);
  });
});
