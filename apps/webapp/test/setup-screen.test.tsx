/** @vitest-environment jsdom */
/**
 * ═══ THE SELF-HOST FIRST-RUN PAGE — SERVER-GATED, ONE SUBMIT, HONEST REFUSALS ═══════════════
 *
 * `/setup` is the ceremony a fresh server's `needsSetup: true` steers to: paste the setup token
 * the server printed at boot, choose the first account's sign-in, and the page drives
 * redeem → register → `/join`. Four properties are load-bearing and each is pinned here:
 *
 *  1. **The form exists only while the SERVER says the ceremony does.** A fresh `GET /hello`
 *     with `needsSetup: true` is the ONLY state that renders the token form; `false` renders
 *     "already set up" with no token input anywhere — a setup page offered on an established
 *     server would advertise a token the server actively revokes. The mutation for this is
 *     forcing the phase to `setup` regardless of the answer; the settled test goes red.
 *  2. **One submit performs redeem THEN register, threading the minted code.** The setup token
 *     is single-use; splitting the two across screens would strand anyone who fell between.
 *     The happy path asserts the register body carries the code the redeem answered — the wire
 *     order, not a label.
 *  3. **A wrong token is THIS form's sentence, not the service's.** `pairing_invalid`'s wire
 *     message ends "ask whoever minted it for a fresh one" — wrong for the one token the SERVER
 *     mints. The form must say where the real remedy is (the log, a restart) and must not crash.
 *  4. **A live session routes to `/join` instead of "already set up".** The common reload:
 *     register just flipped needsSetup false, and the person mid-enrollment must land back in
 *     the wizard, not be told somebody else got there first.
 *
 * The real `SetupScreen`, the real `api-client`, only `fetch` and the router stubbed — the
 * login suite's exact harness.
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

const replace = vi.fn();
// ONE router object, stable across renders — Next's real `useRouter` is. A mock that mints a
// fresh object per render makes every `[router]`-dep effect refire per render, which turns the
// mount's /hello check into an infinite loop the real app cannot have.
const router = { replace, push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

type Answer = { status: number; body?: unknown };
/** Scripted answers by path, plus a RECORD of every request — the wire is what the suite reads. */
let answers: Record<string, Answer> = {};
let calls: Array<{ url: string; body: unknown; bounded: boolean }> = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const coded = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

const HELLO_FRESH = {
  status: 200,
  body: {
    product: "ohmail", flavor: "selfhost", apiVersion: "0.0.0", needsSetup: true,
    auth: { password: true, totp: true, webauthn: true, publicSignup: false },
    features: { sse: true, staging: true, ai: false, pairing: true },
  },
};
const HELLO_SETTLED = { ...HELLO_FRESH, body: { ...HELLO_FRESH.body, needsSetup: false } };

beforeEach(() => {
  answers = {
    "/api/hello": HELLO_FRESH,
    // The settled branch probes the session; a fresh server has none.
    "/api/auth/session": coded(401, "unauthorized", "authentication required"),
  };
  calls = [];
  replace.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      bounded: init?.signal instanceof AbortSignal,
    });
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

async function mountSetup(): Promise<HTMLElement> {
  const { SetupScreen } = await import("../app/(product)/setup/SetupScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(SetupScreen) }),
    );
    await Promise.resolve();
  });
  // The mount's /hello (and, on the settled branch, /auth/session) settle before assertions.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fillAndSubmit(container: HTMLElement): Promise<void> {
  await type(container.querySelector<HTMLInputElement>("#setup-token")!, "first-run-setup-boot-fixture-token");
  await type(container.querySelector<HTMLInputElement>("#setup-email")!, "operator@family.example");
  await type(container.querySelector<HTMLInputElement>("#setup-name")!, "Pat Operator");
  await type(container.querySelector<HTMLInputElement>("#setup-pw")!, "correct horse battery staple");
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("the gate — the form exists exactly while /hello says needsSetup:true", () => {
  it("a fresh server renders the ceremony: token, email, name, password", async () => {
    const c = await mountSetup();
    expect(c.textContent).toContain("Set up your ohmail server");
    expect(c.querySelector("#setup-token"), "the token field is the ceremony").not.toBeNull();
    // WHERE the token comes from, said plainly on the page — the operator's one real question.
    expect(c.textContent).toContain("docker compose logs api");
    // THE GATE'S FETCH IS BOUNDED. A blackholed proxy that accepts the connection and never
    // answers must become the retry card, not an eternal "Checking with your server…" — the
    // browser's fetch has no application timeout of its own, so the signal is the whole bound.
    const hello = calls.find((r) => r.url.includes("/api/hello"));
    expect(hello?.bounded, "the /hello probe must carry an abort signal").toBe(true);
  });

  it("a server WITH accounts never shows the form — needsSetup:false renders 'already set up'", async () => {
    answers["/api/hello"] = HELLO_SETTLED;
    const c = await mountSetup();
    expect(c.querySelector("#setup-token"), "a token form on an established server advertises a credential the server revokes").toBeNull();
    expect(c.textContent).toContain("Already set up");
    // The exit is sign-in, not a dead end.
    expect(c.querySelector('a[href="/login"]')).not.toBeNull();
  });

  it("needsSetup:false with a LIVE session routes to /join — the mid-enrollment reload", async () => {
    answers["/api/hello"] = HELLO_SETTLED;
    answers["/api/auth/session"] = {
      status: 200,
      body: {
        user: {
          userId: "u1", email: "operator@family.example", displayName: "Pat",
          emailVerified: true, twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
        },
        scope: "enrollment",
      },
    };
    await mountSetup();
    expect(replace).toHaveBeenCalledWith("/join");
  });

  it("an unreachable server renders the retry card, never the form", async () => {
    answers["/api/hello"] = coded(503, "hello_unavailable", "this host could not determine its setup state");
    const c = await mountSetup();
    expect(c.querySelector("#setup-token")).toBeNull();
    expect(c.textContent).toContain("Can't reach the server");
  });
});

