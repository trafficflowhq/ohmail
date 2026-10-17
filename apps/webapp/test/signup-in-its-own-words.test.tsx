/** @vitest-environment jsdom */
/**
 * THE SIGNUP SPEAKS THE SCREEN'S LANGUAGE AT EVERY MISTAKE. The server writes its refusals as English
 * diagnostics, and /join and /verify-email showed them verbatim: a German signup met "email must be a
 * valid address", "invalid TOTP code" and "This verification link is not valid any more". Each refusal a
 * signup step can meet now has the screen's own sentence (anything unnamed keeps the server's), the
 * register and resend calls carry the screen's language for the mail, and two lines that were not true
 * say what is: the password is one of two factors (the next step on the open path is the mail, not a
 * passkey), and the verify page no longer promises "no password to leak" under a password field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base32Seed } from "../../../test/support/fixture-credentials.js";
import en from "../messages/en.json";
import de from "../messages/de.json";

type Messages = typeof en;
/** The authenticator's setup key the enrollment answers, derived as every fixture key is. */
const SEED = base32Seed("signup-in-its-own-words");
type Answer = { status: number; body: unknown };

const refusal = (status: number, code: string, message: string): Answer =>
  ({ status, body: { error: { code, message } } });
const ENROLLING = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
  },
  scope: "enrollment",
};
const UNVERIFIED = {
  user: { ...ENROLLING.user, emailVerified: false, twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } },
  scope: "full",
};

let session: Answer = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
let answers: Record<string, Answer> = {};
let sent: Array<{ path: string; body: unknown }> = [];
let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  session = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
  answers = {};
  sent = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input), "http://x");
    const path = url.pathname.replace(/^\/api/, "");
    const json = (a: Answer) =>
      new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    if (init?.body !== undefined) sent.push({ path, body: JSON.parse(String(init.body)) });
    if (path === "/auth/session") return json(session);
    if (answers[path]) return json(answers[path]!);
    if (path === "/auth/2fa/totp/enroll") {
      return json({ status: 200, body: { secret: SEED, otpauthUrl: `otpauth://totp/ohmail:fixture?secret=${SEED}&issuer=ohmail` } });
    }
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

async function render(messages: Messages, screen: "join" | "verify") {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const node = screen === "join"
    ? React.createElement((await import("../app/(product)/join/JoinScreen.js")).JoinScreen, { initialCode: "", publicSignup: true })
    : React.createElement((await import("../app/(product)/verify-email/VerifyEmailScreen.js")).VerifyEmailScreen, { initialToken: "tok" });
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: messages === de ? "de" : "en", messages, timeZone: "UTC", children: node,
    }));
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
  const alertText = () => [...host.querySelectorAll('[role="alert"], .join-error')].map((el) => el.textContent ?? "").join(" | ");
  return { host, type, press, alertText };
}

async function accountStep(messages: Messages) {
  const ui = await render(messages, "join");
  await ui.type("join-email", "pat@family.example");
  await ui.type("join-name", "Pat");
  await ui.type("join-pw", "a-long-signup-password");
  await ui.press(messages.join.createAccount);
  return ui;
}

const REGISTER: Array<[string, Answer, keyof Messages["join"]]> = [
  ["an address with no dot after the @", refusal(400, "validation_failed", "email must be a valid address"), "refusedEmail"],
  ["a password too short", refusal(400, "validation_failed", "password must be between 12 and 1024 characters"), "refusedPassword"],
  ["no name", refusal(400, "validation_failed", "displayName is required"), "refusedName"],
  ["too many signups from one connection", refusal(429, "rate_limited", "Too many signups from this connection."), "refusedTooMany"],
  ["a taken address on the invite path", refusal(409, "email_taken", "There is already an ohmail account for this address. Sign in instead."), "refusedTaken"],
  ["open signup off", refusal(503, "signup_unavailable", "Open signup is unavailable on this deployment right now."), "refusedUnavailable"],
  ["an invite for another address", refusal(403, "invite_invalid", "That invite code is not valid for this email address."), "inviteInvalid"],
  ["a used invite", refusal(409, "invite_used", "This invite has already been used."), "inviteUsed"],
  ["an expired invite", refusal(403, "invite_expired", "This invite has expired."), "inviteExpired"],
];

