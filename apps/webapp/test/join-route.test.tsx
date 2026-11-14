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
let sent: Array<{ path: string; body: unknown }> = [];
let went: string[] = [];
let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
const realLocation = window.location;

beforeEach(() => {
  session = () => NO_SESSION;
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
    if (path === "/account/access") return json(200, { access: "refused", metered: true, canAddMailbox: false, mailboxes: 0, lifecycle: NEVER_STARTED });
    if (path === "/account/manage-link") return json(200, { url: "https://plane.example/manage?token=t" });
    if (path === "/auth/2fa/recovery-codes") return json(200, { codes: CODES });
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
    return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
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
  return { host, blank, type, button, press, heading };
}

describe("the join's page over its ceremony", () => {
  it("a stranger: the stations under the setup's name, the account from three blanks, the mail said sent", async () => {
    const ui = await mount();
    expect(ui.heading()).toBe(J.step_account_title);
    const stations = ui.host.querySelector(`ol[aria-label="${J.progress}"]`);
    expect(stations, "no list named by the setup's progress").not.toBeNull();
    expect(stations!.textContent).toContain(J.rail_account);
    await ui.type(J.emailLabel, " pat@family.example ");
    await ui.type(J.nameLabel, "Pat");
    await ui.type(J.passwordLabel, PASSWORD);
    await ui.press(J.createAccount);
    const register = sent.find((s) => s.path === "/auth/register");
    expect(register?.body).toMatchObject({ email: "pat@family.example", displayName: "Pat", password: PASSWORD, locale: "en" });
    expect(ui.heading()).toBe(J.step_sent_title);
    expect(ui.host.textContent).toContain(J.step_sent_lead.replace("{email}", "pat@family.example"));
  });

  it("the authenticator: its picture, and its code taken as six digits and sent as typed", async () => {
    session = () => json(200, { user: user({ totp: false, recoveryCodes: false }), scope: "enrollment" });
    const ui = await mount();
    expect(ui.heading()).toBe(J.step_factor_title);
    await ui.press(J.useTotp);
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
    expect(ui.heading()).toBe(J.step_plan_title);
    expect(ui.button(J.planLater), "Not now is offered").toBeNull();
    expect(ui.host.textContent).not.toContain(J.planLaterHint);
    const plan = [...ui.host.querySelectorAll("a")].find((a) => a.textContent === J.planStartTrial);
    expect(plan?.getAttribute("href")).toBe("https://plane.example/manage?token=t");
  });

  it("the codes: Download hands this device a text file of them, with its header, and nothing leaves", async () => {
    session = () => json(200, { user: user({ totp: true, recoveryCodes: false }), scope: "full" });
    const ui = await mount();
    expect(ui.heading()).toBe(J.step_codes_title);
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
