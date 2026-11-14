/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A MISTYPED MAIL SERVER IS ANSWERED IN A SENTENCE, ON THE SCREEN WHERE IT WAS TYPED.
 *
 * Measured on a self-hosted install: an unreachable IMAP host put the SSRF gate's own refusal,
 * parameter name and all, in this pane. The pane does not translate that class — the taxonomy it
 * keys on is the PROBE's, and a host refusal is not a member — so it renders the server's own
 * sentence, which is exactly the right behaviour once the server says a sentence. This is the
 * pane's half of that; `packages/api/test/probe-host-refusal.wprobe.test.ts` is the server's, and
 * it drives the classes through the real gate.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const copy = messages.mailboxes as unknown as Record<string, string>;
const picker = messages.providerPicker as unknown as Record<string, string>;
/* The connect form's own buttons live in the onboarding namespace — the same form serves /join. */
const onb = messages.onboarding as unknown as Record<string, string>;

/** What the API answers now — the mapped sentence, for the leg that was at fault. */
const SENTENCE = "That incoming (IMAP) server address could not be found. Check the host name for a typo.";
/** What it used to answer, and what may never appear on this screen again. */
const GATE_STRING = "u is not a permitted url: host did not resolve";

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null,
  continuesAtFolder: null, settled: true, owed: false,
};

const healthy: SubscriptionStatus = {
  subscription: {
    plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
    currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
  },
  balance: 0,
  plans: {},
  entitlements: {
    mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active",
  },
} as unknown as SubscriptionStatus;

/** `mock`-prefixed: `vi.mock`'s factory is hoisted above the imports. */
let mockProbeThrows: unknown = null;

vi.mock("../app/api-client", async () => {
  // The real module is spread so `ApiError` and `messageOf` stay genuine — `probeReasonOf`
  // decides on `err instanceof ApiError`, and a stand-in would make this path untestable.
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({ user: { email: "person@example.test", emailVerified: true }, scope: "full" }),
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: [] as MailboxDTO[] }),
      probe: async () => { if (mockProbeThrows) throw mockProbeThrows; return { verdict: "ok" }; },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => { /* nothing to refresh here */ } }),
}));

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

async function mount(): Promise<HTMLDivElement> {
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

/**
 * A control by the text it starts with, refusing an ambiguous match. A tile's accessible name is
 * its WHOLE text — label plus sub-label — so an exact match finds nothing and a loose one can
 * press the wrong tile.
 */
function press(el: HTMLElement, prefix: string): HTMLElement {
  const hits = [...el.querySelectorAll("button, a")]
    .filter((n) => (n.textContent ?? "").trim().startsWith(prefix));
  expect(hits.length, `"${prefix}" matched ${hits.length} controls, not one`).toBe(1);
  return hits[0] as HTMLElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field this walk needs is not on screen").toBeTruthy();
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}

/** Open the connect form on the generic IMAP arm and fill the three fields the test needs. */
async function toTypedForm(): Promise<HTMLDivElement> {
  const el = await mount();
  await click(press(el, copy.connect!));
  await click(press(el, picker.otherLabel!));
  await typeInto(el.querySelector("#mb-address"), "person@example.test");
  await typeInto(el.querySelector("#mb-imap"), "mail.typo.example");
  await typeInto(el.querySelector("#mb-pass"), "typed-secret");
  return el;
}

beforeEach(() => { mockProbeThrows = null; });
afterEach(async () => { await unmount(); });

describe("the Mailboxes pane renders the host refusal as a sentence", () => {
  it("a refused host puts the server's sentence on screen", async () => {
    mockProbeThrows = new ApiError(400, "validation_failed", SENTENCE);
    const el = await toTypedForm();
    await click(press(el, onb.test!));
    expect(el.textContent, "the refusal was not rendered at all").toContain(SENTENCE);
  });

  /**
   * ANTI-VACUITY. The arm above would pass on a pane that prints whatever the server sends, which
   * is precisely what it did before — so the case that matters is the OLD string, which this pane
   * would happily render again the day the mapping is removed. It is asserted absent here and
   * refused at the server, where the mapping lives.
   */
  it("and the gate's own string is not what the server sends any more", async () => {
    mockProbeThrows = new ApiError(400, "validation_failed", SENTENCE);
    const el = await toTypedForm();
    await click(press(el, onb.test!));
    expect(el.textContent).not.toContain("not a permitted url");
    expect(el.textContent).not.toContain(GATE_STRING);
  });

  /**
   * The probe TAXONOMY still owns its own sentences: a host refusal is not a member of it, and a
   * member must not be answered with the server's words. Both halves in one case, because the
   * pane decides between them with one expression.
   */
  it("a probe-taxonomy refusal still uses the pane's own copy", async () => {
    mockProbeThrows = new ApiError(400, "mailbox_probe_failed", "server sentence", { reason: "auth" });
    const el = await toTypedForm();
    await click(press(el, onb.test!));
    expect(el.textContent).toContain(copy.probe_auth!);
    expect(el.textContent).not.toContain("server sentence");
  });
});
