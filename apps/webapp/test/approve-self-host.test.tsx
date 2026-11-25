/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * A self-hosted approval must prove this server issued it before the page opens the sign-in door.
 * A bare computer link still shows the closed page in either language.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE FLAVOR, before any module under test loads, the way the build inlines it.
process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
process.env.OHMAIL_INTERNAL_API_ORIGIN = "http://api.example.test";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const replaced: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => replaced.push(to), replace: (to: string) => replaced.push(to) }),
  notFound: () => { throw new Error("notFound"); },
}));

let approvalCookie: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "mail.example.test:8443" }),
  cookies: async () => ({
    get: (name: string) => name === "ohmail_approval_launch" && approvalCookie
      ? { name, value: approvalCookie }
      : undefined,
  }),
}));

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const LAUNCH = "1780000000000." + "a".repeat(32);
const VERIFY = "http://api.example.test/auth/desktop-approval/launch";
const READ = `/api/auth/desktop-approval/${ID}`;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let fetched: string[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  globalThis.fetch = realFetch;
  approvalCookie = undefined;
  sessionStorage.clear();
  document.cookie = "tf_owner=; path=/; max-age=0";
  document.cookie = "tf_csrf=; path=/; max-age=0";
  const { markSessionAlive } = await import("@ohmail/app-logic/session/session-truth");
  const { bindApiOwner } = await import("../app/api-client");
  markSessionAlive();
  bindApiOwner(null);
  replaced.length = 0;
});

async function mountPage(
  locale: "en" | "de",
  searchParams: Record<string, string> = { request: ID },
  reply: (url: string, init?: RequestInit) => Response = () => Response.json({}),
): Promise<HTMLDivElement> {
  if (root) await act(() => { root?.unmount(); });
  host?.remove();
  fetched = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    return reply(url, init);
  }) as typeof fetch;
  const { default: ApprovePage } = await import("../app/(product)/approve/page.js");
  const page = await ApprovePage({ searchParams: Promise.resolve(searchParams) });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale, messages: locale === "de" ? de : en, timeZone: "UTC", children: page }));
  });
  // Long enough for a settle, a read or a redirect to have started if the page made one.
  await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
  return host;
}

describe("/approve on a self-hosted build", () => {
  it.each([["en", en], ["de", de]] as const)("says in %s that this server approves no computer sign-in, and does nothing else", async (locale, cat) => {
    const el = await mountPage(locale);
    // The page's sentence: its line, as the design draws it, not a heading.
    expect(el.querySelector("main p")?.textContent).toBe(cat.approve.unavailableTitle);
    expect(el.textContent).toContain(cat.approve.notOffered);
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(el.textContent, "the confirm's line is not on a page with nothing to confirm").not.toContain(cat.approve.onlyYours);
    expect(fetched, "a request left the browser").toEqual([]);
    expect(sessionStorage.length, "a request id was kept for after a sign-in").toBe(0);
    expect(replaced, "the page sent the browser somewhere").toEqual([]);
  });

  it("keeps a launch this deployment refuses closed", async () => {
    approvalCookie = LAUNCH;
    const el = await mountPage("en", { request: ID }, () => new Response(null, { status: 404 }));
    expect(el.querySelector("main p")?.textContent).toBe(en.approve.unavailableTitle);
    expect(fetched).toEqual([VERIFY]);
    expect(sessionStorage.length).toBe(0);
    expect(replaced).toEqual([]);
  });

  it("tells a phone whose launch expired during sign-in to start again in the app", async () => {
    approvalCookie = LAUNCH;
    const el = await mountPage("en", { request: ID }, () => new Response(null, { status: 410 }));
    expect(el.textContent).toContain(en.approve.expiredPhone);
    expect(fetched).toEqual([VERIFY]);
    expect(sessionStorage.length).toBe(0);
    expect(replaced).toEqual([]);
  });

  it("keeps a local phone launch across login and waits for an explicit confirm", async () => {
    approvalCookie = LAUNCH;
    let signedIn = false;
    let confirmations = 0;
    const reply = (url: string, init?: RequestInit) => {
      if (url === VERIFY) {
        expect(JSON.parse(String(init?.body))).toEqual({ approvalId: ID, origin: "https://mail.example.test:8443", launch: LAUNCH });
        expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" });
        return new Response(null, { status: 204 });
      }
      if (!signedIn) {
        const code = url.endsWith("/refresh") ? "refresh_missing" : "unauthorized";
        return Response.json({ error: { code, message: code } }, { status: 401 });
      }
      if (url === READ) {
        return Response.json({ platform: "Android", label: "Android", requestedAt: new Date().toISOString(),
          expiresIn: 300, network: "same", ipClass: "", approved: false });
      }
      if (url === `${READ}/confirm` && init?.method === "POST") {
        confirmations += 1;
        return Response.json({ approved: true });
      }
      return Response.json({ user: { accountId: "account-fixture", email: "owner@example.test" }, scope: "full" });
    };
    await mountPage("en", { request: ID }, reply);
    expect(replaced).toEqual(["/login"]);
    expect(fetched).not.toContain(READ);
    expect(JSON.stringify(Object.values(sessionStorage))).not.toContain(LAUNCH);
    const { takeApprovalReturn } = await import("../app/(product)/approve/approval-return");
    const restored = takeApprovalReturn();
    expect(restored).toBe(`/approve?request=${ID}&device=phone`);
    const returnParams = new URL(restored!, "https://mail.example.test:8443").searchParams;

    signedIn = true;
    document.cookie = "tf_owner=account-fixture; path=/";
    document.cookie = "tf_csrf=fixture; path=/";
    const el = await mountPage("en", Object.fromEntries(returnParams), reply);
    expect(replaced).toEqual(["/login"]);
    expect(fetched[0]).toBe(VERIFY);
    expect(fetched).toContain(READ);
    expect(confirmations).toBe(0);
    const confirm = [...el.querySelectorAll("button")].find((button) => button.textContent?.includes(en.approve.confirm));
    expect(confirm).toBeDefined();
    await act(() => { confirm!.click(); });
    expect(confirmations).toBe(1);
  });

  it("rejects a proof supplied only in the URL", async () => {
    const el = await mountPage("en", { request: ID, launch: LAUNCH }, () => new Response(null, { status: 204 }));
    expect(el.querySelector("main p")?.textContent).toBe(en.approve.unavailableTitle);
    expect(fetched).toEqual([]);
    expect(replaced).toEqual([]);
  });

});
