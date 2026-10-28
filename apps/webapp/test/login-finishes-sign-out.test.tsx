/** @vitest-environment jsdom */
/**
 * THE SIGN-IN PAGE FINISHES A SIGN-OUT THE SERVER NEVER CONFIRMED. A browser marked
 * `tf_owner=signed_out_pending` is sent here by the front door. The form is up at once and says why;
 * behind it the session is presented at the sign-out door — never the refresh door, and never the
 * session read, whose 401 path refreshes and would resume the family the person ended — on the
 * confirm ladder, bounded. When it ends unconfirmed the page says so, in the account pane's words,
 * with Sign out to ask again. A submit stops the next attempt; one already out is ordered before the
 * sign-in by the cookie lock, and the sign-in itself waits until the sign-out is confirmed. A jar
 * another tab signed in to is never this page's to end. The waits are the shipped schedule's: timers
 * advance past `CONFIRM_CAP_MS`, the jitter is never pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { CONFIRM_ATTEMPTS, CONFIRM_CAP_MS, CONFIRM_SEED_MS } from "../app/shell/confirm-schedule.js";
import { SCREENER_INTENTS_PREFIX } from "../app/shell/screener-intents.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const R = messages.resume as Record<string, string>;
const A = messages.account as Record<string, string>;
const PENDING = "signed_out_pending";
/** The server-refused sentence with the door's own reason, as the account pane says it. */
const refusedSaying = (reason: string): string => A.signOutServerRefused!.replace("{reason}", reason);
/** Its words before the reason, for a door whose reason this test does not script. */
const REFUSED_LEAD = A.signOutServerRefused!.split("{reason}")[0]!;
/** Another tab's sign-in, as its answer lands in this jar: the marker names the new account. */
const NEW_ACCOUNT = "acct_new";

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noContent = (): Response => new Response(null, { status: 204 });
const db503 = (): Response => json({ error: { code: "db_busy", message: "busy", retryable: false } }, 503, { "retry-after": "5" });
const revoked = (): Response => json({ error: { code: "refresh_revoked", message: "revoked" } }, 401);
const full = (): Response => json({
  user: {
    userId: "usr_1", accountId: "acct_1", email: "l@example.invalid", displayName: "L", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
}, 200);

/** `null` from a script entry HOLDS the request open until its signal aborts. */
let doorScript: Array<() => Response | null> = [];
let sessionScript: Array<() => Response> = [];
let wire: string[] = [];
let replaced: string[] = [];
let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;

const router = {
  replace: (to: string) => { replaced.push(to); },
  push: (to: string) => { replaced.push(to); },
};
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const count = (name: string): number => wire.filter((w) => w === name).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T14:00:00.000Z"));
  doorScript = [noContent];
  sessionScript = [full];
  wire = [];
  replaced = [];
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal;
    const held = (name: string): Promise<Response> => new Promise<Response>((_, reject) => {
      const stop = (): void => { wire.push(`${name}:aborted`); reject(new DOMException("Aborted", "AbortError")); };
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop);
    });
    if (url.endsWith("/auth/refresh/logout")) {
      wire.push("door");
      const answer = doorScript[Math.min(count("door"), doorScript.length) - 1]!();
      return answer === null ? held("door") : answer;
    }
    // The cache purge after a confirmed sign-out presents nothing: answered apart, never a renewal.
    if (new Headers(init?.headers).get("x-ohmail-clear") === "cache") { wire.push("purge"); return new Response(null, { status: 202 }); }
    if (url.endsWith("/auth/refresh")) { wire.push("refresh"); return revoked(); }
    if (url.includes("/auth/session")) {
      wire.push("session");
      return sessionScript[Math.min(count("session"), sessionScript.length) - 1]!();
    }
    if (url.includes("/auth/login")) {
      wire.push("login");
      return json({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }, 200);
    }
    return json({}, 200);
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis.navigator, "locks");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mountLogin(): Promise<HTMLElement> {
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen, {}) }));
  });
  await tick(0);
  return container;
}

/** One `act` per step, the dynamic import settled in each, so a rung armed mid-advance is not skipped. */
async function tick(ms: number): Promise<void> {
  const flush = async (): Promise<void> => {
    await vi.dynamicImportSettled();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  await act(flush);
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(250, left));
      await flush();
    });
  }
}

