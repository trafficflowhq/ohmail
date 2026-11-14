/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * SETTINGS → MAILBOXES AND A HOME MAIL SERVER (R23-07).
 *
 * With the IMAP consent ticked, a server whose SMTP half has no TLS answered the same IMAP sentence
 * under the ticked box, and no such server could connect: the pane had no SMTP line at all. Each
 * refused protocol now opens its own line, the sentence names the protocol, and each consent rides
 * only its own block. And "Test connection" on a stale second factor asks for the factor in place
 * instead of printing the server's "recent two-factor authentication required".
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const copy = messages.mailboxes as unknown as Record<string, string>;
const picker = messages.providerPicker as unknown as Record<string, string>;
const onb = messages.onboarding as unknown as Record<string, string>;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null,
  continuesAtFolder: null, settled: true, owed: false,
};

const healthy = {
  subscription: {
    plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
    currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
  },
  balance: 0,
  plans: {},
  entitlements: { mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active" },
} as unknown as SubscriptionStatus;

/** `mock`-prefixed: `vi.mock`'s factory is hoisted above the imports. Each call takes the next answer. */
let mockCreates: unknown[] = [];
let mockCreated: Array<{ imap: Record<string, unknown>; smtp: Record<string, unknown> }> = [];
let mockProbes: unknown[] = [];
let mockProbeCalls = 0;
let mockProbed: Array<{ imap: Record<string, unknown> }> = [];
let mockStepUps = 0;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, twofaEnrolled: { webauthn: false, totp: true } },
        scope: "full",
      }),
      login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: async () => undefined,
      stepUpTotp: async () => { mockStepUps += 1; },
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: [] as MailboxDTO[] }),
      probe: async (body: { imap: Record<string, unknown> }) => {
        mockProbeCalls += 1;
        mockProbed.push(body);
        const next = mockProbes.shift();
        if (next) throw next;
        return { host: "mail.home.arpa", user: "person@example.test", folders: 7 };
      },
      create: async (body: { imap: Record<string, unknown>; smtp: Record<string, unknown> }) => {
        mockCreated.push(body);
        const next = mockCreates.shift();
        if (next) throw next;
        return { id: "mb1" };
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => { /* nothing to refresh here */ } }),
}));

const noTls = (transport: "imap" | "smtp", plaintext: "offered" | "not_private"): ApiError =>
  new ApiError(400, "mailbox_probe_failed", "server sentence", {
    reason: "tls", transport, tls: { kind: "tls_unavailable", plaintext },
  });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}
async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}
async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field this walk needs is not on screen").toBeTruthy();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  await act(async () => { el!.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}
function press(el: HTMLElement, prefix: string): HTMLElement {
  const hits = [...el.querySelectorAll("button, a")].filter((n) => (n.textContent ?? "").trim().startsWith(prefix));
  expect(hits.length, `"${prefix}" matched ${hits.length} controls, not one`).toBe(1);
  return hits[0] as HTMLElement;
}

/** The connect form typed; the incoming host is `mail.home.arpa`, the outgoing one `outgoing`. */
async function typedForm(outgoing = "smtp.home.arpa"): Promise<HTMLDivElement> {
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
  });
  await settle();
  await click(press(host, copy.connect!));
  await click(press(host, picker.otherLabel!));
  await typeInto(host.querySelector("#mb-address"), "person@example.test");
  await typeInto(host.querySelector("#mb-imap"), "mail.home.arpa");
  await typeInto(host.querySelector("#mb-smtp"), outgoing);
  await typeInto(host.querySelector("#mb-pass"), "app-password-fixture");
  return host;
}

/** Submit the typed form and answer whatever confirmation stands between it and the create. */
async function connectOnce(el: HTMLElement): Promise<void> {
  await submit(el.querySelector("#mb-address")!.closest("form"));
  if (el.querySelector("#mb-acct-pw")) {
    await typeInto(el.querySelector("#mb-acct-pw"), "account-password");
    await submit(el.querySelector("form.acct-confirm"));
  }
  if (el.querySelector("#mb-code")) {
    await typeInto(el.querySelector("#mb-code"), "123456");
    await submit(el.querySelector("#mb-code")!.closest("form"));
  }
}

/** The consent line for a label, or `null` when it is not offered. */
function line(el: HTMLElement, label: string): HTMLInputElement | null {
  const row = [...el.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(label));
  return row?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

beforeEach(() => {
  mockCreates = []; mockCreated = []; mockProbes = []; mockProbeCalls = 0; mockStepUps = 0; mockProbed = [];
});
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
});

