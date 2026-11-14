/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * `/login`, AS THE WEB SERVES IT: the sign-in's page over the sign-in's own ceremony (`use-sign-in-door.ts`, lifted
 * word for word). The real route and ceremony; only the client's requests and the router are stood in. What a person
 * and a password manager meet: the heading the journeys find, the two blanks by the names their labels give them and
 * by the ids and fill names the sign-in always carried, the code step that takes the keys and opens the number pad
 * for an authenticator's code (a plain keyboard for a recovery code), and the factors the account enrolled.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = messages.login;
const verified: Array<{ how: string; body: unknown }> = [];
/** Every sign-in that left for the server, with what it carried. */
const logins: Array<{ email: string; password: string }> = [];
/** An account that never finished its second factor: the server answers it with the enrollment session. */
const ENROLLING = "enrolling@example.test";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
  auth: {
    session: async () => {
      throw new Error("no session");
    },
    // A password answered by a challenge: an authenticator, recovery codes, and a passkey this browser cannot use.
    login: async (body: { email: string; password: string }) => {
      logins.push(body);
      if (body.email === ENROLLING) return { status: "enrollment" };
      return { status: "twofa_required", loginToken: "tok", methods: ["totp", "recovery_code", "webauthn"] };
    },
    totpVerify: async (body: unknown) => {
      verified.push({ how: "totp", body });
    },
    recoveryVerify: async (body: unknown) => {
      verified.push({ how: "recovery", body });
    },
    webauthnAssertOptions: async () => ({ options: {} }),
    webauthnAssertVerify: async () => undefined,
  },
}));

let roots: Root[] = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  verified.length = 0;
  logins.length = 0;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
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

