/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";

/**
 * THE HOSTS' OWN GUARD. `StepUpPrompt` ends its ceremony when it unmounts; the erase and the
 * password change also refuse a verified callback that reaches a pane no longer mounted, so a
 * regression in the prompt is not an erase. The prompt is stood in for: it hands its `onVerified`
 * to the test, which calls it after the pane is gone. StrictMode is the control: its replayed
 * effects must not read as gone.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rig = vi.hoisted(() => ({ onVerified: null as null | (() => void), wipes: 0 }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("../app/sign-out", () => ({
  forgetThisBrowser: async () => {
    rig.wipes += 1;
    return { remaining: [], inventoryComplete: true };
  },
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));

vi.mock("../app/(product)/mailbox/StepUpPrompt", () => ({
  StepUpPrompt: (props: { onVerified: () => void }) => {
    rig.onVerified = props.onVerified;
    return h("div", { "data-testid": "step-up-prompt" });
  },
}));

const EMAIL = "person@example.test";
const ERASE = "DELETE /api/account";
const CHANGE = "POST /api/auth/password";
const STEP_UP_REQUIRED = { error: { code: "step_up_required", message: "recent two-factor authentication required" } };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let wire: string[] = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const sent = (line: string): number => wire.filter((l) => l === line).length;

beforeEach(() => {
  wire = [];
  rig.onVerified = null;
  rig.wipes = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input), "http://localhost").pathname}`;
    wire.push(line);
    if (line === "GET /api/auth/session") {
      return json(200, {
        user: { id: "u1", accountId: "acct-under-test", email: EMAIL, twofaEnrolled: { webauthn: false, totp: true } },
        scope: "full",
      });
    }
    if (line === ERASE) {
      return sent(ERASE) === 1
        ? json(403, STEP_UP_REQUIRED)
        : json(200, { erased: true, retained: "one billing row", subscription: "none" });
    }
    if (line === CHANGE) return sent(CHANGE) === 1 ? json(403, STEP_UP_REQUIRED) : json(200, { revoked: 1 });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  (await import("../app/shell/account-erased.js")).clearAccountErased();
  vi.restoreAllMocks();
});

async function mount(which: "account" | "password", strict = false): Promise<HTMLElement> {
  const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
  const { PasswordSection } = await import("../app/(product)/mailbox/PasswordSection.js");
  const pane = h(which === "account" ? AccountSection : PasswordSection);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const tree = h(NextIntlClientProvider, {
    locale: "en", messages: en, timeZone: "UTC",
    children: h(ThemeProvider, null, h(ToastHost, null, pane)),
  });
  // Outermost, as the app's root has it: React replays effects only under a StrictMode placed above.
  await act(async () => {
    root!.render(strict ? h(React.StrictMode, null, tree) : tree);
  });
  return host;
}

async function turns(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: Element): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** Tries the verb; the closed window parks it behind the (stand-in) prompt. */
async function toThePrompt(c: HTMLElement, which: "account" | "password"): Promise<void> {
  if (which === "account") {
    await waitFor(() => c.querySelector("#acct-typed") != null, "the typed-address step");
    await type(c.querySelector<HTMLInputElement>("#acct-typed")!, EMAIL);
    await submit(c.querySelector("#acct-typed")!.closest("form")!);
  } else {
    await waitFor(() => c.querySelector("#pwc-current") != null, "the password form");
    await type(c.querySelector<HTMLInputElement>("#pwc-current")!, "old-correct-horse-password");
    await type(c.querySelector<HTMLInputElement>("#pwc-next")!, "new-battery-staple-password");
    await type(c.querySelector<HTMLInputElement>("#pwc-repeat")!, "new-battery-staple-password");
    await submit(c.querySelector("#pwc-current")!.closest("form")!);
  }
  await waitFor(() => c.querySelector('[data-testid="step-up-prompt"]') != null, "the prompt");
  expect(rig.onVerified, "the prompt was handed its onVerified").toBeTruthy();
}

/** The factor verified, as the prompt reports it. */
async function verified(): Promise<void> {
  const call = rig.onVerified!;
  await act(async () => {
    call();
  });
  await turns();
}

const ARMS = [
  { which: "account" as const, verb: ERASE },
  { which: "password" as const, verb: CHANGE },
];

describe("a verified factor that reaches a pane no longer mounted sends nothing", () => {
  for (const { which, verb } of ARMS) {
    it(`${which}: the pane is gone, then the factor reports verified — ${verb} is not sent`, async () => {
      const c = await mount(which);
      await toThePrompt(c, which);
      expect(sent(verb)).toBe(1);

      await act(async () => root!.unmount());
      root = null;
      await verified();

      expect(sent(verb), `${verb} went out for a pane that was gone`).toBe(1);
      expect(rig.wipes).toBe(0);
    });

    it(`CONTROL ${which}: the pane is there — ${verb} is sent once more`, async () => {
      const c = await mount(which);
      await toThePrompt(c, which);
      await verified();
      expect(sent(verb)).toBe(2);
    });

    it(`CONTROL ${which} under StrictMode: the replayed effects do not read as gone`, async () => {
      const c = await mount(which, true);
      await toThePrompt(c, which);
      await verified();
      expect(sent(verb), "a mounted pane refused its own verified factor").toBe(2);
    });
  }
});
