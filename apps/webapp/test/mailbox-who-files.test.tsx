/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * SETTINGS → MAILBOXES SAYS WHO FILES THE MAILBOX. On the web the organizer is the server the page
 * talks to — ohmail Cloud, or a self-hosted server — and the pane said "This computer files this
 * mailbox" and "This computer stops filing…", which reads as closing the laptop stopping the
 * filing. The role says THIS install files; the build says which install that is.
 *
 * Watched red at the base: every Cloud and server case read the computer sentence. The mutation
 * that reds them again is pointing the pane's filer back at "computer".
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = en.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;
const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

/** Which build the pane renders as — read at render time through the getter below. */
const build = vi.hoisted(() => ({ selfHost: false }));
vi.mock("../app/hello", async () => {
  const actual = await vi.importActual<typeof import("../app/hello")>("../app/hello");
  return {
    ...actual,
    get SELF_HOST_BUILD() { return build.selfHost; },
    serverHello: async () => null,
  };
});

let mockListed: MailboxDTO[] = [];
let releaseOutcome: "requested" | "not_organizing" = "requested";

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, accountId: "acc1" },
        scope: "full",
      }),
    },
    billing: { subscription: async () => ({ entitlements: null, subscription: healthy }) },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      organizer: async () => ({ holders: [], unreadable: 0 }),
      organize: async () => ({ outcome: "authorized" }),
      release: async () => ({ outcome: releaseOutcome }),
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

/** A mailbox this install organizes, consented, nothing pending. */
const organizing = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected",
  lastSyncAt: "2026-09-07T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  releaseRequestedAt: null,
  ...over,
} as MailboxDTO);

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

async function mount(locale: "en" | "de", ...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale,
      messages: (locale === "en" ? en : de) as never,
      children: h(MailboxSection),
    }));
  });
  await settle();
  return host;
}

const buttonExactly = (el: HTMLElement, label: string): HTMLButtonElement | null =>
  [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) ?? null;

async function press(b: HTMLButtonElement | null, what: string): Promise<void> {
  expect(b, `no "${what}" control on the row`).not.toBeNull();
  await act(async () => { b!.click(); });
  await settle();
}

/** The organizer block's own text — the part of the row that names who files the mailbox. */
const orgText = (el: HTMLElement): string => el.querySelector(".mbx-org")?.textContent ?? "";

beforeEach(() => { mockListed = []; releaseOutcome = "requested"; build.selfHost = false; });
afterEach(async () => { await unmount(); });

describe.each([
  { name: "ohmail Cloud (the managed build)", selfHost: false, arm: "Cloud" },
  { name: "a self-hosted server", selfHost: true, arm: "Server" },
])("on the web, $name files the mailbox — never this computer", ({ selfHost, arm }) => {
  beforeEach(() => { build.selfHost = selfHost; });

  it("the organizing row names it", async () => {
    const el = await mount("en", organizing());
    expect(orgText(el), "the row says the browser files the mailbox").not.toMatch(/this computer/i);
    expect(orgText(el)).toContain(copy[`stateOrganizing${arm}`]!);
  });

  it("the stop's explanation names it", async () => {
    const el = await mount("en", organizing());
    await press(buttonExactly(el, copy.stopOrganizingHandBack!), copy.stopOrganizingHandBack!);
    expect(orgText(el), "the stop says this computer stops filing").not.toMatch(/this computer/i);
    expect(orgText(el)).toContain(copy[`stopOrganizingWhat${arm}`]!);
  });

  it("the stop's answer names it, requested or not organizing", async () => {
    let el = await mount("en", organizing());
    await press(buttonExactly(el, copy.stopOrganizingHandBack!), copy.stopOrganizingHandBack!);
    await press(buttonExactly(el, copy.stopOrganizingConfirm!), copy.stopOrganizingConfirm!);
    expect(el.textContent ?? "").toContain(copy[`stopOrganizingQueued${arm}`]!);
    expect(el.textContent ?? "").not.toContain(copy.stopOrganizingQueued!);

    releaseOutcome = "not_organizing";
    el = await mount("en", organizing());
    await press(buttonExactly(el, copy.stopOrganizingHandBack!), copy.stopOrganizingHandBack!);
    await press(buttonExactly(el, copy.stopOrganizingConfirm!), copy.stopOrganizingConfirm!);
    expect(el.textContent ?? "").toContain(copy[`stopOrganizingNot${arm}`]!);
    expect(el.textContent ?? "").not.toContain(copy.stopOrganizingNot!);
  });

  it("a stop refused by a live copy names it", async () => {
    const el = await mount("en", organizing({
      releaseRequestedAt: "2026-09-07T09:00:00.000Z", releaseRefusal: "sibling_lapse",
    } as Partial<MailboxDTO>));
    expect(orgText(el)).toContain(copy[`stopOrganizingSiblingLapse${arm}`]!);
    expect(orgText(el), "another copy of this computer, on the web").not.toMatch(/this computer/i);
  });

  it("…in German too, with no raw key on screen", async () => {
    const el = await mount("de", organizing());
    expect(orgText(el)).toContain(copyDe[`stateOrganizing${arm}`]!);
    expect(orgText(el)).not.toContain(copyDe.stateOrganizingHere!);
    expect(orgText(el)).not.toContain(`stateOrganizing${arm}`);
  });
});

describe("the sentence set is in both catalogues", () => {
  it("every key the filer table answers is a translated sentence", async () => {
    const { FILER_KEY_SET } = await import("@ohmail/app-logic/mail-state/mail-state");
    expect(FILER_KEY_SET.length, "the table is empty").toBeGreaterThanOrEqual(16);
    for (const key of FILER_KEY_SET) {
      expect(typeof copy[key], `${key} is missing from en.json`).toBe("string");
      expect(typeof copyDe[key], `${key} is missing from de.json`).toBe("string");
      expect(copyDe[key], `${key} is English in de.json`).not.toBe(copy[key]);
    }
  });
});
