/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { fixturePassword, personalAt } from "../../../test/support/fixture-credentials.js";

const router = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function mount(messages: typeof en, route: "request" | "complete" | "missing" | "join" | "invite") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_BASE", "/api");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const unauthenticated = /\/auth\/(session|refresh)$/.test(String(input));
    return new Response(unauthenticated ? '{"error":{"code":"unauthorized"}}' : '{"status":"ok"}', {
      status: unauthenticated ? 401 : 200,
      headers: { "content-type": "application/json" },
    });
  }));
  const React = await import("react");
  vi.stubGlobal("React", React);
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { ForgotPasswordRoute } = await import("../app/(product)/forgot-password/ForgotPasswordRoute.js");
  const { ResetPasswordRoute } = await import("../app/(product)/reset-password/ResetPasswordRoute.js");
  const { JoinRoute } = await import("../app/(product)/join/JoinRoute.js");
  const join = route === "join" || route === "invite";
  const path = join ? "/join" : route === "request" ? "/forgot-password" : "/reset-password";
  window.history.replaceState(null, "", path);
  const screen = join
    ? React.createElement(JoinRoute, { initialCode: "", publicSignup: route === "join" })
    : route === "request"
      ? React.createElement(ForgotPasswordRoute)
      : React.createElement(ResetPasswordRoute, { initialToken: route === "complete" ? "fixture" : "" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: messages === de ? "de" : "en",
      messages,
      timeZone: "UTC",
      children: screen,
    }));
  });
  const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  return {
    text: () => host.textContent,
    signIn: () => [...host.querySelectorAll('a[href="/login"]')].map((a) => a.textContent),
    image: (label: string) => host.querySelector(`[role="img"][aria-label="${label}"]`),
    field,
    type: async (label: string, value: string) => {
      const input = field(label);
      expect(input).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    submit: async () => {
      const button = host.querySelector<HTMLButtonElement>('button[type="submit"]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
    },
  };
}

it("the reset request and its confirmation link back to sign-in from a direct visit", async () => {
  const ui = await mount(en, "request");
  expect(ui.signIn()).toEqual([en.passwordReset.signIn]);
  await ui.type(en.passwordReset.emailLabel, personalAt("fixture.customer", "example.invalid"));
  await ui.submit();
  expect(ui.text()).toContain(en.passwordReset.sendAgain);
  expect(ui.signIn()).toEqual([en.passwordReset.signIn]);
});

it("the new-password form and its confirmation link back to sign-in in German", async () => {
  const ui = await mount(de, "complete");
  expect(ui.signIn()).toEqual([de.passwordReset.signIn]);
  const password = fixturePassword("password-reset-sign-in");
  await ui.type(de.passwordReset.passwordLabel, password);
  await ui.type(de.passwordReset.repeatLabel, password);
  await ui.submit();
  expect(ui.text()).toContain(de.passwordReset.doneLine);
  expect(ui.signIn()).toEqual([de.passwordReset.signIn]);
});

it("a reset link that cannot be used offers sign-in alongside a fresh link", async () => {
  const ui = await mount(en, "missing");
  expect(ui.text()).toContain(en.passwordReset.newLink);
  expect(ui.signIn()).toEqual([en.passwordReset.signIn]);
});

it("a direct invite-step visit offers sign-in", async () => {
  const ui = await mount(en, "invite");
  expect(ui.field(en.join.inviteLabel)).not.toBeNull();
  expect(ui.signIn()).toEqual([en.join.signIn]);
});

it.each([
  { messages: en, hint: "At least 12 characters, 9 to go.", label: "Password length: 3 of 12" },
  { messages: de, hint: "Mindestens 12 Zeichen, noch 9.", label: "Passwortlänge: 3 von 12" },
])("keeps the short password hint visible and described by the field ($label)", async ({ messages, hint, label }) => {
  const ui = await mount(messages, "join");
  const passwordLabel = messages.join.passwordLabel;
  await ui.type(passwordLabel, "abc");
  const field = ui.field(passwordLabel)!;
  const description = document.getElementById(field.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toBe(hint);
  expect(ui.image(label)).not.toBeNull();
  await ui.type(passwordLabel, fixturePassword("signup-length"));
  expect(ui.text()).not.toContain(hint);
  expect(field.hasAttribute("aria-describedby")).toBe(false);
});