const formIsUp = (el: HTMLElement): boolean => el.querySelector("form") !== null;
const text = (el: HTMLElement): string => el.textContent ?? "";
const alertText = (el: HTMLElement): string | null => el.querySelector('[role="alert"]')?.textContent ?? null;
const signOutButton = (el: HTMLElement): HTMLButtonElement | null =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === A.signOut) ?? null;
const markerIs = (value: string): boolean => document.cookie.split("; ").includes(`tf_owner=${value}`);

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

async function submit(el: HTMLElement): Promise<void> {
  const setValue = (input: HTMLInputElement, value: string): void => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => {
    setValue(el.querySelector<HTMLInputElement>('input[type="email"]')!, "l@example.invalid");
    setValue(el.querySelector<HTMLInputElement>('input[type="password"]')!, "hunter2hunter2");
  });
  await act(async () => {
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** A minimal Web Locks manager: exclusive, FIFO, and an abort of the WAIT honoured. */
function installLocks(): void {
  const queues = new Map<string, Array<() => void>>();
  const busy = new Set<string>();
  const request = async (name: string, opts: { signal?: AbortSignal }, fn: () => Promise<unknown>): Promise<unknown> => {
    if (busy.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => resolve();
        const queue = queues.get(name) ?? [];
        queue.push(waiter);
        queues.set(name, queue);
        opts.signal?.addEventListener("abort", () => {
          const q = queues.get(name) ?? [];
          const at = q.indexOf(waiter);
          if (at >= 0) q.splice(at, 1);
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
      });
    }
    busy.add(name);
    try {
      return await fn();
    } finally {
      busy.delete(name);
      (queues.get(name) ?? []).shift()?.();
    }
  };
  Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
}

describe("a pending sign-out is finished behind the sign-in form", () => {
  it("the door is asked, never the session read nor the refresh; the form is up and says why", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(1_000);
    expect(count("door"), "the unfinished sign-out was not presented at the sign-out door").toBe(1);
    expect(count("session"), "the session was read under a pending sign-out: its 401 path refreshes").toBe(0);
    expect(count("refresh"), "a browser that asked to sign out was resumed").toBe(0);
    expect(formIsUp(el), "the form waited for the sign-out").toBe(true);
    expect(text(el), "the page does not say why it is showing").toContain(R.pendingBody);
    expect(replaced, "the finished sign-out navigated").toEqual([]);
    expect(document.cookie, "a confirmed sign-out left the marker behind").not.toContain(PENDING);
    expect(count("purge"), "the finished sign-out's cache clear").toBe(1);
  });

  it("the family already ended (the door's coded 401): finished at the first ask", async () => {
    doorScript = [revoked];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door")).toBe(1);
    expect(count("refresh")).toBe(0);
    expect(document.cookie).not.toContain(PENDING);
  });

  it("a busy door twice, then 204: asked again on the ladder, never at once", async () => {
    doorScript = [db503, db503, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    expect(count("door")).toBe(1);
    // The waits are the schedule's, jitter and all: the first in [seed/2, seed], the second in
    // [seed, 2·seed]. A retry inside the first half-seed is a hot loop against a busy server.
    await tick(CONFIRM_SEED_MS / 2 - 50);
    expect(count("door"), "the busy door was asked again at once").toBe(1);
    await tick(CONFIRM_SEED_MS / 2 + 100);
    expect(count("door"), "the busy door was not asked again").toBe(2);
    await tick(2 * CONFIRM_SEED_MS + 250);
    expect(count("door"), "the ladder stopped before the door answered").toBe(3);
    await tick(CONFIRM_CAP_MS * 4);
    expect(count("door"), "a confirmed sign-out was asked again").toBe(3);
    expect(count("session") + count("refresh")).toBe(0);
    expect(document.cookie).not.toContain(PENDING);
    expect(formIsUp(el)).toBe(true);
  });

  it("a door that keeps failing: the ladder is bounded, the marker kept, and the refusal is SAID with Sign out", async () => {
    doorScript = [db503];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    // While it runs: the form, and why the page is showing. Nothing is claimed yet.
    expect(text(el)).toContain(R.pendingBody);
    expect(alertText(el), "a refusal was said before the ladder ended").toBeNull();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door"), "the ladder is not the confirm ladder's length").toBe(CONFIRM_ATTEMPTS);
    await tick(120_000);
    expect(count("door"), "the ladder kept asking after it ended").toBe(CONFIRM_ATTEMPTS);
    expect(count("session") + count("refresh"), "a refused sign-out was resumed").toBe(0);
    expect(count("purge"), "a cache clear over a sign-out the server never confirmed").toBe(0);
    expect(document.cookie, "the next visit has nothing left to finish it by").toContain(PENDING);
    // The splash said this before the sign-in page finished the sign-out, and nothing did after:
    // the person left a shared computer believing the session was ended.
    expect(alertText(el), "a sign-out the server never confirmed ended in silence").toBe(refusedSaying("busy"));
    expect(signOutButton(el), "nothing offers to ask again").not.toBeNull();
    expect(formIsUp(el)).toBe(true);
    expect(replaced).toEqual([]);
  });

  it("Sign out, pressed: the ladder again, and a door that answers ends it and the sentence with it", async () => {
    doorScript = [db503, db503, db503, db503, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door")).toBe(CONFIRM_ATTEMPTS);
    expect(alertText(el)).toBe(refusedSaying("busy"));
    await press(signOutButton(el)!);
    await tick(1_000);
    expect(count("door"), "Sign out did not ask the door again").toBe(CONFIRM_ATTEMPTS + 1);
    expect(document.cookie, "a confirmed sign-out left the marker behind").not.toContain(PENDING);
    expect(alertText(el), "the refusal outlived the sign-out it was about").toBeNull();
    expect(text(el)).toContain(R.pendingBody);
    expect(count("session") + count("refresh")).toBe(0);
  });

  it("a door that hangs, then a submit: no further ladder attempt, and no sign-in beside the live family", async () => {
    doorScript = [() => null];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(500);
    expect(count("door")).toBe(1);
    await submit(el);
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS + 30_000);
    // The held ask, then the one the submit makes before anything signs in; never the ladder's.
    expect(count("door"), "the ladder went on behind the submit").toBe(2);
    expect(count("login"), "a sign-in went out while the server still held the family").toBe(0);
    expect(count("session") + count("refresh")).toBe(0);
    expect(alertText(el), "the submit was refused in silence").toContain(REFUSED_LEAD);
    expect(document.cookie).toContain(PENDING);
  });

  it("an attempt still out at the submit, no lock manager: the sign-in waits for it to end", async () => {
    doorScript = [() => null, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(500);
    expect(count("door")).toBe(1);
    await submit(el);
    await tick(2_000);
    expect(count("login"), "the sign-in went out beside a sign-out still at the door").toBe(0);
    await tick(10_000);
    expect(wire.indexOf("door:aborted"), "the held sign-out never ended").toBeGreaterThan(-1);
    expect(count("login"), "the sign-in never left once the sign-out ended").toBe(1);
    // The held ask ends, the submit's own ask confirms the sign-out, and only then the sign-in.
    expect(wire.indexOf("door:aborted")).toBeLessThan(wire.lastIndexOf("door"));
    expect(wire.lastIndexOf("door")).toBeLessThan(wire.indexOf("login"));
    expect(count("door"), "the ladder went on behind a sign-in").toBe(2);
    expect(document.cookie).not.toContain(PENDING);
  });

  it("an attempt still out at the submit is ordered BEFORE the sign-in by the cookie lock", async () => {
    installLocks();
    doorScript = [() => null, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(500);
    expect(count("door")).toBe(1);
    await submit(el);
    await tick(2_000);
    expect(count("login"), "the sign-in went out beside a sign-out holding the lock").toBe(0);
    // The door is given up at its deadline; only then does the sign-in leave.
    await tick(10_000);
    expect(wire.indexOf("door:aborted"), "the held sign-out never ended").toBeGreaterThan(-1);
    expect(count("login"), "the sign-in never left once the sign-out let go").toBe(1);
    expect(wire.indexOf("door:aborted")).toBeLessThan(wire.lastIndexOf("door"));
    expect(wire.lastIndexOf("door")).toBeLessThan(wire.indexOf("login"));
    expect(count("door"), "the ladder went on behind a sign-in").toBe(2);
  });
});

describe("a sign-in never starts beside a sign-out the server has not confirmed", () => {
  it("the ladder ran out: the submit asks the door once more, and a refusal keeps the ceremony from starting", async () => {
    doorScript = [db503];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door")).toBe(CONFIRM_ATTEMPTS);
    await submit(el);
    await tick(2_000);
    expect(count("door"), "the submit did not ask the door first").toBe(CONFIRM_ATTEMPTS + 1);
    expect(count("login"), "a sign-in went out beside a family the server never ended").toBe(0);
    expect(alertText(el)).toBe(refusedSaying("busy"));
    expect(document.cookie).toContain(PENDING);
    expect(formIsUp(el), "the form was taken away").toBe(true);
  });

  it("…and once the door answers, the same submit finishes the sign-out, then signs in", async () => {
    doorScript = [db503, db503, db503, db503, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(alertText(el)).toBe(refusedSaying("busy"));
    await submit(el);
    await tick(2_000);
    expect(count("door")).toBe(CONFIRM_ATTEMPTS + 1);
    expect(count("login"), "the sign-in never left once the sign-out was confirmed").toBe(1);
    expect(wire.lastIndexOf("door")).toBeLessThan(wire.indexOf("login"));
    expect(document.cookie).not.toContain(PENDING);
    expect(alertText(el), "a finished sign-out was still said as refused").toBeNull();
  });

  it("a submit in the ladder's wait stops the ladder; the one ask it makes decides", async () => {
    doorScript = [db503];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    expect(count("door")).toBe(1);
    await submit(el);
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door"), "the ladder went on behind the submit, or the submit asked nothing").toBe(2);
    expect(count("login")).toBe(0);
    expect(alertText(el)).toBe(refusedSaying("busy"));
  });
});

describe("a jar another tab signed in to is not this page's to end", () => {
  it("between two asks: the next ask never leaves, the new marker and the new session's stores are kept", async () => {
    doorScript = [db503, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(100);
    expect(count("door")).toBe(1);
    // Inside the first wait (at least half the seed): the other tab's answer lands in this jar.
    document.cookie = `tf_owner=${NEW_ACCOUNT}; Path=/`;
    localStorage.setItem(`${SCREENER_INTENTS_PREFIX}${NEW_ACCOUNT}`, "[]");
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door"), "the ladder signed out the session another tab had just signed in").toBe(1);
    expect(markerIs(NEW_ACCOUNT), "the new session's marker was overwritten").toBe(true);
    expect(localStorage.getItem(`${SCREENER_INTENTS_PREFIX}${NEW_ACCOUNT}`), "the new session's stores were swept").toBe("[]");
    expect(alertText(el), "a sign-in elsewhere was said as a refused sign-out").toBeNull();
  });

  it("while the door waits for the cookie lock another tab's sign-in holds: the door is never asked", async () => {
    installLocks();
    doorScript = [noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locks = (navigator as unknown as { locks: { request: (n: string, o: object, f: () => Promise<void>) => Promise<unknown> } }).locks;
    void locks.request("ohmail:session-refresh", {}, () => held);
    await mountLogin();
    await tick(500);
    expect(count("door"), "the door went out while another tab held the cookie lock").toBe(0);
    // The sign-in's answer lands, then its lock is let go.
    document.cookie = `tf_owner=${NEW_ACCOUNT}; Path=/`;
    release();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door"), "the sign-out presented the jar another tab had just signed in to").toBe(0);
    expect(markerIs(NEW_ACCOUNT)).toBe(true);
  });

  it("while the door holds its answer: the refusal touches nothing of the new session, and nothing is asked again", async () => {
    doorScript = [() => null, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mountLogin();
    await tick(500);
    expect(count("door")).toBe(1);
    document.cookie = `tf_owner=${NEW_ACCOUNT}; Path=/`;
    localStorage.setItem(`${SCREENER_INTENTS_PREFIX}${NEW_ACCOUNT}`, "[]");
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS + 10_000);
    expect(wire.indexOf("door:aborted"), "the held ask never ended").toBeGreaterThan(-1);
    expect(count("door"), "the ladder asked again with the new session's cookies").toBe(1);
    expect(markerIs(NEW_ACCOUNT), "the refusal marked the new session pending").toBe(true);
    expect(localStorage.getItem(`${SCREENER_INTENTS_PREFIX}${NEW_ACCOUNT}`), "the refusal swept the new session's stores").toBe("[]");
    expect(alertText(el)).toBeNull();
  });
});

describe("THE CONTROL — no pending sign-out, the confirm runs as before", () => {
  it("no marker: the session is read and a live one forwarded; the door is never asked", async () => {
    const el = await mountLogin();
    await tick(1_000);
    expect(count("session")).toBe(1);
    expect(replaced).toEqual(["/"]);
    expect(count("door")).toBe(0);
    expect(text(el)).not.toContain(R.pendingBody);
  });

  it("a marker naming an account: the same, and no sentence", async () => {
    document.cookie = "tf_owner=acct_1; Path=/";
    const el = await mountLogin();
    await tick(1_000);
    expect(count("session")).toBe(1);
    expect(count("door")).toBe(0);
    expect(text(el)).not.toContain(R.pendingBody);
  });
});
