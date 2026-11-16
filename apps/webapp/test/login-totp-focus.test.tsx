/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * STA-F7 — THE CODE INPUT HAS FOCUS WHEN THE SECOND FACTOR ASKS FOR A CODE.
 *
 * A TOTP rolls every 30 seconds and the code step is the only time-boxed screen in the
 * product, yet after the password submit focus rested on nothing: the reader had to click
 * into the one input on the page before typing the code the clock was already eating.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
  auth: {
    // No live session: the form is the right answer.
    session: async () => {
      throw new Error("no session");
    },
    // The ceremony under test: password → a TOTP challenge and nothing else enrolled.
    login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
    totpVerify: async () => undefined,
    recoveryVerify: async () => undefined,
    webauthnAssertOptions: async () => ({ options: {} }),
    webauthnAssertVerify: async () => undefined,
  },
}));

let roots: Root[] = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

describe("STA-F7 — the TOTP step focuses its input", () => {
  it("after the password submit, the code field is the active element", async () => {
    const { SignInRoute: LoginScreen } = await import("../app/(product)/login/SignInRoute.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "UTC",
          now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(LoginScreen),
        }),
      );
    });

    await waitFor(() => container.querySelector("#login-email") != null, "the password step");
    await type(container.querySelector<HTMLInputElement>("#login-email")!, "mila@example.test");
    await type(container.querySelector<HTMLInputElement>("#login-pw")!, "correct horse");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    await waitFor(() => container.querySelector("#login-code") != null, "the code step");
    const code = container.querySelector<HTMLInputElement>("#login-code")!;
    expect(document.activeElement, "the time-boxed step must not cost an extra click").toBe(code);
  }, 20000);
});
