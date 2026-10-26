/** @vitest-environment jsdom */
/**
 * THE JOIN WIZARD'S LAST SCREEN DOES NOT SAY "YOU'RE SET UP" BEFORE THE ORGANIZE DECISION. The mailbox
 * is connected there and nothing has been agreed, so the screen names the step that is left and its press leads into
 * it (`/#/first-run` opens on "What ohmail will do to this mailbox"). A mailbox somebody already agreed to keeps
 * "You're set up" and "Open ohmail".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";

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

async function mountJoin(publicSignup = false, catalog: typeof messages = messages): Promise<HTMLElement> {
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: catalog === de ? "de" : "en", messages: catalog, timeZone: "UTC",
        children: h(JoinScreen, { initialCode: "", publicSignup }),
      }),
    );
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

const box = (over: Record<string, unknown> = {}) => ({
  id: "mb-1", address: "box@family.example", provider: "other", status: "connected", organizerRole: "reader",
  organizeConsentedAt: null, ...over,
});

describe("the join wizard's last screen and the organize decision", () => {
  it("a connected mailbox nobody agreed to: the decision is named as the step left, and the press leads into it", async () => {
    answers["/api/auth/session"] = { status: 200, body: sessionUser() };
    answers["/api/mailboxes"] = { status: 200, body: { items: [box()] } };
    const c = await mountJoin();
    expect(c.textContent).toContain(messages.join.step_connected_title);
    expect(c.textContent).toContain(messages.join.step_connected_lead);
    expect(c.textContent, "setup declared finished before the decision").not.toContain(messages.join.step_done_title);
    const link = [...c.querySelectorAll("a")].find((a) => a.textContent === messages.join.continue);
    expect(link?.getAttribute("href")).toBe("/#/first-run");
    expect([...c.querySelectorAll("a")].some((a) => a.textContent === messages.join.openOhmail)).toBe(false);
  });

  /* The rail's last stop is Organize, so a count of the steps left is the rail's to show, and the lead had
     it as "One step left" while the decision screen asks several questions. */
  for (const catalog of [messages, de]) {
    it(`${catalog === de ? "de" : "en"}: the lead names what comes next and counts no steps`, async () => {
      answers["/api/auth/session"] = { status: 200, body: sessionUser() };
      answers["/api/mailboxes"] = { status: 200, body: { items: [box()] } };
      const c = await mountJoin(false, catalog);
      const lead = c.querySelector(".sub")?.textContent ?? "";
      expect(lead).toBe(catalog.join.step_connected_lead);
      expect(lead).not.toMatch(/\b(one|two|three|\d+)\s+steps?\b|\b(ein|zwei|drei|\d+)\s+schritte?\b/i);
    });
  }

  it("CONTROL: a mailbox somebody already agreed to keeps \"You're set up\" and \"Open ohmail\"", async () => {
    answers["/api/auth/session"] = { status: 200, body: sessionUser() };
    answers["/api/mailboxes"] = { status: 200, body: { items: [box({ organizeConsentedAt: "2026-10-09T10:00:00.000Z" })] } };
    const c = await mountJoin();
    expect(c.textContent).toContain(messages.join.step_done_title);
    expect(c.textContent).not.toContain(messages.join.step_connected_title);
    const link = [...c.querySelectorAll("a")].find((a) => a.textContent === messages.join.openOhmail);
    expect(link?.getAttribute("href")).toBe("/#/first-run");
  });
});
