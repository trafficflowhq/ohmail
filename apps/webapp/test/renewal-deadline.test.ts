/** @vitest-environment jsdom */
/**
 * A RENEWAL THAT NEVER ANSWERS ENDS, AND SAYS SO — IT NEVER SIGNS ANYONE OUT.
 *
 * After a lid close the access cookie has lapsed, and the first request's 401 starts one
 * `POST /auth/refresh` that every other caller in the tab joins, and every other tab waits behind
 * through the cross-tab lock. Sent over a connection that died silently it never answered, so
 * every request, every sync and every press waited with it until a reload. Now the request has
 * `RENEWAL_DEADLINE_MS` (past the API's 60 s limit, so a live renewal always answers first) and
 * the lock wait `REFRESH_LOCK_GRANT_MS` (past the holder's own deadline). A timeout is `unavailable`
 * — nothing was learned about the session — keeps its attempt name for the next try, and the splash
 * shows its busy card at once instead of four more waits.
 *
 * Mutations: the deadline removed → case 1 red; a timeout read as the sign-in's abort (superseded) →
 * case 1's attempt name red; the lock's own abort falling through to the lock-less run → case 3 red;
 * the splash retrying a timeout on its ladder → case 4 red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

type Refresh = typeof import("../app/session-refresh");
/** The attempt names the renewals went out under, in order. */
let sent: string[] = [];
let mode: "hang" | "mint" = "hang";
let priorFetch: typeof globalThis.fetch;

/** A fresh module: one tab's renewal state. */
async function openTab(): Promise<Refresh> {
  vi.resetModules();
  return import("../app/session-refresh");
}

beforeEach(async () => {
  (await import("../app/shell/session-truth.js")).resetSessionTruthForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-23T09:00:00.000Z"));
  sent = [];
  mode = "hang";
  window.localStorage.clear();
  sessionStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=c0; Path=/";
  priorFetch = globalThis.fetch;
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    if (!String(input).includes("/auth/refresh")) return Promise.resolve(new Response("{}", { status: 200 }));
    sent.push(String((JSON.parse(String(init?.body ?? "{}")) as { attemptId?: unknown }).attemptId));
    if (mode === "mint") {
      document.cookie = "tf_csrf=c1; Path=/";
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = priorFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis.navigator, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
});

describe("the renewal's own deadline", () => {
  it("is past the API's 60 s limit and the lock's wait is past it", async () => {
    const tab = await openTab();
    expect(tab.RENEWAL_DEADLINE_MS).toBeGreaterThan(60_000);
    expect(tab.REFRESH_LOCK_GRANT_MS).toBeGreaterThan(tab.RENEWAL_DEADLINE_MS);
  });

  it("1 — a renewal that never answers ends unavailable at its deadline, keeps its name, and the session lives", async () => {
    const tab = await openTab();
    const { sessionIsDead } = await import("../app/shell/session-truth.js");
    let answer: string | null = null;
    void tab.resumeSession().then((a) => { answer = a; });
    // Every other caller joins the one renewal while it is out.
    let joined: string | null = null;
    void tab.resumeSession().then((a) => { joined = a; });
    await vi.advanceTimersByTimeAsync(tab.RENEWAL_DEADLINE_MS - 1_000);
    expect(answer, "the renewal ended before its deadline").toBeNull();
    expect(sent.length, "a joined caller presented the token again").toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(answer, "a renewal that never answered still holds every caller").toBe("unavailable");
    expect(joined).toBe("unavailable");
    expect(tab.lastRefreshReport()?.timedOut).toBe("request");
    expect(tab.lastRefreshOutcome(), "a timeout was read as a sign-in's abort").toBe("unavailable");
    expect(tab.refreshInFlight(), "the timed-out renewal is still in flight").toBe(false);
    expect(sessionIsDead(), "a timeout signed the browser out").toBe(false);

    // The next renewal is the same attempt: the server re-admits a token spent under its own name.
    mode = "mint";
    expect(await tab.resumeSession()).toBe("resumed");
    expect(sent.length).toBe(2);
    expect(sent[1], "the retry presented a new name").toBe(sent[0]);
  });

  it("2 — CONTROL: a renewal answered after a minute still lands", async () => {
    const tab = await openTab();
    let release!: () => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(null, { status: 204 }));
    })) as unknown as typeof fetch;
    const pending = tab.resumeSession();
    await vi.advanceTimersByTimeAsync(60_000);
    release();
    await expect(pending, "a minute-long renewal was cut off").resolves.toBe("resumed");
  });

  it("3 — a tab waiting on a lock that is never granted answers unavailable and sends nothing", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, opts: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      },
    });
    const tab = await openTab();
    let answer: string | null = null;
    void tab.resumeSession().then((a) => { answer = a; });
    await vi.advanceTimersByTimeAsync(tab.REFRESH_LOCK_GRANT_MS - 1_000);
    expect(answer, "the wait ended before its deadline").toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(answer, "the wait for the lock never ended").toBe("unavailable");
    expect(sent, "a renewal went out beside the lock's holder").toEqual([]);
    expect(tab.lastRefreshReport()?.timedOut).toBe("lock");
    expect(tab.refreshInFlight()).toBe(false);
  });
});

describe("the resume splash over a renewal that timed out", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let reloads = 0;
  let replaced: string[] = [];

  beforeEach(() => {
    reloads = 0;
    replaced = [];
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://mail.example/", origin: "https://mail.example", protocol: "https:", hash: "",
        reload: () => { reloads += 1; },
        replace: (u: string) => { replaced.push(u); },
      },
    });
  });
  afterEach(async () => {
    if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
    host?.remove();
    host = null;
  });

  async function flush(): Promise<void> {
    await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
  }
  async function tick(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 5_000) {
      await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(5_000, left)); });
      await flush();
    }
  }

  it("4 — shows the busy card at once, never the sign-in form, and Try again asks again", async () => {
    vi.resetModules();
    const { RENEWAL_DEADLINE_MS } = await import("../app/session-refresh");
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
    expect(sent.length).toBe(1);
    await tick(RENEWAL_DEADLINE_MS + 1_000);
    expect(host.textContent, "the splash never left its wait").toContain(messages.resume.busyTitle);
    expect(replaced, "a timeout sent a signed-in browser to the sign-in form").toEqual([]);
    expect(reloads).toBe(0);
    expect(sent.length, "the splash spent more renewals behind a timeout").toBe(1);

    mode = "mint";
    const again = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === messages.resume.tryAgain);
    expect(again, "the busy card offers no Try again").toBeDefined();
    await act(async () => { again!.click(); });
    await tick(1_000);
    expect(sent.length, "Try again did not ask again").toBe(2);
    expect(sent[1], "Try again presented a new name").toBe(sent[0]);
    expect(reloads, "the renewal after Try again did not reload").toBe(1);
  });
});
