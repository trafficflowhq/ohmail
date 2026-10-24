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
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
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
    expect(container.textContent).toContain("Your password first, then your second factor.");

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
      container.querySelector("form.login-totp")!
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

/**
 * WHAT THE CARD SAYS ABOUT SIGNING UP IS TRUE OF THIS DEPLOYMENT.
 *
 * Measured at that change: the note read "an invite code is not required" on every managed build,
 * `TF_PUBLIC_SIGNUP` or not, while `/join` chose its lead by that flag — so an invite-only beta
 * answered a stranger two ways in one visit. These read the RENDERED sentence, not the key: the
 * posture table next door is asserted by `signup-posture-claims.test.ts`, and a table nobody
 * renders is a guard about nothing.
 */
describe("the sign-in note states this deployment's posture", () => {
  it("an OPEN deployment says no invite code is needed", async () => {
    const note = (await mountLogin({ publicSignup: true }))
      .querySelector(".login-invite-note")!;
    expect(note.textContent).toContain("an invite code is not required");
    expect(note.textContent).not.toContain("invite-only");
  });

  it("an INVITE-ONLY deployment says so, and does not promise open signup", async () => {
    const note = (await mountLogin({ publicSignup: false }))
      .querySelector(".login-invite-note")!;
    expect(note.textContent).toContain("Accounts are by invitation during the beta");
    expect(note.textContent).not.toContain("not required");
  });

  it("an OPEN deployment offers 'Create an account' to /join; an invite-only one does not", async () => {
    const open = (await mountLogin({ publicSignup: true })).querySelector(".login-invite-note")!;
    const create = [...open.querySelectorAll("a")].find((a) => a.textContent === "Create an account");
    expect(create, "no sign-up link where anyone can sign up").toBeDefined();
    expect(create!.getAttribute("href")).toBe("/join");
    await act(async () => root!.unmount());
    host?.remove(); root = null; host = null;

    const gated = (await mountLogin({ publicSignup: false })).querySelector(".login-invite-note")!;
    expect(gated.textContent).not.toContain("Create an account");
  });

  it("…and the link to redeem a code survives in both postures", async () => {
    // The note changes; the way in for somebody holding a code does not.
    for (const publicSignup of [true, false]) {
      const note = (await mountLogin({ publicSignup })).querySelector(".login-invite-note")!;
      const redeem = [...note.querySelectorAll('a[href="/join"]')].map((a) => a.textContent);
      expect(redeem).toContain("Have an invite code?");
      if (root) await act(async () => root!.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });
});
