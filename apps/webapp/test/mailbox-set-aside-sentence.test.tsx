/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THE MANAGED WEB SAYS WHAT THE DESKTOP AND PHONE SAY ABOUT A SET-ASIDE MESSAGE. A message the
 * server sends more of than its declared size allows is set aside and the mailbox goes on; a
 * message skipped in silence is one a person does not see. The real pane, mounted over a row
 * carrying the DTO's `setAside` count, with the zero and the absent row as the controls.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};
const listed: MailboxDTO[] = [];

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
  messageOf: (e: unknown) => String(e),
  auth: { session: async () => ({ user: { email: "owner@example.test", emailVerified: true }, scope: "full" }) },
  billing: {
    subscription: async () => ({
      subscription: {
        plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
        currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
      },
      balance: 0, plans: {},
      entitlements: { mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active" },
    }),
  },
  mailboxes: { list: async () => ({ items: listed }), create: async () => listed[0]!, resync: async () => undefined },
}));
vi.mock("../app/shell/MailStateProvider", () => ({ useMailState: () => ({ state: QUIET, refresh: () => {} }) }));

const dto = (over: Partial<MailboxDTO>): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: new Date().toISOString(),
  createdAt: new Date(Date.now() - 86_400_000).toISOString(), ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}
async function mount(item: MailboxDTO): Promise<string> {
  await unmount();
  listed.splice(0, listed.length, item);
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host.textContent ?? "";
}
afterEach(async () => { await unmount(); });

describe("the web's mailbox row and a set-aside message", () => {
  it("says one message was set aside, and how many when there are more", async () => {
    expect(await mount(dto({ setAside: 1 }))).toContain("One message could not be read and was set aside.");
    expect(await mount(dto({ setAside: 3 }))).toContain("3 messages could not be read and were set aside.");
  });

  it("CONTROL: says nothing at zero", async () => {
    expect(await mount(dto({ setAside: 0 }))).not.toContain("set aside");
  });

  it("CONTRACT: a server that predates the field is unknown, never zero — no line and no error", async () => {
    // The row exactly as an older server sends it: the key is absent, not zero.
    const older = dto({});
    expect("setAside" in older).toBe(false);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const text = await mount(older);
    expect(text, "the row did not render").toContain("person@example.test");
    expect(text).not.toContain("set aside");
    expect(errors, "the absent field raised an error").not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
