/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { Continuation } from "../app/(product)/login/continuation.js";

/**
 * `/login?next=manage` — a NAMED continuation, never an address. After a sign-in (or at once, for a
 * browser already signed in) the page goes to `/account/manage`, which mints a fresh account-page
 * link. An unknown `next` continues to the app as usual.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const FULL = {
  user: {
    userId: "usr_1", accountId: "acct_1", email: "n@example.invalid", displayName: "N",
    emailVerified: true, twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

let routed: string[] = [];
let assigned: string[] = [];
let session: () => Response = () => json(FULL, 200);
const router = {
  replace: (to: string) => { routed.push(to); },
  push: (to: string) => { routed.push(to); },
};
vi.mock("next/navigation", () => ({ useRouter: () => router }));

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  routed = [];
  assigned = [];
  session = () => json(FULL, 200);
  sessionStorage.clear();
  localStorage.clear();
  document.cookie = "tf_signed_out=; Path=/; Max-Age=0";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://ohmail.app/login", origin: "https://ohmail.app", protocol: "https:", hash: "",
      pathname: "/login", search: "",
      assign: (u: string) => { assigned.push(u); },
      replace: (u: string) => { assigned.push(`replace:${u}`); },
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/auth/session")) return session();
    // A signed-out visit's own answer: no refresh token in the jar.
    if (url.includes("/auth/refresh")) return json({ error: { code: "refresh_missing", message: "no" } }, 401);
    if (url.includes("/hello")) return json({ features: { pairing: false } }, 200);
    return json({}, 200);
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(next: Continuation | null): Promise<void> {
  const { SignInRoute: LoginScreen } = await import("../app/(product)/login/SignInRoute.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(LoginScreen, { next }),
    }));
  });
  for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); });
}

describe("the continuation is a name read once, never a URL", () => {
  it("accepts the listed continuations and rejects arbitrary destinations", async () => {
    const { continuationOf } = await import("../app/(product)/login/continuation.js");
    expect(continuationOf("manage")).toBe("/account/manage");
    expect(continuationOf("join")).toBe("/join");
    for (const other of [
      "https://evil.example", "/account/manage", "//evil.example", "Manage", "manage ", ["manage"], "", undefined, null,
      "/join", "Join", "join ", ["join"], "join?step=mailbox",
      "calendar-icloud", ["calendar-google"], "/#/cal/cal-setup?via=google",
    ]) {
      expect(continuationOf(other), JSON.stringify(other)).toBeNull();
    }
  });

  it("the page narrows the query before the screen sees it", async () => {
    const { default: LoginPage } = await import("../app/(product)/login/page.js");
    const nextOf = async (searchParams: Record<string, string>): Promise<unknown> =>
      ((await LoginPage({ searchParams: Promise.resolve(searchParams) })) as React.ReactElement<{ next: unknown }>).props.next;
    expect(await nextOf({ next: "manage" })).toBe("/account/manage");
    expect(await nextOf({ next: "join" })).toBe("/join");
    expect(await nextOf({ next: "https://evil.example" })).toBeNull();
    expect(await nextOf({})).toBeNull();
  });
});

describe("a browser already signed in continues without the form", () => {
  it("with next=manage it leaves for /account/manage as a document navigation", async () => {
    await mount("/account/manage");
    expect(assigned).toEqual(["/account/manage"]);
    expect(routed).toEqual([]);
  });

  it("with next=join it leaves for the signup wizard, which resumes on the server's step", async () => {
    await mount("/join");
    expect(assigned).toEqual(["/join"]);
    expect(routed).toEqual([]);
  });

  it.each(["google", "microsoft"])("requires a handoff for a desktop calendar destination (%s)", async (provider) => {
    const { continuationOf } = await import("../app/(product)/login/continuation.js");
    await mount(continuationOf(`calendar-${provider}`));
    expect(assigned).toEqual([]);
    expect(routed).toEqual(["/"]);
  });

  it("without it, the app as always (the control)", async () => {
    await mount(null);
    expect(routed).toEqual(["/"]);
    expect(assigned).toEqual([]);
  });

  it("the desktop approval's own return still comes first", async () => {
    const { rememberApprovalRequest } = await import("../app/(product)/approve/approval-return.js");
    rememberApprovalRequest("11111111-1111-4111-8111-111111111111");
    await mount("/account/manage");
    expect(routed).toEqual(["/approve?request=11111111-1111-4111-8111-111111111111"]);
    expect(assigned).toEqual([]);
  });
});

describe("the continuation stays off the form", () => {
  const status = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>("[role=status]")];

  it("offers the same password form with and without an account continuation", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    await mount("/account/manage");
    expect(status()).toEqual([]);
    expect(assigned).toEqual([]);
    await act(() => root!.unmount());
    root = null;
    await mount(null);
    expect(host.textContent).not.toContain("Sign in, and your account page opens.");
    expect(status()).toEqual([]);
  });

  it("omits both context sentences when the continuation is setup", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    await mount("/join");
    expect(status()).toEqual([]);
    expect(host.textContent).not.toContain("Sign in, and your setup carries on where it stopped.");
    expect(host.textContent).not.toContain("Sign in, and your account page opens.");
  });

  it("shows the sign-out reason beside the sign-in form", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    sessionStorage.setItem("ohmail.signed-out-reason", "expired");
    await mount("/account/manage");
    expect(status()).toEqual([]);
    expect(host.textContent).toContain(messages.resume.expiredBody);
    expect(host.querySelector("#login-email")).not.toBeNull();
  });
});
