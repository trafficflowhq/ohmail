/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * `/approve` on a self-hosted build. That server mounts no browser approval, because the desktop
 * asks only the hosted service, so a link to this page was made by somebody else. The page says
 * so in the reader's language and does nothing else: no request leaves the browser, no request id
 * is kept for after a sign-in, nobody is sent to `/login`, and there is nothing to press.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE FLAVOR, before any module under test loads, the way the build inlines it.
process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const replaced: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => replaced.push(to), replace: (to: string) => replaced.push(to) }),
  notFound: () => { throw new Error("notFound"); },
}));

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let fetched: string[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  globalThis.fetch = realFetch;
  sessionStorage.clear();
  replaced.length = 0;
});

async function mountPage(locale: "en" | "de"): Promise<HTMLDivElement> {
  fetched = [];
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const { default: ApprovePage } = await import("../app/(product)/approve/page.js");
  const page = await ApprovePage({ searchParams: Promise.resolve({ request: ID }) });
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
});
