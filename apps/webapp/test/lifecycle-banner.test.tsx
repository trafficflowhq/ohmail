/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import { dayStamp } from "@ohmail/app-logic/text/format";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * ═══ THE STRIP ABOVE THE APP ════════════════════════════════════════════════════════════════
 *
 * Three deadlines and one piece of good news, none of them a modal: the app keeps working in
 * every state this draws, so taking the screen would be a lie about what has happened.
 *
 * The properties argued here: the strip appears only for a state the SERVER named; it is put
 * away for the session and comes back in the next one; a NEW deadline is a new strip even in the
 * same session; and the catch-up is said once and names no mailbox — a mailbox the closure paused
 * resumes on its own (mail 0135).
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

let host: HTMLDivElement;
let root: Root;
let access: Record<string, unknown> = { metered: false };
let mailboxList: unknown[] = [];
/** `POST /account/manage-link`, as the case states it; `null` means it was never asked. */
let mint: { status: number; body: unknown } | null = null;
const realFetch = globalThis.fetch;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  globalThis.sessionStorage.clear();
  mailboxList = [];
  mint = null;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/account/manage-link")) {
      const m = mint ?? { status: 404, body: { error: { code: "no_manage_surface" } } };
      return new Response(JSON.stringify(m.body), { status: m.status, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/account/access")) return json(access);
    if (u.includes("/mailboxes")) return json({ items: mailboxList });
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
});

async function mount(locale: "en" | "de" = "en"): Promise<void> {
  const { LifecycleBanner } = await import("../app/(product)/mailbox/LifecycleBanner");
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale,
      messages: locale === "en" ? en : de,
      children: h(ThemeProvider, { children: h(LifecycleBanner) }),
    }));
  });
  // The read is a promise; one more turn lets its `.then` paint.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const text = (): string => host.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];
const press = async (label: string): Promise<void> => {
  const b = buttons().find((x) => x.textContent === label);
  expect(b, `no button labelled ${label}`).toBeDefined();
  await act(async () => { b!.click(); });
};

/** The pure half, driven without a DOM: which strip a set of facts earns. */
describe("which strip the facts earn", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");

  it("grace and past_due earn one each, and only with a deadline to name", async () => {
    const { noticeOf } = await import("../app/(product)/mailbox/LifecycleBanner");
    const base = { closedReason: null } as const;
    expect(noticeOf({ ...base, state: "grace", graceUntil: "2026-09-21T00:00:00Z" }, undefined, NOW))
      .toEqual({ kind: "grace", deadline: "2026-09-21T00:00:00Z" });
    expect(noticeOf({ ...base, state: "past_due", graceUntil: "2026-09-27T00:00:00Z" }, undefined, NOW))
      .toEqual({ kind: "pastDue", deadline: "2026-09-27T00:00:00Z" });
    // A state with no date to state says nothing — a deadline strip without a deadline is noise.
    expect(noticeOf({ ...base, state: "grace", graceUntil: null }, undefined, NOW)).toBeNull();
    expect(noticeOf({ ...base, state: "past_due" }, undefined, NOW)).toBeNull();
  });

  it("a trial speaks only inside its last two days, and never after it has run out", async () => {
    const { noticeOf, TRIAL_NOTICE_DAYS } = await import("../app/(product)/mailbox/LifecycleBanner");
    expect(TRIAL_NOTICE_DAYS).toBe(2);
    const trial = (endsIn: number) => ({
      state: "trialing" as const, closedReason: null,
      trialEndsAt: new Date(NOW + endsIn).toISOString(),
    });
    expect(noticeOf(trial(3 * DAY), undefined, NOW), "three days out").toBeNull();
    expect(noticeOf(trial(1.5 * DAY), undefined, NOW)?.kind).toBe("trialEnding");
    expect(noticeOf(trial(60_000), undefined, NOW)?.kind).toBe("trialEnding");
    /* PAST its end is not this client's business: the server promotes a finished trial to
       `grace`, and arithmetic here would put a second opinion on the screen. */
    expect(noticeOf(trial(-60_000), undefined, NOW)).toBeNull();
    expect(noticeOf({ state: "trialing", closedReason: null, trialEndsAt: "not a date" }, undefined, NOW))
      .toBeNull();
  });

  it("a state with nothing to say says nothing, and an absent lifecycle says nothing", async () => {
    const { noticeOf } = await import("../app/(product)/mailbox/LifecycleBanner");
    for (const state of ["active", "closed", "erased"] as const) {
      expect(noticeOf({ state, closedReason: null, graceUntil: "2026-09-21T00:00:00Z" }, undefined, NOW), state)
        .toBeNull();
    }
    expect(noticeOf(undefined, undefined, NOW)).toBeNull();
  });

  it("the catch-up outranks every deadline — a reopened account is not also in a grace", async () => {
    const { noticeOf } = await import("../app/(product)/mailbox/LifecycleBanner");
    const got = noticeOf(
      { state: "grace", closedReason: null, graceUntil: "2026-09-21T00:00:00Z" },
      { since: "2026-09-01T00:00:00Z" },
      NOW,
    );
    expect(got).toEqual({ kind: "caughtUp", since: "2026-09-01T00:00:00Z" });
  });

  it("the dismissal key carries the DATE, so a new deadline is a new strip", async () => {
    const { dismissKey } = await import("../app/(product)/mailbox/LifecycleBanner");
    const a = dismissKey({ kind: "grace", deadline: "2026-09-21T00:00:00Z" }, "acct-1");
    const b = dismissKey({ kind: "grace", deadline: "2026-09-28T00:00:00Z" }, "acct-1");
    expect(a).not.toBe(b);
    // …and the ACCOUNT, so one person's dismissal is not another's on a shared machine.
    expect(dismissKey({ kind: "grace", deadline: "2026-09-21T00:00:00Z" }, "acct-2")).not.toBe(a);
  });
});

