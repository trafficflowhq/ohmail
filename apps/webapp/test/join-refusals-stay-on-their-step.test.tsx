/** @vitest-environment jsdom */
/**
 * A REFUSAL STAYS ON THE STEP THAT WAS REFUSED. The wizard's deploy-skew fallback (an API that still
 * wants an invite under a webapp armed for open signup) caught every `validation_failed`, so a
 * paying trial user whose mail server sits on their own network, or who typed a POP port, was sent
 * to "Redeem your invite"; and on the account step an address the browser accepts but the server
 * does not (`mila@gmailcom`) was too. Only a refusal that names `inviteCode` opens the invite step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

type Messages = typeof en;

const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

/** What the next `POST /mailboxes` and `POST /auth/register` answer. */
let mailboxAnswer: { status: number; body: unknown } = { status: 201, body: {} };
let registerAnswer: { status: number; body: unknown } = { status: 202, body: { status: "ok" } };
let signedIn = true;

const refusal = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  signedIn = true;
  mailboxAnswer = { status: 201, body: {} };
  registerAnswer = { status: 202, body: { status: "ok" } };
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) {
      return signedIn ? json(200, FULL) : json(401, { error: { code: "unauthorized", message: "authentication required" } });
    }
    if (url.includes("/auth/register")) return json(registerAnswer.status, registerAnswer.body);
    if (url.includes("/mailboxes") && method === "POST") return json(mailboxAnswer.status, mailboxAnswer.body);
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function mount(messages: Messages = en, props: { initialCode: string; publicSignup: boolean } = { initialCode: "", publicSignup: true }) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: messages === de ? "de" : "en", messages, timeZone: "UTC",
      children: React.createElement(JoinScreen, props),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  const type = async (id: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`);
    expect(input, `#${id} is not on screen`).toBeTruthy();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const submit = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const h1 = () => host.querySelector("h1")?.textContent ?? "";
  const alertText = () => [...host.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "").join(" | ");
  const value = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)?.value ?? null;
  return { host, type, submit, h1, alertText, value, settle };
}

/** The generic entry, filled as a person on their own mail server fills it. */
async function mailboxForm(messages: Messages, imapHost: string) {
  const ui = await mount(messages);
  expect(ui.h1()).toBe(messages.join.step_mailbox_title);
  const tile = [...ui.host.querySelectorAll('[role="radio"]')]
    .find((b) => (b.textContent ?? "").startsWith(messages.providerPicker.otherLabel));
  const React = await import("react");
  await (React as unknown as { act: (cb: () => void) => Promise<void> }).act(() => { (tile as HTMLElement).click(); });
  await ui.type("join-mb-address", "pat@family.example");
  await ui.type("join-imap", imapHost);
  await ui.type("join-smtp", "smtp.family.example");
  await ui.type("join-mb-pass", "app-password-fixture");
  return ui;
}

describe("the mailbox step keeps its own refusals", () => {
  it("a mail server on the person's own network: still the mailbox step, the server's sentence, nothing typed lost", async () => {
    const said = "That incoming (IMAP) server address names this machine or your own network, not a mail server on the internet.";
    mailboxAnswer = refusal(400, "validation_failed", said);
    const ui = await mailboxForm(en, "mail.home.lan");
    await ui.submit(en.join.connectMailbox);
    expect(ui.h1()).toBe(en.join.step_mailbox_title);
    expect(ui.h1()).not.toBe(en.join.step_invite_title);
    expect(ui.alertText()).toContain(said);
    expect(ui.alertText()).not.toContain(en.join.inviteRequiredAfterAll);
    expect(ui.value("join-imap")).toBe("mail.home.lan");
    expect(ui.value("join-mb-pass")).toBe("app-password-fixture");
  });

  it("a port that carries no mail (POP3S typed into the IMAP field): still the mailbox step", async () => {
    const said = "Mail is not carried on port 995. Use 993, 143.";
    mailboxAnswer = refusal(400, "validation_failed", said, { port: 995, ports: [993, 143] });
    const ui = await mailboxForm(en, "mail.family.example:995");
    await ui.submit(en.join.connectMailbox);
    expect(ui.h1()).toBe(en.join.step_mailbox_title);
    expect(ui.alertText()).toContain(said);
  });

  it("German: a refused password is the catalogue's sentence, not the server's English", async () => {
    mailboxAnswer = refusal(400, "mailbox_probe_failed",
      "The mail server refused this password. If your provider requires an app-specific password, generate one there and use it here instead of your account password.",
      { reason: "auth", transport: "imap" });
    const ui = await mailboxForm(de, "mail.family.example");
    await ui.submit(de.join.connectMailbox);
    expect(ui.h1()).toBe(de.join.step_mailbox_title);
    expect(ui.alertText()).toBe(de.mailboxes.probe_auth);
  });
});

describe("the account step keeps its own refusals, and the invite step opens only for a missing invite", () => {
  const openAccountForm = async (address: string) => {
    signedIn = false;
    const ui = await mount(en);
    expect(ui.h1()).toBe(en.join.step_account_title);
    await ui.type("join-email", address);
    await ui.type("join-name", "Mila Reyes");
    await ui.type("join-pw", "a-long-enough-password");
    return ui;
  };

  it("an address the browser takes and the server does not (mila@gmailcom): still the account step, its own sentence", async () => {
    registerAnswer = refusal(400, "validation_failed", "email must be a valid address");
    const ui = await openAccountForm("mila@gmailcom");
    await ui.submit(en.join.createAccount);
    expect(ui.h1()).toBe(en.join.step_account_title);
    expect(ui.alertText()).toContain(en.join.refusedEmail);
    expect(ui.value("join-email")).toBe("mila@gmailcom");
  });

  it("the control: an API that still wants an invite under open signup opens the invite step", async () => {
    registerAnswer = refusal(400, "validation_failed", "inviteCode is required");
    const ui = await openAccountForm("mila@example.com");
    await ui.submit(en.join.createAccount);
    expect(ui.h1()).toBe(en.join.step_invite_title);
    expect(ui.alertText()).toContain(en.join.inviteRequiredAfterAll);
  });
});
