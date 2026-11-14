/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";

/**
 * THE STRIP FOLLOWS THE PAYMENT: a person who has just paid never reads a
 * trial or payment strip again. The strip draws from the access feed, asks once on a return to
 * the tab (no clock), polls after a hand-off, and keeps a catch-up another reader was handed.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const t0 = Date.parse("2026-09-28T08:00:00.000Z");
const GRACE = {
  metered: true, access: "open", canAddMailbox: true, mailboxes: 1,
  lifecycle: { state: "grace", closedReason: null, graceUntil: "2026-10-01T09:00:00.000Z" },
};
const TRIAL = {
  metered: true, access: "open", canAddMailbox: true, mailboxes: 1,
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: "2026-09-29T20:00:00.000Z" },
};
const PAID = {
  metered: true, access: "open", canAddMailbox: true, mailboxes: 1,
  lifecycle: { state: "active", closedReason: null },
};
const SINCE = "2026-09-23T02:15:07.000Z";
const CAUGHT_UP = { ...PAID, caughtUp: { since: SINCE } };

let host: HTMLDivElement;
let root: Root;
let access: Record<string, unknown> | "fail" = PAID;
let gate: Promise<void> | null = null;
let accessReads = 0;
let clock = t0;
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setOwner(id: string | null): void {
  document.cookie = id === null
    ? "tf_owner=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"
    : `tf_owner=${id}; path=/`;
}

beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  globalThis.sessionStorage.clear();
  setOwner("acct_A");
  // A tab in front, as a browser reports it: jsdom answers "prerender", which no clock reads through.
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  accessReads = 0;
  access = PAID;
  gate = null;
  clock = t0;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/account/access")) {
      accessReads += 1;
      const body = access;
      if (gate !== null) await gate;
      return body === "fail" ? json({ error: "unavailable" }, 503) : json(body);
    }
    return json({});
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  globalThis.fetch = realFetch;
  globalThis.sessionStorage.clear();
  setOwner(null);
  delete (document as unknown as Record<string, unknown>).visibilityState;
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
};

let renders = 0;
async function mount(): Promise<void> {
  const { LifecycleBanner } = await import("../app/(product)/mailbox/LifecycleBanner");
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en,
      children: h(ThemeProvider, {
        children: h(React.Profiler, { id: "strip", onRender: () => { renders += 1; }, children: h(LifecycleBanner) }),
      }),
    }));
  });
  await settle();
}

/** A new document in the same tab: module state is gone, the session store is not. */
async function reload(): Promise<void> {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  await mount();
}

/** A return to this tab from another one: both events fire, as a browser fires them. */
async function returnToTab(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
}

const text = (): string => host.textContent ?? "";
const later = (ms: number): void => { clock += ms; };

describe("the strip after a payment in another tab", () => {
  it("is gone on the return to this tab, after exactly one read", async () => {
    access = GRACE;
    await mount();
    expect(text()).toContain("Your trial ended.");
    const before = accessReads;
    access = PAID; // paid in the second tab
    later(5 * 60_000);
    await returnToTab();
    expect(text(), "a paid account reads no grace strip").toBe("");
    expect(accessReads - before, "focus and visibility together are one read").toBe(1);
  });

  it("the same for the trial strip", async () => {
    access = TRIAL;
    await mount();
    expect(text()).toContain("Your trial ends on");
    access = PAID;
    later(60_000);
    await returnToTab();
    expect(text()).toBe("");
  });

  it("follows an answer another surface of this tab asked for, and asks nothing itself", async () => {
    access = GRACE;
    await mount();
    expect(text()).toContain("Your trial ended.");
    const before = accessReads;
    access = PAID;
    later(10_000);
    const { account } = await import("../app/api-client");
    await act(async () => { await account.access({ fresh: true }); });
    await settle();
    expect(text()).toBe("");
    expect(accessReads - before).toBe(1);
  });

  it("a read that fails on the return says nothing and takes nothing down", async () => {
    access = GRACE;
    await mount();
    access = "fail";
    later(60_000);
    await returnToTab();
    expect(text()).toContain("Your trial ended.");
  });
});

