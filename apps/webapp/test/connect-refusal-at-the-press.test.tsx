/** @vitest-environment jsdom */
/**
 * A REFUSED CONNECT IS TOLD WHERE THE PRESS WAS. The /join mailbox step is one form
 * on three surfaces — managed signup, a managed invite, and self-hosted setup (`/setup` hands off
 * to `/join`). Its refusal rendered at the top of the step, above the fold of a form that scrolls,
 * with focus left on nothing, so "Connect mailbox" looked dead. jsdom has no layout, so the page
 * below is a model: each element is one row in document order and the viewport starts on the
 * button, as it does after a press at the bottom of the form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { mailboxProbes } from "./join-mailbox-probes.js";

type Messages = typeof en;

const ROW = 40;
const VIEW = 400;
let scrollY = 0;
const topOf = (el: Element): number => [...document.querySelectorAll("*")].indexOf(el) * ROW;
const inView = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= VIEW;
};
const realRect = Element.prototype.getBoundingClientRect;
const realScroll = Element.prototype.scrollIntoView;

const SURFACES = [
  { name: "managed signup", flavor: "", props: { initialCode: "", publicSignup: true } },
  { name: "a managed invite", flavor: "", props: { initialCode: "OHMAIL-AAAA-BBBB-CCCC", publicSignup: false } },
  { name: "self-hosted setup", flavor: "selfhost", props: { initialCode: "", publicSignup: false } },
] as const;

const session = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
  },
  scope: "full",
};

/** What the server says for each refusal (`PROBE_REFUSAL` in `mailbox-service.ts`) — every one names a port. */
const SERVER_SAYS: Record<string, string> = {
  "connect/imap": "We could not reach that mail server. Check the IMAP host and port and try again.",
  "connect/smtp": "We could not reach that outgoing (SMTP) mail server. Check the SMTP host and port and try again.",
  "timeout/imap": "That mail server did not answer in time. Check the IMAP host and port, and try again.",
  "tls/imap": "That mail server's certificate was refused, so we stopped before sending the password. " +
    "Check the IMAP host, and whether the port expects TLS.",
};

let refusal: { status: number; body: unknown } = { status: 400, body: {} };
const refuse = (
  reason: string, transport: string, extra: Record<string, unknown> = {},
  message = SERVER_SAYS[`${reason}/${transport}`]!,
) => {
  refusal = {
    status: reason === "timeout" ? 502 : 400,
    body: { error: { code: "mailbox_probe_failed", message, details: { reason, transport, ...extra } } },
  };
};

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  scrollY = 0;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const top = topOf(this) - scrollY;
    return { top, bottom: top + ROW, height: ROW, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  Element.prototype.scrollIntoView = function (this: Element) {
    const t = topOf(this);
    if (t < scrollY) scrollY = t;
    else if (t + ROW > scrollY + VIEW) scrollY = t + ROW - VIEW;
  };
  refuse("connect", "imap");
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, session);
    if (url.includes("/mailboxes") && method === "POST") return json(refusal.status, refusal.body);
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  Element.prototype.getBoundingClientRect = realRect;
  Element.prototype.scrollIntoView = realScroll;
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.restoreAllMocks();
});

/** The wizard, freshly imported under the surface's build flavor, resumed on the mailbox step. */
async function mountOn(surface: (typeof SURFACES)[number], messages: Messages = en) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  if (surface.flavor) process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = surface.flavor;
  else delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  /* What the product's layout does for every page of its group, `/join` among them (`(product)/LocaleShell.tsx`): the
     reader's catalogue is the active one, through which the shipped step worded the refusals it handed the runner. */
  const locale = await import("../app/shell/locale.js");
  locale.setActiveCatalog(messages === de ? "de" : "en", messages as never);
  const api = await import("../app/api-client.js");
  const shipped = await import("../app/shell/probe-refusal.js");
  const { JoinRoute: JoinScreen } = await import("../app/(product)/join/JoinRoute.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: messages === de ? "de" : "en", messages, timeZone: "UTC",
      children: React.createElement(JoinScreen, surface.props),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };

  /* The step is the one connect form: its fields by their labels, its tiles by their names. */
  const { type, choose, field, refusal, button } = mailboxProbes(host, messages, act);
  const connect = () => {
    const press = button(messages.join.manualConnect) ?? button(messages.join.connectMailbox);
    expect(press, "no Connect button").toBeTruthy();
    return press!;
  };
  /** The viewport where a person pressing the button has it: the button at the bottom edge. */
  const toButton = () => { scrollY = topOf(connect()) + ROW - VIEW; };
  /** A real press: the viewport on the button, focus on the button, then the click. */
  const press = async () => {
    toButton();
    connect().focus();
    await act(async () => { connect().click(); });
    await settle();
  };
  const alert = () => {
    const found = [...host.querySelectorAll('[role="alert"]')];
    expect(found.length, "one refusal on screen").toBe(1);
    return found[0] as HTMLElement;
  };
  return { host, type, choose, field, toButton, press, alert, refusal, api, shipped };
}