async function mount(props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const { SignInRoute } = await import("../app/(product)/login/SignInRoute.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(SignInRoute, props) }));
  });
  return container;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(c: HTMLElement): Promise<void> {
  await act(async () => {
    c.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
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

/** A blank by the name its label gives it. */
const blank = (c: HTMLElement, name: string): HTMLInputElement | null => {
  const label = [...c.querySelectorAll("label")].find((l) => l.textContent === name);
  return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
};
const button = (c: HTMLElement, name: string): HTMLButtonElement | undefined =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.startsWith(name));

/** Signs in with a password, to the code step. */
async function toCode(c: HTMLElement): Promise<HTMLInputElement> {
  await waitFor(() => blank(c, L.emailLabel) !== null, "the password step");
  await type(blank(c, L.emailLabel)!, "mila@example.test");
  await type(blank(c, L.passwordLabel)!, "Correct horse battery");
  await submit(c);
  await waitFor(() => c.querySelector<HTMLInputElement>("#login-code") !== null, "the code step");
  return c.querySelector<HTMLInputElement>("#login-code")!;
}

describe("/login draws the sign-in's page over its ceremony", () => {
  it("the password step: the heading the journeys find, the two blanks by their names, ids and fill names", async () => {
    const c = await mount();
    await waitFor(() => blank(c, L.emailLabel) !== null, "the password step");
    expect(c.querySelector("h1")?.textContent).toBe(L.title.replace(/\.$/, ""));
    const email = blank(c, L.emailLabel)!;
    const password = blank(c, L.passwordLabel)!;
    /* No name on a blank, as the card's had none: a press before the page's script runs sends nothing typed. */
    expect([email.id, email.name, email.type, email.autocomplete]).toEqual(["login-email", "", "email", "username"]);
    expect([password.id, password.name, password.type, password.autocomplete]).toEqual([
      "login-pw",
      "",
      "password",
      "current-password",
    ]);
    expect(button(c, L.continue)).toBeTruthy();
  }, 20000);

  it("the code step takes the keys and opens the number pad for an authenticator's code; a recovery code a keyboard", async () => {
    const c = await mount();
    const code = await toCode(c);
    expect(document.activeElement, "the time-boxed step costs no extra click").toBe(code);
    expect([code.inputMode, code.autocomplete, code.name]).toEqual(["numeric", "one-time-code", ""]);
    /* Only the factors this account enrolled and this browser can use: no passkey here. */
    expect(button(c, L.usePasskey)).toBeUndefined();
    await act(async () => {
      button(c, L.useRecovery)!.click();
    });
    await waitFor(() => blank(c, L.recoveryLabel) !== null, "the recovery code's blank");
    expect(c.querySelector<HTMLInputElement>("#login-code")!.inputMode).toBe("text");
  }, 20000);

  it("a code sent goes through the ceremony once, with the code as typed", async () => {
    const c = await mount();
    const code = await toCode(c);
    await type(code, "123456");
    await submit(c);
    await waitFor(() => verified.length > 0, "the code verified");
    expect(verified).toEqual([{ how: "totp", body: { loginToken: "tok", code: "123456" } }]);
  }, 20000);

  it("Start over is a fresh password step: a login token is used once", async () => {
    const c = await mount();
    await toCode(c);
    await act(async () => {
      button(c, L.startOver)!.click();
    });
    await waitFor(() => blank(c, L.passwordLabel) !== null, "the password step again");
    expect(c.querySelector("#login-code")).toBeNull();
    /* The address outlives the start over; the password never does. */
    expect(blank(c, L.emailLabel)!.value).toBe("mila@example.test");
    expect(blank(c, L.passwordLabel)!.value).toBe("");
  }, 20000);

  it("a named continuation is said before the form", async () => {
    const c = await mount({ next: "/account/manage" });
    await waitFor(() => blank(c, L.emailLabel) !== null, "the password step");
    expect(c.textContent).toContain(L.continueManage);
  }, 20000);
});

/*
 * NOTHING LEAVES HALF FILLED, AND NOTHING TYPED OUTLIVES ITS ANSWER. The old card's blanks were `required`, so the
 * browser refused an empty form and nothing ran; the page holds the press itself. And the blanks are the ceremony's
 * own: the lifted line that empties the password the moment the server has answered empties the blank a person sees,
 * also where that answer is the enrollment session and the page stands while `/join` opens.
 */
describe("/login sends no half-filled sign-in, and keeps no password after the answer", () => {
  /** Settles what a press set going: the ceremony's checks before a sign-in leaves run on timers and promises. */
  const settled = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

  it("an empty press sends no sign-in: the address takes the keys and says it is wanted", async () => {
    const c = await mount();
    await waitFor(() => blank(c, L.emailLabel) !== null, "the password step");
    await submit(c);
    await settled();
    expect(logins).toEqual([]);
    expect(document.activeElement).toBe(blank(c, L.emailLabel));
    expect(blank(c, L.emailLabel)!.getAttribute("aria-invalid")).toBe("true");
  }, 20000);

  it("a press without a password sends no sign-in: the password takes the keys and says it is wanted", async () => {
    const c = await mount();
    await waitFor(() => blank(c, L.emailLabel) !== null, "the password step");
    await type(blank(c, L.emailLabel)!, "mila@example.test");
    await submit(c);
    await settled();
    expect(logins).toEqual([]);
    expect(document.activeElement).toBe(blank(c, L.passwordLabel));
    expect(blank(c, L.passwordLabel)!.getAttribute("aria-invalid")).toBe("true");
  }, 20000);

  it("after an enrollment answer the password blank is empty", async () => {
    const c = await mount();
    await waitFor(() => blank(c, L.emailLabel) !== null, "the password step");
    await type(blank(c, L.emailLabel)!, ENROLLING);
    await type(blank(c, L.passwordLabel)!, "Correct horse battery");
    await submit(c);
    await waitFor(() => logins.length > 0, "the sign-in left");
    await settled();
    expect(logins).toEqual([{ email: ENROLLING, password: "Correct horse battery" }]);
    const password = blank(c, L.passwordLabel)!;
    expect(password.value).toBe("");
    expect(password.getAttribute("value") ?? "").toBe("");
  }, 20000);
});