describe("the strip on screen", () => {
  it("names the deadline and offers one link, in both languages", async () => {
    access = {
      metered: true, canAddMailbox: true, mailboxes: 1,
      lifecycle: { state: "grace", closedReason: null, graceUntil: "2026-09-21T09:00:00.000Z" },
    };
    await mount("en");
    expect(text()).toContain("Your trial ended.");
    expect(text()).toContain("Sep");
    expect(buttons().map((b) => b.textContent)).toEqual([en.accountLifecycle.subscribe, en.accountLifecycle.later]);
    // Never a modal, and never a dialog: it is a status strip, and it is announced as one.
    expect(host.querySelector("[role=status]")).not.toBeNull();
    expect(host.querySelectorAll("[role=dialog]")).toHaveLength(0);

    await act(async () => { root.unmount(); });
    root = createRoot(host);
    const { forgetAccess } = await import("../app/api-client");
    forgetAccess();
    await mount("de");
    expect(text()).toContain("Deine Testphase ist abgelaufen.");
  });

  it("a failed payment says FIX PAYMENT, not subscribe — the account already has one", async () => {
    access = {
      metered: true, canAddMailbox: true, mailboxes: 1,
      lifecycle: { state: "past_due", closedReason: null, graceUntil: "2026-09-27T09:00:00.000Z" },
    };
    await mount();
    expect(text()).toContain("Your last payment failed.");
    expect(buttons().map((b) => b.textContent)).toEqual([en.accountLifecycle.fixPayment, en.accountLifecycle.later]);
  });

  it("goes away when it is put away, and the dismissal is remembered for the session", async () => {
    access = {
      metered: true, canAddMailbox: true, mailboxes: 1,
      lifecycle: { state: "grace", closedReason: null, graceUntil: "2026-09-21T09:00:00.000Z" },
    };
    await mount();
    expect(text()).toContain("Your trial ended.");
    await press(en.accountLifecycle.later);
    expect(text()).toBe("");

    // A second mount in the SAME session stays quiet…
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    const { forgetAccess } = await import("../app/api-client");
    forgetAccess();
    await mount();
    expect(text()).toBe("");

    // …and the NEXT session says it again. A deadline put away this morning is worth saying
    // again tomorrow, which is the whole reason the store is `sessionStorage`.
    globalThis.sessionStorage.clear();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    forgetAccess();
    await mount();
    expect(text()).toContain("Your trial ended.");
  });

  it("a store that will not answer is not a dismissal — the strip still shows", async () => {
    /* A private window, or site data blocked: `sessionStorage` throws on access. Showing a strip
       twice is a smaller failure than never showing it, so an unreadable store reads NOT
       dismissed — and the write that follows must not take the screen down with it. */
    const real = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() { throw new DOMException("blocked", "SecurityError"); },
    });
    try {
      access = {
        metered: true, canAddMailbox: true, mailboxes: 1,
        lifecycle: { state: "grace", closedReason: null, graceUntil: "2026-09-21T09:00:00.000Z" },
      };
      await mount();
      expect(text()).toContain("Your trial ended.");
      await press(en.accountLifecycle.later);
      expect(text()).toBe("");
    } finally {
      if (real) Object.defineProperty(window, "sessionStorage", real);
    }
  });

  it("an unmetered host draws nothing at all", async () => {
    access = { metered: false };
    await mount();
    expect(text()).toBe("");
  });

  it("names no price in either language", async () => {
    for (const [state, until] of [["grace", "graceUntil"], ["past_due", "graceUntil"]] as const) {
      for (const locale of ["en", "de"] as const) {
        access = {
          metered: true, canAddMailbox: true, mailboxes: 1,
          lifecycle: { state, closedReason: null, [until]: "2026-09-27T09:00:00.000Z" },
        };
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        const { forgetAccess } = await import("../app/api-client");
        forgetAccess();
        globalThis.sessionStorage.clear();
        await mount(locale);
        expect(text(), `${state} ${locale}`)
          .not.toMatch(/CHF|EUR|USD|€|\$[0-9]|\/month|\/Monat|pro Monat|per month/);
      }
    }
  });
});