describe("the return schedule", () => {
  it("a trial that ended while the tab was open is said on the next return past the quiet floor", async () => {
    const { QUIET_RETURN_MS } = await import("../app/(product)/mailbox/LifecycleBanner");
    expect(QUIET_RETURN_MS).toBe(15 * 60_000);
    access = PAID;
    await mount();
    const before = accessReads;
    access = GRACE;
    later(QUIET_RETURN_MS - 1_000);
    await returnToTab();
    expect(accessReads - before, "nothing drawn: a return inside the floor asks nothing").toBe(0);
    later(2_000);
    await returnToTab();
    expect(accessReads - before).toBe(1);
    expect(text()).toContain("Your trial ended.");
  });

  it("NO CLOCK: a whole day in front with nothing pressed asks nothing past the first paint", async () => {
    // Date moves with the timers here: a frozen clock would let every read join the first.
    vi.restoreAllMocks();
    vi.useFakeTimers({ now: t0, toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    access = GRACE;
    await mount();
    const before = accessReads;
    for (let hour = 0; hour < 24; hour += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    }
    expect(accessReads - before).toBe(0);
    expect(text()).toContain("Your trial ended.");
  });

  it("one render per answer: the snapshot is the stored reference", async () => {
    access = GRACE;
    renders = 0;
    await mount();
    const afterMount = renders;
    access = PAID;
    later(60_000);
    await returnToTab();
    expect(renders - afterMount).toBe(1);
  });
});

describe("the access door joins a return, and never across a write", () => {
  it("a fresh read inside the debounce joins the answer in hand", async () => {
    const { account } = await import("../app/api-client");
    const { RETURN_DEBOUNCE_MS } = await import("@ohmail/app-logic/doors/wall-lift");
    await account.access({ fresh: true });
    later(RETURN_DEBOUNCE_MS - 1);
    await account.access({ fresh: true });
    expect(accessReads).toBe(1);
    later(2);
    await account.access({ fresh: true });
    expect(accessReads).toBe(2);
  });

  it("a write since the held read is not joined: a payment confirmed can change the answer", async () => {
    const { account } = await import("../app/api-client");
    access = GRACE;
    await account.access({ fresh: true });
    await account.confirmReturn("cs_test_1");
    access = PAID;
    const a = await account.access({ fresh: true });
    expect(accessReads).toBe(2);
    expect(a.metered && a.lifecycle?.state).toBe("active");
  });
});

describe("the payer's own tab", () => {
  it("?billing=success with the payment pending: polls until paid, then draws nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const { LIFT_POLL_MS, LIFT_POLL_MAX } = await import("@ohmail/app-logic/doors/wall-lift");
    window.history.replaceState(null, "", "/?billing=success");
    access = GRACE; // the confirm answered `pending`: the program has not applied it yet
    await mount();
    expect(text()).toContain("Your trial ended.");
    for (let n = 0; n < 4; n += 1) {
      later(LIFT_POLL_MS);
      await act(async () => { await vi.advanceTimersByTimeAsync(LIFT_POLL_MS); });
    }
    access = PAID;
    later(LIFT_POLL_MS);
    await act(async () => { await vi.advanceTimersByTimeAsync(LIFT_POLL_MS); });
    await settle();
    expect(text()).toBe("");
    const polled = accessReads;
    expect(polled).toBeLessThanOrEqual(LIFT_POLL_MAX + 1);
    for (let n = 0; n < 5; n += 1) {
      later(LIFT_POLL_MS);
      await act(async () => { await vi.advanceTimersByTimeAsync(LIFT_POLL_MS); });
    }
    expect(accessReads, "the poll ends where the answer lands").toBe(polled);
  });
});

describe("the catch-up another reader was handed first", () => {
  it("is still said by the strip that mounts after the wall lifted", async () => {
    const { account } = await import("../app/api-client");
    access = CAUGHT_UP; // the wall's lift read: the door answers the catch-up once
    await act(async () => { await account.access({ fresh: true }); });
    access = PAID;
    later(5_000);
    await act(async () => { await account.access({ fresh: true }); });
    await mount();
    expect(text()).toContain("catching up");
  });

  it("survives a reload in the session; put away, it is gone for good", async () => {
    const { account } = await import("../app/api-client");
    access = CAUGHT_UP;
    await act(async () => { await account.access({ fresh: true }); });
    access = PAID;
    await mount();
    expect(text()).toContain("catching up");
    later(5_000);
    await reload();
    expect(text(), "a reload keeps what the service answered once").toContain("catching up");
    const got = [...host.querySelectorAll("button")].find((b) => b.textContent === "Got it");
    await act(async () => { got!.click(); });
    expect(text()).toBe("");
    later(5_000);
    await reload();
    expect(text()).toBe("");
  });
});

describe("the feed belongs to one account", () => {
  it("a sign-in as B after A's grace strip draws nothing for B until B's own answer", async () => {
    access = GRACE;
    await mount();
    expect(text()).toContain("Your trial ended.");
    setOwner("acct_B");
    let release: () => void = () => undefined;
    gate = new Promise<void>((r) => { release = r; });
    access = { ...GRACE, lifecycle: { ...GRACE.lifecycle, graceUntil: "2026-11-05T09:00:00.000Z" } };
    later(60_000);
    await returnToTab(); // B's read is in flight
    await mount(); // the shell re-renders for the account that is signed in now
    expect(text(), "A's strip is not B's").toBe("");
    gate = null;
    release();
    await settle();
    expect(text()).toContain("Nov");
  });
});
