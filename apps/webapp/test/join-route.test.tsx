/** @vitest-environment jsdom */
/**
 * THE JOIN'S PAGE OVER THE JOIN'S OWN CEREMONY (`JoinRoute`: built, not mounted yet). The real ceremony and the real
 * `api-client`, only `fetch`, the router and the document's navigation stubbed. What the route must keep of the card:
 * the stations listed under the setup's name (the name the first run's journey arrives by), the account made from the
 * three blanks and the public path's mail said sent, the authenticator's code as six digits, and the plan step's one
 * way on to the account page, with no "Not now" (decided in the inbox by its recommendation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { PROVIDERS } from "../app/shell/providers.js";

const J = en.join;
const PASSWORD = fixturePassword("join-route");
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NO_SESSION = json(401, { error: { code: "unauthorized", message: "authentication required" } });
const user = (twofa: { totp: boolean; recoveryCodes: boolean }) => ({
  userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
  twofaEnrolled: { webauthn: false, ...twofa },
});
/** The recovery codes the stand-in makes. */
const CODES = [["AAAA", "1111"], ["BBBB", "2222"], ["CCCC", "3333"], ["DDDD", "4444"]].map((c) => c.join("-"));
/** The authenticator key the stand-in hands out. */
const SEED = "JBSWY3DPEHPK3PXP";
const NEVER_STARTED = {
  state: "closed", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
  erasureAt: null, erasedAt: null, formerlyPaid: false, lifecycleEpoch: "2026-09-22T00:00:00.000Z",
};

let session: () => Response = () => NO_SESSION;
/** What the service says of the account's plan: refused until a case says the account may add a mailbox. */
let entitled = false;
/** What the next `POST /mailboxes` answers. */
let create: () => Response = () => json(201, {});
let sent: Array<{ path: string; body: unknown }> = [];
let went: string[] = [];
let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
const realLocation = window.location;

