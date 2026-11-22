/** @vitest-environment jsdom */
/**
 * WHERE A PASSWORD TYPED AT THE SIGN-UP'S MAILBOX STEP IS, AND WHERE IT NEVER IS. The real page over the real
 * ceremony, the real server client and the web's own connect wire; only `fetch` is a stand-in. A marker is typed as
 * the mailbox's password and walked through the wizard saying no (the browser holds another account), a refused
 * password whose answer repeats what was sent, the second factor asked and cancelled, asked again and verified, and
 * the connect. It may stand in the one password field, and in the `pass` of the two servers of the request that
 * connects. Everything else a page writes to is watched and must stay clean: every request's address, headers and
 * body, both stores, the address and its history, the cookie jar, the console and the page's own markup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PROVIDERS } from "../app/shell/providers.js";

const J = en.join;
/** A value no sentence holds, assembled here: found anywhere but the field and a body's `pass`, it leaked. */
const MARKER = ["zq", "MARKER", "sweep", "7Kd"].join("-");
const ADDRESS = "pat@fastmail.example";
const FASTMAIL = PROVIDERS.find((p) => p.id === "fastmail")!;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NEVER_STARTED = {
  state: "closed", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
  erasureAt: null, erasedAt: null, formerlyPaid: false, lifecycleEpoch: "2026-09-22T00:00:00.000Z",
};
const user = (accountId: string, email: string) => ({
  userId: `u-${accountId}`, accountId, email, displayName: "Pat", emailVerified: true,
  twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
});

interface Asked { readonly path: string; readonly url: string; readonly method: string; readonly headers: string; readonly body: unknown }
let asked: Asked[] = [];
let written: string[] = [];
let account: [string, string] = ["a1", "pat@family.example"];
let creates: Array<() => Response> = [];
let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

const record = (sink: string) => (...args: unknown[]): void => {
  written.push(`${sink}: ${args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)))).join(" ")}`);
};

