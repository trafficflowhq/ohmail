/** @vitest-environment jsdom */
/**
 * A REFUSAL IS SAID IN THE READER'S LANGUAGE ON THE ACCOUNT PANE'S SESSION READ AND IN THE STEP-UP
 * PROMPT. The pane rendered its session read's refusal through `messageOf`, so a lost marker read
 * the client's English literal under German; the prompt rendered every server refusal but the
 * lockout as the server's English diagnostic ("two-factor verification failed"). Each surface is
 * driven over `fetch` in German, with the English twin as the control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const A = "0b7e3a52-5d2b-4c7e-9a41-2f1d6c8e9a01";
const WIRE_401 = "two-factor verification failed";
const ENROLLED = (webauthn: boolean) => ({
  status: 200,
  body: { user: { accountId: A, email: "a@example.test", twofaEnrolled: { webauthn, totp: true, recoveryCodes: true } }, scope: "full" },
});

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer> = {};
let calls: Array<{ method: string; url: string; body: string | null }> = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  // A 401 at the step-up door is renewed once and sent again (no `NEVER_REFRESH` entry): the renewal succeeds.
  answers = { "POST /auth/refresh": { status: 204 } };
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    const hit = Object.entries(answers).find(([key]) => {
      const [m, p] = key.split(" ");
      return m === method && url.includes(p!);
    });
    const a = hit?.[1] ?? { status: 200, body: {} };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status, headers: { "content-type": "application/json" },
    });
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  document.cookie = "tf_owner=; path=/; max-age=0";
  vi.unstubAllGlobals();
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
});

async function settle(n = 12): Promise<void> {
  await act(async () => { for (let i = 0; i < n; i += 1) await Promise.resolve(); });
}

async function mount(locale: "en" | "de", node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : en, timeZone: "UTC",
      children: h(ThemeProvider, null, h(ToastHost, null, node)),
    }));
  });
  await settle();
  return host;
}

async function signedIn(): Promise<void> {
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(A);
  document.cookie = `tf_owner=${A}; path=/`;
}

async function prompt(locale: "en" | "de"): Promise<HTMLElement> {
  const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
  return mount(locale, h(StepUpPrompt, { onVerified: () => {}, onCancel: () => {}, onDiscarded: () => {} }));
}

async function submitCode(c: HTMLElement): Promise<void> {
  const input = c.querySelector<HTMLInputElement>("#stepup-code")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { c.querySelector("form")!.requestSubmit(); });
  await settle(30);
}

const alertOf = (c: HTMLElement): string => c.querySelector('[role="alert"]')?.textContent ?? "";

describe("the step-up prompt says a server refusal in the reader's language", () => {
  const CASES: Array<[string, Answer, (m: typeof en) => string]> = [
    ["a wrong code", { status: 401, body: { error: { code: "credential_refused", message: WIRE_401 } } }, (m) => m.devices.stepUpBadCode],
    ["the slowed sign-in", { status: 429, body: { error: { code: "sign_in_slowed", message: "sign-in slowed" } } }, (m) => m.devices.stepUpSlowed],
    ["any other refusal", { status: 500, body: { error: { code: "internal", message: "internal error" } } }, (m) => m.devices.stepUpRefused],
  ];
  for (const [name, answer, key] of CASES) {
    it(`${name}, in German, never the server's English`, async () => {
      await signedIn();
      answers["GET /api/auth/session"] = ENROLLED(false);
      answers["POST /api/auth/step-up/totp"] = answer;
      const c = await prompt("de");
      await submitCode(c);
      expect(alertOf(c)).toBe(key(de));
      expect(key(de)).not.toBe(key(en));
    });
    it(`control: ${name}, in English, says the English sentence`, async () => {
      await signedIn();
      answers["GET /api/auth/session"] = ENROLLED(false);
      answers["POST /api/auth/step-up/totp"] = answer;
      const c = await prompt("en");
      await submitCode(c);
      expect(alertOf(c)).toBe(key(en));
    });
  }

  it("a refused passkey, in German, is the passkey's sentence, not the code's", async () => {
    await signedIn();
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    const buf = new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: {
        get: async () => ({
          id: "cred", rawId: buf, type: "public-key",
          response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null },
          getClientExtensionResults: () => ({}),
        }),
      },
    });
    answers["GET /api/auth/session"] = ENROLLED(true);
    answers["POST /api/auth/step-up/webauthn/options"] = { status: 200, body: { options: { challenge: "AQID", allowCredentials: [] } } };
    answers["POST /api/auth/step-up/webauthn/verify"] = { status: 401, body: { error: { code: "credential_refused", message: WIRE_401 } } };
    const c = await prompt("de");
    const press = [...c.querySelectorAll("button")].find((b) => b.textContent === de.devices.stepUpPasskey)!;
    expect(press, "the passkey arm is offered").toBeTruthy();
    await act(async () => { press.click(); });
    await settle(30);
    expect(alertOf(c)).toBe(de.devices.stepUpBadPasskey);
  });

  it("control: a code the server takes says nothing", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    answers["POST /api/auth/step-up/totp"] = { status: 200, body: { ok: true } };
    const c = await prompt("de");
    await submitCode(c);
    expect(c.querySelector('[role="alert"]')).toBeNull();
    expect(calls.some((r) => r.url.includes("/api/auth/step-up/totp")), "the code was sent").toBe(true);
  });
});

describe("a recovery code earns the step-up, for an authenticator that is gone", () => {
  const ENROLLED_NO_SHEET = {
    status: 200,
    body: { user: { accountId: A, email: "a@example.test", twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: false } }, scope: "full" },
  };
  const toggleIn = (c: HTMLElement, m: typeof en): HTMLButtonElement | undefined =>
    [...c.querySelectorAll("button")].find((b) => b.textContent === m.devices.stepUpRecoveryToggle);

  async function recoveryArm(locale: "en" | "de", onVerified: () => void = () => {}): Promise<HTMLElement> {
    const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
    const c = await mount(locale, h(StepUpPrompt, { onVerified, onCancel: () => {}, onDiscarded: () => {} }));
    const toggle = toggleIn(c, locale === "de" ? de : en);
    expect(toggle, "the recovery arm is offered").toBeTruthy();
    await act(async () => { toggle!.click(); });
    const input = c.querySelector<HTMLInputElement>("#stepup-recovery")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, " abcd-efgh-ijkl ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { c.querySelector("form")!.requestSubmit(); });
    await settle(30);
    return c;
  }

  it("the code goes to the step-up's own door, and a code it takes continues the parked verb", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    answers["POST /api/auth/step-up/recovery-code"] = { status: 200, body: { ok: true, remainingCodes: 9 } };
    let verified = 0;
    const c = await recoveryArm("en", () => { verified += 1; });
    const sent = calls.filter((r) => r.url.includes("/api/auth/step-up/recovery-code"));
    expect(sent.map((r) => JSON.parse(r.body!))).toEqual([{ code: "abcd-efgh-ijkl" }]);
    expect(calls.some((r) => r.url.includes("/api/auth/step-up/totp")), "the code went to the authenticator's door").toBe(false);
    expect(verified).toBe(1);
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });

  it("a refused code, in German, is the recovery code's sentence", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    answers["POST /api/auth/step-up/recovery-code"] = { status: 401, body: { error: { code: "credential_refused", message: WIRE_401 } } };
    const c = await recoveryArm("de");
    expect(alertOf(c)).toBe(de.devices.stepUpBadRecoveryCode);
    expect(de.devices.stepUpBadRecoveryCode).not.toBe(en.devices.stepUpBadRecoveryCode);
  });

  it("control: an account with no recovery codes is not offered the arm", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED_NO_SHEET;
    const c = await prompt("en");
    expect(toggleIn(c, en)).toBeUndefined();
  });
});

describe("the Account pane's session read says a refusal in the reader's language", () => {
  async function pane(locale: "en" | "de"): Promise<HTMLElement> {
    const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
    return mount(locale, h(AccountSection));
  }

  it("a lost marker, in German, is the session sentence, not the client's English literal", async () => {
    const { bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    const c = await pane("de");
    expect(c.textContent).toContain(de.session.refusedOwnerAbsent);
    expect(c.textContent).not.toContain("lost the name of the account");
  });

  it("control: a read the server answers says no refusal", async () => {
    await signedIn();
    answers["GET /api/auth/session"] = ENROLLED(false);
    const c = await pane("de");
    expect(c.textContent).not.toContain(de.session.refusedOwnerAbsent);
    expect(c.textContent).not.toContain("lost the name of the account");
  });
});

describe("the renderer says the client's own refusals in the reader's language", () => {
  it("a sign-in that could not be checked, in German and in English", async () => {
    const { ApiError, SESSION_UNCHECKED } = await import("../app/api-client.js");
    const { useRefusalSentence } = await import("../app/(product)/refusal-sentence.js");
    const Say = () => h("p", null, useRefusalSentence()(new ApiError(503, SESSION_UNCHECKED, "Your sign-in could not be checked just now. Try again in a moment.")));
    expect((await mount("de", h(Say))).textContent).toBe(de.session.refusedSessionUnchecked);
    await act(async () => root!.unmount());
    host?.remove();
    root = null;
    expect((await mount("en", h(Say))).textContent).toBe(en.session.refusedSessionUnchecked);
  });
});

/**
 * A CONNECT REFUSAL THE SERVER WORDS IS SAID IN THE READER'S LANGUAGE. The server writes English in
 * every language; each refusal here is built by the code that raises it (the mailbox service, the
 * allowance check, the step-up gate, the dial guard, the local doors) and read as a client reads it
 * off the wire. English says exactly the server's sentence, German the catalogue's.
 */