async function manualForm(surface: (typeof SURFACES)[number], messages: Messages = en) {
  const ui = await mountOn(surface, messages);
  expect(ui.host.textContent).toContain(messages.onboarding.providerFirst);
  await ui.choose(messages.providerPicker.otherShort);
  expect(ui.host.querySelector("[data-page-filling-form] h1")?.textContent).toBe(messages.join.manualTitle);
  await ui.type("join-mb-address", "pat@family.example");
  await ui.type("join-imap", "mail.family.example");
  await ui.type("join-smtp", "smtp.family.example");
  await ui.type("join-mb-pass", "app-password-fixture");
  return ui;
}

describe.each(SURFACES)("the /join connect form on $name", (surface) => {
  it("puts the refusal in view and moves focus to it, press after press", async () => {
    const ui = await manualForm(surface);
    // The model is live: with the button in view, the top of the step is above the fold.
    ui.toButton();
    expect(inView(ui.host.querySelector("[data-page-filling-form] h1")!), "the modelled page does not scroll").toBe(false);

    for (const attempt of [1, 2]) {
      await ui.press();
      const said = ui.alert();
      expect(inView(said), `press ${attempt}: the refusal is off screen`).toBe(true);
      expect(document.activeElement, `press ${attempt}: focus is not on the refusal`).toBe(said);
    }
  });

  it("names the field this form has, and how a port is written in it — never a port field", async () => {
    const ui = await manualForm(surface);
    await ui.press();
    const text = ui.alert().textContent ?? "";
    // The server's own sentence says "host and port"; this form has one field per server, which
    // takes `name:port` (R23-03), so the sentence names that and not a field that is not there.
    expect(text).not.toMatch(/host and port/i);
    expect(text).toContain("IMAP server name");
    expect(text).toContain("goes after the name, as mail.example.com:1143");
  });
});

describe("the /join refusal copy", () => {
  const managed = SURFACES[0];
  const cases: Array<{ what: string; set: () => void; has: RegExp }> = [
    { what: "an unreachable outgoing server", set: () => refuse("connect", "smtp"), has: /SMTP server name/ },
    { what: "a server that did not answer in time", set: () => refuse("timeout", "imap"), has: /in time.*IMAP server name/ },
    { what: "a certificate refused with no detail", set: () => refuse("tls", "imap"), has: /certificate.*IMAP server name/ },
  ];
  for (const c of cases) {
    it(`${c.what}: says so without a port`, async () => {
      c.set();
      const ui = await manualForm(managed);
      await ui.press();
      const text = ui.alert().textContent ?? "";
      expect(text).toMatch(c.has);
      expect(text).not.toMatch(/host and port|whether the port/i);
    });
  }

  it("a named certificate fault names no port: the catalogue's own sentence (self-signed certificate)", async () => {
    const own = "That mail server's certificate is self-signed, which we cannot verify, so we stopped before sending the password.";
    refuse("tls", "imap", { tls: { kind: "self_signed" } }, own);
    const ui = await manualForm(managed);
    await ui.press();
    expect(ui.alert().textContent).toBe(en.mailboxes.probe_tls_self_signed);
  });

  it("German, a self-signed certificate: the sentence the shipped step said, through the product's catalogue", async () => {
    const server = "That mail server's certificate is self-signed, which we cannot verify, so we stopped before sending the password. Ask whoever runs the server to install a certificate from a public authority.";
    const tls = { kind: "self_signed" };
    refuse("tls", "imap", { tls }, server);
    const ui = await manualForm(managed, de);
    await ui.press();
    const thrown = new ui.api.ApiError(400, "mailbox_probe_failed", server, { reason: "tls", transport: "imap", tls });
    // The shipped step's own chain for this refusal: no no-port sentence for a named kind, then the runner's `messageOf`.
    expect(ui.shipped.noPortProbeSentence(thrown, true)).toBeNull();
    expect(ui.api.messageOf(thrown)).toBe(de.mailboxes.probe_tls_self_signed);
    expect(ui.refusal()).toBe(ui.api.messageOf(thrown));
  });

  it("a certificate for another host says both hosts, as the shipped step's catalogue sentence named them", async () => {
    const server = "That mail server's certificate does not match the host you entered, so we stopped before sending the password. Check the IMAP host with your provider.";
    const tls = { kind: "hostname_mismatch", certHost: "mail.provider.example", expectedHost: "mail.family.example" };
    refuse("tls", "imap", { tls }, server);
    const ui = await manualForm(managed);
    await ui.press();
    const shipped = ui.api.messageOf(new ui.api.ApiError(400, "mailbox_probe_failed", server, { reason: "tls", transport: "imap", tls }));
    expect(shipped).toContain("mail.provider.example");
    expect(shipped).toContain("mail.family.example");
    expect(ui.refusal()).toBe(shipped);
  });

  it("behind a named provider there is no server field to name", async () => {
    const ui = await mountOn(managed);
    await ui.choose("Fastmail");
    expect(ui.field("join-imap")).toBeNull();
    await ui.type("join-mb-address", "pat@fastmail.example");
    await ui.type("join-mb-pass", "app-password-fixture");
    await ui.press();
    const text = ui.alert().textContent ?? "";
    expect(text).toMatch(/could not reach/i);
    expect(text).not.toMatch(/\bport\b|server name/i);
  });

  it("German: the sentence is the catalogue's, and a port goes after the name", async () => {
    const ui = await manualForm(managed, de);
    await ui.press();
    const text = ui.alert().textContent ?? "";
    expect(text).toContain("IMAP-Server");
    expect(text).toContain("kommt hinter den Namen");
    expect(text).not.toMatch(/host and port/i);
  });
});