describe("Settings → Mailboxes, a home server without TLS on either half", () => {
  it("each refused protocol opens its own line, and each consent rides only its own block", async () => {
    mockCreates = [noTls("imap", "offered"), noTls("smtp", "offered")];
    const el = await typedForm();

    await connectOnce(el);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      copy.probe_tls_unavailable!.replace("{protocol}", "IMAP"));
    expect(line(el, copy.insecureConsentLabel!), "no IMAP line after the IMAP refusal").not.toBeNull();
    expect(line(el, copy.insecureConsentLabelSmtp!), "an SMTP line before SMTP refused").toBeNull();

    await click(line(el, copy.insecureConsentLabel!)!);
    await connectOnce(el);
    expect(mockCreated[1]!.imap.allowInsecure).toBe(true);
    expect(mockCreated[1]!.smtp.allowInsecure, "the IMAP tick reached the SMTP block").toBeUndefined();
    // The refusal names the protocol that refused, and does not read as the IMAP one.
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      copy.probe_tls_unavailable!.replace("{protocol}", "SMTP"));
    expect(line(el, copy.insecureConsentLabel!)!.checked).toBe(true);

    await click(line(el, copy.insecureConsentLabelSmtp!)!);
    await connectOnce(el);
    expect(mockCreated[2]!.imap.allowInsecure).toBe(true);
    expect(mockCreated[2]!.smtp.allowInsecure).toBe(true);
  });

  /* ONE SERVER ON BOTH LEGS, ONE CONSENT: the line the refusal opens names both servers, and its tick
     claims both blocks, each re-proved by its own probe. */
  it("one host on both legs: one line for both, and its tick claims both blocks", async () => {
    mockCreates = [noTls("imap", "offered")];
    const el = await typedForm("mail.home.arpa");
    await connectOnce(el);
    expect(line(el, copy.insecureConsentLabelBoth!), "no line for the one server").not.toBeNull();
    expect(line(el, copy.insecureConsentLabel!), "a line per protocol over one server").toBeNull();
    expect(line(el, copy.insecureConsentLabelSmtp!)).toBeNull();
    await click(line(el, copy.insecureConsentLabelBoth!)!);
    await connectOnce(el);
    expect([mockCreated[1]!.imap.allowInsecure, mockCreated[1]!.smtp.allowInsecure]).toEqual([true, true]);
  });

  it("a server not on the person's network gets no line, and the sentence says why", async () => {
    mockCreates = [noTls("smtp", "not_private")];
    const el = await typedForm();
    await connectOnce(el);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      copy.probe_tls_unavailable_public!.replace("{protocol}", "SMTP"));
    expect(line(el, copy.insecureConsentLabel!)).toBeNull();
    expect(line(el, copy.insecureConsentLabelSmtp!)).toBeNull();
  });
});

describe("Test connection on a home server without TLS", () => {
  it("says there is no encryption, not that a certificate was refused, and offers the same line", async () => {
    mockProbes = [noTls("imap", "offered")];
    const el = await typedForm();
    await click(press(el, onb.test!));
    expect(el.querySelector(".set-verdict.bad")?.textContent).toContain(
      copy.probe_tls_unavailable!.replace("{protocol}", "IMAP"));
    expect(el.textContent).not.toContain("certificate was refused");
    // Ticking the line clears the verdict it answered, so the press is a fresh test.
    await click(line(el, copy.insecureConsentLabel!)!);
    await click(press(el, onb.test!));
    expect(mockProbed[1]!.imap.allowInsecure, "the test did not dial what the connect would").toBe(true);
    expect(el.querySelector(".set-verdict.ok")).not.toBeNull();
  });
});

describe("Test connection on a stale second factor (R23-07)", () => {
  it("asks for the factor in place, and the verified factor runs the test once", async () => {
    mockProbes = [new ApiError(403, "step_up_required", "recent two-factor authentication required")];
    const el = await typedForm();
    await click(press(el, onb.test!));
    expect(el.querySelector('[data-testid="step-up-prompt"]'), "no step-up prompt after the test was refused").not.toBeNull();
    expect(el.textContent).not.toContain("recent two-factor authentication required");

    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    expect(mockStepUps).toBe(1);
    expect(mockProbeCalls, "the test did not run again after the factor").toBe(2);
    expect(el.querySelector('[data-testid="step-up-prompt"]')).toBeNull();
    expect(el.querySelector(".set-verdict.ok")).not.toBeNull();
  });

  it("a second refusal after a verified factor is said, never asked again", async () => {
    const stale = () => new ApiError(403, "step_up_required", "recent two-factor authentication required");
    mockProbes = [stale(), stale()];
    const el = await typedForm();
    await click(press(el, onb.test!));
    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    expect(el.querySelector('[data-testid="step-up-prompt"]')).toBeNull();
    expect(el.querySelector(".set-verdict.bad")?.textContent).toContain(messages.devices.stepUpExpired);
  });
});