beforeEach(() => {
  asked = [];
  written = [];
  account = ["a1", "pat@family.example"];
  creates = [];
  window.history.replaceState(null, "", "/join");
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    record("storage")(key, value);
    setItem.call(this, key, value);
  });
  const replace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "replaceState").mockImplementation((state, unused, url) => {
    record("history")(state, url);
    replace(state, unused, url);
  });
  vi.spyOn(window.history, "pushState").mockImplementation(record("history"));
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
    vi.spyOn(console, method).mockImplementation(record(`console.${method}`));
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown; headers?: unknown }) => {
    const url = String(input);
    const path = new URL(url, "http://x").pathname.replace(/^\/api/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = JSON.stringify(init?.headers instanceof Headers ? [...init.headers.entries()] : (init?.headers ?? null));
    asked.push({ path, url, method, headers, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
    if (path === "/auth/session") return json(200, { user: user(...account), scope: "full" });
    if (path === "/auth/refresh") return json(401, { error: { code: "refresh_missing", message: "no" } });
    if (path === "/auth/step-up/totp") return json(200, { ok: true });
    if (path === "/account/access") return json(200, { access: "open", metered: true, canAddMailbox: true, mailboxes: 1, lifecycle: NEVER_STARTED });
    if (path === "/mailboxes/oauth/microsoft/availability") return json(200, { available: false, device: false });
    if (path === "/mailboxes" && method === "POST") return (creates.shift() ?? (() => json(500, { error: { code: "internal", message: "no answer was set" } })))();
    if (path.startsWith("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function atTheMailboxStep() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinRoute } = await import("../app/(product)/join/JoinRoute.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", children: React.createElement(JoinRoute, { initialCode: "", publicSignup: true }),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  /** A field, by the name its label gives it, anywhere on the page (the factor's dialog too). */
  const blank = (name: string) => {
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent === name);
    return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
  };
  const type = async (name: string, value: string) => {
    const input = blank(name);
    expect(input, `no field named ${name}`).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  /** A press by the start of its name: an ink button also carries its key. */
  const press = async (name: string, within: ParentNode = document) => {
    const button = [...within.querySelectorAll("button")].find((b) => b.textContent?.startsWith(name));
    expect(button, `no button named ${name}`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const heading = () => host.querySelector("h1")?.textContent ?? null;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  return { host, blank, type, press, heading, dialog };
}

/** The requests that connect, and every request with each `pass` taken out. */
const connects = () => asked.filter((a) => a.path === "/mailboxes" && a.method === "POST");
const besidesPass = (a: Asked): string =>
  `${a.url} ${a.headers} ${JSON.stringify(a.body, (key, value: unknown) => (key === "pass" ? undefined : value)) ?? ""}`;

/** The marker is in the one password field, or (`held: false`) in no field; and in nothing else a page writes to. */
function clean(held: boolean): void {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .filter((field) => field.value.includes(MARKER))
    .map((field) => field.getAttribute("type") ?? "text");
  expect(fields, "the fields that hold what was typed").toEqual(held ? ["password"] : []);
  expect(document.documentElement.outerHTML.includes(MARKER), "the page's markup holds the password").toBe(false);
  expect(written.filter((line) => line.includes(MARKER)), "a store, the address or the console holds the password").toEqual([]);
  expect(document.cookie).not.toContain(MARKER);
  expect(document.URL).not.toContain(MARKER);
  for (const stored of [window.localStorage, window.sessionStorage])
    for (let i = 0; i < stored.length; i += 1) expect(stored.getItem(stored.key(i)!) ?? "").not.toContain(MARKER);
  for (const a of asked) expect(besidesPass(a), `${a.method} ${a.path} carries the password outside a pass`).not.toContain(MARKER);
  // Only the request that connects carries it at all, in the two servers' own `pass`.
  for (const a of asked) {
    if (a.path === "/mailboxes" && a.method === "POST") continue;
    expect(JSON.stringify(a.body) ?? "", `${a.method} ${a.path} carries the password`).not.toContain(MARKER);
  }
}

describe("a password typed at the sign-up's mailbox step", () => {
  it("is in the one field and in the connect's two `pass`, through the wizard's no, a refusal that repeats it, the second factor and the connect; then it is gone", async () => {
    const ui = await atTheMailboxStep();
    expect(ui.heading()).toBe(J.step_mailbox_title);
    await ui.type(J.mailboxAddress, ADDRESS);
    await ui.press(FASTMAIL.label);
    await ui.type(J.appPasswordLabel, MARKER);
    clean(true);

    // The browser now holds another account: nothing typed for this one leaves.
    account = ["b2", "sam@family.example"];
    await ui.press(J.connectMailbox);
    expect(connects(), "a credential left under another account").toEqual([]);
    expect(ui.host.textContent).toContain(J.accountChanged.replace("{email}", "sam@family.example"));
    clean(true);

    // The server refuses the password and repeats what it was sent, in its sentence and in its details.
    account = ["a1", "pat@family.example"];
    creates = [() => json(422, { error: {
      code: "mailbox_probe_failed", message: `The mail server refused the password ${MARKER}.`,
      details: { reason: "auth", transport: "imap", echoed: MARKER, tls: { certHost: MARKER } },
    } })];
    await ui.press(J.connectMailbox);
    expect(connects()).toHaveLength(1);
    expect(ui.host.textContent).toContain(en.mailboxes.probe_auth_fastmail);
    clean(true);

    // The second factor is asked in place; Cancel sends nothing more and keeps what was typed.
    creates = [() => json(403, { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } })];
    await ui.press(J.connectMailbox);
    expect(ui.dialog(), "the factor is asked in place").not.toBeNull();
    clean(true);
    await ui.press(en.stepUp.cancel, ui.dialog()!);
    expect(ui.dialog()).toBeNull();
    expect(connects()).toHaveLength(2);
    clean(true);

    // Asked again and verified: the same press is sent once more, and the mailbox is connected.
    creates = [
      () => json(403, { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } }),
      () => json(201, { id: "mb1", address: ADDRESS, provider: "fastmail", organizeConsentedAt: null }),
    ];
    await ui.press(J.connectMailbox);
    await ui.type(en.stepUp.codeLabel, "123456");
    await ui.press(en.stepUp.verify, ui.dialog()!);
    expect(connects()).toHaveLength(4);
    expect(connects()[3]!.body).toEqual(connects()[2]!.body);
    expect(ui.heading()).toBe(J.myMailboxes.replace(/\.$/, ""));

    // Every request that connected carried it in the two servers' `pass`, and the factor's own request did not.
    for (const c of connects()) {
      const body = c.body as { imap: { pass: string }; smtp: { pass: string } };
      expect([body.imap.pass, body.smtp.pass]).toEqual([MARKER, MARKER]);
    }
    expect(asked.filter((a) => a.path === "/auth/step-up/totp").map((a) => a.body)).toEqual([{ code: "123456" }]);
    clean(false);
  });

  it("a refusal for payment that repeats the password is the wizard's to answer, and the wizard is handed none of it", async () => {
    const ui = await atTheMailboxStep();
    await ui.type(J.mailboxAddress, ADDRESS);
    await ui.press(FASTMAIL.label);
    await ui.type(J.appPasswordLabel, MARKER);
    creates = [() => json(402, { error: {
      code: "payment_required", message: `No plan for the mailbox whose password is ${MARKER}.`, details: { reason: "payment_required", echoed: MARKER },
    } })];
    await ui.press(J.connectMailbox);
    expect(connects()).toHaveLength(1);
    // The account reads as entitled, so the wizard is back on the mailbox step, its form mounted anew and empty of it.
    expect(ui.heading()).toBe(J.step_mailbox_title);
    clean(false);
  });
});
