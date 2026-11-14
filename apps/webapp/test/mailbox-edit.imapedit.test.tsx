/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus, type UpdateMailboxBody } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * MAILBOX-IMAP-EDIT — **EDITING A CONNECTED MAILBOX, AND THE ONE THING A BAD EDIT MAY NOT DO.**
 *
 * `PATCH /mailboxes/:id` has always been able to rotate a mailbox's credentials, tried the login
 * before storing it, and refused a bad one without touching what was stored. Until this slice no
 * product client called it: the only door in the pane was "connect a new mailbox". This adds the
 * edit door and holds down the property that makes it safe to offer at all —
 *
 *   **A REFUSED SAVE LEAVES THE EXISTING MAILBOX RUNNING.**
 *
 * The server tries the new credentials before it stores them, so a wrong password (or a mistyped
 * host) is answered `mailbox_probe_failed` and NOTHING is written — the stored login survives and
 * the worker keeps organizing the mailbox on it. A typo here must therefore never take a working
 * mailbox offline; it returns to the edit form with the field to correct, and the row goes on
 * saying what it said. The server half of this is mutation-checked in
 * `packages/api/test/mailbox-patch-probe.at10.test.ts`; this is the pane's half.
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

/* ── The server, as far as this pane can see it ──────────────────────────────────────── */

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
let mockListed: MailboxDTO[] = [];
let mockUpdateCalls: Array<{ id: string; body: UpdateMailboxBody }> = [];
/** When set, `mailboxes.update` throws it instead of resolving — the refused-probe case. */
let mockUpdateThrows: unknown = null;
let mockRefreshes = 0;

vi.mock("../app/api-client", async () => {
  // Spread the real module so `ApiError`, `codeOf` and `messageOf` stay the genuine ones —
  // `probeReasonOf` decides on `err instanceof ApiError`, so a hand-rolled stand-in would make
  // the refused-probe path untestable.
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true }, scope: "full",
      }),
      login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: async () => undefined,
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      create: async () => mockListed[0]!,
      resync: async () => undefined,
      update: async (id: string, body: UpdateMailboxBody) => {
        mockUpdateCalls.push({ id, body });
        if (mockUpdateThrows) throw mockUpdateThrows;
        return { ...mockListed[0]!, id };
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => { mockRefreshes += 1; } }),
}));

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: "2026-08-04T11:00:00.000Z",
  createdAt: "2026-08-04T10:00:00.000Z", ...over,
});

/* ── Mounting the real pane ──────────────────────────────────────────────────────────── */

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

