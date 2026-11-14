/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * A SIGN-IN IN ANOTHER TAB TAKES THE TAB `/approve` SENT TO `/login` BACK TO ITS REQUEST, by the id
 * that tab kept and nothing another tab says. The other tab is heard as the mint stamp's `storage`
 * event, or as a changed `tf_owner` when this tab is looked at again; either only makes this tab ask
 * the classifier, and only a full session takes the kept return. The real client, over `fetch`.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const ACCT = "acct-1";
const MINTED = "ohmail.session.mintedAt";
const navigated: string[] = [];
/* One router object, as Next's is: the bootstrap effect depends on it. */
const router = { push: (to: string) => { navigated.push(to); }, replace: (to: string) => { navigated.push(to); } };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { bindApiOwner } = await import("../app/api-client");
const { markSessionAlive } = await import("@ohmail/app-logic/session/session-truth");
const { rememberApprovalRequest, takeApprovalReturn } = await import("../app/(product)/approve/approval-return");

type State = "none" | "enrollment" | "full" | "busy";
type Wire = { status: number; body?: unknown; cookie?: string };
let sent: string[] = [];
/** Session reads the client aborted, by their order among the session reads. */
let abortedReads: number[] = [];
/** Off: an answer already complete when the abort came, which the client must still not act on. */
let honourAbort = true;
let fetchBefore: typeof fetch | null = null;
/** Honours the signal, so an abort is a fact the case can read, not one the double drops. */
function wire(route: (method: string, url: string) => Wire | Promise<Wire>): void {
  fetchBefore ??= globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push(`${method} ${url}`);
    const nth = sessionReads();
    const signal = init?.signal;
    const answer = Promise.resolve(route(method, url)).then((w) => {
      if (signal?.aborted && !honourAbort) abortedReads.push(nth);
      return w;
    });
    const w = await (signal && honourAbort ? Promise.race([answer, new Promise<Wire>((_, reject) => {
      const fire = (): void => { abortedReads.push(nth); reject(new DOMException("Aborted", "AbortError")); };
      if (signal.aborted) fire(); else signal.addEventListener("abort", fire, { once: true });
    })]) : answer);
    if (w.cookie) document.cookie = w.cookie;
    return new Response(w.body === undefined ? null : JSON.stringify(w.body), {
      status: w.status, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
const UNAUTHORIZED: Wire = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
const REFRESH_MISSING: Wire = { status: 401, body: { error: { code: "refresh_missing", message: "missing refresh token" } } };
const BUSY: Wire = { status: 503, body: { error: { code: "db_busy", message: "busy", retryable: true } } };
const session = (scope = "full") => ({
  user: { userId: `usr-${ACCT}`, accountId: ACCT, email: "m@example.test", displayName: "M", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } },
  scope,
});
const sessionReads = (): number => sent.filter((s) => s === "GET /api/auth/session").length;

/** Answers the case controls: the session read by `state`, a held one by `hold`. */
let state: State = "none";
let hold: Promise<void> | null = null;
function serve(): void {
  wire(async (m, url) => {
    if (url === "/auth/refresh") return REFRESH_MISSING;
    if (url === "/api/auth/session") {
      const gate = hold;
      if (gate) await gate;
      if (state === "full") return { status: 200, body: session() };
      if (state === "enrollment") return { status: 200, body: session("enrollment") };
      return state === "busy" ? BUSY : UNAUTHORIZED;
    }
    if (m === "POST" && url === "/api/auth/login") {
      return { status: 200, body: { status: "twofa_required", loginToken: "tok", methods: ["totp"] } };
    }
    return UNAUTHORIZED;
  });
}
function held(): () => void {
  let release!: () => void;
  hold = new Promise<void>((r) => { release = r; });
  return () => { hold = null; release(); };
}

/** Another tab of this browser finished a sign-in: its cookies are this jar's; it may stamp the mint. */
function signedInElsewhere(opts: { stamp: boolean }): void {
  document.cookie = `tf_owner=${ACCT}; path=/`;
  document.cookie = "tf_csrf=c2; path=/";
  if (opts.stamp) stampElsewhere();
}
function stampElsewhere(): void {
  const at = String(Date.now() + Math.random());
  localStorage.setItem(MINTED, at);
  window.dispatchEvent(new StorageEvent("storage", { key: MINTED, newValue: at }));
}

function clearClientState(): void {
  for (const name of ["tf_owner", "tf_csrf"]) document.cookie = `${name}=; path=/; max-age=0`;
  localStorage.removeItem(MINTED);
  markSessionAlive();
  bindApiOwner(null);
  if (fetchBefore) { globalThis.fetch = fetchBefore; fetchBefore = null; }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  clearClientState();
  sent = [];
  abortedReads = [];
  honourAbort = true;
  navigated.length = 0;
  state = "none";
  hold = null;
  sessionStorage.clear();
  serve();
});
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  clearClientState();
});

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out waiting for: ${what}; navigated: ${JSON.stringify(navigated)}; sent: ${sent.join(", ")}`);
}
const pause = async (ms: number): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function mount(): Promise<HTMLDivElement> {
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
  });
  return host;
}

/** The bootstrap asked, the refresh was refused, and the form stands. */
async function signedOutLanding(): Promise<void> {
  await waitFor(() => sent.includes("POST /auth/refresh"), "the bootstrap's refused refresh");
  await pause(60);
  expect(navigated, "a signed-out /login left").toEqual([]);
}

async function submitPassword(el: HTMLElement): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (const [id, value] of [["#login-email", "m@example.test"], ["#login-pw", "correct horse"]] as const) {
    const input = el.querySelector<HTMLInputElement>(id)!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await waitFor(() => el.querySelector("#login-code") !== null, "the code step");
}

describe("a sign-in in another tab brings this tab back to the request it kept", () => {
  it("the other tab's mint stamp: this tab asks once more and returns to /approve for its request", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    state = "full";
    signedInElsewhere({ stamp: true });
    await waitFor(() => navigated.length > 0, "the return to the request");
    expect(navigated).toEqual([`/approve?request=${ID}`]);
    expect(takeApprovalReturn(), "the return was not taken, or taken twice").toBeNull();
  });

  it("a jar that refused the stamp: the changed marker is read when this tab is looked at again", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    state = "full";
    signedInElsewhere({ stamp: false });
    await pause(60);
    expect(navigated, "nothing was heard yet, so nothing may move").toEqual([]);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => navigated.length > 0, "the return to the request");
    expect(navigated).toEqual([`/approve?request=${ID}`]);
  });

  it("control: looking at this tab again with the jar unchanged asks nothing", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    const before = sessionReads();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await pause(60);
    expect(sessionReads()).toBe(before);
    expect(navigated).toEqual([]);
  });

  it("control: looking at this tab after a stamp it already asked about asks nothing more", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    state = "enrollment";
    signedInElsewhere({ stamp: true });
    await pause(120);
    const before = sessionReads();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await pause(60);
    expect(sessionReads(), "the same sign-in was asked about twice").toBe(before);
    expect(navigated).toEqual([]);
  });

  it("control: with no request kept, a sign-in elsewhere moves this tab nowhere and asks nothing", async () => {
    await mount();
    await signedOutLanding();
    const before = sessionReads();
    state = "full";
    signedInElsewhere({ stamp: true });
    await pause(80);
    expect(navigated).toEqual([]);
    expect(sessionReads(), "the login screen listened without a return to take").toBe(before);
  });

  it("control: a kept request past its ten minutes arms nothing, and a sign-in elsewhere asks nothing", async () => {
    rememberApprovalRequest(ID, Date.now() - 10 * 60_000 - 1_000);
    await mount();
    await signedOutLanding();
    const before = sessionReads();
    state = "full";
    signedInElsewhere({ stamp: true });
    await pause(80);
    expect(navigated).toEqual([]);
    expect(sessionReads(), "a stale return armed the listener").toBe(before);
  });

  it("a kept request that runs out while this tab waits takes it nowhere", async () => {
    rememberApprovalRequest(ID, Date.now() - 10 * 60_000 + 400);
    await mount();
    await signedOutLanding();
    await pause(450);
    const before = sessionReads();
    state = "full";
    signedInElsewhere({ stamp: true });
    await waitFor(() => sessionReads() > before, "the stamp's ask");
    await pause(80);
    expect(navigated, "a return that ran out was followed").toEqual([]);
  });

  it("a stamp whose session is not a full one leaves the request kept, and the next full one returns", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    state = "enrollment";
    signedInElsewhere({ stamp: true });
    await waitFor(() => sessionReads() >= 2, "the second ask");
    await pause(60);
    expect(navigated, "an enrolment-only session took the return").toEqual([]);
    state = "full";
    stampElsewhere();
    await waitFor(() => navigated.length > 0, "the return to the request");
    expect(navigated).toEqual([`/approve?request=${ID}`]);
  });

  it("a busy answer to that ask is asked again on the ladder, and the full one returns", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    state = "busy";
    signedInElsewhere({ stamp: true });
    await waitFor(() => sessionReads() >= 2, "the busy ask");
    state = "full";
    await waitFor(() => navigated.length > 0, "the return after the busy answer", 6000);
    expect(navigated).toEqual([`/approve?request=${ID}`]);
  });

  it("a newer stamp stops the ask an older one started, and asks afresh", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    state = "enrollment";
    const release = held();
    signedInElsewhere({ stamp: true });
    await waitFor(() => sessionReads() >= 2, "the first stamp's ask");
    stampElsewhere();
    await waitFor(() => sessionReads() >= 3, "the second stamp's ask");
    state = "full";
    release();
    await waitFor(() => navigated.length > 0, "the return to the request");
    expect(abortedReads, "the older ask was left running").toContain(2);
    expect(navigated).toEqual([`/approve?request=${ID}`]);
  });

  it("a ceremony that owns this page is not interrupted: a stamp after the submit is not heard", async () => {
    rememberApprovalRequest(ID);
    const el = await mount();
    await signedOutLanding();
    await submitPassword(el);
    const before = sessionReads();
    state = "full";
    signedInElsewhere({ stamp: true });
    await pause(80);
    expect(navigated).toEqual([]);
    expect(sessionReads(), "a session read went out under a ceremony in flight").toBe(before);
  });

  it("an ask in flight when the password is submitted is stopped, and its answer moves nothing", async () => {
    rememberApprovalRequest(ID);
    const el = await mount();
    await signedOutLanding();
    state = "full";
    // The server's full answer is already on its way: only the stop itself can keep it from acting.
    honourAbort = false;
    const release = held();
    signedInElsewhere({ stamp: true });
    await waitFor(() => sessionReads() >= 2, "the stamp's ask");
    await submitPassword(el);
    release();
    await pause(1000);
    expect(abortedReads, "the ask outlived the submit").toContain(2);
    expect(navigated, "an answer moved the tab out from under a ceremony").toEqual([]);
  });

  it("a sign-out elsewhere removes the stamp, and a removal is not a sign-in", async () => {
    rememberApprovalRequest(ID);
    await mount();
    await signedOutLanding();
    const before = sessionReads();
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: MINTED, newValue: null })); });
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "ohmail.theme", newValue: "dark" })); });
    await pause(60);
    expect(sessionReads()).toBe(before);
    expect(navigated).toEqual([]);
  });

  it("an answer that lands after another one already moved this tab sends it nowhere else", async () => {
    rememberApprovalRequest(ID);
    state = "busy";
    await mount();
    await waitFor(() => sessionReads() >= 1, "the bootstrap's first, busy, ask");
    state = "full";
    signedInElsewhere({ stamp: true });
    await waitFor(() => navigated.length > 0, "the return to the request");
    // The bootstrap's own retry is due within a second; its answer must not send the tab on.
    await pause(1200);
    expect(navigated, "a second answer sent the tab to the app").toEqual([`/approve?request=${ID}`]);
  });
});
