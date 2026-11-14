/** @vitest-environment jsdom */
/**
 * A RELOADED RESUME SPLASH PRESENTS THE REFRESH TOKEN ONCE (triage-026-ux-boot). The splash's renewal
 * is a keepalive request: a reload while it is out leaves it running, the browser releases the dead
 * page's lock, and its answer lands in the jar after the page is gone. The next page's splash used to
 * present the same token again at once (the server converged it inside its grace). Now it waits for
 * that answer to land and presents nothing; with no answer by the bound it presents as before.
 *
 * Pages are module instances over one jar and one lock manager that drops a page's grants when the
 * page unloads; the dead page's request is never answered to it, and its answer is a cookie write.
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
process.env.NEXT_PUBLIC_API_BASE = "/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

/** The jar's refresh token: HttpOnly, so the server's side of the rig holds it. */
let refreshToken = "r1";
let presented: Array<{ page: number; token: string; at: number }> = [];
let page = 0;
/** How long the server takes to answer; the dead page's answer lands in the jar after it. */
let answerMs = 200;
let loseAnswers = false;
/** The next answer is a fault the page hears at once (503), and the jar keeps its token. */
let faultNext = false;
let reloads = 0;
const roots: Root[] = [];

// ── a lock manager whose grants die with their page ───────────────────────────────────────────
interface Grant { page: number; mode: string; done: boolean }
let held: Grant[] = [];
let queue: Array<{ page: number; mode: string; run: () => void }> = [];
function pump(): void {
  while (queue.length > 0) {
    const next = queue[0]!;
    const free = next.mode === "shared" ? !held.some((g) => g.mode === "exclusive") : held.length === 0;
    if (!free) return;
    queue.shift();
    next.run();
  }
}
function release(g: Grant): void {
  if (g.done) return;
  g.done = true;
  held = held.filter((x) => x !== g);
  pump();
}
const locks = {
  request: (_name: string, opts: { mode?: string } | undefined, cb: () => Promise<unknown>) => {
    const owner = page;
    const mode = opts?.mode ?? "exclusive";
    return new Promise((resolve, reject) => {
      queue.push({
        page: owner, mode, run: () => {
          const grant: Grant = { page: owner, mode, done: false };
          held.push(grant);
          Promise.resolve().then(() => cb()).then((v) => { release(grant); resolve(v); }, (e) => { release(grant); reject(e); });
        },
      });
      pump();
    });
  },
};
/** The page unloads: the browser releases its locks; its requests keep going without it. */
function unload(p: number): void {
  for (const g of held.filter((x) => x.page === p)) release(g);
  queue = queue.filter((q) => q.page !== p);
}

function serve(): Promise<Response> {
  const from = page;
  const token = refreshToken;
  presented.push({ page: from, token, at: Date.now() });
  if (faultNext) {
    faultNext = false;
    return Promise.resolve(new Response(JSON.stringify({ error: { code: "db_busy", message: "busy" } }),
      { status: 503, headers: { "content-type": "application/json" } }));
  }
  const next = `r${presented.length + 1}`;
  return new Promise((resolve) => {
    setTimeout(() => {
      if (loseAnswers) return;
      // The browser stores the answer's cookies whether or not its page is still there.
      refreshToken = next;
      document.cookie = `tf_csrf=c-${next}; Path=/`;
      if (from === page) resolve(new Response(null, { status: 204 }));
    }, answerMs);
  });
}

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}
async function tick(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 50) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(50, left)); });
    await flush();
  }
}

/** A new page in this tab loads the splash: fresh modules, the same jar, storage and locks. */
async function loadSplash(owner = "acct_A"): Promise<void> {
  page += 1;
  vi.resetModules();
  const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(ResumeScreen, { initialOwner: owner }),
    }));
  });
  await flush();
}

/** The person reloads: the page's locks go, its request goes on. */
async function reload(): Promise<void> {
  unload(page);
  const r = roots.pop();
  if (r) await act(async () => { r.unmount(); });
}

beforeEach(async () => {
  (await import("@ohmail/app-logic/session/session-truth")).resetSessionTruthForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-06T08:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  refreshToken = "r1";
  presented = [];
  page = 0;
  answerMs = 200;
  loseAnswers = false;
  faultNext = false;
  reloads = 0;
  held = [];
  queue = [];
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: locks });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://mail.example/resume", origin: "https://mail.example", protocol: "https:", hash: "",
      reload: () => { reloads += 1; },
      replace: () => {},
    },
  });
  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/auth/refresh")) return serve();
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount(); });
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const timesPresented = (token: string): number => presented.filter((p) => p.token === token).length;

