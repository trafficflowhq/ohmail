/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";
import { personalAt } from "../../../test/support/fixture-credentials.js";

/**
 * SETTINGS > MAILBOXES > CONNECT HAS NO PORT FIELD, so its refusals name none; a port goes after the
 * server name (`name:port`, R23-03) and the connect and timeout sentences say so. The form sends no
 * port for a bare generic entry (the probe walks 993, then 143) and a fixed pair behind a preset. Both
 * places the form says a refusal are driven: the Test verdict, and the refusal the connect itself
 * hands back to the form. The edit form keeps its port-naming sentence — it has the field
 * (`mailbox-edit.imapedit.test.tsx`).
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

/** `mock`-prefixed: `vi.mock`'s factory is hoisted above the imports. */
let mockProbeThrows: unknown = null;
let mockCreateThrows: unknown = null;
/** What `POST /mailboxes/discover` answers, by domain; anything else is refused. */
let mockDiscover: Record<string, unknown> = {};
let mockLookups: unknown[] = [];

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({ user: { email: "person@example.test", emailVerified: true }, scope: "full" }),
      login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: async () => undefined,
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: [] as MailboxDTO[] }),
      probe: async () => { if (mockProbeThrows) throw mockProbeThrows; return { verdict: "ok" }; },
      create: async () => { throw mockCreateThrows; },
      discover: async (b: { domain: string }) => {
        mockLookups.push(b);
        if (!(b.domain in mockDiscover)) throw new actual.ApiError(503, "discover_unconfigured", "no lookup");
        return mockDiscover[b.domain];
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => { /* nothing to refresh here */ } }),
}));

const refused = (reason: string, extra: Record<string, unknown> = {}): ApiError =>
  new ApiError(400, "mailbox_probe_failed", "server sentence", { reason, transport: "imap", ...extra });

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

/** The connect form on the generic entry, with every field it asks for typed. */
async function typedForm(): Promise<HTMLDivElement> {
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
  await typeInto(host.querySelector("#mb-imap"), "mail.example.test");
  await typeInto(host.querySelector("#mb-smtp"), "smtp.example.test");
  await typeInto(host.querySelector("#mb-pass"), "app-password-fixture");
  return host;
}

/** From the typed form to the create: the connect is tried on submit. */
async function ceremony(el: HTMLElement): Promise<void> {
  await submit(el.querySelector("#mb-address")!.closest("form"));
}

beforeEach(() => { mockProbeThrows = null; mockCreateThrows = null; mockDiscover = {}; mockLookups = []; });
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
});

describe("Settings > Connect names no port field", () => {
  for (const reason of ["connect", "timeout", "tls"]) {
    it(`the Test verdict for ${reason}`, async () => {
      mockProbeThrows = refused(reason, reason === "tls" ? { tls: { kind: "self_signed" } } : {});
      const el = await typedForm();
      await click(press(el, onb.test!));
      const said = el.querySelector(".set-verdict.bad")?.textContent ?? "";
      expect(said).toContain("IMAP server name");
      // No port FIELD is named; the connect and timeout sentences say a port goes after the name.
      expect(said).not.toMatch(/host and port|whether the port/i);
    });
  }

  it("the refusal the connect hands back to the form", async () => {
    mockCreateThrows = refused("connect");
    const el = await typedForm();
    await ceremony(el);
    expect(el.querySelector("#mb-address"), "the refusal did not return to the form").toBeTruthy();
    const said = el.querySelector('[role="alert"]')?.textContent ?? "";
    expect(said).toContain("IMAP server name");
    expect(said).toContain("goes after the name, as mail.example.com:1143");
    expect(said).not.toMatch(/host and port/i);
  });

  it("a named certificate kind keeps its own sentence there", async () => {
    mockCreateThrows = refused("tls", { tls: { kind: "self_signed" } });
    const el = await typedForm();
    await ceremony(el);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.probe_tls_self_signed);
  });
});

describe("Settings > Connect asks for the address first", () => {
  async function openForm(): Promise<HTMLDivElement> {
    const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
    });
    await settle();
    await click(press(host, copy.connect!));
    return host;
  }
  async function address(el: HTMLElement, value: string): Promise<void> {
    await typeInto(el.querySelector("#mb-address"), value);
    await act(async () => { el.querySelector("#mb-address")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await settle();
  }
  const checked = (el: HTMLElement) => [...el.querySelectorAll('[role="radio"][aria-checked="true"] .pvp-name')]
    .map((n) => n.textContent);

  it("the address is asked before any tile, and its domain preselects one", async () => {
    mockDiscover["acme-workspace.example"] = { preset: "gmail", proton: false, imap: null, smtp: null };
    const el = await openForm();
    expect(checked(el)).toEqual([]);
    expect(el.querySelector("#mb-address"), "the address is on screen before a choice").toBeTruthy();
    await address(el, personalAt("fixture.person", "icloud.com"));
    expect(checked(el)).toEqual(["iCloud Mail"]);
    await address(el, "person@acme-workspace.example");
    expect(checked(el)).toEqual(["Gmail"]);
    expect(mockLookups).toEqual([{ domain: "acme-workspace.example" }]);
  });

  it("a refused password behind a preset says that provider's own sentence", async () => {
    mockCreateThrows = refused("auth");
    const el = await openForm();
    await address(el, personalAt("fixture.person", "t-online.de"));
    expect(checked(el)).toEqual(["t-online"]);
    await typeInto(el.querySelector("#mb-pass"), "app-password-fixture");
    await ceremony(el);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(copy.probe_auth_tonline);
  });

  it("an unreachable host on the generic entry offers the hosts the lookup found, as a fill", async () => {
    mockDiscover["acme-srv.example"] = {
      preset: null, proton: false,
      imap: { host: "imap.acme-srv.example", port: 993, secure: true }, smtp: { host: "smtp.acme-srv.example", port: 465, secure: true },
    };
    mockCreateThrows = refused("connect");
    const el = await openForm();
    await address(el, "person@acme-srv.example");
    expect(checked(el), "an unknown provider leaves the choice to the person").toEqual([]);
    await click(press(el, picker.otherLabel!));
    await typeInto(el.querySelector("#mb-imap"), "mail.acme-srv.example");
    await typeInto(el.querySelector("#mb-smtp"), "mail.acme-srv.example");
    await typeInto(el.querySelector("#mb-pass"), "app-password-fixture");
    await ceremony(el);
    await click(press(el, picker.discoveredUse!));
    expect((el.querySelector("#mb-imap") as HTMLInputElement).value).toBe("imap.acme-srv.example");
    expect((el.querySelector("#mb-smtp") as HTMLInputElement).value).toBe("smtp.acme-srv.example");
    expect(el.querySelector('[role="alert"]'), "the old refusal goes with the hosts it was about").toBeNull();
  });
});