beforeEach(() => {
  session = () => NO_SESSION;
  document.cookie = "tf_family=; Path=/; Max-Age=0";
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  entitled = false;
  create = () => json(201, {});
  sent = [];
  went = [];
  window.history.replaceState(null, "", "/join");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() { return document.URL; },
      get search() { return new URL(document.URL).search; },
      get pathname() { return new URL(document.URL).pathname; },
      get hash() { return new URL(document.URL).hash; },
      get origin() { return new URL(document.URL).origin; },
      assign: (url: string) => { went.push(url); },
      replace: (url: string) => { went.push(url); },
    },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = new URL(String(input), "http://x").pathname.replace(/^\/api/, "");
    if (init?.body !== undefined) sent.push({ path, body: JSON.parse(String(init.body)) });
    if (path === "/auth/session") return session();
    if (path === "/auth/refresh") return json(401, { error: { code: "refresh_missing", message: "no" } });
    if (path === "/auth/register") return json(202, { status: "ok" });
    if (path === "/auth/2fa/totp/enroll") return json(200, { secret: SEED, otpauthUrl: `otpauth://totp/ohmail:pat?secret=${SEED}` });
    if (path === "/auth/2fa/totp/activate") return json(422, { error: { code: "unprocessable", message: "invalid TOTP code" } });
    if (path === "/account/access") {
      return entitled
        ? json(200, { access: "open", metered: true, canAddMailbox: true, mailboxes: 1, lifecycle: NEVER_STARTED })
        : json(200, { access: "refused", metered: true, canAddMailbox: false, mailboxes: 0, lifecycle: NEVER_STARTED });
    }
    if (path === "/account/manage-link") return json(200, { url: "https://plane.example/manage?token=t" });
    if (path === "/auth/2fa/recovery-codes") return json(200, { codes: CODES });
    if (path === "/mailboxes" && (init?.method ?? "GET").toUpperCase() === "POST") return create();
    if (path.startsWith("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  vi.restoreAllMocks();
});

async function mount(props: Record<string, unknown> = { initialCode: "", publicSignup: true }) {
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
      locale: "en", messages: en, timeZone: "UTC", children: React.createElement(JoinRoute, props as never),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  /** A blank, by the name its label gives it. */
  const blank = (name: string) => {
    const label = [...host.querySelectorAll("label")].find((l) => l.textContent === name);
    return label
      ? (document.getElementById(label.htmlFor) as HTMLInputElement | null)
      : [...host.querySelectorAll<HTMLInputElement>("input[aria-label]")].find(
          (input) => input.getAttribute("aria-label") === name,
        ) ?? null;
  };
  const type = async (name: string, value: string) => {
    const input = blank(name);
    expect(input, `no blank named ${name}`).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  /** A button by the start of its name: an ink button also carries its key. */
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(name)) ?? null;
  const press = async (name: string) => {
    const b = button(name);
    expect(b, `no button named ${name}`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
  };
  const heading = () => host.querySelector("h1")?.textContent ?? null;
  const signIn = () => [...host.querySelectorAll('a[href="/login"]')].map((a) => a.textContent);
  return { host, blank, type, button, press, heading, signIn };
}

describe("the join's page over its ceremony", () => {
  it("a stranger: the stations under the setup's name, the account from three blanks, the mail said sent", async () => {
    const ui = await mount();
    expect(ui.heading()).toBe(J.account.replace("<name>,</name>", `${J.nameLabel},`).replace("<email>,</email>", `${J.emailLabel},`).replace("<password></password>.", J.passwordLabel));
    expect(ui.signIn()).toEqual([J.signIn]);
    const stations = ui.host.querySelector('[role="img"][aria-label^="Step 1 of 5, Account"]');
    expect(stations, "no list named by the setup's progress").not.toBeNull();
    expect(stations!.getAttribute("aria-label")).toContain(J.rail_account);
    await ui.type(J.emailLabel, " pat@family.example ");
    await ui.type(J.nameLabel, "Pat");
    await ui.type(J.passwordLabel, PASSWORD);
    await ui.press(J.continue);
    const register = sent.find((s) => s.path === "/auth/register");
    expect(register?.body).toMatchObject({ email: "pat@family.example", displayName: "Pat", password: PASSWORD, locale: "en" });
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.heading()).toContain(J.openLink.split("<a>")[0]!.trim());
    expect(ui.host.textContent).toContain(J.openLink.replace("<a>{email}</a>.", "pat@family.example"));
  });

  it("the authenticator: its picture, and its code taken as six digits and sent as typed", async () => {
    document.cookie = "tf_family=enroll-fixture; Path=/";
    document.cookie = "tf_owner=a1; Path=/";
    session = () => json(200, { user: user({ totp: false, recoveryCodes: false }), scope: "enrollment", familyId: "enroll-fixture" });
    const ui = await mount();
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.heading()).toBe(J.lockWith.replace("<how></how>.", J.factorPasskeyWord));
    await ui.press(J.factorApp);
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.host.querySelector(`[aria-label="${J.totpQrAria}"]`), "no picture of the enrolment").not.toBeNull();
    expect(ui.host.textContent).toContain(SEED.match(/.{4}/g)!.join(" "));
    await ui.type(J.totpLabel, "12a 345-6");
    expect(ui.blank(J.totpLabel)!.value).toBe("123456");
    await ui.press(J.activate);
    expect(sent.find((s) => s.path === "/auth/2fa/totp/activate")?.body).toEqual({ code: "123456" });
    // The refusal is said under the code it is about.
    const code = ui.blank(J.totpLabel)!;
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(code.getAttribute("aria-describedby")!)?.textContent).toBe(J.refusedTotpCode);
  });

  it("the plan: one way on, a link to the account page the service mints; no Not now", async () => {
    session = () => json(200, { user: user({ totp: true, recoveryCodes: true }), scope: "full" });
    const ui = await mount();
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.heading()).toBe("Start your 14-day trial");
    expect(ui.button(J.planLater), "Not now is offered").toBeNull();
    expect(ui.host.textContent).not.toContain(J.planLaterHint);
    const plan = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === J.planStartTrial);
    expect(plan?.getAttribute("href")).toBe("https://plane.example/manage?token=t");
  });

  it("the codes: Download hands this device a text file of them, with its header, and nothing leaves", async () => {
    session = () => json(200, { user: user({ totp: true, recoveryCodes: false }), scope: "full" });
    const ui = await mount();
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.heading()).toBe(J.step_codes_title.replace(/\.$/, ""));
    const files: Array<{ name: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      files.push({ name: this.download, href: this.getAttribute("href") ?? "" });
    });
    const before = sent.length;
    await ui.press(J.codesDownload);
    expect(files.map((f) => f.name)).toEqual(["ohmail-recovery-codes.txt"]);
    const text = decodeURIComponent(files[0]!.href.replace(/^data:text\/plain;charset=utf-8,/, ""));
    expect(text).toContain(J.codesFileHeader);
    for (const code of CODES) expect(text).toContain(code);
    expect(sent.length, "the codes went somewhere").toBe(before);
  });
});

/**
 * THE MAILBOX STEP IS THE ONE CONNECT FORM, UNDER THE WIZARD. The form sends and says what the step sent and said; the
 * wizard stays what asks whose browser this is before a credential leaves, what a refused connect means for the
 * setup, and where a connected mailbox ends.
 */