describe("the catch-up after the wall lifts", () => {
  const REOPENED = {
    metered: true, canAddMailbox: true, mailboxes: 2,
    lifecycle: { state: "active", closedReason: null },
    caughtUp: { since: "2026-09-01T09:00:00.000Z" },
  };

  it("says since when ohmail is catching up, with no number and no mailbox to start again", async () => {
    access = REOPENED;
    // A paused reader, the one the old strip listed with "does not take them again on its own".
    mailboxList = [
      { id: "m1", address: "a@example.test", organizerRole: "reader", organizeConsentedAt: "2026-05-01T00:00:00Z" },
    ];
    await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // The worker has not run when this is said, so a number here would be the free month's mail.
    expect(text()).toContain(en.accountLifecycle.caughtUp.replace("{date}", dayStamp(REOPENED.caughtUp.since)));
    expect(text()).not.toMatch(/\d+ messages?/);
    // Organizing resumes on its own, so the strip names no mailbox and links nowhere.
    expect(text()).not.toContain("a@example.test");
    expect(host.querySelectorAll("a")).toHaveLength(0);
    expect(buttons().map((b) => b.textContent)).toEqual([en.accountLifecycle.dismiss]);
  });

  it("neither catalogue still says ohmail will not take the mailboxes again on its own", () => {
    for (const cat of [en, de] as const) {
      const words = JSON.stringify(cat.accountLifecycle);
      expect("handedBack" in cat.accountLifecycle).toBe(false);
      expect(words).not.toContain("does not take them again");
      expect(words).not.toContain("nimmt sie nicht von selbst wieder");
    }
  });

  it("is said ONCE: dismissed by `since`, so the same catch-up never returns this session", async () => {
    access = REOPENED;
    await mount();
    expect(text()).toContain(en.accountLifecycle.caughtUp.replace("{date}", dayStamp(REOPENED.caughtUp.since)));
    await press(en.accountLifecycle.dismiss);
    expect(text()).toBe("");

    await act(async () => { root.unmount(); });
    root = createRoot(host);
    const { forgetAccess } = await import("../app/api-client");
    forgetAccess();
    await mount();
    expect(text()).toBe("");

    // A LATER closure is a different `since`, so it is a different notice and speaks.
    access = { ...REOPENED, caughtUp: { since: "2026-09-19T09:00:00.000Z" } };
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    forgetAccess();
    await mount();
    expect(text()).toContain(en.accountLifecycle.caughtUp.replace("{date}", dayStamp("2026-09-19T09:00:00.000Z")));
  });

  it("an older API's count is not said: the sentence is the same, with no number", async () => {
    access = { ...REOPENED, caughtUp: { since: "2026-09-01T09:00:00.000Z", count: 478 } };
    await mount();
    expect(text()).toContain(en.accountLifecycle.caughtUp.replace("{date}", dayStamp(REOPENED.caughtUp.since)));
    expect(text()).not.toContain("478");
  });
});

/* A PRESS IS OWED A SENTENCE: a Subscribe that went nowhere says why, in the wall's own words,
   and the strip stays for the next try. */
describe("the strip's press when the page cannot be opened", () => {
  const TRIAL = {
    metered: true, access: "open", canAddMailbox: true, mailboxes: 1,
    lifecycle: { state: "trialing", closedReason: null, trialEndsAt: new Date(Date.now() + 36 * 3_600_000).toISOString() },
  };
  const alert = (): HTMLElement | null => host.querySelector('[role="alert"]');

  for (const [name, answer, sentence] of [
    ["a server that did not answer", { status: 503, body: { error: { code: "unavailable" } } }, en.accessLock.mintFailed],
    ["an unconfirmed address", { status: 403, body: { error: { code: "email_unverified" } } }, en.accessLock.mintUnverified],
    ["no page on this deployment", { status: 404, body: { error: { code: "no_manage_surface" } } }, en.accessLock.mintFailed],
  ] as const) {
    it(`${name}: the strip says so, and stays`, async () => {
      access = TRIAL;
      mint = answer;
      await mount();
      expect(text()).toContain(en.accountLifecycle.trialEnds.replace("{date}", dayStamp(TRIAL.lifecycle.trialEndsAt)));
      await press("Subscribe");
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(alert()?.textContent, "a press that went nowhere said nothing").toBe(sentence);
      expect(text(), "the strip went away with the refusal").toContain(en.accountLifecycle.trialEnds.replace("{date}", dayStamp(TRIAL.lifecycle.trialEndsAt)));
      const again = buttons().find((b) => b.textContent === "Subscribe");
      expect(again?.disabled, "the press was left disabled").toBe(false);
    });
  }

  it("a later press that leaves takes the sentence with it", async () => {
    access = TRIAL;
    mint = { status: 503, body: { error: { code: "unavailable" } } };
    await mount();
    await press("Subscribe");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(alert()).not.toBeNull();
    mint = { status: 200, body: { url: "https://account.example/manage?t=abc" } };
    const stop = (ev: Event): void => { ev.preventDefault(); };
    document.addEventListener("click", stop, true);
    try {
      await press("Subscribe");
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    } finally {
      document.removeEventListener("click", stop, true);
    }
    expect(alert(), "the refusal outlived the press it was about").toBeNull();
  });
});
