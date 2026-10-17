/** @vitest-environment jsdom */
/**
 * THE SIGNUP'S FINISHING DETAILS, each one a walked fault. The authenticator fallback was a 32-letter key
 * with no QR, no grouping and no Copy, its refusal far from the field. A typo in the address had no way
 * back. The rail painted every station undone on "Check your email" and put Email after Recovery,
 * though the open path confirms the address first, with no aria-current. The recovery codes could only be
 * written down. The dead-link page named sign-in with no control for it. The Checkout session id stayed
 * in the address bar after the return. Two text buttons were 18px tall.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base32Seed, managedAddress, personalAt } from "../../../test/support/fixture-credentials.js";
import en from "../messages/en.json";

type Answer = { status: number; body: unknown };
/** The authenticator's setup key the enrollment answers, derived as every fixture key is. */
const SEED = base32Seed("join-finishing-details");
/** A fixture address at a provider's domain, as typed; `dotless` drops the domain's dots, as a thumb does. */
const typed = (name: string, domain: string, dotless = false): string => {
  const a = personalAt(`fixture.${name}`, domain);
  return dotless ? a.replace(domain, domain.replace(/\./g, "")) : a;
};
const user = (over: Record<string, unknown> = {}) => ({
  userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
  twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false }, ...over,
});
const NO_SESSION: Answer = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
const CODES = ["aaaa-bbbb", "cccc-dddd", "eeee-ffff", "gggg-hhhh"];

let session: Answer = NO_SESSION;
let answers: Record<string, Answer> = {};
let sent: Array<{ path: string; body: unknown }> = [];
let clipboard: string[] = [];
let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  session = NO_SESSION;
  answers = {};
  sent = [];
  clipboard = [];
  window.history.replaceState(null, "", "/join");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async (s: string) => { clipboard.push(s); } },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(input), "http://x").pathname.replace(/^\/api/, "");
    const json = (a: Answer) =>
      new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    if (init?.body !== undefined) sent.push({ path, body: JSON.parse(String(init.body)) });
    if (path === "/auth/session") return json(session);
    if (answers[path]) return json(answers[path]!);
    if (path === "/auth/2fa/totp/enroll") {
      return json({ status: 200, body: { secret: SEED, otpauthUrl: `otpauth://totp/ohmail:fixture?secret=${SEED}&issuer=ohmail` } });
    }
    if (path === "/auth/2fa/recovery-codes") return json({ status: 200, body: { codes: CODES } });
    if (path === "/account/access") return json({ status: 200, body: { access: "refused", metered: true, canAddMailbox: false, mailboxes: 0 } });
    if (path === "/account/manage-link") return json({ status: 200, body: { url: "https://plane.example/manage?token=t" } });
    if (path.startsWith("/mailboxes")) return json({ status: 200, body: { items: [] } });
    return json({ status: 200, body: {} });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function render(screen: "join" | "verify", props: Record<string, unknown> = {}) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const node = screen === "join"
    ? React.createElement((await import("../app/(product)/join/JoinScreen.js")).JoinScreen, { initialCode: "", publicSignup: true, ...props })
    : React.createElement((await import("../app/(product)/verify-email/VerifyEmailScreen.js")).VerifyEmailScreen, { initialToken: "tok" });
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: node }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  const type = async (id: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`);
    expect(input, `#${id} is not on screen`).toBeTruthy();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const press = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button, `no "${label}" button`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const rail = () => [...host.querySelectorAll(".join-rail li")].map((li) => ({
    label: li.textContent, state: li.getAttribute("data-state"), current: li.getAttribute("aria-current"),
  }));
  return { host, type, press, rail, settle };
}

