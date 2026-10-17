/** @vitest-environment jsdom */
/**
 * THE FRONT DOOR NEVER LOOPS, WHATEVER `tf_owner` SAYS. Measured on ohmail.app: a sign-out
 * whose server half went unconfirmed leaves `tf_owner=signed_out_pending` beside a live refresh
 * family, and every later visit to `/` reloaded the resume splash about five times a second until
 * the platform's firewall challenged the browser. The splash compared the raw marker the edge saw
 * with a parsed one that is null for the reserved word, so it never matched and never stamped.
 * Each jar below is one the live repro found; every needle is rendered catalogue text.
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

const PENDING = "signed_out_pending";
const R = messages.resume;
const A = messages.account;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = (): Response => new Response(null, { status: 204 });
const coded401 = (code: string) => (): Response => json({ error: { code, message: "no" } }, 401);
const db503 = (): Response => json({ error: { code: "db_busy", retryable: true, message: "busy" } }, 503);

/** What each door answers, in order; the last answer repeats. */
let doors: { refresh: Array<() => Response>; signOut: Array<() => Response> };
let asked: string[] = [];
let reloads = 0;
let replaced: string[] = [];
let assigned: string[] = [];
let priorFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const setOwner = (raw: string | null): void => {
  document.cookie = raw === null ? "tf_owner=; Path=/; Max-Age=0" : `tf_owner=${raw}; Path=/`;
};
const answer = (list: Array<() => Response>, n: number): Response => list[Math.min(n, list.length) - 1]!();

beforeEach(async () => {
  (await import("../app/shell/session-truth.js")).resetSessionTruthForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(1);
  doors = { refresh: [noContent], signOut: [noContent] };
  asked = [];
  reloads = 0;
  replaced = [];
  assigned = [];
  sessionStorage.clear();
  localStorage.clear();
  // `http:` like jsdom's own document: a `Secure` marker written on an http page is never read back.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "http://localhost/", origin: "http://localhost", protocol: "http:", hash: "", pathname: "/",
      reload: () => { reloads += 1; },
      replace: (u: string) => { replaced.push(u); },
      assign: (u: string) => { assigned.push(u); },
    },
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith("/auth/refresh/logout")) return answer(doors.signOut, asked.filter((u) => u.endsWith("/auth/refresh/logout")).length);
    if (url.endsWith("/auth/refresh")) return answer(doors.refresh, asked.filter((u) => u.endsWith("/auth/refresh")).length);
    if (url.includes("/api/auth/session")) return json({ error: { code: "unauthorized", message: "no" } }, 401);
    return json({}, 200);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  await unmount();
  globalThis.fetch = priorFetch;
  setOwner(null);
  sessionStorage.clear();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function tick(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(250, left)); });
    await flush();
  }
}

/** The splash as `resume/page.tsx` renders it: `initialOwner` is the RAW cookie the edge saw. */
async function mountSplash(initialOwner: string | null): Promise<HTMLElement> {
  const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(ResumeScreen, { initialOwner }),
    }));
  });
  await flush();
  return host;
}

const signOuts = (): number => asked.filter((u) => u.endsWith("/auth/refresh/logout")).length;
const refreshes = (): number => asked.filter((u) => u.endsWith("/auth/refresh")).length;
const text = (el: HTMLElement): string => el.textContent ?? "";

describe("a sign-out the server never confirmed is finished, never resumed and never reloaded", () => {
  it("THE STUCK JAR — the marker beside a live family: the door is asked once, then /login", async () => {
    setOwner(PENDING);
    await mountSplash(PENDING);
    await tick(2_000);
    expect(reloads, "the splash reloaded itself — the loop measured on ohmail.app").toBe(0);
    expect(refreshes(), "a browser that asked to be signed out was resumed").toBe(0);
    expect(signOuts(), "the unfinished sign-out was not presented at the sign-out door").toBe(1);
    expect(replaced, "a finished sign-out did not land on the sign-in page").toEqual(["/login"]);
  });

  it("the family already ended (the door's coded 401): the jar is cleared and it lands on /login", async () => {
    doors.signOut = [coded401("refresh_revoked")];
    setOwner(PENDING);
    await mountSplash(PENDING);
    await tick(2_000);
    expect(reloads).toBe(0);
    expect(refreshes()).toBe(0);
    expect(replaced).toEqual(["/login"]);
  });

  it("a door that keeps faulting ends on a card that says so — no reload, no resume", async () => {
    doors.signOut = [db503];
    setOwner(PENDING);
    const el = await mountSplash(PENDING);
    await tick(60_000);
    expect(reloads, "a fault turned into a reload").toBe(0);
    expect(refreshes()).toBe(0);
    expect(replaced, "an unconfirmed sign-out was reported as done").toEqual([]);
    expect(signOuts(), "the ladder is bounded and was walked").toBeGreaterThan(1);
    const asks = signOuts();
    await tick(120_000);
    expect(signOuts(), "the ladder kept asking after it ended").toBe(asks);
    expect(text(el), "the card does not say the server half is unconfirmed")
      .toContain(A.signOutServerRefused.split("{reason}")[0]!.trim());
  });
});

describe("the like-with-like compare ships only with the finishing step", () => {
  it("THE PAIR — the refresh door would mint, and a browser that asked to sign out is still never resumed", async () => {
    // Compared like with like, the reserved marker now MATCHES the edge's reading. Without the
    // finishing step beside it, the splash would spend the refresh token and sign the person back
    // in to the session they asked to leave. Remove `finish` and this goes red.
    doors.refresh = [noContent];
    doors.signOut = [db503];
    setOwner(PENDING);
    await mountSplash(PENDING);
    await tick(60_000);
    expect(refreshes(), "a sign-out the person asked for was undone by a resume").toBe(0);
    expect(reloads).toBe(0);
  });
});

describe("the splash compares the marker it was chosen for with the jar, like with like", () => {
  it("a marker that names no account is the same marker on both sides: one resume, no loop", async () => {
    setOwner("not.an.id!");
    await mountSplash("not.an.id!");
    await tick(1_000);
    expect(refreshes(), "the splash read an unchanged jar as a changed one and spent nothing").toBe(1);
    expect(reloads, "a mint reloads exactly once").toBe(1);
  });
});

describe("a terminal state after at most a handful of passes, whatever the marker", () => {
  it("a splash reached again and again ends on the busy card, and stops navigating", async () => {
    // The jar names B while the edge chose A: the splash's own answer is a reload. Every pass
    // here is one of those reloads landing on the splash again.
    setOwner("acct_B");
    let card: HTMLElement | null = null;
    for (let pass = 1; pass <= 12; pass += 1) {
      card = await mountSplash("acct_A");
      await tick(100);
      await unmount();
    }
    expect(reloads, "the splash kept reloading — no pass bound").toBeLessThanOrEqual(6);
    card = await mountSplash("acct_A");
    await tick(100);
    expect(text(card), "the last pass did not end on a card").toContain(R.busyTitle);
  });

  it("the bound is not keyed by tf_owner: a marker that flips every pass is still bounded", async () => {
    const marks = ["acct_A", PENDING, "acct_B", "", "acct_C"];
    for (let pass = 0; pass < 12; pass += 1) {
      const m = marks[pass % marks.length]!;
      setOwner(m === "" ? null : m);
      await mountSplash("acct_Z");
      await tick(100);
      await unmount();
    }
    expect(reloads, "a flipping marker defeated the bound").toBeLessThanOrEqual(6);
  });
});
