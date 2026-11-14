/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A MAILBOX WHOSE SERVER THIS DEPLOYMENT WILL NOT DIAL IS SAID AS THAT. The organizer's door refused
 * the address, or the port, before a socket existed, and wrote `connect` with the token beside it;
 * the row read `connect`'s "not available" about a server that may well answer, and sent the
 * person to look at the wrong thing. The detail token names the refusal; the strip reads the same key.
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
  subscription: { plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500, currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null },
  balance: 0, plans: {},
  entitlements: { mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active" },
} as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];
vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: { session: async () => ({ user: { email: "person@example.test", emailVerified: true }, scope: "full" }) },
    billing: { subscription: async () => healthy },
    mailboxes: { list: async () => ({ items: mockListed }), resync: async () => undefined },
  };
});
vi.mock("../app/shell/MailStateProvider", () => ({ useMailState: () => ({ state: QUIET, refresh: () => {} }) }));

const dto = (over: Partial<MailboxDTO>): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@home.example", displayName: null, status: "error",
  lastSyncAt: "2026-09-27T11:00:00.000Z", createdAt: "2026-09-20T10:00:00.000Z", ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
});

async function rowText(m: MailboxDTO): Promise<string> {
  mockListed = [m];
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) })); });
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
  return host.querySelector(".mbx-bad")?.textContent ?? "";
}

describe("a mailbox row refused by the deployment's dial door", () => {
  it("an address this deployment will not connect to is said as that", async () => {
    const said = await rowText(dto({ errorCode: "connect", errorDetail: "MAILBOX_HOST_REFUSED" }));
    expect(said, "the row says the server is not available about a refusal of ours").not.toBe(copy.err_connect);
    expect(said).toBe(copy.err_host_refused);
  });

  it("a port that carries no mail is said as that", async () => {
    const said = await rowText(dto({ errorCode: "connect", errorDetail: "MAILBOX_PORT_REFUSED" }));
    expect(said).not.toBe(copy.err_connect);
    expect(said).toBe(copy.err_port_refused);
  });

  it("the strip reads the same key", async () => {
    const { mailboxErrorKey } = await import("@ohmail/app-logic/mail-state/mailbox-error-key");
    expect(mailboxErrorKey("connect", "MAILBOX_HOST_REFUSED").key).toBe("err_host_refused");
    expect(mailboxErrorKey("connect", "MAILBOX_PORT_REFUSED").key).toBe("err_port_refused");
  });

  it("both catalogues carry both sentences", async () => {
    const de = (await import("../messages/de.json")).default.mailboxes as unknown as Record<string, string>;
    for (const key of ["err_host_refused", "err_port_refused"]) {
      expect(typeof copy[key], `en lacks ${key}`).toBe("string");
      expect(typeof de[key], `de lacks ${key}`).toBe("string");
    }
  });

  it("CONTROL: an ordinary connect failure keeps its own sentence", async () => {
    const said = await rowText(dto({ errorCode: "connect", errorDetail: "ECONNREFUSED" }));
    expect(said).toBe(copy.err_connect);
  });
});