describe("the rail on the open path", () => {
  it("Email is the second station, and the current one says so", async () => {
    const ui = await render("join");
    expect(ui.rail().map((s) => s.label)).toEqual(["Account", "Email", "Passkey", "Recovery", "Plan", "Mailbox"]);
    expect(ui.rail()[0]).toEqual({ label: "Account", state: "now", current: "step" });
    expect(ui.rail().filter((s) => s.current === "step")).toHaveLength(1);
  });

  it("Check your email: the account is behind, Email is where the person is", async () => {
    answers["/auth/register"] = { status: 202, body: { status: "ok" } };
    const ui = await render("join");
    await ui.type("join-email", "pat@family.example");
    await ui.type("join-name", "Pat");
    await ui.type("join-pw", "a-long-signup-password");
    await ui.press(en.join.createAccount);
    expect(ui.host.querySelector("h1")?.textContent).toBe(en.join.step_sent_title);
    expect(ui.rail().slice(0, 3)).toEqual([
      { label: "Account", state: "done", current: null },
      { label: "Email", state: "now", current: "step" },
      { label: "Passkey", state: "todo", current: null },
    ]);
  });

  it("the second factor: account and Email behind", async () => {
    session = { status: 200, body: { user: user(), scope: "enrollment" } };
    const ui = await render("join");
    expect(ui.rail().slice(0, 3).map((s) => s.state)).toEqual(["done", "done", "now"]);
  });
});

