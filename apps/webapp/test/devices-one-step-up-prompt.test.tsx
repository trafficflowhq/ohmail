/** @vitest-environment jsdom */
import { WithReport } from "../../../packages/app/test/support/with-report.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * ONE STEP-UP PROMPT PER PRESS (DEVICES-SECTION-SECOND-PROMPT, ARCH-AUTH-SECOND-FACTOR § 2). A
 * press refused `step_up_required` parks its verb and asks for the second factor; the verified
 * factor re-runs the verb once. A second `step_up_required` after that is the pane's sentence,
 * `devices.stepUpExpired`, never a second prompt. The pane's own suite keeps the admit case.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer> = {};
let calls: Array<{ method: string; url: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  answers = {
    "GET /api/devices": { status: 200, body: { items: [] } },
    "GET /api/pair": { status: 200, body: { items: [] } },
  };
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = Object.entries(answers).find(([key]) => {
      const [m, path] = key.split(" ");
      return m === method && url.includes(path!);
    });
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

async function mountNode(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

async function mountSection(): Promise<HTMLElement> {
  const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
  return mountNode(h(WithReport, { view: DevicesSection }));
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const buttonByText = (c: ParentNode, text: string): HTMLButtonElement => {
  const b = [...c.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  expect(b, `a button reading "${text}"`).toBeTruthy();
  return b!;
};


describe("a second step_up_required after a verified factor", () => {
  const REFUSED = { status: 403, body: { error: { code: "step_up_required", message: "step-up verification required" } } };

  it("is the pane's sentence, not a second prompt, and the factor is asked once", async () => {
    answers["POST /api/pair"] = REFUSED;
    answers["GET /api/auth/session"] = {
      status: 200,
      body: { user: { twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } }, scope: "full" },
    };
    answers["POST /api/auth/step-up/totp"] = { status: 200, body: { ok: true } };
    const c = await mountSection();
    await click(buttonByText(c, "Add a device"));
    expect(c.querySelector('[data-testid="step-up-prompt"]'), "the first refusal asks for the factor").toBeTruthy();
    await type(c.querySelector<HTMLInputElement>("#stepup-code")!, "123456");
    await click(buttonByText(c, "Verify code"));
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    const mints = calls.filter((r) => r.method === "POST" && r.url.includes("/api/pair"));
    const stepUps = calls.filter((r) => r.method === "POST" && r.url.includes("/api/auth/step-up/"));
    expect(mints.length, "the verified factor re-ran the mint once").toBe(2);
    expect(stepUps.length).toBe(1);
    expect(c.querySelector('[data-testid="step-up-prompt"]'), "a second prompt opened").toBeNull();
    expect(c.textContent).toContain(messages.devices.stepUpExpired);
  });
});