describe("the resume splash, reloaded while its renewal is out", () => {
  it("presents the refresh token once: the next page waits for the first page's answer and reloads on it", async () => {
    await loadSplash();
    expect(timesPresented("r1"), "control: the first page presented").toBe(1);
    await tick(70);
    await reload();
    await loadSplash();
    await tick(400);
    expect(timesPresented("r1"), "the reloaded splash presented the same token again").toBe(1);
    expect(presented, "the reloaded splash presented anything at all").toHaveLength(1);
    expect(reloads, "the reloaded splash did not go on into the app").toBe(1);
  });

  it("another account signing in while the reloaded splash waits: nothing is presented, the splash reloads", async () => {
    loseAnswers = true;
    await loadSplash();
    await tick(70);
    await reload();
    await loadSplash();
    await tick(200);
    // A sign-in elsewhere as somebody else: the jar names acct_B and carries its own session.
    document.cookie = "tf_owner=acct_B; Path=/";
    document.cookie = "tf_csrf=c-b1; Path=/";
    await tick(400);
    expect(presented, "the splash presented another account's jar").toHaveLength(1);
    expect(reloads, "the splash did not hand the page to the jar's own session").toBe(1);
  });

  it("another account's sign-in during the wait is never taken as the previous page's answer", async () => {
    loseAnswers = true;
    await loadSplash();
    await tick(70);
    await reload();
    // The next page, its caller asking no account (a splash whose edge saw no owner asks none).
    page += 1;
    vi.resetModules();
    const refresh = await import("../app/session-refresh.js");
    const answer = refresh.resumeSession({ landing: true, mayProceed: () => true });
    await tick(200);
    // A sign-in elsewhere as somebody else moves the jar off the noted mark; the server then faults.
    document.cookie = "tf_owner=acct_B; Path=/";
    document.cookie = "tf_csrf=c-b1; Path=/";
    refreshToken = "rB";
    faultNext = true;
    await tick(400);
    expect(await answer, "another account's sign-in was taken as this tab's renewal").not.toBe("resumed");
    expect(refresh.lastRefreshReport()?.outcome, "a mint this tab never had was recorded").not.toBe("minted");
  });

  it("CONTROL: a splash in a tab with nothing out presents at once", async () => {
    const start = Date.now();
    await loadSplash();
    expect(presented.map((p) => p.at - start)).toEqual([0]);
    await tick(400);
    expect(reloads).toBe(1);
  });

  it("the wait is bounded: an answer that never lands is presented for again once the bound has passed", async () => {
    loseAnswers = true;
    await loadSplash();
    const first = presented[0]!.at;
    await tick(70);
    await reload();
    await loadSplash();
    await tick(14_000);
    expect(presented, "the reloaded splash presented before the bound").toHaveLength(1);
    await tick(1_500);
    expect(presented, "the reloaded splash never presented").toHaveLength(2);
    expect(presented[1]!.at - first).toBeGreaterThanOrEqual(15_000);
  });

  it("the note holds no token and goes at sign-out: a time, the jar's mark and the account", async () => {
    loseAnswers = true;
    await loadSplash();
    const raw = sessionStorage.getItem("ohmail.session.splashOut");
    expect(raw, "the splash left no note for its next page").not.toBeNull();
    expect(Object.keys(JSON.parse(raw!) as object).sort()).toEqual(["at", "mark", "owner"]);
    expect(raw).not.toContain("r1");
    const refresh = await import("../app/session-refresh.js");
    expect(refresh.forgetSplashPresentation()).toEqual([]);
    expect(sessionStorage.getItem("ohmail.session.splashOut"), "sign-out's door left the note").toBeNull();
  });

  it("CONTROL: an answer the first page heard (a fault) takes its note with it; the next page presents at once", async () => {
    faultNext = true;
    await loadSplash();
    await tick(50);
    await reload();
    const start = Date.now();
    await loadSplash();
    expect(presented, "control: both pages presented the token the fault left live").toHaveLength(2);
    expect(presented[1]!.at - start, "a heard answer held the next page").toBe(0);
  });
});
