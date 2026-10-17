/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * `/login?next=manage` — a NAMED continuation, never an address. After a sign-in (or at once, for a
 * browser already signed in) the page goes to `/account/manage`, which mints a fresh account-page
 * link; any other `next` is no continuation and the page goes to the app as it always has.
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
    if (url.includes("/auth/refresh")) return json({ error: { code: "refresh_revoked", message: "no" } }, 401);
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

async function mount(next: "/account/manage" | "/join" | null): Promise<void> {
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
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
  it("`manage` and `join` and nothing else name a route", async () => {
    const { continuationOf } = await import("../app/(product)/login/continuation.js");
    expect(continuationOf("manage")).toBe("/account/manage");
    expect(continuationOf("join")).toBe("/join");
    for (const other of [
      "https://evil.example", "/account/manage", "//evil.example", "Manage", "manage ", ["manage"], "", undefined, null,
      "/join", "Join", "join ", ["join"], "join?step=mailbox",
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

describe("the form says where it goes", () => {
  const status = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>("[role=status]")];

  it("names the account page in the context slot when there is a continuation, and says nothing extra otherwise", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    await mount("/account/manage");
    // In the one status slot, not a second lede beside the factor sentence.
    expect(status().map((el) => el.textContent)).toEqual([messages.login.continueManage]);
    expect(assigned).toEqual([]);
    await act(() => root!.unmount());
    root = null;
    await mount(null);
    expect(host.textContent).not.toContain(messages.login.continueManage);
    expect(status()).toEqual([]);
  });

  it("names the setup, not the account page, when the continuation is the wizard", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    await mount("/join");
    expect(status().map((el) => el.textContent)).toEqual([messages.login.continueJoin]);
    expect(host.textContent).not.toContain(messages.login.continueManage);
  });

  it("a sign-out's reason and the continuation share that one slot, the reason first", async () => {
    session = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    sessionStorage.setItem("ohmail.signed-out-reason", "expired");
    await mount("/account/manage");
    const slots = status();
    expect(slots).toHaveLength(1);
    expect(slots[0]!.textContent).toBe(`${messages.resume.expiredBody} ${messages.login.continueManage}`);
  });
});
