import { afterEach, beforeEach, expect, vi } from "vitest";
import en from "../messages/en.json";

const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

export const STEP_UP = { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } };
export const MAILBOX_DTO = {
  id: "mb1", address: "pat@family.example", provider: "imap", organizeConsentedAt: null,
};

export const fixture = {
  /** Answers to POST /mailboxes, in order. The last answer repeats. */
  creates: [] as Array<{ status: number; body: unknown }>,
  createBodies: [] as unknown[],
  stepUps: [] as unknown[],
  signedIn: true,
  hasCodes: true,
  recentFactor: false,
  codesRequests: [] as (string | null)[],
  routed: [] as string[],
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => { fixture.routed.push(to); }, replace: (to: string) => { fixture.routed.push(to); } }),
}));

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fixture.creates = [];
  fixture.createBodies = [];
  fixture.stepUps = [];
  fixture.signedIn = true;
  fixture.hasCodes = true;
  fixture.recentFactor = false;
  fixture.codesRequests = [];
  fixture.routed.length = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return fixture.signedIn
      ? json(200, { ...FULL, user: { ...FULL.user, twofaEnrolled: { ...FULL.user.twofaEnrolled, recoveryCodes: fixture.hasCodes } } })
      : json(401, { error: { code: "unauthorized", message: "no" } });
    if (url.includes("/auth/refresh")) return json(401, { error: { code: "refresh_missing", message: "no" } });
    if (url.includes("/auth/login")) return json(200, { status: "twofa_required", loginToken: "tok", methods: ["totp"] });
    if (url.includes("/auth/2fa/totp/verify")) { fixture.signedIn = true; fixture.recentFactor = true; return json(200, FULL); }
    if (url.endsWith("/auth/2fa/recovery-codes")) {
      fixture.codesRequests.push(new Headers(init?.headers).get("x-ohmail-recovery-if-missing"));
      if (!fixture.recentFactor) return json(403, STEP_UP);
      fixture.hasCodes = true;
      return json(200, { codes: ["abcd-efgh-ijkl"] });
    }
    if (url.includes("/auth/step-up/totp")) {
      fixture.stepUps.push(JSON.parse(String(init?.body ?? "{}")));
      return json(200, { ok: true });
    }
    if (url.includes("/mailboxes") && method === "POST") {
      fixture.createBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const answer = fixture.creates.length > 1 ? fixture.creates.shift()! : fixture.creates[0]!;
      return json(answer.status, answer.body);
    }
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

export async function unmountJoin(): Promise<void> {
  if (unmount) await unmount();
  unmount = null;
}

afterEach(async () => {
  await unmountJoin();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

export async function mountJoin() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinRoute: JoinScreen } = await import("../app/(product)/join/JoinRoute.js");
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
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  return { host, act, settle };
}

/** `/login` as a link opens it, signed out: the page reads `?next=`, the person signs in with a code. Returns where the tab left for. */
export async function signInFrom(link: string): Promise<string[]> {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { default: LoginPage } = await import("../app/(product)/login/page.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const url = new URL(link);
  const left: string[] = [];
  const location = Object.getOwnPropertyDescriptor(window, "location")!;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: url.href, origin: url.origin, protocol: url.protocol, pathname: url.pathname, search: url.search, hash: "",
      assign: (to: string) => { left.push(to); }, replace: (to: string) => { left.push(`replace:${to}`); },
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const until = async (done: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !done(); i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(done(), what).toBe(true);
  };
  const fill = async (id: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const submit = () => act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  try {
    const page = await LoginPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) });
    await act(async () => {
      root.render(React.createElement(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: page }));
    });
    await until(() => host.querySelector("#login-email") !== null, "the password step");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(left, "the existing session must not satisfy the fresh sign-in").toEqual([]);
    await fill("login-email", "pat@family.example");
    await fill("login-pw", "sign-in-password-fixture");
    await submit();
    await until(() => host.querySelector("#login-code") !== null, "the code step");
    await fill("login-code", "123456");
    await submit();
    await until(() => left.length > 0, "the sign-in's continuation");
    return left;
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.defineProperty(window, "location", location);
  }
}
