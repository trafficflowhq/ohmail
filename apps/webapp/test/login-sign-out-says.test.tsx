/** @vitest-environment jsdom */
/**
 * A PENDING SIGN-OUT WHOSE WIPE DOES NOT LAND SAYS SO ON THE SIGN-IN PAGE, in the account pane's words
 * and order (`signOutTrouble`), with Sign out to ask again: a mirror another tab holds open, a browser
 * that will not say what it holds. Once the door has answered, asking it again changes neither, so the
 * ladder stops there; while the door still refuses, its server half is asked again on the ladder.
 * Driven through the real sign-out; the browser's IndexedDB is the double here, and the door's answers
 * are scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { CONFIRM_ATTEMPTS, CONFIRM_CAP_MS } from "../app/shell/confirm-schedule.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const A = messages.account as Record<string, string>;
const R = messages.resume as Record<string, string>;
const PENDING = "signed_out_pending";
/** The registry's anchor: this origin was seen holding no mirror before the registry named them all. */
const ANCHOR = "ohmail.mirror.__since";
const MIRROR = "ohmail-mirror:acct_1";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = (): Response => new Response(null, { status: 204 });
const db503 = (): Response => json({ error: { code: "db_busy", message: "busy", retryable: false } }, 503);

/** What the sign-out door answers, in order; the last answer repeats. */
let doorScript: Array<() => Response> = [noContent];
/** Whether another tab still holds the mirror open: its delete is then BLOCKED, not done. */
let held = true;
let wire: string[] = [];
let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;
/* One router for the page's life, as Next's is: a new one each render would re-run its effects. */
const router = { replace: () => {}, push: () => {} };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const count = (name: string): number => wire.filter((w) => w === name).length;

/** An IndexedDB that lists one mirror and answers each delete as blocked while `held`, done after. */
function mirrorOnDisk(): void {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = {
    databases: async () => (held ? [{ name: MIRROR, version: 1 }] : []),
    deleteDatabase: () => {
      const req = {} as { onsuccess?: () => void; onblocked?: () => void };
      queueMicrotask(() => (held ? req.onblocked?.() : req.onsuccess?.()));
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

beforeEach(() => {
  vi.useFakeTimers();
  doorScript = [noContent];
  held = true;
  wire = [];
  sessionStorage.clear();
  localStorage.clear();
  localStorage.setItem(`ohmail.mirror.${MIRROR}`, "1");
  mirrorOnDisk();
  document.cookie = `tf_owner=${PENDING}; Path=/`;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/auth/refresh/logout")) {
      wire.push("door");
      return doorScript[Math.min(count("door"), doorScript.length) - 1]!();
    }
    if (url.endsWith("/auth/refresh")) { wire.push("refresh"); return json({ error: { code: "refresh_revoked" } }, 401); }
    if (url.includes("/auth/session")) { wire.push("session"); return json({}, 401); }
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
  Reflect.deleteProperty(globalThis, "indexedDB");
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

const alerts = (el: HTMLElement): string[] => [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const signOutButton = (el: HTMLElement): HTMLButtonElement | null =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === A.signOut) ?? null;

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

describe("a wipe that does not land ends the ladder, and is said", () => {
  it("another tab holds the mirror open, the door answered: the pane's sentence after one ask, with Sign out", async () => {
    localStorage.setItem(ANCHOR, "1");
    doorScript = [noContent];
    const el = await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door"), "asking the door again cannot unblock a tab that holds the mirror open").toBe(1);
    expect(alerts(el), "a blocked wipe ended in silence").toEqual([A.signOutBlocked]);
    expect(signOutButton(el)).not.toBeNull();
    expect(el.textContent).toContain(R.pendingBody);
    expect(count("session") + count("refresh")).toBe(0);
  });

  it("…and while the door refuses too, its server half is still asked on the ladder, then the wipe is said", async () => {
    localStorage.setItem(ANCHOR, "1");
    doorScript = [db503];
    const el = await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door"), "a blocked wipe stopped the server half's retries").toBe(CONFIRM_ATTEMPTS);
    await tick(60_000);
    expect(count("door"), "the ladder kept asking after it ended").toBe(CONFIRM_ATTEMPTS);
    expect(alerts(el), "a blocked wipe ended in silence").toEqual([A.signOutBlocked]);
    expect(document.cookie).toContain(PENDING);
  });

  it("a browser that will not say what it holds: its own sentence, never the blocked one", async () => {
    held = false;
    doorScript = [noContent];
    const el = await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door")).toBe(1);
    expect(alerts(el), "an unverifiable wipe ended in silence").toEqual([A.signOutUnverified]);
  });

  it("Sign out, pressed once the other tab is closed: asked again, finished, and the sentence goes", async () => {
    localStorage.setItem(ANCHOR, "1");
    doorScript = [noContent];
    const el = await mountLogin();
    await tick(1_000);
    expect(alerts(el)).toEqual([A.signOutBlocked]);
    held = false;
    await act(async () => { signOutButton(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(1_000);
    expect(count("door"), "Sign out did not ask again").toBe(2);
    expect(alerts(el), "the sentence outlived the sign-out it was about").toEqual([]);
  });

  it("a submit over a blocked wipe the server also refused asks once more, and does not sign in", async () => {
    localStorage.setItem(ANCHOR, "1");
    doorScript = [db503];
    const el = await mountLogin();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(alerts(el)).toEqual([A.signOutBlocked]);
    await submit(el);
    await tick(1_000);
    expect(count("door"), "the submit did not ask the sign-out first").toBe(CONFIRM_ATTEMPTS + 1);
    expect(count("login"), "a sign-in went out over an unfinished sign-out").toBe(0);
    expect(alerts(el)).toEqual([A.signOutBlocked]);
    expect(document.cookie).toContain(PENDING);
  });
});