describe("the ceremony — one submit drives redeem, then register with the minted code", () => {
  it("happy path: /pair/redeem answers a code, register carries it, and the page hands off to /join", async () => {
    answers["/api/pair/redeem"] = {
      status: 200,
      body: { grant: "invite", invite: { code: "OHMAIL-AAAA-BBBB-CCCC", email: "operator@family.example", expiresAt: "2026-01-01T00:00:00.000Z" } },
    };
    answers["/api/auth/register"] = {
      status: 201,
      body: {
        user: {
          userId: "u1", email: "operator@family.example", displayName: "Pat Operator",
          emailVerified: true, twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
        },
        scope: "enrollment",
      },
    };
    const c = await mountSetup();
    await fillAndSubmit(c);

    const redeem = calls.find((r) => r.url.includes("/api/pair/redeem"));
    expect(redeem, "the redeem never left").toBeTruthy();
    expect(redeem!.body).toMatchObject({
      grant: "invite", token: "first-run-setup-boot-fixture-token", email: "operator@family.example",
    });

    const register = calls.find((r) => r.url.includes("/api/auth/register"));
    expect(register, "the register never left").toBeTruthy();
    // THE THREAD: the code register spends is the one the redeem minted — the wire order that
    // makes this a ceremony rather than two disconnected forms.
    expect(register!.body).toMatchObject({
      email: "operator@family.example", displayName: "Pat Operator",
      inviteCode: "OHMAIL-AAAA-BBBB-CCCC",
    });
    expect(calls.findIndex((r) => r.url.includes("/pair/redeem")))
      .toBeLessThan(calls.findIndex((r) => r.url.includes("/auth/register")));

    expect(replace).toHaveBeenCalledWith("/join");
  });

  it("a wrong or expired token gets THIS form's sentence — the log and the restart, not 'ask whoever minted it'", async () => {
    answers["/api/pair/redeem"] = coded(400, "pairing_invalid",
      "That pairing token is not valid. Ask whoever minted it for a fresh one.");
    const c = await mountSetup();
    await fillAndSubmit(c);

    const alert = c.querySelector('[role="alert"]');
    expect(alert, "the refusal must be said, not crashed on").not.toBeNull();
    // The service's sentence is written for USER-minted pairing tokens; this token's minter is
    // the server itself, so the wire message's remedy is wrong here and must not render.
    expect(alert!.textContent).not.toContain("whoever minted it");
    expect(alert!.textContent).toContain("server log");
    // No register attempt rode behind the failed redeem, and the form survives for a retry.
    expect(calls.some((r) => r.url.includes("/auth/register"))).toBe(false);
    expect(c.querySelector("#setup-token")).not.toBeNull();
  });

  it("a register refusal AFTER a successful redeem keeps the minted code — the retry must not re-burn the token", async () => {
    answers["/api/pair/redeem"] = {
      status: 200,
      body: { grant: "invite", invite: { code: "OHMAIL-DDDD-EEEE-FFFF", email: "operator@family.example", expiresAt: "2026-01-01T00:00:00.000Z" } },
    };
    answers["/api/auth/register"] = coded(400, "validation_failed", "password must be at least 12 characters");
    const c = await mountSetup();
    await fillAndSubmit(c);
    expect(c.querySelector('[role="alert"]')!.textContent).toContain("password");

    // Fix the password, submit again: the redeem is NOT repeated (the token is spent), the
    // register goes out with the SAME minted code.
    answers["/api/auth/register"] = {
      status: 201,
      body: {
        user: {
          userId: "u1", email: "operator@family.example", displayName: "Pat Operator",
          emailVerified: true, twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
        },
        scope: "enrollment",
      },
    };
    await type(c.querySelector<HTMLInputElement>("#setup-pw")!, "a much longer correct password");
    await act(async () => {
      c.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const redeems = calls.filter((r) => r.url.includes("/pair/redeem"));
    expect(redeems, "a second redeem would burn a token that no longer exists").toHaveLength(1);
    const registers = calls.filter((r) => r.url.includes("/auth/register"));
    expect(registers).toHaveLength(2);
    expect((registers[1]!.body as { inviteCode?: string }).inviteCode).toBe("OHMAIL-DDDD-EEEE-FFFF");
    expect(replace).toHaveBeenCalledWith("/join");
  });
});