describe("the join's mailbox step: the one connect form under the wizard", () => {
  const ADDRESS = "pat@fastmail.example";
  const FASTMAIL = PROVIDERS.find((p) => p.id === "fastmail")!;
  const posts = () => sent.filter((s) => s.path === "/mailboxes");
  /** The wizard resumed on the mailbox step, the Fastmail tile chosen, an address and a password typed. */
  const typed = async () => {
    entitled = true;
    session = () => json(200, { user: user({ totp: true, recoveryCodes: true }), scope: "full" });
    const ui = await mount();
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.heading()?.trim()).toBe(en.onboarding.providerFirst);
    await ui.type(J.mailboxAddress, ADDRESS);
    await ui.press(FASTMAIL.label);
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.heading()).toBe(J.step_mailbox_title);
    await ui.type(J.appPasswordLabel, PASSWORD);
    return ui;
  };

  it("connected: one request, the body the step always sent, and the done step names the row the server answered", async () => {
    create = () => json(201, { id: "mb1", address: ADDRESS, provider: "fastmail", organizeConsentedAt: null });
    const ui = await typed();
    await ui.press(J.connectMailbox);
    expect(posts().map((s) => s.body)).toEqual([{
      provider: "fastmail",
      address: ADDRESS,
      imap: { host: FASTMAIL.imap.host, port: FASTMAIL.imap.port, secure: FASTMAIL.imap.secure, user: ADDRESS, pass: PASSWORD },
      smtp: { host: FASTMAIL.smtp.host, port: FASTMAIL.smtp.port, secure: FASTMAIL.smtp.secure, user: ADDRESS, pass: PASSWORD },
    }]);
    expect(ui.signIn()).toEqual([J.signIn]);
    expect(ui.heading()).toBe(J.myMailboxes.replace(/\.$/, ""));
    expect(ui.host.textContent).toContain(ADDRESS);
  });

  it("a browser now signed in as somebody else sends nothing, says the wizard's sentence, and keeps what was typed", async () => {
    const ui = await typed();
    session = () => json(200, { user: { ...user({ totp: true, recoveryCodes: true }), accountId: "b2", email: "sam@family.example" }, scope: "full" });
    await ui.press(J.connectMailbox);
    expect(posts(), "a credential typed for one account left under another").toEqual([]);
    expect(ui.heading()).toBe(J.step_mailbox_title);
    expect(ui.host.textContent).toContain(J.accountChanged.replace("{email}", "sam@family.example"));
    expect(ui.blank(J.mailboxAddress)!.value).toBe(ADDRESS);
    expect(ui.blank(J.appPasswordLabel)!.value).toBe(PASSWORD);
  });

  it("a refusal for payment is the wizard's: the plan step, with the server's sentence", async () => {
    const said = "This account needs a plan before it can connect a mailbox.";
    create = () => json(402, { error: { code: "payment_required", message: said, details: { reason: "payment_required" } } });
    const ui = await typed();
    // The plan step reads the account once as it opens; while it says no mailbox may be added, the step stands.
    entitled = false;
    await ui.press(J.connectMailbox);
    expect(posts()).toHaveLength(1);
    expect(ui.heading()).toBe("Start your 14-day trial");
    expect(ui.host.textContent).toContain(said);
  });

  it("what was typed survives a trip to another step and the wizard's sentence stands at the form; the password does not travel", async () => {
    const said = "This account needs a plan before it can connect a mailbox.";
    create = () => json(402, { error: { code: "payment_required", message: said, details: { reason: "payment_required" } } });
    const ui = await typed();
    // The account reads as entitled when the plan step opens, so the wizard returns to the provider chooser.
    // The previous tile stays selected. Press it again to open the form with the typed address and an empty password.
    await ui.press(J.connectMailbox);
    expect(posts()).toHaveLength(1);
    expect(ui.heading()?.trim()).toBe(en.onboarding.providerFirst);
    expect(ui.blank(J.mailboxAddress)!.value, "the address typed before the trip").toBe(ADDRESS);
    expect(ui.button(FASTMAIL.label)?.getAttribute("aria-pressed"), "the tile chosen before the trip").toBe("true");
    await ui.press(FASTMAIL.label);
    expect(ui.blank(J.appPasswordLabel), "the tile chosen before the trip").not.toBeNull();
    expect(ui.blank(J.appPasswordLabel)!.value, "a password kept across steps").toBe("");
    expect(ui.host.textContent).toContain(said);
  });

  it("a session nobody can read any more sends nothing, and the wizard says why where the press was", async () => {
    const ui = await typed();
    session = () => NO_SESSION;
    await ui.press(J.connectMailbox);
    expect(posts(), "a credential left with nobody known to be signed in").toEqual([]);
    const said = [...ui.host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "").join("");
    expect(said.trim(), "the press ended with nothing said").not.toBe("");
  });
});