describe("the account step's refusals, in the screen's words", () => {
  for (const messages of [de, en]) {
    const lang = messages === de ? "de" : "en";
    for (const [what, answer, key] of REGISTER) {
      it(`${lang}: ${what}`, async () => {
        answers["/auth/register"] = answer;
        const ui = await accountStep(messages);
        expect(ui.alertText()).toContain(messages.join[key]);
        // In English the screen's sentence may share words with the server's; German proves the mapping.
        if (messages === de) expect(ui.alertText()).not.toContain((answer.body as { error: { message: string } }).error.message);
      });
    }
  }

  it("a full house is said in German, above the way to the list", async () => {
    answers["/auth/register"] = refusal(503, "signup_capacity", "ohmail is full for now. Join the list and we will let you in as soon as a place opens.");
    const ui = await accountStep(de);
    expect(ui.host.textContent).toContain(de.join.refusedFull);
    expect(ui.host.textContent).not.toContain("ohmail is full for now");
  });

  it("a refusal the screen has no words for keeps the server's sentence", async () => {
    answers["/auth/register"] = refusal(400, "validation_failed", "something new the server says");
    const ui = await accountStep(de);
    expect(ui.alertText()).toContain("something new the server says");
  });

  it("register carries the screen's language for the mail", async () => {
    answers["/auth/register"] = { status: 202, body: { status: "ok" } };
    await accountStep(de);
    const body = sent.find((s) => s.path === "/auth/register")?.body as { locale?: string } | undefined;
    expect(body?.locale).toBe("de");
  });
});

describe("the authenticator step's refusal, in the screen's words", () => {
  for (const messages of [de, en]) {
    it(`${messages === de ? "de" : "en"}: a code that did not match`, async () => {
      session = { status: 200, body: ENROLLING };
      answers["/auth/2fa/totp/activate"] = refusal(422, "unprocessable", "invalid TOTP code");
      const ui = await render(messages, "join");
      await ui.press(messages.join.useTotp);
      await ui.type("join-totp", "123456");
      await ui.press(messages.join.activate);
      expect(ui.alertText()).toContain(messages.join.refusedTotpCode);
      expect(ui.alertText()).not.toContain("invalid TOTP code");
    });
  }
});

describe("the verify page's refusals, in the screen's words", () => {
  const VERIFY: Array<[string, Answer, (m: Messages) => string]> = [
    ["a dead link", refusal(400, "invalid_token", "This verification link is not valid any more."), (m) => m.verify.refusedLink],
    ["a wrong password", refusal(401, "credential_refused", "invalid email or password"), (m) => m.verify.refusedPassword],
    ["the lockout", refusal(423, "account_locked", "too many failed attempts"), (m) => m.login.tooManyAttempts],
    ["the slowdown", refusal(429, "sign_in_slowed", "slowed"), (m) => m.login.signInSlowed],
  ];
  for (const messages of [de, en]) {
    for (const [what, answer, sentence] of VERIFY) {
      it(`${messages === de ? "de" : "en"}: ${what}`, async () => {
        answers["/auth/verify-email"] = answer;
        const ui = await render(messages, "verify");
        await ui.type("verify-pw", "a-long-signup-password");
        await ui.press(messages.verify.confirm);
        expect(ui.alertText()).toContain(sentence(messages));
        if (messages === de) expect(ui.alertText()).not.toContain((answer.body as { error: { message: string } }).error.message);
      });
    }
  }
});

describe("the resend asks for the mail in the screen's language", () => {
  it("de", async () => {
    session = { status: 200, body: UNVERIFIED };
    const ui = await render(de, "join");
    await ui.press(de.join.verifyResend);
    expect(sent.find((s) => s.path === "/auth/verify-email/resend")?.body).toEqual({ locale: "de" });
  });
});

describe("two lines that were not true", () => {
  it("the password hint does not promise a passkey as the next step: on the open path the next step is the mail", () => {
    for (const m of [en, de]) {
      expect(m.join.passwordHint).not.toMatch(/next step adds|nächsten Schritt kommt/);
      expect(m.join.passwordHint).toMatch(/12/);
    }
  });

  it("the verify page, under a password field, does not say there is no password", () => {
    expect(en.verify.footer).not.toMatch(/no password/i);
    expect(de.verify.footer).not.toMatch(/kein Passwort/i);
  });
});

describe("German on the signup screens says Mail, not Post", () => {
  it("no join or verify string uses Post for mail (Postfach is the mailbox and stays)", () => {
    const offenders = Object.entries({ ...de.join, ...Object.fromEntries(Object.entries(de.verify).map(([k, v]) => [`verify.${k}`, v])) })
      .filter(([, v]) => typeof v === "string" && /\bPost\b/.test(v))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});
