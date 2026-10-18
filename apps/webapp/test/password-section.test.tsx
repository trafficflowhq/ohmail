/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * SETTINGS → ACCOUNT, CHANGING THE PASSWORD, against `POST /auth/password`'s answers. The change is
 * tried first: a closed step-up window parks the typed values and asks for the factor, and the
 * verified factor sends the same change once. A wrong current password is `credential_refused` —
 * an answer, said in place, never renewed and sent again and never the sign-in dead end. Every
 * attempt leaves the three fields empty. The pane is reachable from Settings → Account and from
 * the wall a refused account sees.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { status: number; body?: unknown };
/** Each key answers its list in order; the last answer repeats. */
let answers: Record<string, Answer[]> = {};
let calls: Array<{ method: string; url: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const CURRENT = "pw-correct-horse-password";
const NEXT = "new-battery-staple-password";
const STEP_UP_REQUIRED: Answer = {
  status: 403, body: { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } },
};

beforeEach(() => {
  answers = {
    "GET /api/auth/session": [{
      status: 200,
      body: { user: { twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } }, scope: "full" },
    }],
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
    const list = hit[1];
    const a = list.length > 1 ? list.shift()! : list[0]!;
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

async function mountNode(node: React.ReactNode, locale: "en" | "de" = "en"): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "en" ? en : de, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
    await Promise.resolve();
  });
  await settle();
  return host;
}

