/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { MailboxDTO } from "../app/api-client";
import messages from "../messages/en.json";

const STORED = "sarada@xn--mller-kva.example";
const SHOWN = "sarada@müller.example";
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = React.act;
const roots: Root[] = [];
let host: HTMLDivElement | null = null;

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  host?.remove();
  host = null;
});

const listed: MailboxDTO[] = [];

vi.mock("../app/api-client", async (importOriginal) => {
  // The rendered shell reaches exports this test never stubs (for example `boundApiOwner`, read
  // when the page wires its connect and mailboxes calls), so keep the real module underneath and
  // override only the pieces this test drives.
  const actual = await importOriginal<typeof import("../app/api-client")>();
  return {
    ...actual,
    apiConfigured: () => true,
    // The Screener's refusal copy reads this constant to give an unreachable server its own
    // sentence; the value is asserted against the real export in `owner-marker-three-states`.
    OFFLINE_CODE: "network_unreachable",
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
    messageOf: (e: unknown) => String(e),
    auth: {
      session: async () => ({ user: { email: "owner@example.test", emailVerified: true }, scope: "full" }),
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
    mailboxes: { list: async () => ({ items: listed }), create: async () => listed[0]!, resync: async () => undefined },
  };
});

vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ohmail/app-logic/mail-state/mail-state-binding")>();
  return {
    ...actual,
    useMailState: () => ({
      state: { key: "quiet", clock: false, count: 0, blockedReason: null, mailboxCount: 1, settled: true },
      mailboxes: null,
      freshness: { state: "unknown", asOf: null },
      refresh: () => {},
    }),
  };
});

describe("ACCEPTANCE: the Settings → Mailboxes row", () => {
  it("names the connected mailbox readably, in the row and in its hover title", async () => {
    listed.splice(0, listed.length, {
      id: "mb1", provider: "imap", address: STORED, displayName: null,
      status: "connected", lastSyncAt: "2026-08-01T00:00:00.000Z",
    } as MailboxDTO);
    const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

    const row = host.querySelector<HTMLElement>(".mbx-addr");
    expect(row, "the pane rendered no mailbox row").not.toBeNull();
    expect(row!.textContent).toBe(SHOWN);
    expect(row!.getAttribute("title")).toBe(SHOWN);
  });
});
