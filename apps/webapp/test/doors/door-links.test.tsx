/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactTypes from "react";
import en from "../../messages/en.json";

/**
 * EVERY ADDRESS A DOOR'S PAGE DRAWS IS ONE OF THE WEB'S OWN (as the security ruling asks). A door's page writes no
 * address: it draws a link only for a way its door hands it (`DoorWay`), and the web's route writes each such way as a
 * literal, never a value of the request (`next`, a query, a fragment, a kept return). So every `a[href]` a door's page
 * draws is root-relative with one leading slash, or the bound `ohmail://` anchor of a desktop's code, or the wall's
 * guide, or the account page the server handed the join's plan step: never an address of another host. Mounted here:
 * each route that hands its page a way (the sign-in's and the join's), in each state that draws one, under an address
 * bar a stranger wrote, over the real ceremony with only the server's answers stood in.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

/** The wall's way to the self-host guide, should the wall draw it as a link. */
const SELF_HOST_GUIDE = "https://github.com/trafficflowhq/ohmail/blob/main/docs/self-host/README.md";
/** A desktop's code handed back to the app: only a bound code, only its own characters. */
const BOUND_DESKTOP = /^ohmail:\/\/link\?code=[A-Za-z0-9-]+$/;
/** The account page the server hands the join's plan step (the stand-in's answer). */
const ACCOUNT_PAGE = "https://plane.example/manage?token=t";

/** Each address a door may draw: its own, one leading slash and no second; or one of the three the ruling names. */
function allowed(href: string, accountPage: string | null): boolean {
  if (/^\/(?![/\\])/.test(href) && !/[\s\\]/.test(href)) return true;
  return BOUND_DESKTOP.test(href) || href === SELF_HOST_GUIDE || (accountPage !== null && href === accountPage);
}

/** What a stranger can write into the address bar before the page draws. */
const HOSTILE = "?next=%2F%2Fevil.example&to=https%3A%2F%2Fevil.example&join=//evil.example#//evil.example";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const enrolled = (twofa: { webauthn: boolean; totp: boolean; recoveryCodes: boolean }) => ({
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: twofa,
  },
  scope: "full",
});
const NEVER_STARTED = {
  state: "closed", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
  erasureAt: null, erasedAt: null, formerlyPaid: false, lifecycleEpoch: "2026-09-22T00:00:00.000Z",
};

/** The server, as each case answers it. */
let session: () => Response;
let mailboxes: () => Response;
let register: () => Response;
/** The plan step's ask for the account page: its address, or no such page here. */
let manageLink: () => Response;
/** The account's standing: refused (never started, the plan step) or open (past it). */
let access: "refused" | "open";
let originalFetch: typeof globalThis.fetch;
let unmounts: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  session = () => json(401, { error: { code: "unauthorized", message: "authentication required" } });
  mailboxes = () => json(200, { items: [] });
  register = () => json(202, { status: "ok" });
  manageLink = () => json(200, { url: ACCOUNT_PAGE });
  access = "refused";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const path = new URL(String(input), "http://x").pathname.replace(/^\/api/, "");
    if (path === "/auth/session") return session();
    if (path === "/auth/refresh") return json(401, { error: { code: "refresh_missing", message: "no" } });
    if (path === "/auth/register") return register();
    if (path === "/account/access")
      return access === "open"
        ? json(200, { access: "open", metered: true, canAddMailbox: true, mailboxes: 1 })
        : json(200, { access: "refused", metered: true, canAddMailbox: false, mailboxes: 0, lifecycle: NEVER_STARTED });
    if (path === "/account/manage-link") return manageLink();
    if (path.startsWith("/mailboxes")) return mailboxes();
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});

afterEach(async () => {
  for (const down of unmounts) await down();
  unmounts = [];
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * A route of the web, mounted as the web mounts it, at `path` under the hostile address bar, over a build with a
 * server (`configured`) or none, settled. Returns the document's links then, and the mount to type into.
 */
async function mounted(
  route: { file: string; name: string },
  path: string,
  props: Record<string, unknown>,
  configured = true,
): Promise<{ host: HTMLElement; settle: () => Promise<void>; act: (cb: () => Promise<void> | void) => Promise<void> }> {
  vi.resetModules();
  if (configured) process.env.NEXT_PUBLIC_API_BASE = "/api";
  else delete process.env.NEXT_PUBLIC_API_BASE;
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  window.history.replaceState(null, "", `${path}${HOSTILE}`);
  const React = (await import("react")) as typeof ReactTypes;
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const Route = (await import(route.file))[route.name] as ReactTypes.ComponentType<Record<string, unknown>>;
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
      locale: "en", messages: en, timeZone: "UTC", children: React.createElement(Route, props),
    }));
  });
  await settle();
  unmounts.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, settle, act };
}

/** Every address the document draws as a link, as written. */
const addresses = (): string[] => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")!);