async function mount(...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
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

function byText(el: HTMLElement, text: string): HTMLElement | null {
  return [...el.querySelectorAll("button, a")]
    .find((n) => (n.textContent ?? "").trim() === text) as HTMLElement | undefined ?? null;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field the walk needs is not on screen").toBeTruthy();
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}

async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Type into the edit form's fields, leaving blank any the caller omits. */
async function fillEdit(el: HTMLElement, f: {
  pass: string; host?: string; port?: string; user?: string;
  smtpHost?: string; smtpPort?: string;
}): Promise<void> {
  await typeInto(el.querySelector("#mb-edit-pass"), f.pass);
  if (f.host !== undefined) await typeInto(el.querySelector("#mb-edit-host"), f.host);
  if (f.port !== undefined) await typeInto(el.querySelector("#mb-edit-port"), f.port);
  if (f.user !== undefined) await typeInto(el.querySelector("#mb-edit-user"), f.user);
  if (f.smtpHost !== undefined) await typeInto(el.querySelector("#mb-edit-smtp"), f.smtpHost);
  if (f.smtpPort !== undefined) await typeInto(el.querySelector("#mb-edit-smtp-port"), f.smtpPort);
}

/** From an open edit form, to the PATCH: the save is tried on submit (a fresh step-up window). */
async function finishCeremony(el: HTMLElement): Promise<void> {
  await submit(el.querySelector("form.acct-confirm")); // edit form → PATCH
}

beforeEach(() => {
  mockListed = [];
  mockUpdateCalls = [];
  mockUpdateThrows = null;
  mockRefreshes = 0;
});

afterEach(async () => { await unmount(); });

/* ══════════════════════════════════════════════════════════════════════════════════════
   THE EDIT DOOR EXISTS, ON THE ROWS THAT CAN USE IT
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("MAILBOX-IMAP-EDIT — the edit form", () => {
  it("a live mailbox row offers an Edit control that opens the form", async () => {
    const el = await mount(dto());
    const edit = byText(el, copy.edit!);
    expect(edit, "a connected mailbox has no way to change its settings").toBeTruthy();

    await click(edit!);
    expect(el.querySelector("#mb-edit-pass"), "Edit did not open the form").toBeTruthy();
    expect(el.textContent ?? "", "the form does not say whose mailbox it is editing")
      .toContain("person@example.test");
  });

  it("a mailbox in error offers Edit too — that is the row whose credentials need re-entering", async () => {
    const el = await mount(dto({ status: "error", errorCode: "auth" }));
    expect(byText(el, copy.edit!), "a quarantined mailbox could not be repaired from the pane").toBeTruthy();
  });

  it("a disconnected mailbox offers no Edit — reconnecting is a different door", async () => {
    const el = await mount(dto({ status: "disabled" }));
    expect(byText(el, copy.edit!), "a tombstone offered an edit").toBeNull();
  });

  it("rotating only the password sends only the password — stored host/port/user are kept", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "new-app-password" });
    await finishCeremony(el);

    expect(mockUpdateCalls.length, "the PATCH never went out").toBe(1);
    expect(mockUpdateCalls[0]!.id).toBe("mb1");
    // Only `pass`. A blank server field is DROPPED, not sent empty — the server merges what is
    // sent over what it stored, so an omitted host means "keep the current one".
    expect(mockUpdateCalls[0]!.body).toEqual({ imap: { pass: "new-app-password" } });
  });

  it("a corrected host/port/user rides along with the password, port as a number", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "pw", host: "imap2.example.test", port: "993", user: "u@example.test" });
    await finishCeremony(el);

    expect(mockUpdateCalls[0]!.body).toEqual({
      imap: { pass: "pw", host: "imap2.example.test", port: 993, user: "u@example.test" },
    });
  });

  it("an impossible port is refused before the ceremony, and nothing is sent", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "pw", port: "70000" });
    await submit(el.querySelector("form.acct-confirm"));

    // Still on the edit form — neither the save nor the step-up prompt was reached.
    expect(el.querySelector("#mb-edit-pass"), "a bad port advanced the save").toBeTruthy();
    expect(el.querySelector('[data-testid="step-up-prompt"]'), "a bad port reached the step-up").toBeNull();
    expect(el.textContent ?? "").toContain(copy.portInvalid!);
    expect(mockUpdateCalls.length, "a bad port still sent a PATCH").toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   SET-M3 — THE SENDING HALF IS CORRECTABLE TOO
   ══════════════════════════════════════════════════════════════════════════════════════

   The connect form has always collected an SMTP host; the edit form patched IMAP only, so a
   mistyped or migrated SMTP host had NO correction path — the one credential screen in the
   product could fix half a mailbox. `PATCH /mailboxes/:id` has accepted an `smtp` block all
   along (probed before it is stored, `smtpMaxSizeBytes` re-learned from the dial — the
   compose size hint feeds off exactly that), so this is the pane's missing half, not a new
   server capability. */

describe("MAILBOX-SMTP-EDIT — the edit form can correct the outgoing server", () => {
  it("offers SMTP host and port fields alongside the IMAP ones", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    expect(el.querySelector("#mb-edit-smtp"), "no SMTP host field on the edit form").toBeTruthy();
    expect(el.querySelector("#mb-edit-smtp-port"), "no SMTP port field on the edit form").toBeTruthy();
  });

  it("a typed SMTP host rides as its own transport block, carrying the password", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "pw", smtpHost: "smtp2.example.test" });
    await finishCeremony(el);

    expect(mockUpdateCalls.length, "the PATCH never went out").toBe(1);
    // The `smtp` block needs `pass` — the server re-tries the SMTP login before storing
    // anything, exactly as it does for IMAP — and an untouched IMAP config still sends only
    // the password (the server merges what is sent over what it stored).
    expect(mockUpdateCalls[0]!.body).toEqual({
      imap: { pass: "pw" },
      smtp: { pass: "pw", host: "smtp2.example.test" },
    });
  });

  it("an edit that touches no SMTP field sends NO smtp block — no needless SMTP dial", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "pw", host: "imap2.example.test" });
    await finishCeremony(el);

    expect(mockUpdateCalls[0]!.body).toEqual({
      imap: { pass: "pw", host: "imap2.example.test" },
    });
  });

  it("SMTP host, port and a corrected username travel together, port as a number", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "pw", user: "u@example.test", smtpHost: "smtp.example.test", smtpPort: "587" });
    await finishCeremony(el);

    expect(mockUpdateCalls[0]!.body).toEqual({
      imap: { pass: "pw", user: "u@example.test" },
      smtp: { pass: "pw", host: "smtp.example.test", port: 587, user: "u@example.test" },
    });
  });

  it("an impossible SMTP port is refused before the ceremony, like the IMAP one", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "pw", smtpPort: "0" });
    await submit(el.querySelector("form.acct-confirm"));

    expect(el.querySelector("#mb-edit-pass"), "a bad SMTP port advanced the ceremony").toBeTruthy();
    expect(el.textContent ?? "").toContain(copy.portInvalid!);
    expect(mockUpdateCalls.length, "a bad SMTP port still sent a PATCH").toBe(0);
  });

  it("a refused SMTP probe returns to the edit form with the SMTP fields intact, naming the SMTP host", async () => {
    for (const [details, key] of [
      [{ reason: "connect", transport: "smtp" }, "probe_connect_smtp"],
      [{ reason: "tls", transport: "smtp", tls: { kind: "generic" } }, "probe_tls_smtp"],
    ] as const) {
      mockUpdateCalls = [];
      mockUpdateThrows = new ApiError(400, "mailbox_probe_failed", "that outgoing server refused", details);

      const el = await mount(dto());
      await click(byText(el, copy.edit!)!);
      await fillEdit(el, { pass: "pw", smtpHost: "typo.example.test" });
      await finishCeremony(el);

      expect(mockUpdateCalls.length).toBe(1);
      // Back on the edit form, the typed SMTP host still in its field — the correction is a keystroke.
      const smtp = el.querySelector<HTMLInputElement>("#mb-edit-smtp");
      expect(smtp, "did not return to the edit form").toBeTruthy();
      expect(smtp!.value).toBe("typo.example.test");
      const said = el.querySelector('[role="alert"]')?.textContent ?? "";
      expect(said, details.reason).toBe(copy[key]);
      expect(said, "an outgoing refusal sent the person to the incoming server").not.toMatch(/IMAP/);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   THE INVARIANT — A REFUSED SAVE LEAVES THE MAILBOX RUNNING
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("MAILBOX-IMAP-EDIT — a refused probe never stands the mailbox down", () => {
  it("THE GUARD: a wrong password returns to the edit form and the mailbox keeps running", async () => {
    // Exactly what `PATCH /mailboxes/:id` answers when the rotated password is refused: the old
    // credential is left in place server-side, so the pane must not act as though anything changed.
    mockUpdateThrows = new ApiError(400, "mailbox_probe_failed", "the mail server refused this password", { reason: "auth" });

    const el = await mount(dto({ status: "connected", lastSyncAt: "2026-08-04T11:00:00.000Z" }));
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "the-wrong-password" });
    await finishCeremony(el);

    // The attempt reached the server — this is a real refusal, not a form that failed to submit.
    expect(mockUpdateCalls.length, "the PATCH was never attempted").toBe(1);

    // Back on the EDIT form, with the reason and the field to correct — never a dead end at a
    // prompt that cannot change a password.
    expect(el.querySelector("#mb-edit-pass"), "a refused save did not return to the edit form").toBeTruthy();
    expect(el.querySelector("#stepup-code"), "left stranded at the step-up prompt").toBeNull();
    expect(el.textContent ?? "").toContain(copy.probe_auth!);

    // AND THE MAILBOX IS STILL RUNNING. It is still listed, still at its address, and NOT shown as
    // disconnected — a failed rotation must not appear to have taken the mailbox offline.
    expect(el.querySelector(".mbx-row"), "the mailbox row vanished on a refused save").toBeTruthy();
    expect(el.textContent ?? "").toContain("person@example.test");
    expect(el.textContent ?? "", "a refused edit made the running mailbox read as disconnected")
      .not.toContain(copy.status_disabled!);
  });

  it("a connection refusal says 'reach', not 'password' — it does not send the user to the wrong fix", async () => {
    mockUpdateThrows = new ApiError(400, "mailbox_probe_failed", "server sentence", { reason: "connect" });

    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "unchanged-entry-password", host: "typo.example.test" });
    await finishCeremony(el);

    expect(el.querySelector("#mb-edit-pass"), "did not return to the edit form").toBeTruthy();
    expect(el.textContent ?? "").toContain(copy.probe_connect!);
    // The connection-refusal sentence, not the wrong-password one — sending the user to change a
    // password that was always fine is the exact conflation the probe taxonomy exists to end.
    expect(el.textContent ?? "", "a refused connection was reported as a rejected password")
      .not.toContain(copy.probe_auth!);
  });

  it("a successful save returns to the list and re-reads it", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.edit!)!);
    await fillEdit(el, { pass: "new-app-password" });
    await finishCeremony(el);

    // Back on the list: the edit form is gone and the Edit control is offered again.
    expect(el.querySelector("#mb-edit-pass"), "stayed on the edit form after a clean save").toBeNull();
    expect(byText(el, copy.edit!), "did not return to the list").toBeTruthy();
    // The shell strip is nudged so it does not stay a poll behind a mailbox that may have recovered.
    expect(mockRefreshes, "the strip was never told the credential changed").toBeGreaterThan(0);
  });
});
