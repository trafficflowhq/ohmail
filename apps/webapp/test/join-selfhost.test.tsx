/** @vitest-environment jsdom */
/**
 * ═══ THE /join WIZARD ON A SELF-HOST BUILD — NO PLAN STEP, NO VERIFY GATE, NO BILLING WIRE ═══
 *
 * The self-host route table carries no billing ("not refused: not built", `routes/self-host.ts`)
 * and composes the verified-address product gate OFF, so the wizard's managed journey has two
 * steps that CANNOT exist there: `plan` (its poll would 404 forever — the exact
 * discovered-absent-by-404 failure `/hello` negotiation exists to prevent) and `verify` (nothing
 * on the server refuses an unverified account, so its "we need this before you continue" copy
 * would be false). `SELF_HOST_BUILD` — the compiled flavor — removes both.
 *
 * What is pinned, deliberately at the WIRE rather than the label:
 *
 *  1. Resuming with everything enrolled lands on the MAILBOX step and `GET
 *     /billing/subscription` never leaves the client. The recorded mutation for this is
 *     reverting the self-host branch in `bootstrap()` — the wizard then parks on a plan step
 *     that loads forever, red here.
 *  2. The codes step's continue goes to the mailbox step, not `plan`.
 *  3. The progress rail never shows a Plan stop — a rail promising a step that cannot happen
 *     is the wizard describing a journey its server does not have.
 *
 * The real `JoinScreen`, the real `api-client`, only `fetch` and the router stubbed. The flavor
 * is set before the module graph loads — exactly how the build inlines it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE FLAVOR, before any module under test loads — the test-side twin of the build inlining it.
process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// One STABLE router — a per-render object would refire every [router]-dep effect (see
// setup-screen.test.tsx for the loop that produces).
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer> = {};
let calls: string[] = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const sessionUser = (over: Record<string, unknown> = {}) => ({
  user: {
    userId: "u1", accountId: "a1", email: "operator@family.example", displayName: "Pat",
    emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
    ...over,
  },
  scope: "full",
});

beforeEach(() => {
  answers = {};
  calls = [];
  router.replace.mockClear();
  router.push.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
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

async function mountJoin(publicSignup = false): Promise<HTMLElement> {
  const { JoinRoute: JoinScreen } = await import("../app/(product)/join/JoinRoute.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(JoinScreen, { initialCode: "", publicSignup }),
      }),
    );
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

describe("the self-host /join journey", () => {
  it("everything enrolled + no mailbox resumes on the MAILBOX step, and no billing request ever leaves", async () => {
    answers["/api/auth/session"] = { status: 200, body: sessionUser() };
    answers["/api/mailboxes"] = { status: 200, body: { items: [] } };
    const c = await mountJoin();

    // The mailbox step, not a plan step waiting on a route this server does not carry.
    expect(c.textContent).toContain("Connect a mailbox");
    expect(c.textContent).not.toContain("Choose your plan");
    // THE WIRE ASSERTION — the one the reverted composition cannot pass: the managed bootstrap
    // asks `GET /billing/subscription` before it will show a mailbox, and on this server that
    // route does not exist.
    expect(calls.some((u) => u.includes("/billing/"))).toBe(false);
  });

  it("the codes step's continue leads to the mailbox step, never `plan`", async () => {
    answers["/api/auth/session"] = {
      status: 200,
      body: sessionUser({ twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: false } }),
    };
    answers["/api/auth/2fa/recovery-codes"] = { status: 200, body: { codes: ["AAAA-" + "1111", "BBBB-" + "2222"] } };
    answers["/api/mailboxes"] = { status: 200, body: { items: [] } };
    const c = await mountJoin();

    expect(c.textContent).toContain("Save your recovery codes");
    const check = c.querySelector<HTMLElement>('input[type="checkbox"], [role="switch"]')!;
    await act(async () => {
      check.click();
      await Promise.resolve();
    });
    const goOn = [...c.querySelectorAll("button")].find((b) => b.textContent === "Continue")!;
    await act(async () => {
      goOn.click();
      await Promise.resolve();
    });

    expect(c.textContent).toContain("Connect a mailbox");
    expect(c.textContent).not.toContain("Choose your plan");
    expect(calls.some((u) => u.includes("/billing/"))).toBe(false);
  });

  it("the invite step's reason is the self-host one, never the managed beta sentence", async () => {
    // Anonymous visitor: the bootstrap's `GET /auth/session` 401s and is caught, so the
    // wizard stands on the invite step — where the lead sentence claims WHY a code is needed.
    // On this box invitation is the permanent design, not a beta condition.
    answers["/api/auth/session"] = { status: 401 };
    const c = await mountJoin();

    expect(c.textContent).toContain("Accounts on this server are created by invitation.");
    expect(c.textContent).not.toContain("invite-only during the beta");
  });

  it("a server that still asks for a code sends the visitor to its operator, never to the managed support address", async () => {
    // The web container armed for open signup and the API not: the wizard's deploy-skew branch.
    answers["/api/auth/session"] = { status: 401 };
    answers["/api/auth/register"] = { status: 400, body: { error: { code: "validation_failed", message: "inviteCode required" } } };
    const c = await mountJoin(true);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [id, value] of [["#join-email", "person@family.example"], ["#join-name", "Sam"], ["#join-pw", "a long enough password"]]) {
      await act(async () => {
        const input = c.querySelector<HTMLInputElement>(id!)!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => {
      c.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(calls.some((u) => u.includes("/auth/register")), "the register ran").toBe(true);
    const alert = c.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain(messages.join.inviteRequiredAfterAllSelfHost);
    expect(alert).not.toContain("support@ohmail.app");
  });

  it("the rail never promises a Plan stop on a server that sells nothing", async () => {
    answers["/api/auth/session"] = { status: 200, body: sessionUser() };
    answers["/api/mailboxes"] = { status: 200, body: { items: [] } };
    const c = await mountJoin();

    const stations = [...c.querySelectorAll("ol, ul")].find((l) => l.getAttribute("aria-label") === messages.join.progress);
    const railLabels = [...(stations?.querySelectorAll("li") ?? [])].map((el) => el.textContent);
    expect(railLabels).not.toContain("Plan");
    expect(railLabels).toContain("Mailbox");
  });
});