const SIGN_IN = { file: "../../app/(product)/login/SignInRoute.js", name: "SignInRoute" };
const JOIN = { file: "../../app/(product)/join/JoinRoute.js", name: "JoinRoute" };

describe("every address a door's page draws is the web's own", () => {
  it("the sign-in: the ways to the join, password reset and the demo in their respective postures", async () => {
    const drawn: string[] = [];
    const back: string[] = [];
    const collect = () => {
      for (const link of document.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href")!;
        (link.getAttribute("aria-label") === en.login.back ? back : drawn).push(href);
      }
    };
    for (const [publicSignup, next] of [
      [true, null],
      [false, "/join"],
      [true, "/account/manage"],
    ] as const) {
      const { host } = await mounted(SIGN_IN, "/login", { publicSignup, next });
      const reset = [...host.querySelectorAll("a[href]")].filter((link) => link.textContent === en.login.forgotPassword);
      expect(reset.map((link) => link.getAttribute("href"))).toEqual(["/forgot-password"]);
      collect();
    }
    const { host } = await mounted(SIGN_IN, "/login", { publicSignup: false, next: null }, false);
    expect(host.querySelector('a[href="/forgot-password"]')).toBeNull();
    collect();
    expect([...drawn, ...back].filter((href) => !allowed(href, null))).toEqual([]);
    expect([...new Set(back)]).toEqual(["/"]);
    expect([...new Set(drawn)].sort()).toEqual(["/?demo=1", "/forgot-password", "/join"]);
  }, 30000);

  it("the join: the sign-in, the demo, the way back, the plan's account page and its Do this later, the first run, the list and the expired setup", async () => {
    const drawn: string[] = [];
    const typed = async (ui: Awaited<ReturnType<typeof mounted>>, id: string, value: string) => {
      const input = ui.host.querySelector<HTMLInputElement>(`#${id}`)!;
      await ui.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    /* A stranger at the account step: the way to the sign-in. */
    await mounted(JOIN, "/join", { initialCode: "", publicSignup: true });
    const signupLinks = addresses();
    expect(signupLinks).toEqual(expect.arrayContaining(["/privacy", "/terms"]));
    drawn.push(...signupLinks);
    /* No server behind the build: the demo. */
    await mounted(JOIN, "/join", { initialCode: "", publicSignup: true }, false);
    drawn.push(...addresses());
    /* The plan step: the account page the server handed. */
    session = () => json(200, enrolled({ webauthn: true, totp: false, recoveryCodes: true }));
    await mounted(JOIN, "/join", { initialCode: "", publicSignup: true });
    drawn.push(...addresses());
    /* The plan step where the service hands no account page: Do this later, the one way the step then draws. */
    manageLink = () => json(404, { error: { code: "not_found", message: "no account page here" } });
    await mounted(JOIN, "/join", { initialCode: "", publicSignup: true });
    const later = [...document.querySelectorAll("a[href]")].filter((a) => a.textContent === en.join.later);
    expect(later.map((a) => a.getAttribute("href")), "the plan step drew no Do this later").toEqual(["/"]);
    drawn.push(...addresses());
    manageLink = () => json(200, { url: ACCOUNT_PAGE });
    /* A signed-in account past the plan whose mailbox read fails: the way back to ohmail. */
    access = "open";
    mailboxes = () => json(503, { error: { code: "db_busy", message: "busy" } });
    await mounted(JOIN, "/join", { initialCode: "", publicSignup: true, signedIn: true });
    drawn.push(...addresses());
    /* Set up: into ohmail at the first run. */
    mailboxes = () => json(200, { items: [{ id: "m1", address: "pat@family.example", provider: "other", status: "connected", organizerRole: "reader", organizeConsentedAt: null }] });
    await mounted(JOIN, "/join", { initialCode: "", publicSignup: true });
    drawn.push(...addresses());
    /* A registration the service refuses for now (the list), and one whose setup session is gone (sign in again). */
    session = () => json(401, { error: { code: "unauthorized", message: "authentication required" } });
    access = "refused";
    for (const refused of [
      json(409, { error: { code: "signup_capacity", message: "full" } }),
      json(401, { error: { code: "unauthorized", message: "gone" } }),
    ]) {
      register = () => refused;
      const ui = await mounted(JOIN, "/join", { initialCode: "", publicSignup: true });
      await typed(ui, "join-email", "pat@family.example");
      await typed(ui, "join-name", "Pat");
      await typed(ui, "join-pw", "a-long-signup-password");
      await ui.act(async () => {
        ui.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await ui.settle();
      drawn.push(...addresses());
    }
    expect(drawn.filter((href) => !allowed(href, ACCOUNT_PAGE))).toEqual([]);
    /* Not a census of nothing: every way out the card drew as a link stands here, as the route wrote it. */
    expect([...new Set(drawn)].sort()).toEqual([
      "/", "/#/first-run", "/#pricing", "/?demo=1", "/login", "/login?next=join", "/privacy", "/terms", ACCOUNT_PAGE,
    ].sort());
  }, 60000);
});
