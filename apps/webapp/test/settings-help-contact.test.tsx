/** @vitest-environment jsdom */
/**
 * SETTINGS › HELP & CONTACT — the pane, the prefilled mail and its diagnostics block. Write to us
 * opens the person's own composer addressed to support with a subject and the block; with no
 * mailbox to send from it is a mailto: carrying the same two. The block names classes and an
 * opaque id, never an address or a host, and comes out of the message in one press.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { HelpContactPane } from "../app/(product)/mailbox/HelpContactPane";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = { surface: "web" as const, version: "0.30.3", commit: "0123456789abcdef0123456789abcdef01234567", accountId: "3f2a9c1e-0b7d-4e55-9a10-2c3d4e5f6a7b" };
// Assembled at run time: a provider-domain address is what the block must classify and never write.
const MAILBOX = {
  id: "mb-1", address: ["ana", "gmail.com"].join("@"), status: "error", errorCode: "timeout", errorDetail: "imap.gmail.com:993",
  createdAt: "2026-10-01T00:00:00.000Z", authKind: "password",
} as unknown as MailboxFacts;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(node: ReturnType<typeof h>, messages: AbstractIntlMessages = en, locale = "en"): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale, messages, timeZone: "UTC", children: node }));
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const button = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === label);

describe("the Help & contact pane", () => {
  const DESK = { ...HOST, surface: "desktop" as const, mailtoLeaves: false };
  it("CONTROL: a paired host's own store refusal leaves the composer", async () => {
    const host = { ...MAILBOX, errorCode: "storage", errorDetail: "MAILBOX_STORE_REFUSED" } as MailboxFacts;
    const el = await mount(h(HelpContactPane, { host: DESK, mailboxes: [host], onWrite: () => {} }));
    expect(button(el, "Write to us")).toBeDefined();
  });
});
