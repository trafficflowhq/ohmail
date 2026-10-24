/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * A PAID RETURN TO THE WIZARD FOR AN ACCOUNT THAT ALREADY HAS A MAILBOX goes where the wizard's
 * own bootstrap sends an entitled account with one: the done step, never "Connect a mailbox".
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
/** The request's cookies as the server page reads them. */
let requestCookies: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name in requestCookies ? { value: requestCookies[name]! } : undefined) }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalFetch: typeof globalThis.fetch;
let accessReads = 0;
let mailboxItems: unknown[] = [];
/** A fault the mailbox read answers with, or `null` for the list. */
let mailboxFault: Response | null = null;
/** Set to hold the session read until the test lets it answer. */
let sessionGate: Promise<void> | null = null;
let sessionStatus = 200;
let paidFromStart = false;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const enrolled = {
  user: {
    userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
    emailVerified: true, twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
  },
  scope: "full",
};

const MAILBOX = {
  id: "mbx_1", address: "pat@example.invalid", provider: "imap", status: "connected",
  organizerRole: "reader", createdAt: "2026-09-10T00:00:00.000Z",
};

beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  accessReads = 0;
  mailboxItems = [MAILBOX];
  mailboxFault = null;
  sessionGate = null;
  sessionStatus = 200;
  paidFromStart = false;
  requestCookies = {};
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) return json({ error: { code: "refresh_missing", message: "none" } }, 401);
    if (url.includes("/auth/session")) {
      if (sessionGate) await sessionGate;
      return sessionStatus === 200 ? json(enrolled) : json({ error: { code: "unauthorized", message: "no" } }, sessionStatus);
    }
    if (url.includes("/account/access")) {
      accessReads += paidFromStart ? 2 : 1;
      // The bootstrap's read finds the account unpaid; every read after the return finds it paid.
      return json({ metered: true, canAddMailbox: accessReads > 1, mailboxes: accessReads > 1 ? 3 : 0 });
    }
    if (url.includes("/account/checkout/confirm")) return json({ state: "confirmed" });
    if (url.includes("/account/manage-link")) return json({ url: "https://account.example/m" });
    if (url.includes("/mailboxes")) return mailboxFault ? mailboxFault.clone() : json({ items: mailboxItems });
    return json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function mountReturn(props: Record<string, unknown> = { billingReturn: "success" }): Promise<HTMLElement> {
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(JoinScreen, { initialCode: "", publicSignup: false, ...props }),
    }));
    await Promise.resolve();
  });
  for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); });
  return host;
}

describe("the paid return for an account that already has a mailbox", () => {
  it("lands on the done step with the mailbox named, never the connect step", async () => {
    const c = await mountReturn();
    expect(accessReads, "the return's poll never read access, so this proves nothing").toBeGreaterThan(1);
    expect(c.textContent).not.toContain(messages.join.step_mailbox_lead);
    expect(c.textContent).toContain("pat@example.invalid");
  });

  it("CONTROL: an account with no mailbox is still asked to connect one", async () => {
    mailboxItems = [];
    const c = await mountReturn();
    expect(accessReads).toBeGreaterThan(1);
    expect(c.textContent).toContain(messages.join.step_mailbox_lead);
  });
});

/**
 * THE SHELL SENDS A SIGNED-IN ACCOUNT WITH NO MAILBOX HERE, as a page load. Until the server has said which
 * step it is on, the page shows a wait, never the sign-up form; a fault is a fault, never "you have no account".
 */
describe("a signed-in account resuming setup", () => {
  const signUpShown = (c: HTMLElement): boolean =>
    c.querySelector("#join-email") !== null || c.querySelector("#join-code") !== null
    || c.querySelector("h1")?.textContent === messages.join.step_account_title;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); });
  };

  async function mountPage(): Promise<HTMLElement> {
    const { default: JoinPage } = await import("../app/(product)/join/page.js");
    const page = await JoinPage({ searchParams: Promise.resolve({}) });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: page }));
    });
    return host;
  }

  beforeEach(() => {
    requestCookies = { tf_owner: "acct_A" };
    paidFromStart = true;
    mailboxItems = [];
  });

  it("shows a wait, not the sign-up form, while the session read is out", async () => {
    let release!: () => void;
    sessionGate = new Promise<void>((r) => { release = r; });
    const c = await mountPage();
    expect(signUpShown(c)).toBe(false);
    expect(c.querySelector("h1")?.textContent).toBe(messages.onboarding.resumeCheckingTitle);
    await act(async () => { release(); });
    await settle();
    expect(c.textContent).toContain(messages.join.step_mailbox_lead);
  });

  it("a 503 on the mailbox read is a retryable fault, never the sign-up form", async () => {
    mailboxFault = json({ error: { code: "db_busy", message: "busy" } }, 503);
    const c = await mountPage();
    await settle();
    expect(signUpShown(c)).toBe(false);
    expect(c.querySelector("h1")?.textContent).toBe(messages.onboarding.resumeUnreachableTitle);
    expect(c.querySelector('a[href="/"]')?.textContent).toBe(messages.onboarding.resumeLeave);
    mailboxFault = null;
    const retry = [...c.querySelectorAll("button")].find((b) => b.textContent === messages.onboarding.resumeRetry);
    await act(async () => { retry!.click(); });
    await settle();
    expect(c.textContent).toContain(messages.join.step_mailbox_lead);
  });

  it("CONTROL: a request with no owner marker and no session is the invite step at once", async () => {
    requestCookies = {};
    sessionStatus = 401;
    const c = await mountPage();
    expect(c.querySelector("#join-code")).not.toBeNull();
    await settle();
    expect(c.querySelector("#join-code")).not.toBeNull();
  });
});
