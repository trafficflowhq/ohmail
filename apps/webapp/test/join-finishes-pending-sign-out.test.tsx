/** @vitest-environment jsdom */
/**
 * THE SIGN-UP AND CONFIRMATION PAGES UNDER A SIGN-OUT THE SERVER NEVER CONFIRMED. `/login` finishes such a
 * sign-out behind its form and links to `/join`; an invitation mail links to `/join` and `/verify-email`
 * from another site. Neither page may read the session the jar still carries (`tf_owner=signed_out_pending`
 * beside the previous person's cookies): its answer is that person's account, and its 401 path refreshes,
 * which resumes the family they ended. So each finishes the sign-out at the door instead, as `/login` does,
 * says so when it cannot, and asks the door once more before a registration or a confirmation mints a
 * session beside it. The waits are the shipped schedule's: timers advance past `CONFIRM_CAP_MS`.
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
const J = messages.join as Record<string, string>;
const V = messages.verify as Record<string, string>;
const PENDING = "signed_out_pending";
const refusedSaying = (reason: string): string => A.signOutServerRefused!.replace("{reason}", reason);

/** The previous person's account, as the jar's session would answer for it. */
const MAILBOX_A = "a-mailbox@example.invalid";
const SESSION_A = {
  user: {
    userId: "usr_A", accountId: "acct_A", email: "person-a@example.invalid", displayName: "Person A", emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
  },
  scope: "full",
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = (): Response => new Response(null, { status: 204 });
const db503 = (): Response => json({ error: { code: "db_busy", message: "busy", retryable: false } }, 503);

/** `null` from a script entry HOLDS the request open until its signal aborts. */
let doorScript: Array<() => Response | null> = [];
/** Whether the jar's access cookie is still live; a lapsed one is renewed by a refresh while the jar holds one. */
let accessLive = false;
let refreshable = true;
let refreshed = false;
let wire: string[] = [];
let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;

const router = { replace: (_to: string) => {}, push: (_to: string) => {} };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const count = (name: string): number => wire.filter((w) => w === name).length;
/** Anything that reads or acts on the account the jar's session belongs to. */
const ACCOUNT_READS = ["session", "refresh", "access", "mailboxes", "codes"];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T14:00:00.000Z"));
  doorScript = [noContent];
  accessLive = false;
  refreshable = true;
  refreshed = false;
  wire = [];
  sessionStorage.clear();
  localStorage.clear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal;
    if (url.endsWith("/auth/refresh/logout")) {
      wire.push("door");
      const answer = doorScript[Math.min(count("door"), doorScript.length) - 1]!();
      if (answer !== null) return answer;
      return new Promise<Response>((_, reject) => {
        const stop = (): void => { wire.push("door:aborted"); reject(new DOMException("Aborted", "AbortError")); };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop);
      });
    }
    // The cache purge after a confirmed sign-out presents nothing: answered apart, never a renewal.
    if (new Headers(init?.headers).get("x-ohmail-clear") === "cache") { wire.push("purge"); return new Response(null, { status: 202 }); }
    if (url.endsWith("/auth/refresh")) {
      wire.push("refresh");
      if (!refreshable) return json({ error: { code: "refresh_missing", message: "no refresh token" } }, 401);
      refreshed = true;
      return noContent();
    }
    if (url.includes("/auth/session")) {
      wire.push("session");
      return accessLive || refreshed ? json(SESSION_A, 200) : json({ error: { code: "unauthorized", message: "no session" } }, 401);
    }
    if (url.includes("/auth/2fa/recovery-codes")) { wire.push("codes"); return json({ codes: ["c1"] }, 200); }
    if (url.includes("/account/access")) { wire.push("access"); return json({ metered: false, canAddMailbox: true }, 200); }
    if (url.includes("/mailboxes")) {
      wire.push("mailboxes");
      return json({ items: [{ id: "mbx_A", address: MAILBOX_A, provider: "imap", organizeConsentedAt: null }] }, 200);
    }
    if (url.includes("/auth/register")) { wire.push("register"); return json({ status: "ok" }, 202); }
    if (url.includes("/auth/verify-email")) { wire.push("verify"); return json({ status: "verified" }, 200); }
    wire.push(`other ${url}`);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(which: "join" | "verify"): Promise<HTMLElement> {
  const child = which === "join"
    ? h((await import("../app/(product)/join/JoinScreen.js")).JoinScreen, { initialCode: "", publicSignup: true })
    : h((await import("../app/(product)/verify-email/VerifyEmailScreen.js")).VerifyEmailScreen, { initialToken: "tok_1" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: child }));
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

