/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { ApiError, messageOf, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";
import { launchRefused } from "@trafficflow/services/mail";

/**
 * GMAIL'S REFUSED SIGN-IN SAYS WHY, AND THE NOTE IS THERE BEFORE THE PRESS — on every web form.
 *
 * A Reddit user was stuck on "the mail server refused the password" with a Google password in the
 * field. The service now stamps `details.authHint` on Google's refusals (`launchRefused`, the real
 * refusal builder, makes each one here); the Settings pane (connect, Test, edit), /join and the
 * first-run form say Google's sentence for it, with the 2-Step Verification and App Passwords links
 * under the two password kinds. No hint, or a word outside the set, is the generic sentence. /join
 * has its own file (`gmail-refusal-join.test.tsx`): it runs on the real client over a fetch double.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const M = en.mailboxes as unknown as Record<string, string>;
const P = en.providerPicker as unknown as Record<string, string>;
const HINTS = ["app_password_required", "invalid", "web_login", "imap_disabled"] as const;
const LINKS = { prereq: "https://myaccount.google.com/signinoptions/twosv", help: "https://myaccount.google.com/apppasswords" };

/** The refusal the API sends for a hint, built by the service's own builder, as the client receives it. */
const refusalFor = (hint?: string): ApiError => {
  const r = launchRefused("auth", false, hint as never) as unknown as { httpStatus: number; code: string; message: string; details: unknown };
  return new ApiError(r.httpStatus, r.code, r.message, r.details);
};
const hrefs = (el: Element): string[] => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null,
  continuesAtFolder: null, settled: true, owed: false,
};
const healthy = {
  subscription: { plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500, currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null },
  balance: 0, plans: {},
  entitlements: { mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active" },
} as unknown as SubscriptionStatus;

let mockThrows: unknown = null;
let mockListed: MailboxDTO[] = [];
vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: { session: async () => ({ user: { email: "person@example.test", emailVerified: true }, scope: "full" }) },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      resync: async () => undefined,
      probe: async () => { if (mockThrows) throw mockThrows; return { host: "imap.gmail.com", user: "u", folders: 3 }; },
      create: async () => { if (mockThrows) throw mockThrows; return mockListed[0]; },
      update: async () => { if (mockThrows) throw mockThrows; return mockListed[0]; },
    },
  };
});
vi.mock("../app/shell/MailStateProvider", () => ({ useMailState: () => ({ state: QUIET, refresh: () => {} }) }));

const roots: Root[] = [];
beforeEach(() => { mockThrows = null; mockListed = []; });
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

const settle = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }); };
async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: node }));
  });
  await settle();
  return el;
}
async function click(el: Element | null | undefined): Promise<void> {
  expect(el, "a control this walk needs is not on screen").toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field this walk needs is not on screen").toBeTruthy();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  await act(async () => { el!.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}
const startingWith = (el: HTMLElement, text: string, sel = "button, a, [role=radio]"): HTMLElement | undefined =>
  [...el.querySelectorAll<HTMLElement>(sel)].find((n) => (n.textContent ?? "").trim().startsWith(text));

/* ── Settings → Mailboxes ─────────────────────────────────────────────────────────────── */

async function pane(...items: MailboxDTO[]): Promise<HTMLDivElement> {
  mockListed = items;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  return render(h(MailboxSection));
}
async function gmailForm(): Promise<HTMLDivElement> {
  const el = await pane();
  await click(startingWith(el, M.connect!));
  await click(startingWith(el, "Gmail", "[role=radio]"));
  await typeInto(el.querySelector("#mb-address"), "someone@gmail.test");
  await typeInto(el.querySelector("#mb-pass"), "the-google-password");
  return el;
}
const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "gmail", address: "someone@example.test", displayName: null, status: "connected",
  lastSyncAt: "2026-10-20T11:00:00.000Z", createdAt: "2026-10-20T10:00:00.000Z", ...over,
} as MailboxDTO);

