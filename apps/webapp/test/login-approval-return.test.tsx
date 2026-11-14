/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * AFTER THE ORDINARY SIGN-IN, BACK TO THE APPROVAL IT INTERRUPTED — by the request id the page
 * kept in this tab, never by a `?next=`. Without one kept, the sign-in lands where it always did.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const pushed: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => pushed.push(to), replace: (to: string) => pushed.push(to) }),
}));

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
  auth: {
    session: async () => { throw new Error("no session"); },
    login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
    totpVerify: async () => undefined,
    recoveryVerify: async () => undefined,
    webauthnAssertOptions: async () => ({ options: {} }),
    webauthnAssertVerify: async () => undefined,
  },
}));

let roots: Root[] = [];
beforeEach(() => {
  pushed.length = 0;
  sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const submit = async (el: HTMLElement): Promise<void> => {
  await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
};

async function signIn(): Promise<void> {
  const { SignInRoute: LoginScreen } = await import("../app/(product)/login/SignInRoute.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
  });
  await waitFor(() => container.querySelector("#login-email") != null, "the password step");
  await type(container.querySelector<HTMLInputElement>("#login-email")!, "mila@example.test");
  await type(container.querySelector<HTMLInputElement>("#login-pw")!, "correct horse");
  await submit(container);
  await waitFor(() => container.querySelector("#login-code") != null, "the code step");
  await type(container.querySelector<HTMLInputElement>("#login-code")!, "123456");
  await submit(container);
  await waitFor(() => pushed.length > 0, "the navigation after the factor");
}

describe("the sign-in returns to the approval by its id", () => {
  it("a kept request id brings the browser back to /approve for it", async () => {
    const { rememberApprovalRequest } = await import("../app/(product)/approve/approval-return.js");
    rememberApprovalRequest(ID);
    await signIn();
    expect(pushed).toEqual([`/approve?request=${ID}`]);
  }, 20000);

  it("with nothing kept, the sign-in lands on the app as before", async () => {
    await signIn();
    expect(pushed).toEqual(["/"]);
  }, 20000);
});
