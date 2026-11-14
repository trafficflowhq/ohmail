/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A MAILBOX CONNECTED WITHOUT TLS WHOSE SERVER LEFT THE PERSON'S NETWORK IS SAID AS THAT. The dial
 * is refused before a socket exists, so the row's `connect` sentence ("not available") would send
 * somebody to look at a server that answers; the detail token names the refusal.
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

describe("a mailbox row refused for plaintext off the person's network", () => {
  it("says the server's address is no longer on the person's network", async () => {
    const said = await rowText(dto({ errorCode: "connect", errorDetail: "MAILBOX_PLAINTEXT_REFUSED" }));
    expect(said).toBe(copy.err_plaintext_refused);
  });

  it("any other connect failure keeps its own sentence", async () => {
    const said = await rowText(dto({ errorCode: "connect", errorDetail: "ECONNREFUSED" }));
    expect(said).toBe(copy.err_connect);
  });
});

/* THE DESKTOP'S OWN DOOR NAMES A STORED PASSWORD IT CANNOT USE (LOCAL-DOOR-CREDENTIAL-BLOCK-NOT-ON-
   THE-DTO): nothing was dialled, so `err_connect`'s "not available" is false. The detail is derived
   at read time by the local engine and never stored; the strip reads the same key. */
describe("a mailbox whose saved password this computer cannot use", () => {
  it("says the password could not be opened, never that the server is not available", async () => {
    const said = await rowText(dto({ errorCode: "connect", errorDetail: "MAILBOX_CREDENTIAL_UNREADABLE" }));
    expect(said).toBe(copy.err_credential_unreadable);
  });

  it("says the password belongs to another server", async () => {
    const said = await rowText(dto({ errorCode: "connect", errorDetail: "MAILBOX_CREDENTIAL_FOREIGN_HOST" }));
    expect(said).toBe(copy.err_credential_foreign_host);
  });

  it("CONTROL: a detail the reader does not know leaves the code's own key", async () => {
    const { mailboxErrorKey } = await import("@ohmail/app-logic/mail-state/mailbox-error-key");
    expect(mailboxErrorKey("connect", "constructor").key).toBe("err_connect");
    expect(mailboxErrorKey("connect", null).key).toBe("err_connect");
    expect(mailboxErrorKey(null, "MAILBOX_CREDENTIAL_UNREADABLE").key).toBe("err_credential_unreadable");
  });
});
