/** @vitest-environment jsdom */
/**
 * ═══ STA-F1 + STA-F6 — WHAT THE SIGN-IN SCREEN SAYS MUST BE TRUE OF THE SIGN-IN ON SCREEN ═══
 *
 * STA-F1, observed live: the login card promised "Your password, then your passkey… nothing to
 * type and nothing to leak" UNCONDITIONALLY — including to a TOTP-only account, whose very next
 * step asked for a typed six-digit code. Claims-are-contracts: the passkey sentences may render
 * exactly when a passkey ceremony is what is being offered, and never before the account's
 * methods are known.
 *
 * STA-F6, observed live: login refusals rendered the SERVER's wire diagnostics raw — "invalid
 * email or password", lowercase, unpunctuated for a card. A bare 401 at this form now gets the
 * form's own sentence for the factor that was tried; every richer refusal (lockout, taxonomy
 * errors) keeps the server's sentence exactly as before.
 *
 * The real `LoginScreen`, the real `api-client`, only `fetch` and the router stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const build = vi.hoisted(() => ({ selfHost: false }));

vi.mock("../app/hello", async (load) => ({
  ...await load<typeof import("../app/hello")>(),
  get SELF_HOST_BUILD() { return build.selfHost; },
}));

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer> = {};
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const coded = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

beforeEach(() => {
  build.selfHost = false;
  answers = {
    // The already-signed-in check on mount: no session, so the form stays.
    "/api/auth/session": coded(401, "unauthorized", "authentication required"),
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const hit = Object.entries(answers).find(([path]) => url.includes(path));
    if (!hit) return new Response("{}", { status: 200 });
    const [, a] = hit;
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function mountLogin(props: { publicSignup?: boolean } = {}): Promise<HTMLElement> {
  const { SignInRoute: LoginScreen } = await import("../app/(product)/login/SignInRoute.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", children: h(LoginScreen, props),
      }),
    );
    await Promise.resolve();
  });
  return host;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitPassword(container: HTMLElement): Promise<void> {
  await type(container.querySelector<HTMLInputElement>("#login-email")!, "person@example.com");
  await type(container.querySelector<HTMLInputElement>("#login-pw")!, "correct horse battery");
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("STA-F1 — the passkey promise renders only over a passkey ceremony", () => {
  it("a TOTP-only account never sees the word 'passkey', on either step", async () => {
    answers["/api/auth/login"] = {
      status: 200,
      body: { status: "twofa_required", loginToken: "tok_1", methods: ["totp"] },
    };
    const container = await mountLogin();

    // Password step: the account's methods are unknown, so nothing may promise a passkey.
    expect(container.textContent).not.toMatch(/passkey/i);

    await submitPassword(container);

    // TOTP step: a typed six-digit code is what is on screen, and the copy says so.
    expect(container.querySelector("#login-code"), "the TOTP step never rendered").not.toBeNull();
    expect(container.textContent, "passkey copy stood over a typed-code ceremony — STA-F1 exactly")
      .not.toMatch(/passkey/i);
    expect(container.textContent).not.toContain("nothing to type");
  });
});

describe("STA-F6 — a bare 401 gets the form's own sentence, not the wire string", () => {
  it("a wrong password answers in copy, and never the raw 'invalid email or password'", async () => {
    answers["/api/auth/login"] = coded(401, "credential_refused", "invalid email or password");
    const container = await mountLogin();
    await submitPassword(container);

    const alert = container.querySelector('[role="alert"]');
    expect(alert, "the refusal rendered nowhere").not.toBeNull();
    expect(alert!.textContent).toBe("That email and password didn't match. Check both and try again.");
    expect(container.textContent).not.toContain("invalid email or password");
  });

  it("a wrong TOTP code answers in copy, and never the raw 'two-factor verification failed'", async () => {
    answers["/api/auth/login"] = {
      status: 200,
      body: { status: "twofa_required", loginToken: "tok_1", methods: ["totp"] },
    };
    const container = await mountLogin();
    await submitPassword(container);

    answers["/api/auth/2fa/totp/verify"] = coded(401, "credential_refused", "two-factor verification failed");
    await type(container.querySelector<HTMLInputElement>("#login-code")!, "000000");
    await act(async () => {
      container.querySelector("#login-code")!.closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("That code didn't work. Codes expire quickly — try the newest one.");
    expect(container.textContent).not.toContain("two-factor verification failed");
  });

  it("the throttle's two refusals render as sentences that say to wait, never as a wrong password", async () => {
    answers["/api/auth/login"] = coded(429, "sign_in_slowed", "sign_in_slowed");
    let container = await mountLogin();
    await submitPassword(container);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(messages.login.signInSlowed);
    await act(async () => root!.unmount());
    host?.remove(); root = null; host = null;

    answers["/api/auth/login"] = coded(423, "account_locked", "too many failed attempts");
    container = await mountLogin();
    await submitPassword(container);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(messages.login.tooManyAttempts);
    expect(container.textContent).not.toContain("too many failed attempts");
  });

  it("a refusal RICHER than a bare 401 keeps the server's own sentence — the taxonomy is not re-derived", async () => {
    answers["/api/auth/login"] = coded(429, "rate_limited", "Too many attempts. Try again in 12 minutes.");
    const container = await mountLogin();
    await submitPassword(container);
    expect(container.querySelector('[role="alert"]')!.textContent)
      .toBe("Too many attempts. Try again in 12 minutes.");
  });
});

describe("sign-in offers account creation only where signup is open", () => {
  it.each([
    { deployment: "managed open", selfHost: false, publicSignup: true, joins: ["Create an account"] },
    { deployment: "managed invite-only", selfHost: false, publicSignup: false, joins: [] },
    { deployment: "self-hosted", selfHost: true, publicSignup: false, joins: [] },
    { deployment: "self-hosted with public signup set", selfHost: true, publicSignup: true, joins: [] },
  ])("$deployment shows only the signup action the deployment supports", async ({ selfHost, publicSignup, joins }) => {
    build.selfHost = selfHost;
    const page = await mountLogin({ publicSignup });

    expect([...page.querySelectorAll('a[href="/join"]')].map((link) => link.textContent)).toEqual(joins);
    expect(page.textContent?.includes("Create an account")).toBe(joins.length > 0);
    expect(page.textContent).not.toContain("Have an invite code?");
    expect(page.textContent).not.toMatch(/invite-only|by invitation|you can sign up|invite code is not required/i);
  });
});
