/** @vitest-environment jsdom */
/**
 * /JOIN SAYS WHY GOOGLE REFUSED, AND SAYS "APP PASSWORD" BEFORE THE PRESS. The mailbox step on the
 * real client over a fetch double; each refusal is built by the service's own `launchRefused`, as
 * the API sends it. Settings and the first-run form: `gmail-refusal-says-why.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { launchRefused } from "@trafficflow/services/mail";

type Messages = typeof en;
const HINTS = ["app_password_required", "invalid", "web_login", "imap_disabled"] as const;
const LINKS = { prereq: "https://myaccount.google.com/signinoptions/twosv", help: "https://myaccount.google.com/apppasswords" };
const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

/** The next `POST /mailboxes` refusal, as the service builds it; `null` answers 201. */
let refused: { status: number; body: unknown } | null = null;
const refusalFor = (hint?: string): { status: number; body: unknown } => {
  const r = launchRefused("auth", false, hint as never) as unknown as { httpStatus: number; code: string; message: string; details: unknown };
  return { status: r.httpStatus, body: { error: { code: r.code, message: r.message, details: r.details } } };
};

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  refused = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, FULL);
    if (url.includes("/mailboxes") && method === "POST") return refused ? json(refused.status, refused.body) : json(201, {});
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

async function joinGmail(messages: Messages = en) {
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
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  expect(host.querySelector("h1")?.textContent).toBe(messages.join.step_mailbox_title);
  const tile = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => (b.textContent ?? "").startsWith("Gmail"));
  await act(async () => { tile!.click(); });
  const type = async (id: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`);
    expect(input, `#${id} is not on screen`).toBeTruthy();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  await type("join-mb-address", "pat@gmail.test");
  await type("join-mb-pass", "the-google-password");
  const connect = async () => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === messages.join.connectMailbox);
    expect(button, "no Connect").toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const refusal = () => host.querySelector(".join-error.at-press")?.textContent ?? null;
  const helpLinks = () => [...host.querySelectorAll("a")].filter((a) => a.getAttribute("href") === LINKS.help).length;
  return { host, connect, refusal, helpLinks };
}

describe("/join's mailbox step on Gmail", () => {
  it("the note and its two links before the press", async () => {
    const ui = await joinGmail();
    expect(ui.host.textContent).toContain(en.providerPicker.note_gmail);
    const hrefs = [...ui.host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining([LINKS.prereq, LINKS.help]));
  });

  for (const hint of HINTS) {
    it(`${hint}: Google's sentence at the press`, async () => {
      refused = refusalFor(hint);
      const ui = await joinGmail();
      await ui.connect();
      expect(ui.refusal()).toBe((en.mailboxes as Record<string, string>)[`probe_auth_gmail_${hint}`]);
      expect(ui.helpLinks(), "the links under the refusal").toBe(hint === "app_password_required" || hint === "invalid" ? 2 : 1);
    });
  }

  it("control: no hint is the generic sentence and no extra links", async () => {
    refused = refusalFor();
    const ui = await joinGmail();
    await ui.connect();
    expect(ui.refusal()).toBe(en.mailboxes.probe_auth);
    expect(ui.helpLinks()).toBe(1);
  });

  it("in German too", async () => {
    refused = refusalFor("web_login");
    const ui = await joinGmail(de);
    await ui.connect();
    expect(ui.refusal()).toBe((de.mailboxes as Record<string, string>).probe_auth_gmail_web_login);
  });
});
