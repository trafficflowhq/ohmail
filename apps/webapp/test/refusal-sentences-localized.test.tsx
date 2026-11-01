/** @vitest-environment jsdom */
/**
 * A REFUSAL IS SAID IN THE READER'S LANGUAGE ON THE ACCOUNT PANE'S SESSION READ AND IN THE STEP-UP
 * PROMPT. The pane rendered its session read's refusal through `messageOf`, so a lost marker read
 * the client's English literal under German; the prompt rendered every server refusal but the
 * lockout as the server's English diagnostic ("two-factor verification failed"). Each surface is
 * driven over `fetch` in German, with the English twin as the control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const A = "0b7e3a52-5d2b-4c7e-9a41-2f1d6c8e9a01";
const WIRE_401 = "two-factor verification failed";
const ENROLLED = (webauthn: boolean) => ({
  status: 200,
  body: { user: { accountId: A, email: "a@example.test", twofaEnrolled: { webauthn, totp: true, recoveryCodes: true } }, scope: "full" },
});

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer> = {};
let calls: Array<{ method: string; url: string; body: string | null }> = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  // A 401 at the step-up door is renewed once and sent again (no `NEVER_REFRESH` entry): the renewal succeeds.
  answers = { "POST /auth/refresh": { status: 204 } };
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    const hit = Object.entries(answers).find(([key]) => {
      const [m, p] = key.split(" ");
      return m === method && url.includes(p!);
    });
    const a = hit?.[1] ?? { status: 200, body: {} };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status, headers: { "content-type": "application/json" },
    });
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  document.cookie = "tf_owner=; path=/; max-age=0";
  vi.unstubAllGlobals();
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
});

async function settle(n = 12): Promise<void> {
  await act(async () => { for (let i = 0; i < n; i += 1) await Promise.resolve(); });
}

async function mount(locale: "en" | "de", node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : en, timeZone: "UTC",
      children: h(ThemeProvider, null, h(ToastHost, null, node)),
    }));
  });
  await settle();
  return host;
}

async function signedIn(): Promise<void> {
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(A);
  document.cookie = `tf_owner=${A}; path=/`;
}

async function prompt(locale: "en" | "de"): Promise<HTMLElement> {
  const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
  return mount(locale, h(StepUpPrompt, { onVerified: () => {}, onCancel: () => {}, onDiscarded: () => {} }));
}

async function submitCode(c: HTMLElement): Promise<void> {
  const input = c.querySelector<HTMLInputElement>("#stepup-code")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { c.querySelector("form")!.requestSubmit(); });
  await settle(30);
}

const alertOf = (c: HTMLElement): string => c.querySelector('[role="alert"]')?.textContent ?? "";

describe("the step-up prompt says a server refusal in the reader's language", () => {
  const CASES: Array<[string, Answer, (m: typeof en) => string]> = [
    ["a wrong code", { status: 401, body: { error: { code: "credential_refused", message: WIRE_401 } } }, (m) => m.devices.stepUpBadCode],
    ["the slowed sign-in", { status: 429, body: { error: { code: "sign_in_slowed", message: "sign-in slowed" } } }, (m) => m.devices.stepUpSlowed],
    ["any other refusal", { status: 500, body: { error: { code: "internal", message: "internal error" } } }, (m) => m.devices.stepUpRefused],
  ];
  for (const [name, answer, key] of CASES) {
    it(`${name}, in German, never the server's English`, async () => {
      await signedIn();
      answers["GET /api/auth/session"] = ENROLLED(false);
      answers["POST /api/auth/step-up/totp"] = answer;
      const c = await prompt("de");
      await submitCode(c);
      expect(alertOf(c)).toBe(key(de));
      expect(key(de)).not.toBe(key(en));
    });
    it(`control: ${name}, in English, says the English sentence`, async () => {
      await signedIn();
      answers["GET /api/auth/session"] = ENROLLED(false);
      answers["POST /api/auth/step-up/totp"] = answer;
      const c = await prompt("en");
      await submitCode(c);
      expect(alertOf(c)).toBe(key(en));
    });
  }

  it("a refused passkey, in German, is the passkey's sentence, not the code's", async () => {
    await signedIn();
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    const buf = new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: {
        get: async () => ({
          id: "cred", rawId: buf, type: "public-key",
          response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null },
          getClientExtensionResults: () => ({}),
        }),
      },
    });
    answers["GET /api/auth/session"] = ENROLLED(true);
    answers["POST /api/auth/step-up/webauthn/options"] = { status: 200, body: { options: { challenge: "AQID", allowCredentials: [] } } };
    answers["POST /api/auth/step-up/webauthn/verify"] = { status: 401, body: { error: { code: "credential_refused", message: WIRE_401 } } };
    const c = await prompt("de");
    const press = [...c.querySelectorAll("button")].find((b) => b.textContent === de.devices.stepUpPasskey)!;
    expect(press, "the passkey arm is offered").toBeTruthy();
    await act(async () => { press.click(); });
    await settle(30);
    expect(alertOf(c)).toBe(de.devices.stepUpBadPasskey);
  });

  it("control: a code the server takes says nothing", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    answers["POST /api/auth/step-up/totp"] = { status: 200, body: { ok: true } };
    const c = await prompt("de");
    await submitCode(c);
    expect(c.querySelector('[role="alert"]')).toBeNull();
    expect(calls.some((r) => r.url.includes("/api/auth/step-up/totp")), "the code was sent").toBe(true);
  });
});

describe("a recovery code earns the step-up, for an authenticator that is gone", () => {
  const ENROLLED_NO_SHEET = {
    status: 200,
    body: { user: { accountId: A, email: "a@example.test", twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: false } }, scope: "full" },
  };
  const toggleIn = (c: HTMLElement, m: typeof en): HTMLButtonElement | undefined =>
    [...c.querySelectorAll("button")].find((b) => b.textContent === m.devices.stepUpRecoveryToggle);

  async function recoveryArm(locale: "en" | "de", onVerified: () => void = () => {}): Promise<HTMLElement> {
    const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
    const c = await mount(locale, h(StepUpPrompt, { onVerified, onCancel: () => {}, onDiscarded: () => {} }));
    const toggle = toggleIn(c, locale === "de" ? de : en);
    expect(toggle, "the recovery arm is offered").toBeTruthy();
    await act(async () => { toggle!.click(); });
    const input = c.querySelector<HTMLInputElement>("#stepup-recovery")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, " abcd-efgh-ijkl ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { c.querySelector("form")!.requestSubmit(); });
    await settle(30);
    return c;
  }

  it("the code goes to the step-up's own door, and a code it takes continues the parked verb", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    answers["POST /api/auth/step-up/recovery-code"] = { status: 200, body: { ok: true, remainingCodes: 9 } };
    let verified = 0;
    const c = await recoveryArm("en", () => { verified += 1; });
    const sent = calls.filter((r) => r.url.includes("/api/auth/step-up/recovery-code"));
    expect(sent.map((r) => JSON.parse(r.body!))).toEqual([{ code: "abcd-efgh-ijkl" }]);
    expect(calls.some((r) => r.url.includes("/api/auth/step-up/totp")), "the code went to the authenticator's door").toBe(false);
    expect(verified).toBe(1);
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });

  it("a refused code, in German, is the recovery code's sentence", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    answers["POST /api/auth/step-up/recovery-code"] = { status: 401, body: { error: { code: "credential_refused", message: WIRE_401 } } };
    const c = await recoveryArm("de");
    expect(alertOf(c)).toBe(de.devices.stepUpBadRecoveryCode);
    expect(de.devices.stepUpBadRecoveryCode).not.toBe(en.devices.stepUpBadRecoveryCode);
  });

  it("control: an account with no recovery codes is not offered the arm", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED_NO_SHEET;
    const c = await prompt("en");
    expect(toggleIn(c, en)).toBeUndefined();
  });
});

describe("the Account pane's session read says a refusal in the reader's language", () => {
  async function pane(locale: "en" | "de"): Promise<HTMLElement> {
    const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
    return mount(locale, h(AccountSection));
  }

  it("a lost marker, in German, is the session sentence, not the client's English literal", async () => {
    const { bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    const c = await pane("de");
    expect(c.textContent).toContain(de.session.refusedOwnerAbsent);
    expect(c.textContent).not.toContain("lost the name of the account");
  });

  it("control: a read the server answers says no refusal", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    const c = await pane("de");
    expect(c.textContent).not.toContain(de.session.refusedOwnerAbsent);
    expect(c.textContent).not.toContain("lost the name of the account");
  });
});

describe("the renderer says the client's own refusals in the reader's language", () => {
  it("a sign-in that could not be checked, in German and in English", async () => {
    const { ApiError, SESSION_UNCHECKED } = await import("../app/api-client.js");
    const { useRefusalSentence } = await import("../app/(product)/refusal-sentence.js");
    const Say = () => h("p", null, useRefusalSentence()(new ApiError(503, SESSION_UNCHECKED, "Your sign-in could not be checked just now. Try again in a moment.")));
    expect((await mount("de", h(Say))).textContent).toBe(de.session.refusedSessionUnchecked);
    await act(async () => root!.unmount());
    host?.remove();
    root = null;
    expect((await mount("en", h(Say))).textContent).toBe(en.session.refusedSessionUnchecked);
  });
});

describe("a server answer, as the prompt reads one", () => {
  it("the renderer's spelling of the client-raised codes is api-client's own", async () => {
    const { SESSION_ENDED_REFUSAL_CODE, SESSION_UNCHECKED } = await import("../app/api-client.js");
    const { CLIENT_RAISED } = await import("../app/(product)/refusal-sentence.js");
    expect(CLIENT_RAISED).toEqual({ unchecked: SESSION_UNCHECKED, ended: SESSION_ENDED_REFUSAL_CODE });
  });

  it("the two client-raised 4xx/5xx refusals are not server answers; a server's own refusal is", async () => {
    const { ApiError, SESSION_ENDED_REFUSAL_CODE, SESSION_UNCHECKED } = await import("../app/api-client.js");
    const { serverAnswered } = await import("../app/(product)/refusal-sentence.js");
    expect(serverAnswered(new ApiError(401, SESSION_ENDED_REFUSAL_CODE, "ended"))).toBe(false);
    expect(serverAnswered(new ApiError(503, SESSION_UNCHECKED, "unchecked"))).toBe(false);
    expect(serverAnswered(new ApiError(0, "owner_absent", "lost"))).toBe(false);
    expect(serverAnswered(new Error("x"))).toBe(false);
    // Control: the server's refusals, the lowest and a fault.
    expect(serverAnswered(new ApiError(400, "validation_failed", "code is required"))).toBe(true);
    expect(serverAnswered(new ApiError(401, "credential_refused", WIRE_401))).toBe(true);
    expect(serverAnswered(new ApiError(503, "db_busy", "busy"))).toBe(true);
  });
});