const text = (el: HTMLElement): string => el.textContent ?? "";
/** The sign-out's own sentence, in the block that offers Sign out. */
const troubleText = (el: HTMLElement): string | null =>
  el.querySelector('.join-error-note [role="alert"]')?.textContent ?? null;
const signOutButton = (el: HTMLElement): HTMLButtonElement | null =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === A.signOut) ?? null;

async function fill(el: HTMLElement, selector: string, value: string): Promise<void> {
  await act(async () => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** The open sign-up's account form, filled and sent. */
async function createAccount(el: HTMLElement): Promise<void> {
  await fill(el, "#join-email", "new-person@example.invalid");
  await fill(el, "#join-name", "New Person");
  await fill(el, "#join-pw", "hunter2hunter2");
  await submit(el);
}

/** The confirmation form, its password typed and sent. */
async function confirmAddress(el: HTMLElement): Promise<void> {
  await fill(el, "#verify-pw", "hunter2hunter2");
  await submit(el);
}

describe("/join finishes a pending sign-out instead of reading the session", () => {
  it("access lapsed: the door is asked; neither the session read nor the refresh, nothing of the account", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("join");
    await tick(1_000);
    expect(count("door"), "the unfinished sign-out was not presented at the sign-out door").toBe(1);
    expect(count("refresh"), "the family the person ended was resumed").toBe(0);
    expect(wire.filter((w) => ACCOUNT_READS.includes(w)), "the previous person's account was read").toEqual([]);
    expect(document.cookie, "a confirmed sign-out left the marker behind").not.toContain(PENDING);
    expect(el.querySelector("#join-email"), "the sign-up form waited for the sign-out").not.toBeNull();
    expect(troubleText(el)).toBeNull();
  });

  it("access still live: the previous person's account is never read, nor shown", async () => {
    accessLive = true;
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("join");
    await tick(1_000);
    expect(wire.filter((w) => ACCOUNT_READS.includes(w)), "the previous person's account was read").toEqual([]);
    expect(text(el), "the previous person's mailbox is on the sign-up page").not.toContain(MAILBOX_A);
    expect(count("door")).toBe(1);
  });

  it("a door that keeps failing: the ladder is bounded, the marker kept, and the refusal is said with Sign out", async () => {
    doorScript = [db503];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("join");
    expect(troubleText(el), "a refusal was said before the ladder ended").toBeNull();
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door"), "the ladder is not the confirm ladder's length").toBe(CONFIRM_ATTEMPTS);
    await tick(120_000);
    expect(count("door"), "the ladder kept asking after it ended").toBe(CONFIRM_ATTEMPTS);
    expect(wire.filter((w) => ACCOUNT_READS.includes(w))).toEqual([]);
    expect(document.cookie, "the next visit has nothing left to finish it by").toContain(PENDING);
    expect(troubleText(el), "a sign-out the server never confirmed ended in silence").toBe(refusedSaying("busy"));
    expect(signOutButton(el), "the sentence says to press Sign out, and nothing offers it").not.toBeNull();
  });

  it("Sign out, pressed: the ladder again; a door that answers ends it and the sentence with it", async () => {
    doorScript = [db503, db503, db503, db503, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("join");
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(troubleText(el)).toBe(refusedSaying("busy"));
    await act(async () => { signOutButton(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(1_000);
    expect(count("door")).toBe(CONFIRM_ATTEMPTS + 1);
    expect(document.cookie).not.toContain(PENDING);
    expect(troubleText(el), "the refusal outlived the sign-out it was about").toBeNull();
  });

  it("Create account while the door refuses: the door is asked once more and no registration leaves", async () => {
    doorScript = [db503];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("join");
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    await createAccount(el);
    await tick(2_000);
    expect(count("door"), "the registration did not ask the door first").toBe(CONFIRM_ATTEMPTS + 1);
    expect(count("register"), "an account was made beside a family the server never ended").toBe(0);
    expect(troubleText(el)).toBe(refusedSaying("busy"));
    expect(document.cookie).toContain(PENDING);
  });

  it("…and once the door answers, the same press finishes the sign-out, then registers", async () => {
    doorScript = [db503, db503, db503, db503, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("join");
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    await createAccount(el);
    await tick(2_000);
    expect(count("register"), "the registration never left once the sign-out was confirmed").toBe(1);
    expect(wire.lastIndexOf("door")).toBeLessThan(wire.indexOf("register"));
    expect(document.cookie).not.toContain(PENDING);
    expect(troubleText(el)).toBeNull();
    expect(wire.filter((w) => ACCOUNT_READS.includes(w))).toEqual([]);
  });

  it("a press while the first ask is held: it ends first, the door is asked again, and only then the registration", async () => {
    doorScript = [() => null, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("join");
    await tick(500);
    expect(count("door")).toBe(1);
    await createAccount(el);
    await tick(2_000);
    expect(count("register"), "the registration went out beside a sign-out still at the door").toBe(0);
    await tick(15_000);
    expect(wire.indexOf("door:aborted"), "the held sign-out never ended").toBeGreaterThan(-1);
    expect(count("register")).toBe(1);
    expect(wire.indexOf("door:aborted")).toBeLessThan(wire.lastIndexOf("door"));
    expect(wire.lastIndexOf("door")).toBeLessThan(wire.indexOf("register"));
    expect(count("door"), "the ladder went on behind the registration").toBe(2);
  });
});

describe("/verify-email finishes a pending sign-out before it confirms", () => {
  it("the door on arrival; while it refuses, the confirmation never leaves and the refusal is said", async () => {
    doorScript = [db503];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("verify");
    expect(count("door"), "the unfinished sign-out was not presented at the sign-out door").toBe(1);
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    expect(count("door")).toBe(CONFIRM_ATTEMPTS);
    expect(troubleText(el)).toBe(refusedSaying("busy"));
    await confirmAddress(el);
    await tick(2_000);
    expect(count("door"), "the confirmation did not ask the door first").toBe(CONFIRM_ATTEMPTS + 1);
    expect(count("verify"), "a session was minted beside a family the server never ended").toBe(0);
    expect(wire.filter((w) => ACCOUNT_READS.includes(w))).toEqual([]);
    expect(text(el)).not.toContain(V.doneTitle);
  });

  it("…and once the door answers, the confirmation leaves after it", async () => {
    doorScript = [db503, db503, db503, db503, noContent];
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const el = await mount("verify");
    await tick(CONFIRM_CAP_MS * CONFIRM_ATTEMPTS);
    await confirmAddress(el);
    await tick(2_000);
    expect(count("verify")).toBe(1);
    expect(wire.lastIndexOf("door")).toBeLessThan(wire.indexOf("verify"));
    expect(document.cookie).not.toContain(PENDING);
    expect(text(el)).toContain(V.doneTitle);
  });
});

describe("THE CONTROL — no pending sign-out, both pages as before", () => {
  it("/join reads the session and resumes where the server says; the door is never asked", async () => {
    accessLive = true;
    document.cookie = "tf_owner=acct_A; Path=/";
    const el = await mount("join");
    await tick(1_000);
    expect(count("session"), "the wizard no longer resumes from the server").toBeGreaterThan(0);
    expect(count("door")).toBe(0);
    expect(text(el)).toContain(MAILBOX_A);
  });

  it("/join with no marker and no session (a stranger): the session is asked as before, the door never", async () => {
    refreshable = false;
    const el = await mount("join");
    await tick(1_000);
    expect(count("session")).toBeGreaterThan(0);
    expect(count("door")).toBe(0);
    expect(el.querySelector("#join-email")).not.toBeNull();
    expect(text(el)).toContain(J.createAccount);
  });

  it("/verify-email: the confirmation leaves at once; the door is never asked", async () => {
    const el = await mount("verify");
    await confirmAddress(el);
    await tick(1_000);
    expect(count("verify")).toBe(1);
    expect(count("door")).toBe(0);
    expect(text(el)).toContain(V.doneTitle);
  });
});