describe("a connect refusal the server words, in the reader's language", () => {
  type Wire = { code: string; message: string; details?: unknown };
  interface Raised { name: string; wire: Wire; key: string; values?: Record<string, string | number> }
  const wireOf = (e: unknown): Wire => {
    const r = e as { code: string; message: string; details?: unknown };
    return { code: r.code, message: r.message, ...(r.details === undefined ? {} : { details: JSON.parse(JSON.stringify(r.details)) }) };
  };
  const caught = async (p: Promise<unknown>): Promise<Wire> => {
    try { await p; } catch (e) { return wireOf(e); }
    throw new Error("nothing was refused");
  };

  async function raised(): Promise<Raised[]> {
    const { MailboxAllowanceError } = await import("../../../packages/services/src/mailbox-allowance.js");
    const { MailboxService, MAILBOX_REFUSALS, ServiceError } = await import("@trafficflow/services/mail");
    const { clearedFor, plaintextDialPin } = await import("../../../packages/api/src/dial-host-guard.js");
    const { withStepUp } = await import("../../../packages/api/src/middleware.js");
    const { hostChangeRefusal, sameLoginRefusal } = await import("../../sidecar/src/composition-passes.js");
    const allowance = (over: Record<string, unknown>) => ({
      mailboxLimit: 2, canAddMailbox: true, accessRefusal: null, enabledCount: 2, ...over,
    }) as never;
    const svc = new MailboxService({ keyProvider: {} } as never);
    const ctx = { accountId: A, now: () => new Date() } as never;
    const probe = async () => ({ verdict: "ok" as const });
    const IMAP = { host: "imap.example.test", user: "pat", pass: "fixture-password" };
    const ADDRESS = "pat@example.test";
    const create = (body: Record<string, unknown>) => caught(svc.create(ctx, { provider: "imap", address: ADDRESS, imap: IMAP, ...body } as never, { probe }));
    const refusingGuard = {
      services: { probeHostGuard: { check: async () => { throw new ServiceError("validation_failed", 400, "u is not a permitted url: host is not public"); } } },
    } as never;
    const stepUp = await withStepUp(async () => new Response(null), { options: { stepUp: true } } as never)(
      new Request("http://api.test/mailboxes"),
      { session: { lastTwofaAt: null }, now: () => new Date(), authConfig: { stepUpWindowMs: 300_000 } } as never, {},
    );
    return [
      { name: "a full plan", wire: wireOf(new MailboxAllowanceError("at_limit", allowance({}))), key: "refused_mailbox_limit_reached", values: { limit: 2, count: 2 } },
      { name: "a plan of one", wire: wireOf(new MailboxAllowanceError("at_limit", allowance({ mailboxLimit: 1, enabledCount: 1 }))), key: "refused_mailbox_limit_reached", values: { limit: 1, count: 1 } },
      { name: "an unpaid account", wire: wireOf(new MailboxAllowanceError("payment_required", allowance({ canAddMailbox: false, accessRefusal: "payment_required" }))), key: "refused_payment_required" },
      { name: "a suspended account", wire: wireOf(new MailboxAllowanceError("suspended", allowance({ canAddMailbox: false, accessRefusal: "suspended" }))), key: "refused_account_suspended" },
      { name: "no further mailbox", wire: wireOf(new MailboxAllowanceError("not_permitted", allowance({ canAddMailbox: false }))), key: "refused_mailbox_not_permitted" },
      { name: "already connected", wire: wireOf(MAILBOX_REFUSALS.addressTaken()), key: "refused_mailbox_exists" },
      { name: "disconnected", wire: wireOf(MAILBOX_REFUSALS.mailboxDisabled()), key: "refused_mailbox_disabled" },
      { name: "signs in with Microsoft", wire: wireOf(MAILBOX_REFUSALS.signsInWithOAuth("microsoft")), key: "refused_signs_in_with_oauth", values: { provider: "microsoft" } },
      { name: "signs in through its provider", wire: wireOf(MAILBOX_REFUSALS.signsInWithOAuth("google")), key: "refused_signs_in_with_oauth", values: { provider: "other" } },
      { name: "no stored password", wire: wireOf(MAILBOX_REFUSALS.credentialNeeded()), key: "refused_credential_needed" },
      { name: "settings moved", wire: wireOf(MAILBOX_REFUSALS.configMoved("imap")), key: "refused_mailbox_config_changed", values: { transport: "imap" } },
      { name: "outgoing settings moved", wire: wireOf(MAILBOX_REFUSALS.configMoved("smtp")), key: "refused_mailbox_config_changed", values: { transport: "smtp" } },
      { name: "the same login twice", wire: wireOf(sameLoginRefusal()), key: "refused_same_login" },
      { name: "the phone's own incoming server", wire: wireOf(hostChangeRefusal(null)), key: "refused_organizer_host_change" },
      { name: "a host this service does not dial", wire: await caught(clearedFor(refusingGuard, "mail.example.test", 587, "smtp")), key: "refused_mailbox_host_refused", values: { transport: "smtp" } },
      { name: "plaintext off this network", wire: await caught(plaintextDialPin(undefined, "mail.example.test", "imap")), key: "refused_mailbox_host_plaintext", values: { transport: "imap" } },
      { name: "a second factor to renew", wire: ((await stepUp.json()) as { error: Wire }).error, key: "refused_step_up_required" },
      { name: "no address", wire: await caught(svc.probeConnection(ctx, { address: "", imap: IMAP }, { probe })), key: "refused_field_address" },
      { name: "no incoming server to test", wire: await caught(svc.probeConnection(ctx, { address: ADDRESS, imap: { ...IMAP, host: " " } }, { probe })), key: "refused_field_imap_host" },
      { name: "no password to test", wire: await caught(svc.probeConnection(ctx, { address: ADDRESS, imap: { ...IMAP, pass: "" } }, { probe })), key: "refused_field_imap_pass" },
      { name: "no provider", wire: await create({ provider: "" }), key: "refused_field_provider" },
      { name: "no password to connect", wire: await create({ imap: { ...IMAP, pass: "" } }), key: "refused_field_imap" },
      { name: "no incoming server to connect", wire: await create({ imap: { ...IMAP, host: "" } }), key: "refused_field_imap_server" },
      { name: "an incoming port nothing listens on", wire: await create({ imap: { ...IMAP, port: 0 } }), key: "refused_field_imap_port" },
      { name: "an outgoing port nothing listens on", wire: await create({ smtp: { host: "smtp.example.test", port: 70_000 } }), key: "refused_field_smtp_port" },
    ];
  }

  afterEach(async () => {
    const { DEFAULT_LOCALE, setActiveCatalog } = await import("../app/shell/locale.js");
    setActiveCatalog(DEFAULT_LOCALE, null);
  });

  it("English is exactly the server's sentence and German the catalogue's, code by code", async () => {
    const { refusalCopy, SERVER_REFUSAL_CODES } = await import("../app/shell/server-refusal.js");
    const { fillFrom, setActiveCatalog } = await import("../app/shell/locale.js");
    const { createTranslator } = await import("next-intl");
    const cases = await raised();
    // Every code the table words is driven here; the probe's refusals have their own forms' tests.
    expect(new Set(cases.map((c) => c.wire.code)))
      .toEqual(new Set([...SERVER_REFUSAL_CODES].filter((c) => c !== "mailbox_probe_failed")));
    const german = createTranslator({ locale: "de", messages: de as never, namespace: "mailboxes" as never }) as unknown as
      (key: string, values?: Record<string, unknown>) => string;
    /* Two server sentences end on an unscoped "nothing is deleted", which no catalogue entry may say
       (`deleted-claims.test.ts`): there the catalogue keeps the first sentence and says what is kept. */
    const SCOPED = new Set(["refused_payment_required", "refused_mailbox_not_permitted"]);
    const M = en.mailboxes as Record<string, string>;
    for (const c of cases) {
      setActiveCatalog("en", en as never);
      if (SCOPED.has(c.key)) {
        expect(refusalCopy(c.wire), `${c.name}, in English`).toBe(M[c.key]);
        expect(c.wire.message.startsWith(M[c.key]!.slice(0, M[c.key]!.indexOf(". ") + 2)), c.name).toBe(true);
      } else {
        expect(refusalCopy(c.wire), `${c.name}, in English`).toBe(c.wire.message);
      }
      setActiveCatalog("de", fillFrom(en as never, de as never));
      const said = refusalCopy(c.wire);
      expect(said, `${c.name}, in German`).toBe(german(c.key, c.values));
      expect(said, `${c.name} stayed English under German`).not.toBe(c.wire.message);
    }
  });

  it("messageOf says a worded code in German and passes any other through", async () => {
    const { ApiError, messageOf } = await import("../app/api-client.js");
    const { fillFrom, setActiveCatalog } = await import("../app/shell/locale.js");
    const [full] = await raised();
    setActiveCatalog("de", fillFrom(en as never, de as never));
    const atLimit = new ApiError(409, full!.wire.code, full!.wire.message, full!.wire.details);
    expect(messageOf(atLimit)).toContain("Postfächer");
    expect(messageOf(new ApiError(409, "conflict", "the server's own sentence"))).toBe("the server's own sentence");
    // A worded code in a shape the table does not read keeps the server's sentence.
    expect(messageOf(new ApiError(409, "mailbox_disabled", "This mailbox is disconnected and cannot send."))).toBe("This mailbox is disconnected and cannot send.");
  });

});

