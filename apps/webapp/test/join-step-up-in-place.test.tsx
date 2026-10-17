/** @vitest-environment jsdom */
/**
 * THE STEP-UP WINDOW CLOSES WHERE PEOPLE LEAVE. `POST /mailboxes` wants a second factor from the last
 * five minutes, and making an app password takes longer than that. The mailbox step used to end on
 * "That took a little too long — sign in again", whose `/login` forwarded the still-signed-in browser
 * to an empty Ohbox with the setup gone. Now the factor is asked for in place (Settings' own prompt),
 * the very connect that was refused is sent again once, and everything typed stays; a second refusal
 * right after a verified factor is the sign-in screen, and its link resumes `/join`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

const STEP_UP = { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } };
const MAILBOX_DTO = {
  id: "mb1", address: "pat@family.example", provider: "imap", organizeConsentedAt: null,
};

/** The answers `POST /mailboxes` gives, in order; the last one repeats. */
let creates: Array<{ status: number; body: unknown }> = [];
let createBodies: unknown[] = [];
let stepUps: unknown[] = [];

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  creates = [];
  createBodies = [];
  stepUps = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, FULL);
    if (url.includes("/auth/step-up/totp")) {
      stepUps.push(JSON.parse(String(init?.body ?? "{}")));
      return json(200, { ok: true });
    }
    if (url.includes("/mailboxes") && method === "POST") {
      createBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const answer = creates.length > 1 ? creates.shift()! : creates[0]!;
      return json(answer.status, answer.body);
    }
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

async function atTheMailboxStep() {
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
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
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
  const press = async (label: string, scope: ParentNode = host) => {
    const button = [...scope.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const h1 = () => host.querySelector("h1")?.textContent ?? "";
  const prompt = () => host.querySelector<HTMLElement>('[data-testid="step-up-prompt"]');
  const value = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)?.value ?? null;
  const connectButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === en.join.connectMailbox) ?? null;

  expect(h1()).toBe(en.join.step_mailbox_title);
  const tile = [...host.querySelectorAll('[role="radio"]')]
    .find((b) => (b.textContent ?? "").startsWith(en.providerPicker.otherLabel));
  await act(async () => { (tile as HTMLElement).click(); });
  await type("join-mb-address", "pat@family.example");
  await type("join-imap", "mail.family.example");
  await type("join-smtp", "smtp.family.example");
  await type("join-mb-pass", "app-password-fixture");
  return { host, type, press, h1, prompt, value, connectButton, settle };
}

describe("the mailbox step asks for the second factor in place", () => {
  it("a closed window opens the prompt; the verified code re-sends the same connect once; the step ends connected", async () => {
    creates = [{ status: 403, body: STEP_UP }, { status: 201, body: MAILBOX_DTO }];
    const ui = await atTheMailboxStep();
    await ui.press(en.join.connectMailbox);

    expect(ui.h1(), "the refusal is not the sign-in screen").toBe(en.join.step_mailbox_title);
    expect(ui.prompt(), "the step-up prompt is on screen").toBeTruthy();
    expect(ui.value("join-mb-pass"), "the typed password is still there").toBe("app-password-fixture");
    expect(ui.connectButton()?.disabled, "Connect waits for the factor").toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(ui.prompt()!.contains(document.activeElement), "focus is not in the prompt").toBe(true);

    await ui.type("stepup-code", "123456");
    await ui.press(en.devices.stepUpVerify, ui.prompt()!);

    expect(stepUps).toEqual([{ code: "123456" }]);
    expect(createBodies, "exactly the refused connect, sent again once").toHaveLength(2);
    expect(createBodies[1]).toEqual(createBodies[0]);
    expect(ui.h1()).toBe(en.join.step_connected_title);
  });

  it("Cancel keeps everything typed and sends nothing more", async () => {
    creates = [{ status: 403, body: STEP_UP }];
    const ui = await atTheMailboxStep();
    await ui.press(en.join.connectMailbox);
    expect(ui.prompt()).toBeTruthy();
    await ui.press(en.devices.cancel, ui.prompt()!);
    expect(ui.prompt()).toBeNull();
    expect(createBodies).toHaveLength(1);
    expect(ui.h1()).toBe(en.join.step_mailbox_title);
    expect(ui.value("join-mb-address")).toBe("pat@family.example");
    expect(ui.value("join-imap")).toBe("mail.family.example");
    expect(ui.value("join-mb-pass")).toBe("app-password-fixture");
    expect(ui.connectButton()?.disabled).toBe(false);
  });

  it("a second refusal right after a verified factor is the sign-in screen, and its link resumes /join", async () => {
    creates = [{ status: 403, body: STEP_UP }];
    const ui = await atTheMailboxStep();
    await ui.press(en.join.connectMailbox);
    await ui.type("stepup-code", "123456");
    await ui.press(en.devices.stepUpVerify, ui.prompt()!);
    expect(createBodies).toHaveLength(2);
    expect(ui.h1()).toBe(en.join.expiredTitle);
    const signIn = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === en.join.signIn);
    expect(signIn?.getAttribute("href")).toBe("/login?next=join");
  });
});