describe("Settings → Mailboxes", () => {
  it("the Gmail note says App Password, its two links, before any press", async () => {
    const el = await gmailForm();
    expect(el.textContent).toContain(P.note_gmail);
    expect(hrefs(el)).toEqual(expect.arrayContaining([LINKS.prereq, LINKS.help]));
  });

  for (const hint of HINTS) {
    it(`connect and Test, ${hint}: Google's sentence`, async () => {
      mockThrows = refusalFor(hint);
      const el = await gmailForm();
      await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      await settle();
      const alert = el.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe(M[`probe_auth_gmail_${hint}`]);
      const linked = hint === "app_password_required" || hint === "invalid";
      // The links under the refusal, besides the note's own pair.
      expect(hrefs(el).filter((u) => u === LINKS.help).length, hint).toBe(linked ? 2 : 1);

      await click(startingWith(el, en.onboarding.test!));
      const verdict = el.querySelector(".set-verdict.bad");
      expect(verdict?.textContent).toContain(M[`probe_auth_gmail_${hint}`]);
      expect(hrefs(verdict!).length, hint).toBe(linked ? 2 : 0);
    });
  }

  it("control: no hint and an unknown hint are the generic sentence, with no links", async () => {
    for (const thrown of [refusalFor(), new ApiError(400, "mailbox_probe_failed", "x", { reason: "auth", transport: "imap", authHint: "toString" })]) {
      mockThrows = thrown;
      const el = await gmailForm();
      await click(startingWith(el, en.onboarding.test!));
      const verdict = el.querySelector(".set-verdict.bad");
      expect(verdict?.textContent).toContain(M.probe_auth);
      expect(hrefs(verdict!)).toEqual([]);
      await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
      document.body.innerHTML = "";
    }
  });

  it("edit: a Gmail row asks for a new App Password, and a refused one says Google's sentence", async () => {
    mockThrows = refusalFor("invalid");
    const el = await pane(dto());
    await click(startingWith(el, M.edit!));
    expect(el.textContent).toContain(M.editIntro_gmail);
    await typeInto(el.querySelector("#mb-edit-pass"), "old-app-password");
    await act(async () => { el.querySelector("form.acct-confirm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(el.textContent).toContain(M.probe_auth_gmail_invalid);
  });

  it("the row: a Gmail mailbox whose password stops working says a changed Google password ends it", async () => {
    const el = await pane(dto({ status: "error", errorCode: "auth" } as Partial<MailboxDTO>));
    expect(el.textContent).toContain(M.err_auth_gmail);
  });

  it("control: another provider's row and edit say what they said", async () => {
    const el = await pane(dto({ provider: "icloud", address: "someone@example.test", status: "error", errorCode: "auth" } as Partial<MailboxDTO>));
    expect(el.textContent).toContain(M.err_auth);
    expect(el.textContent).not.toContain(M.err_auth_gmail);
    await click(startingWith(el, M.edit!));
    expect(el.textContent).toContain(M.editIntro);
    expect(el.textContent).not.toContain(M.editIntro_gmail);
  });
});

/* ── The first-run form ───────────────────────────────────────────────────────────────── */

describe("the first-run mailbox form", () => {
  const facts: OnboardingFacts = {
    door: "cloud", mailbox: null, account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" }, ai: "on", queuedSenders: 0,
  };
  async function firstRun(probe: FirstRunHost["probe"]): Promise<HTMLDivElement> {
    const { FirstRun } = await import("../app/shell/FirstRun");
    const { KeymapProvider } = await import("../app/shell/keymap");
    const { probeReasonOf } = await import("../app/shell/probe-refusal");
    const host = {
      door: "cloud", ai: "on", probe,
      connect: async () => ({ id: "mb-2" }), organize: async () => "stored",
      complete: async () => {}, setAiEnabled: async () => {},
      probeReason: probeReasonOf, probeMessage: (err: unknown) => messageOf(err), plaintextOffer: () => null,
    } as unknown as FirstRunHost;
    return render(h(KeymapProvider, {
      children: h(FirstRun, {
        host, facts, onRefresh: () => {}, onLeave: () => {}, add: true,
        pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: null,
      }),
    }));
  }
  const fill = async (el: HTMLElement): Promise<void> => {
    await typeInto(el.querySelector("input[id$='-address']"), "someone@gmail.test");
    await typeInto(el.querySelector("input[id$='-pass']"), "the-google-password");
  };

  it("Gmail is pre-selected, and its note and links are on screen before the press", async () => {
    const el = await firstRun(async () => ({ host: "imap.gmail.com", user: "u", folders: 1 }));
    expect(el.querySelector<HTMLInputElement>('input[type="radio"][value="gmail"]')?.checked).toBe(true);
    expect(el.textContent).toContain(P.note_gmail);
    expect(hrefs(el)).toEqual(expect.arrayContaining([LINKS.prereq, LINKS.help]));
  });

  for (const hint of HINTS) {
    it(`Test, ${hint}: Google's sentence`, async () => {
      const el = await firstRun(async () => { throw refusalFor(hint); });
      await fill(el);
      await click(startingWith(el, "Test connection"));
      const verdict = el.querySelector(".set-verdict.bad");
      expect(verdict?.textContent).toContain(M[`probe_auth_gmail_${hint}`]);
      expect(hrefs(verdict!).length, hint).toBe(hint === "app_password_required" || hint === "invalid" ? 2 : 0);
    });
  }

  it("control: no hint and an unknown hint are the generic sentence", async () => {
    for (const thrown of [refusalFor(), new ApiError(400, "mailbox_probe_failed", "x", { reason: "auth", transport: "imap", authHint: "constructor" })]) {
      const el = await firstRun(async () => { throw thrown; });
      await fill(el);
      await click(startingWith(el, "Test connection"));
      expect(el.querySelector(".set-verdict.bad")?.textContent).toContain(M.probe_auth);
      await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
      document.body.innerHTML = "";
    }
  });
});
