/** @vitest-environment jsdom */
/**
 * THE SPLASH IS NEVER A BLANK PAGE. Reported on ohmail.app: a bare page in the canvas colour for over
 * 20 s, then the sign-in form. The resume splash rendered an empty `div.gate` for as long as the
 * refresh door took (measured over a production build: a door held 20 s was 20 s of nothing). It now
 * shows its card from the first frame, server-rendered, and says what it waits for once the wait
 * outlasts the loading grace. Every needle is rendered catalogue text; the grace is the shipped one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { LOADING_GRACE_MS } from "../app/shell/loading-grace.js";
import * as scan from "../../../scripts/lib/source-scan.mjs";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
process.env.NEXT_PUBLIC_API_BASE = "/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const R = messages.resume as Record<string, string>;

let refreshes = 0;
let reloads = 0;
let replaced: string[] = [];
let priorFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(async () => {
  (await import("../app/shell/session-truth.js")).resetSessionTruthForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-18T14:00:00.000Z"));
  refreshes = 0;
  reloads = 0;
  replaced = [];
  sessionStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://mail.example/", origin: "https://mail.example", protocol: "https:", hash: "",
      reload: () => { reloads += 1; },
      replace: (u: string) => { replaced.push(u); },
    },
  });
  priorFetch = globalThis.fetch;
  // The refresh door never answers: the wait the report measured, at its worst.
  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/auth/refresh")) {
      refreshes += 1;
      return new Promise<Response>(() => {});
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  globalThis.fetch = priorFetch;
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await flush();
}

async function mountResume(): Promise<HTMLElement> {
  const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(ResumeScreen, { initialOwner: "acct_A" }),
    }));
  });
  await flush();
  return host;
}

const text = (el: HTMLElement): string => el.textContent ?? "";
const mark = (el: HTMLElement): string | null => el.querySelector(".gate-card .wordmark")?.textContent ?? null;

describe("the splash paints its card while the refresh door is out", () => {
  it("a door that never answers: the wordmark card at once, the waiting line after the grace", async () => {
    const el = await mountResume();
    expect(refreshes, "the splash never asked the refresh door").toBe(1);
    expect(mark(el), "the splash painted nothing while it waited").toBe("ohmail");
    expect(el.querySelector('.gate[aria-busy="true"]'), "the wait is not marked busy").not.toBeNull();
    expect(R.workingBody, "the catalogue has no waiting line").toBe("Checking your sign-in…");
    // Below the grace, the card alone: a sentence that flashes is worse than a quiet card.
    await advance(LOADING_GRACE_MS - 50);
    expect(text(el)).not.toContain(R.workingBody);
    await advance(100);
    expect(text(el), "a long wait never says what it waits for").toContain(R.workingBody);
    // Still waiting, still saying so, and nothing navigated.
    await advance(20_000);
    expect(mark(el)).toBe("ohmail");
    expect(text(el)).toContain(R.workingBody);
    expect(replaced).toEqual([]);
    expect(reloads).toBe(0);
  });

  it("the server renders the card: the first paint is never empty", async () => {
    const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen.js");
    const html = renderToString(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(ResumeScreen, { initialOwner: "acct_A" }),
    }));
    expect(html, "the document the edge sends paints nothing").toMatch(/class="gate-card"/);
    expect(html).toContain("<em>oh</em>mail");
    expect(html, "the waiting line is said before the grace").not.toContain(R.workingBody);
  });

  it("the waiting line is said in German too", () => {
    expect((de.resume as Record<string, string>).workingBody).toBe("Deine Anmeldung wird geprüft …");
  });
});

describe("the splash never finishes a sign-out", () => {
  it("ResumeScreen names neither the reserved marker nor the sign-out", () => {
    const src = scan.withoutComments(readFileSync(resolve("apps/webapp/app/(product)/resume/ResumeScreen.tsx"), "utf8"));
    const specifiers = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    expect(specifiers.length, "the reader found no imports, so it reads nothing").toBeGreaterThan(3);
    expect(specifiers.filter((s) => /sign-out/.test(s)), "the splash loads the sign-out").toEqual([]);
    expect(src, "the splash reads the reserved marker by name").not.toMatch(/\bOWNER_SIGNED_OUT\b/);
  });
});