async function mount(locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const { PasswordSection } = await import("../app/(product)/mailbox/PasswordSection.js");
  return mountNode(h(PasswordSection), locale);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await settle();
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

const fields = (c: ParentNode): HTMLInputElement[] =>
  ["#pwc-current", "#pwc-next", "#pwc-repeat"].map((s) => c.querySelector<HTMLInputElement>(s)!);

async function fill(c: ParentNode, current: string, next: string, repeat = next): Promise<void> {
  const [a, b, r] = fields(c);
  await type(a!, current);
  await type(b!, next);
  await type(r!, repeat);
}

async function verifyCode(c: ParentNode): Promise<void> {
  await type(c.querySelector<HTMLInputElement>("#stepup-code")!, "123456");
  await click(buttonByText(c, en.devices.stepUpVerify));
}

const changes = () => calls.filter((r) => r.method === "POST" && r.url.includes("/api/auth/password"));

describe("changing the password", () => {
  it("a closed window asks for the factor, and the verified factor sends the same change once", async () => {
    answers["POST /api/auth/password"] = [STEP_UP_REQUIRED, { status: 200, body: { revoked: 2 } }];
    answers["POST /api/auth/step-up/totp"] = [{ status: 200, body: { ok: true } }];
    const c = await mount();
    await fill(c, CURRENT, NEXT);
    await click(buttonByText(c, en.passwordChange.submit));

    expect(c.querySelector('[data-testid="step-up-prompt"]'), "the refusal asks for the factor").toBeTruthy();
    // The typed values left the page with the attempt; the factor sends what was parked.
    expect(c.querySelector("#pwc-current")).toBeNull();
    await verifyCode(c);

    expect(changes().map((r) => r.body)).toEqual([
      { currentPassword: CURRENT, newPassword: NEXT }, { currentPassword: CURRENT, newPassword: NEXT },
    ]);
    expect(calls.filter((r) => r.url.includes("/api/auth/step-up/"))).toHaveLength(1);
    expect(c.querySelector('[data-testid="step-up-prompt"]')).toBeNull();
    expect(c.textContent).toContain("2 other sessions were signed out");
    expect(fields(c).map((f) => f.value)).toEqual(["", "", ""]);
  });

  it("a second step-up refusal after the factor is the sign-in sentence, never a second prompt", async () => {
    answers["POST /api/auth/password"] = [STEP_UP_REQUIRED];
    answers["POST /api/auth/step-up/totp"] = [{ status: 200, body: { ok: true } }];
    const c = await mount();
    await fill(c, CURRENT, NEXT);
    await click(buttonByText(c, en.passwordChange.submit));
    await verifyCode(c);

    expect(changes()).toHaveLength(2);
    expect(c.querySelector('[data-testid="step-up-prompt"]')).toBeNull();
    expect(c.textContent).toContain(en.devices.stepUpExpired);
  });

  it("a wrong current password is said in place: no renewal, no navigation, the fields empty", async () => {
    answers["POST /api/auth/password"] = [
      { status: 401, body: { error: { code: "credential_refused", message: "current password is incorrect" } } },
    ];
    answers["POST /api/auth/refresh"] = [{ status: 200, body: {} }];
    const where = window.location.href;
    const c = await mount();
    await fill(c, "wrong-guess-password", NEXT);
    await click(buttonByText(c, en.passwordChange.submit));

    expect(c.textContent).toContain(en.passwordChange.wrongCurrent);
    expect(c.textContent).not.toContain(en.devices.stepUpExpired);
    expect(calls.filter((r) => r.url.includes("/auth/refresh")), "a verdict was renewed and sent again").toEqual([]);
    expect(changes()).toHaveLength(1);
    expect(window.location.href).toBe(where);
    expect(c.querySelector('[data-testid="step-up-prompt"]')).toBeNull();
    expect(fields(c).map((f) => f.value)).toEqual(["", "", ""]);
  });

  it("a session's own 401 is the sign-in sentence, never the wrong-password one", async () => {
    answers["POST /api/auth/password"] = [
      { status: 401, body: { error: { code: "unauthorized", message: "no active session" } } },
    ];
    const c = await mount();
    await fill(c, CURRENT, NEXT);
    await click(buttonByText(c, en.passwordChange.submit));

    expect(c.textContent).toContain(en.devices.stepUpExpired);
    expect(c.textContent).not.toContain(en.passwordChange.wrongCurrent);
  });

  it("a locked client is told how long to wait", async () => {
    answers["POST /api/auth/password"] = [
      { status: 423, body: { error: { code: "account_locked", message: "too many failed attempts", details: { retryAfter: 600 } } } },
    ];
    const c = await mount();
    await fill(c, CURRENT, NEXT);
    await click(buttonByText(c, en.passwordChange.submit));

    expect(c.textContent).toContain("Try again in 10 minutes");
    expect(c.querySelector('[data-testid="step-up-prompt"]')).toBeNull();
    expect(fields(c).map((f) => f.value)).toEqual(["", "", ""]);
  });

  it("two new passwords that differ, or a short one, are said before anything is sent", async () => {
    const c = await mount();
    await fill(c, CURRENT, NEXT, "new-battery-staple-passwort");
    await click(buttonByText(c, en.passwordChange.submit));
    expect(c.textContent).toContain(en.passwordChange.mismatch);
    expect(fields(c).map((f) => f.value)).toEqual(["", "", ""]);

    await fill(c, CURRENT, "password-1x");
    await click(buttonByText(c, en.passwordChange.submit));
    expect(c.textContent).toContain(en.passwordChange.tooShort);
    expect(changes()).toEqual([]);
  });

  it("German renders German, and every key is in both catalogues", async () => {
    expect(Object.keys(de.passwordChange).sort()).toEqual(Object.keys(en.passwordChange).sort());
    expect(de.accessLock.changePassword).toBeTruthy();
    const c = await mount("de");
    expect(c.textContent).toContain(de.passwordChange.title);
    expect(c.textContent).not.toContain(en.passwordChange.title);
    buttonByText(c, de.passwordChange.submit);
  });
});

describe("where the pane is reached", () => {
  it("Settings → Account renders it above the account's own cards, on every build", () => {
    /* Comments blanked: a mention in prose is not a mount. `CloudShell` serves the managed and
       the self-hosted build alike (`SELF_HOST_BUILD` chooses nothing here). */
    const src = readFileSync(resolve(process.cwd(), "apps/webapp/app/(product)/mailbox/CloudShell.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
    expect(src).toContain("accountSection={<><PasswordSection /><AccountSection /></>}");
  });

  it("the wall opens it by a press, and takes no password before the press", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock.js");
    const c = await mountNode(h(AccessLock, {
      facts: { reason: "payment_required" as const, manageUrl: "https://manage.example/t" },
    }));
    expect(c.querySelectorAll("input[type=password]")).toHaveLength(0);
    // The wall's three actions are unchanged; the door stands beside the way out.
    expect([...c.querySelectorAll(".wall-act")].map((b) => b.textContent))
      .not.toContain(en.accessLock.changePassword);

    await click(buttonByText(c, en.accessLock.changePassword));
    expect(c.querySelector("#pwc-current"), "the press opened the password change").toBeTruthy();
    expect(changes(), "opening it sent nothing").toEqual([]);

    await click(buttonByText(c, en.accessLock.back));
    expect(c.querySelector("#pwc-current")).toBeNull();
    buttonByText(c, en.accessLock.signOut);
  });
});