describe("a server answer, as the prompt reads one", () => {
  it("the renderer's spelling of the client-raised codes is api-client's own", async () => {
    const { SESSION_ENDED_REFUSAL_CODE, SESSION_UNCHECKED } = await import("../app/api-client.js");
    const { CLIENT_RAISED } = await import("../app/(product)/refusal-sentence.js");
    expect(CLIENT_RAISED).toEqual({ unchecked: SESSION_UNCHECKED, ended: SESSION_ENDED_REFUSAL_CODE });
  });

  it("the two client-raised 4xx/5xx refusals are not server answers; a server's own refusal is", async () => {
    const { ApiError, SESSION_ENDED_REFUSAL_CODE, SESSION_UNCHECKED } = await import("../app/api-client.js");
    const { serverAnswered } = await import("../app/(product)/refusal-sentence.js");
    expect(serverAnswered(new ApiError(401, SESSION_ENDED_REFUSAL_CODE, "ended"))).toBe(false);
    expect(serverAnswered(new ApiError(503, SESSION_UNCHECKED, "unchecked"))).toBe(false);
    expect(serverAnswered(new ApiError(0, "owner_absent", "lost"))).toBe(false);
    expect(serverAnswered(new Error("x"))).toBe(false);
    // Control: the server's refusals, the lowest and a fault.
    expect(serverAnswered(new ApiError(400, "validation_failed", "code is required"))).toBe(true);
    expect(serverAnswered(new ApiError(401, "credential_refused", WIRE_401))).toBe(true);
    expect(serverAnswered(new ApiError(503, "db_busy", "busy"))).toBe(true);
  });
});