describe("the authenticator fallback", () => {
  async function totpOpen() {
    session = { status: 200, body: { user: user(), scope: "enrollment" } };
    const ui = await render("join");
    await ui.press(en.join.useTotp);
    return ui;
  }

  it("a real QR, the key in groups of four, and Copy takes it whole", async () => {
    const ui = await totpOpen();
    const qr = ui.host.querySelector('.join-qr svg[role="img"]');
    expect(qr?.getAttribute("aria-label")).toBe(en.join.totpQrAria);
    expect(qr?.querySelector("path")?.getAttribute("d")?.length ?? 0).toBeGreaterThan(100);
    expect(ui.host.querySelector(".join-secret code")?.textContent).toBe(SEED.match(/.{1,4}/g)!.join(" "));
    expect(SEED.length, "a 16-letter key reads as four groups").toBe(16);
    await ui.press(en.join.totpCopy);
    expect(clipboard).toEqual([SEED]);
    expect([...ui.host.querySelectorAll("button")].some((b) => b.textContent === en.join.totpCopied)).toBe(true);
  });

  it("the app link is a control of the screen, not raw browser blue", async () => {
    const ui = await totpOpen();
    const link = [...ui.host.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("otpauth://"));
    expect(link?.className).toContain("join-alt");
  });

  it("a refused code is said under the code field, not above the step", async () => {
    answers["/auth/2fa/totp/activate"] = { status: 422, body: { error: { code: "unprocessable", message: "invalid TOTP code" } } };
    const ui = await totpOpen();
    await ui.type("join-totp", "123456");
    await ui.press(en.join.activate);
    const errors = [...ui.host.querySelectorAll(".join-error")];
    expect(errors).toHaveLength(1);
    const field = ui.host.querySelector("#join-totp")!;
    expect(field.compareDocumentPosition(errors[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the recovery codes can be kept without a pen", () => {
  it("Copy puts them on the clipboard one per line; Download is a text file with them", async () => {
    session = { status: 200, body: { user: user({ twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: false } }), scope: "full" } };
    const ui = await render("join");
    expect(ui.host.querySelectorAll(".join-codes li")).toHaveLength(4);
    await ui.press(en.join.codesCopy);
    expect(clipboard).toEqual([CODES.join("\n")]);
    const download = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === en.join.codesDownload)!;
    expect(download.getAttribute("download")).toBe("ohmail-recovery-codes.txt");
    const text = decodeURIComponent(download.getAttribute("href")!.replace(/^data:text\/plain;charset=utf-8,/, ""));
    for (const c of CODES) expect(text).toContain(c);
    expect(text).toContain(en.join.codesFileHeader);
  });
});

describe("a typo in the address has a way back", () => {
  it("the dot left out, and a slipped letter: the likely address, as a button that applies it", async () => {
    const ui = await render("join");
    await ui.type("join-email", typed("mila", "gmail.com", true));
    await ui.press(`Did you mean ${typed("mila", "gmail.com")}?`);
    expect(ui.host.querySelector<HTMLInputElement>("#join-email")!.value).toBe(typed("mila", "gmail.com"));
    expect(ui.host.querySelector(".join-suggest")).toBeNull();
    await ui.type("join-email", typed("pat", "gmial.com"));
    expect(ui.host.querySelector(".join-suggest")?.textContent).toBe(`Did you mean ${typed("pat", "gmail.com")}?`);
  });

  it("an address on a domain it does not know, or on a known one, is left alone", async () => {
    const ui = await render("join");
    for (const a of ["pat@family.example", typed("pat", "gmail.com"), typed("pat", "gmx.ch")]) {
      await ui.type("join-email", a);
      expect(ui.host.querySelector(".join-suggest"), a).toBeNull();
    }
  });

  it("Check your email: Wrong address? goes back to the form with the address kept", async () => {
    answers["/auth/register"] = { status: 202, body: { status: "ok" } };
    const ui = await render("join");
    await ui.type("join-email", "pat@famliy.example");
    await ui.type("join-name", "Pat");
    await ui.type("join-pw", "a-long-signup-password");
    await ui.press(en.join.createAccount);
    await ui.press(en.join.wrongAddress);
    expect(ui.host.querySelector("h1")?.textContent).toBe(en.join.step_account_title);
    expect(ui.host.querySelector<HTMLInputElement>("#join-email")!.value).toBe("pat@famliy.example");
  });
});

describe("addressSuggestion, the rule itself", () => {
  it("one slip of a letter, or the dot, on a common mail domain; nothing else", async () => {
    const { addressSuggestion } = await import("../app/(product)/join/address-hint.js");
    for (const [slip, meant] of [["gmail.con", "gmail.com"], ["gmaill.com", "gmail.com"], ["gmal.com", "gmail.com"],
      ["hotmial.com", "hotmail.com"], ["outlok.com", "outlook.com"]] as const) {
      expect(addressSuggestion(typed("a", slip)), slip).toBe(typed("a", meant));
    }
    expect(addressSuggestion(typed("a", "web.de", true))).toBe(typed("a", "web.de"));
    for (const fine of [typed("a", "gmail.com"), typed("a", "gmail.com").toUpperCase(), "a@family.example",
      managedAddress("fixture.a"), "no-at-sign", "@gmial", "a@gm"]) {
      expect(addressSuggestion(fine), fine).toBeNull();
    }
  });
});

describe("the dead-link page has the control it names", () => {
  it("Sign in, carrying on into the setup", async () => {
    const ui = await render("verify");
    const link = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === en.verify.signIn);
    expect(link?.getAttribute("href")).toBe("/login?next=join");
  });
});

describe("the Checkout return", () => {
  it("reads the session id once, asks the service with it, and takes it out of the address bar", async () => {
    window.history.replaceState(null, "", "/join?billing=success&session_id=cs_fixture_return_1");
    session = { status: 200, body: { user: user({ twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } }), scope: "full" } };
    await render("join", { billingReturn: "success" });
    expect(window.location.search).toBe("?billing=success");
    expect(sent.find((s) => s.path === "/account/checkout/confirm")?.body).toEqual({ sessionId: "cs_fixture_return_1" });
  });

  it("an account already entitled on return goes to the mailbox step, and the session id leaves the bar all the same", async () => {
    // The live walk's case: the trial was applied before the page came back, so the plan step never shows.
    window.history.replaceState(null, "", "/join?billing=success&session_id=cs_fixture_return_2");
    session = { status: 200, body: { user: user({ twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } }), scope: "full" } };
    answers["/account/access"] = { status: 200, body: { access: "open", metered: true, canAddMailbox: true, mailboxes: 0 } };
    const ui = await render("join", { billingReturn: "success" });
    expect(ui.host.querySelector("h1")?.textContent).toBe(en.join.step_mailbox_title);
    expect(window.location.search).toBe("?billing=success");
  });
});

describe("text buttons are targets", () => {
  it(".join-alt is at least 24px tall", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/webapp/app/app.css"), "utf8");
    const block = /\n\.join-alt \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/min-height:\s*24px/);
  });

  it("a recovery code is never broken across lines, and narrow screens get one column", () => {
    // The live walk at 390px: "6276-1584-" on one line and "5566" on the next.
    const css = readFileSync(resolve(process.cwd(), "apps/webapp/app/app.css"), "utf8");
    expect(/\n\.join-codes code \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/white-space:\s*nowrap/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.join-codes \{ grid-template-columns: 1fr; \}/);
  });
});
