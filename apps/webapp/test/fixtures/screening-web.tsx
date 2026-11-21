import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { vi } from "vitest";
import { resetResumeLaneForTests } from "@ohmail/app-logic/session/resume-lane";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import en from "../../messages/en.json";
import de from "../../messages/de.json";

(globalThis as { React?: typeof React }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

export const act = React.act;
export const ACCOUNT = "account-screening";
export const ISO = "2026-09-04T12:40:00.000Z";
type Answer = (path: string, query: URLSearchParams, method: string, init?: RequestInit) => Response | Promise<Response> | undefined;

let root: Root | undefined;

export function installScreeningWeb(fragment: string, answer: Answer, folders = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1280);
  const fake = createRequire(resolve("packages/client-engine/package.json"))("fake-indexeddb") as typeof import("fake-indexeddb");
  vi.stubGlobal("indexedDB", new fake.IDBFactory());
  vi.stubGlobal("IDBKeyRange", fake.IDBKeyRange);
  vi.stubGlobal("matchMedia", (media: string) => ({
    media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }));
  if (!globalThis.CSS?.escape) vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => {};
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
  window.history.replaceState(null, "", fragment);

  let sessions = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const { pathname, searchParams } = new URL(request?.url ?? String(input), window.location.href);
    const supplied = await answer(pathname, searchParams, init?.method ?? request?.method ?? "GET", init);
    if (supplied !== undefined) {
      if (supplied.ok && !supplied.headers.has("X-Ohmail-Account")) {
        supplied.headers.set("X-Ohmail-Account", ACCOUNT);
      }
      return supplied;
    }
    switch (pathname) {
      case "/api/auth/session":
        sessions += 1;
        return Response.json({
          scope: "full",
          user: { accountId: ACCOUNT, userId: "user-screening", email: "owner@example.invalid",
            displayName: "Test reader", emailVerified: true,
            twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } },
        });
      case "/auth/refresh":
        return new Response(null, { status: 204 });
      case "/api/consent":
        return Response.json({
          seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60, foldersEnabledAt: folders ? ISO : null,
        });
      case "/api/sync/snapshot":
        return new Response(null, { status: 404 });
      case "/api/sync":
        return syncScreeningWeb([], 0);
      case "/api/billing/subscription":
        return Response.json({ plan: "solo", status: "active", aiEnabled: false });
      default:
        return Response.json({});
    }
  });
  return { sessionCalls: () => sessions };
}

export const syncScreeningWeb = (creates: readonly unknown[], cursor: number) => Response.json({
  changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${cursor}`, hasMore: false, serverTime: ISO,
}, { headers: { "X-Ohmail-Account": ACCOUNT } });

async function modules() {
  const { CloudShell } = await import("../../app/(product)/mailbox/CloudShell");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  return { CloudShell, ThemeProvider, ToastHost };
}

export async function warmScreeningWeb(): Promise<void> {
  await modules();
}

export async function mountScreeningWeb(locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const { CloudShell, ThemeProvider, ToastHost } = await modules();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de} timeZone="UTC" now={new Date(ISO)}>
      <ThemeProvider><ToastHost><CloudShell demo={false} /></ToastHost></ThemeProvider>
    </NextIntlClientProvider>,
  ));
  return host;
}

export async function tick(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(left, 250)); });
  }
}

export async function teardownScreeningWeb(): Promise<void> {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  window.localStorage.clear();
  resetStorageOwnerForTest();
  resetResumeLaneForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
