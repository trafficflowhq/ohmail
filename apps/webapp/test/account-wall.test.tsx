/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { readFileSync } from "node:fs";

/**
 * ═══ THE WALL — every lifecycle state, both catalogues, and the two things it may never do ═══
 *
 * The screen a managed account meets when its subscription has ended. Three properties the cases
 * below are about, in the order they were argued:
 *
 *  1. IT NAMES WHAT HAPPENED AND WHEN, from the server's facts. Never from this machine's clock,
 *     and never a date it does not have — a closure with no `closedAt` falls back to the undated
 *     sentence rather than guessing.
 *  2. ERASED IS NOT A SCREEN. `deleteAccount` removes the users, the sessions and the credentials
 *     (§1(j)), so nobody signs in to read "erased on <date>" and that
 *     sentence exists nowhere.
 *  3. AN OLDER SERVER STILL LOCKS. A 402 whose body carries no lifecycle is a refusal all the
 *     same, and the screen says what it has always said.
 */

// React as a global and API_BASE before the module under test imports `api-client`.
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

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function mount(node: React.ReactNode, locale: "en" | "de" = "en"): Promise<void> {
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, children: h(ThemeProvider, { children: node }),
    }));
  });
}

const text = (): string => host.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];
/** The page's sentence: its line, as the design draws it, not a heading. */
const sentence = (): string => host.querySelector("main p")?.textContent ?? "";
/** A press by its words. */
const named = (name: string): HTMLButtonElement | undefined => buttons().find((b) => b.textContent === name);
/** The wall's ways out on their sheet, as a person reads them: each row's press, its name first, in order. */
const ways = (): string[] => [...host.querySelectorAll('[role="list"] button')].map((b) => b.textContent ?? "");

/** A closure the server has attributed and dated. */
const closed = (
  reason: "trial_ended" | "canceled" | "unpaid" | "suspended",
  extra: Record<string, unknown> = {},
) => ({
  state: "closed" as const,
  closedReason: reason,
  closedAt: "2026-08-24T09:00:00.000Z",
  erasureAt: "2026-09-23T09:00:00.000Z",
  formerlyPaid: false,
  ...extra,
});

const WALL = {
  reason: "payment_required" as const,
  manageUrl: "https://manage.example/t",
  exportPath: "/account/export",
};

describe("the wall names the closure and its date", () => {
  it("each attributed reason gets its own sentence, and none of them is another's", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    const seen: string[] = [];
    for (const reason of ["trial_ended", "canceled", "unpaid"] as const) {
      await mount(h(WallRoute, { facts: { ...WALL, lifecycle: closed(reason) } }));
      // The date the SERVER stated, rendered in the reader's own zone by the one formatter.
      expect(text(), reason).toContain("Aug");
      expect(text(), reason).toContain("2026");
      const headline = sentence();
      expect(headline, reason).not.toBe("");
      seen.push(headline);
    }
    // Three reasons, three sentences — not one sentence worn three times.
    expect(new Set(seen).size).toBe(3);
    expect(seen[0]).toMatch(/trial/i);
    expect(seen[1]).toMatch(/subscription/i);
    expect(seen[2]).toMatch(/payment/i);
  });

  it("a suspension says nothing about an erasure date, because there is not one", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, {
      facts: {
        reason: "suspended" as const,
        manageUrl: WALL.manageUrl,
        lifecycle: closed("suspended", { erasureAt: null }),
      },
    }));
    expect(sentence()).toBe("This account is suspended");
    // An operator hold is not a departure (ruling §1(a)): no clock, and somewhere to ask.
    expect(text()).toContain("operator");
    expect(text()).toContain("support@ohmail.app");
    expect(text()).not.toMatch(/are erased on/);
  });

  it("the delete hint points at the date above only where a date IS above", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    // Dated erasure sentence on screen: the hint may reference it.
    await mount(h(WallRoute, { facts: { ...WALL, lifecycle: closed("trial_ended") } }));
    expect(text()).toMatch(/today, not on Sep 2[23], 2026/);
    // A held account renders no date, so the hint stops pointing at one.
    await mount(h(WallRoute, {
      facts: {
        reason: "suspended" as const,
        manageUrl: WALL.manageUrl,
        lifecycle: closed("suspended", { erasureAt: null }),
      },
    }));
    expect(text()).not.toContain("today, not on");
    expect(text()).toContain(en.accessLock.deleteHintUndated);
    // An older server says nothing about dates at all — same undated hint.
    await mount(h(WallRoute, { facts: { ...WALL, lifecycle: undefined } }));
    expect(text()).not.toContain("today, not on");
    expect(text()).toContain(en.accessLock.deleteHintUndated);
  });

  it("a closure the server could not attribute gets the undated sentence, not a guessed date", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, {
      facts: { ...WALL, lifecycle: { ...closed("canceled"), closedReason: null, closedAt: null } },
    }));
    expect(sentence()).toBe("This account is not active");
    // …and it still carries the erasure date it DOES have.
    expect(text()).toMatch(/are erased on/);
  });

  it("ERASED renders no date and no erasure sentence — nobody can sign in to read one", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, {
      facts: {
        ...WALL,
        lifecycle: {
          state: "erased" as const, closedReason: "canceled" as const,
          closedAt: "2026-08-24T09:00:00.000Z", erasedAt: "2026-09-23T09:00:00.000Z",
          erasureAt: null, formerlyPaid: true,
        },
      },
    }));
    expect(sentence()).toBe("This account is not active");
    expect(text()).not.toMatch(/erased on/i);
    expect(text()).not.toContain("Sep");
    /* AND NO ERASURE SENTENCE AT ALL. "Nothing has been erased" is what this state used to
       render, which is false for an erased account — a false claim in an unreachable state is
       still a false claim, and this is the case that caught it. */
    expect(text()).not.toMatch(/Nothing has been erased/);
    expect(text()).not.toMatch(/are erased on/);
    // The two true sentences stay: the organizer stopped, and the mailbox is untouched.
    expect(text()).toContain(en.accessLock.stoppedUntouched);
  });

  it("a staff hold is not offered SUBSCRIBE — the account may be fully paid", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, {
      facts: {
        reason: "suspended" as const,
        manageUrl: WALL.manageUrl,
        lifecycle: closed("suspended", { erasureAt: null }),
      },
    }));
    // The way back is a BUTTON (it mints at the press); its label is what this case is about.
    expect(named("Open your ohmail account")).toBeTruthy();
    expect(text()).not.toContain("Subscribe");
  });

  it("`formerlyPaid` changes no sentence — it is the server's retention arithmetic, not copy", async () => {
    /* Measured rather than assumed. The trial keeps data 30 days and a formerly paid account 90
       (the ruled numbers), but that difference reaches this screen ALREADY APPLIED, as one
       `erasureAt`. If a sentence ever starts differing on the flag, this case says so. */
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, { facts: { ...WALL, lifecycle: closed("canceled", { formerlyPaid: false }) } }));
    const cold = text();
    await mount(h(WallRoute, { facts: { ...WALL, lifecycle: closed("canceled", { formerlyPaid: true }) } }));
    expect(text()).toBe(cold);
  });

  it("the open states never reach this screen with a dated headline", async () => {
    /* `grace`, `past_due`, `trialing` and `active` are `ok: true` at the gate and raise no 402.
       If one ever arrives here it must not be dressed as a closure. */
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    for (const state of ["trialing", "grace", "past_due", "active"] as const) {
      await mount(h(WallRoute, {
        facts: { ...WALL, lifecycle: { ...closed("canceled"), state } },
      }));
      expect(sentence(), state).toBe("This account is not active");
    }
  });
});

describe("the wall's three actions", () => {
  it("are the three chosen ones, in the chosen order, and each says what it does", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, { facts: { ...WALL, lifecycle: closed("trial_ended") } }));
    /* The way back is the page's one act; the two ways out stand beside it on a sheet, each with the line that says
       what it does. The guide stands under them and is deliberately not one of them: it explains, it does not act. */
    expect(named("Subscribe")).toBeTruthy();
    expect(ways()).toEqual([
      expect.stringMatching(/^Move to self-hosted.+your own server reads/),
      expect.stringMatching(/^Delete my account now.+Your mailbox is not touched/),
    ]);
    // …and the guide is there, reachable by keyboard like everything else.
    expect(buttons().map((b) => b.textContent)).toContain("Read the self-host guide");
    // The way back out of this browser is never inside the action column, and never absent.
    expect(buttons().map((b) => b.textContent)).toContain("Sign out");
  });

  it("withholds Subscribe when the service named no page, and the export when it serves none", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, {
      facts: { reason: "payment_required" as const, lifecycle: closed("canceled") },
    }));
    // A control that goes nowhere is the one a person on this screen will press.
    expect(named("Subscribe")).toBeUndefined();
    expect(ways()).toEqual([expect.stringMatching(/^Delete my account now/)]);
    expect(text()).not.toContain("Move to self-hosted");
  });

  it("names no price, no plan and no currency in either language", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    for (const locale of ["en", "de"] as const) {
      await mount(
        h(WallRoute, { facts: { ...WALL, lifecycle: closed("unpaid", { formerlyPaid: true }) } }),
        locale,
      );
      expect(text(), locale).not.toMatch(/CHF|EUR|USD|€|\$[0-9]|\/month|\/Monat|pro Monat|per month/);
    }
  });

  it("says the mailbox is untouched — in both languages, on the closed arm", async () => {
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    await mount(h(WallRoute, { facts: { ...WALL, lifecycle: closed("trial_ended") } }), "en");
    expect(text()).toContain(en.accessLock.stoppedUntouched);
    await mount(h(WallRoute, { facts: { ...WALL, lifecycle: closed("trial_ended") } }), "de");
    expect(text()).toContain(de.accessLock.stoppedUntouched);
  });

  it("the export's filename carries the day it was taken", async () => {
    const { exportFilename } = await import("../app/(product)/mailbox/use-wall-door");
    expect(exportFilename(new Date(2026, 8, 5))).toBe("ohmail-settings-2026-09-05.json");
    expect(exportFilename(new Date(2026, 11, 31))).toBe("ohmail-settings-2026-12-31.json");
  });
});

describe("the 402 sink carries the lifecycle, and an older server still locks", () => {
  /* The ONE sink (`api-client.ts`), driven through a real refusal rather than by calling the
     narrowing directly: the point of the case is that the details reach the screen. */
  let seen: unknown[] = [];
  let stop: (() => void) | null = null;
  const realFetch = globalThis.fetch;

  const refuseWith = (details: unknown): void => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { code: "subscription_required", message: "no", details } }),
      { status: 402, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  };

  beforeEach(() => { seen = []; });
  afterEach(() => { stop?.(); stop = null; globalThis.fetch = realFetch; });

  it("hands the wall the lifecycle, the manage page and the export path", async () => {
    const { onAccessRefused, mailboxes, forgetAccess } = await import("../app/api-client");
    forgetAccess();
    stop = onAccessRefused((f) => seen.push(f));
    refuseWith({
      reason: "payment_required",
      manageUrl: "https://manage.example/t",
      lifecycle: closed("trial_ended"),
      exportPath: "/account/export",
    });
    await mailboxes.list().catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      reason: "payment_required",
      manageUrl: "https://manage.example/t",
      exportPath: "/account/export",
      lifecycle: { state: "closed", closedReason: "trial_ended" },
    });
  });

  it("A BODY WITHOUT A LIFECYCLE STILL LOCKS, with the sentence this screen has always shown", async () => {
    const { onAccessRefused, mailboxes, forgetAccess } = await import("../app/api-client");
    const { WallRoute } = await import("../app/(product)/mailbox/WallRoute");
    forgetAccess();
    stop = onAccessRefused((f) => seen.push(f));
    refuseWith({ reason: "payment_required", manageUrl: "https://manage.example/t" });
    await mailboxes.list().catch(() => undefined);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("lifecycle");
    await mount(h(WallRoute, { facts: seen[0] as never }));
    expect(sentence()).toBe("This account is not active");
    expect(text()).toContain("Nothing has been deleted");
    // …and the old label, because there is no lifecycle to call it a resubscription.
    expect(named("Manage subscription")).toBeTruthy();
  });

  it("an unknown state is DROPPED, not rendered — a drift must not invent a screen", async () => {
    const { lifecycleOf } = await import("../app/api-client");
    expect(lifecycleOf({ state: "hibernating" })).toBeUndefined();
    expect(lifecycleOf({ state: 7 })).toBeUndefined();
    expect(lifecycleOf(null)).toBeUndefined();
    expect(lifecycleOf("closed")).toBeUndefined();
    // …and an unknown REASON is "not attributed", which the screen has a sentence for.
    expect(lifecycleOf({ state: "closed", closedReason: "audited" })?.closedReason).toBeNull();
    expect(lifecycleOf({ state: "closed", closedAt: "" })?.closedAt).toBeNull();
  });

  it("a 402 that is not THIS code raises nothing — it is a refused request, not a refused account", async () => {
    const { onAccessRefused, mailboxes, forgetAccess } = await import("../app/api-client");
    forgetAccess();
    stop = onAccessRefused((f) => seen.push(f));
    refuseWith({ reason: "payment_required", lifecycle: closed("canceled") });
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { code: "quota_exceeded", details: { lifecycle: closed("canceled") } } }),
      { status: 402, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    await mailboxes.list().catch(() => undefined);
    expect(seen).toHaveLength(0);
  });
});

describe("the lock does not unset itself", () => {
  /* CLOUDSHELL'S RULE, asserted where it is decidable: a refusal is a fact about the ACCOUNT, and
     a later request that happens to succeed is not evidence it was lifted. The shell holds the
     FIRST facts (`setRefused((held) => held ?? facts)`) and signing in again is what clears it —
     which is a page load, so nothing in this module can undo a lock. The two halves below are the
     ones this side owns: a success notifies NOTHING, so there is no signal that could unlock; and
     a second refusal does not replace the first fact the shell is showing. */
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("a 200 after a refusal raises nothing — there is no signal that could lift the lock", async () => {
    const { onAccessRefused, mailboxes, forgetAccess } = await import("../app/api-client");
    forgetAccess();
    const raised: unknown[] = [];
    const stop = onAccessRefused((f) => raised.push(f));
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ error: { code: "subscription_required", details: { reason: "payment_required" } } }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
      await mailboxes.list().catch(() => undefined);
      expect(raised).toHaveLength(1);

      globalThis.fetch = (async () => new Response(
        JSON.stringify({ items: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
      await mailboxes.list();
      await mailboxes.list();
      // Still one. Success is silent, so the shell is never TOLD anything that could take the
      // wall down — which is why the rule holds without the shell doing anything to keep it.
      expect(raised).toHaveLength(1);
    } finally { stop(); }
  });

  it("the shell keeps the FIRST refusal, so two doors cannot argue about one account", async () => {
    /* The holder, in the form `CloudShell` and `DesktopGate` both write it. Driven rather than
       read as text: the property is "the second answer loses", and two refusals is the sequence
       that makes it decidable. */
    let held: { reason: string } | null = null;
    const hold = (facts: { reason: string }): void => { held = held ?? facts; };
    const { onAccessRefused, mailboxes, forgetAccess } = await import("../app/api-client");
    forgetAccess();
    const stop = onAccessRefused(hold as never);
    try {
      for (const reason of ["payment_required", "suspended"]) {
        globalThis.fetch = (async () => new Response(
          JSON.stringify({ error: { code: "subscription_required", details: { reason } } }),
          { status: 402, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
        await mailboxes.list().catch(() => undefined);
      }
      expect(held).not.toBeNull();
      expect((held as unknown as { reason: string }).reason).toBe("payment_required");
    } finally { stop(); }
  });
});

describe("the wall's box, not its sentences", () => {
  /**
   * `.gate-card p` sets colour, size, line-height and margin at specificity (0,1,1). A bare
   * `.wall-lead` is (0,1,0) and LOSES: the one full-ink sentence on the screen would render at
   * ink2 with the shared 20px margin, which is the same "the sentences were right and the box was
   * not" defect this file already has a case for, arriving through the cascade instead of through
   * Tailwind. So every `.wall-*` rule is written under `.gate-card`, and this reads the file.
   */
  it("every wall rule is written under `.gate-card`, so none of them loses to `.gate-card p`", () => {
    const css = readFileSync(`${process.cwd()}/apps/webapp/app/app.css`, "utf8");
    const selectors = [...css.matchAll(/^([^@{}\n][^{}\n]*)\{/gm)]
      .map((m) => m[1]!.trim())
      .filter((s) => s.includes(".wall-"));
    expect(selectors.length).toBeGreaterThanOrEqual(4);
    expect(selectors).toEqual(expect.arrayContaining([
      ".gate-card.wall-card",
      ".gate-card .wall-lead",
      ".gate-card .wall-erase",
      ".gate-card .wall-erase .set-pane",
    ]));
    for (const sel of selectors) {
      expect(sel.startsWith(".gate-card"), sel).toBe(true);
    }
    // A POSITIVE CONTROL for the reader itself: it does classify a bare rule as one.
    const bare = [...".wall-lead {\n  margin: 0;\n}\n".matchAll(/^([^@{}\n][^{}\n]*)\{/gm)]
      .map((m) => m[1]!.trim());
    expect(bare).toEqual([".wall-lead"]);
    expect(bare[0]!.startsWith(".gate-card")).toBe(false);
  });
});

describe("the copy is in both catalogues", () => {
  it("every key the wall reads, in en and de, with matching key sets", () => {
    type Group = Record<string, string>;
    const e = (en as unknown as { accessLock: Group }).accessLock;
    const d = (de as unknown as { accessLock: Group }).accessLock;
    const keys = [
      "title", "suspendedTitle", "kept", "manage", "signOut",
      "trialEnded", "canceled", "unpaid", "stopped", "mailboxUntouched",
      "erasure", "erasureHeld", "erasureUnknown", "subscribe", "moveOut", "moveOutHint",
      "moveOutGuide", "moveOutFailed", "deleteNow", "deleteHint", "deleteHintUndated", "back",
      "openAccount", "openInBrowser",
    ];
    for (const k of keys) {
      expect(e[k], `en.accessLock.${k}`).toBeTruthy();
      expect(d[k], `de.accessLock.${k}`).toBeTruthy();
    }
    expect(Object.keys(e).sort()).toEqual(Object.keys(d).sort());
    // The dated sentences take the placeholder the screen passes, in both languages.
    for (const k of ["trialEnded", "canceled", "unpaid", "erasure"]) {
      expect(e[k], `en.${k}`).toContain("{date}");
      expect(d[k], `de.${k}`).toContain("{date}");
    }
  });

  it("NEITHER CATALOGUE GREW A PRICE TOKEN — the census, over the whole file", () => {
    /* Not narrowed to the namespace: the rule is about the published catalogue, and a lane that
       adds a price anywhere in it has broken the same rule. The readings at this lane's base
      were en 16 / de 13 and they have not moved; the survivors are the marketing
       pricing page's, which is exempt by the plan §8 ruling. */
    const RE = /CHF|EUR|USD|€|\$[0-9]|\/month|\/Monat|pro Monat|per month|Plus|Pro /;
    const count = (o: unknown): number => JSON.stringify(o).split("\n").length && (() => {
      let n = 0;
      const walk = (v: unknown): void => {
        if (typeof v === "string") { if (RE.test(v)) n += 1; return; }
        if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
      };
      walk(o);
      return n;
    })();
    // The namespaces this lane added or touched carry none at all — the reading that is about
    // THIS lane, rather than about the file's pre-existing marketing copy.
    expect(count((en as unknown as { accessLock: unknown }).accessLock)).toBe(0);
    expect(count((de as unknown as { accessLock: unknown }).accessLock)).toBe(0);
    expect(count((en as unknown as { accountLifecycle: unknown }).accountLifecycle)).toBe(0);
    expect(count((de as unknown as { accountLifecycle: unknown }).accountLifecycle)).toBe(0);
    // A positive control: the regex DOES read a price where one lives, so a 0 above means the
    // strings are clean and not that the census matches nothing.
    expect(count({ a: "CHF 9 per month" })).toBe(1);
  });
});

/**
 * THE WALL SHOWS BEFORE ANY MAILBOX RENDERS AFTER SIGN-IN. The real Cloud entry, a fresh
 * browser (no stored verdict, an empty mirror), `/mailboxes` answering 402: every frame the
 * container ever held is recorded, and none of them may be the empty Ohbox. The ordinary account
 * (a stored `open`) keeps frame one local — the control that the gate costs it nothing.
 */
describe("the first paint after sign-in waits for the verdict", async () => {
  const shell = await import("./fixtures/cloud-confirm-shell");
  /* A return from paying comes after the access door's join window: a fresh read inside it is the
     answer already in hand (focus and visibility fire together), so each case below waits it out. */
  const { RETURN_DEBOUNCE_MS } = await import("@ohmail/app-logic/doors/wall-lift");
  const { vi } = await import("vitest");
  const OWNER = shell.ACCOUNT;
  const CLOSED = {
    metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, aiEnabled: false,
    lifecycle: {
      state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
      closedAt: "2026-08-25T00:00:00.000Z", erasureAt: "2026-10-23T00:00:00.000Z",
      erasedAt: null, formerlyPaid: false,
    },
    manageUrl: "https://plane.ohmail.app/manage?token=t", exportPath: "/account/export",
  };
  const OPEN = { metered: true, access: "open", canAddMailbox: true, mailboxes: 5, aiEnabled: true };
  const refused402 = (): Response => new Response(JSON.stringify({
    error: { code: "subscription_required", message: "not active", details: { reason: "payment_required", lifecycle: CLOSED.lifecycle, exportPath: "/account/export" } },
  }), { status: 402, headers: { "content-type": "application/json" } });
  const jsonOf = (b: unknown): Response =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

  let access: () => Promise<Response> | Response = () => jsonOf(CLOSED);
  /** Whether the product doors refuse — true for the closed account, false for the control. */
  let walled = true;
  let asked: string[] = [];
  let frames: string[] = [];
  /** Did the opening frame show while the verdict was being asked? */
  let sawOpening = false;
  /** Did the mail shell mount at any moment before the wall stood? */
  let sawShellBeforeWall = false;
  let observer: MutationObserver | null = null;

  beforeEach(async () => {
    // The client holds one access read per session; a case's unanswered read must not be the next one's.
    const client = await import("../app/api-client");
    client.forgetAccess();
    client.bindApiOwner(null);
    shell.installConfirmEnv();
    shell.scriptSession(() => shell.sessionFull());
    shell.rememberOwner(OWNER);
    localStorage.clear();
    sessionStorage.clear();
    asked = [];
    frames = [];
    sawOpening = false;
    sawShellBeforeWall = false;
    walled = true;
    access = () => jsonOf(CLOSED);
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      asked.push(new URL(url, "https://ohmail.app").pathname);
      if (url.includes("/auth/refresh")) return new Response(null, { status: 204 });
      if (url.includes("/account/access")) return access();
      if (walled && url.includes("/mailboxes")) return refused402();
      if (walled && url.includes("/sync")) return refused402();
      return base(input as RequestInfo, init);
    }) as unknown as typeof globalThis.fetch;
    observer = new MutationObserver(() => {
      const t = document.body.textContent ?? "";
      if (frames[frames.length - 1] !== t) frames.push(t);
      if (document.querySelector('main[data-kind="web"] [role="status"]')) sawOpening = true;
      if (!(document.body.textContent ?? "").includes(wallTitle) && document.querySelector(".fr-root")) sawShellBeforeWall = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  afterEach(async () => {
    observer?.disconnect();
    await shell.teardownConfirmEnv();
  });

  /* RE-POINTED TO THE NEW SHELL (RULING-NEW-SHELL-FIRST D (1)): the mail stands when the frame's root is drawn
     (`.fr-root`, `packages/app/src/frame/FrameRoot.tsx`, as sign-out-every-tab finds it), where today's shell drew
     `.today`. */
  const ohbox = [en.ohbox.emptyPlain, en.ohbox.emptyScreenerTitle, en.ohbox.emptyFiledTitle];
  const wallTitle = "Your trial ended on";
  /** The wall stands: its sentence names the closure. */
  const wallStands = (): boolean => [...document.body.querySelectorAll("main p")].some((p) => p.textContent?.startsWith(wallTitle));

  it("a closed account's first frame with anything in it is the wall, never an empty Ohbox", async () => {
    await shell.mountCloudShell();
    await shell.tick(2_000);
    const withText = frames.filter((f) => f.trim() !== "");
    expect(sawShellBeforeWall, "the mail shell mounted before the wall").toBe(false);
    expect(sawOpening, "the verdict was not asked before the first paint").toBe(true);
    expect(withText.length, "nothing was ever painted").toBeGreaterThan(0);
    expect(withText[0]).toContain(wallTitle);
    for (const f of frames) for (const s of ohbox) expect(f, "an empty Ohbox was painted").not.toContain(s);
    // The verdict was asked before any roster read.
    const first = asked.findIndex((p) => p.endsWith("/account/access"));
    const roster = asked.findIndex((p) => p.endsWith("/mailboxes"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(roster === -1 || first < roster, JSON.stringify(asked)).toBe(true);
    expect(localStorage.getItem(`ohmail.access.${OWNER}`)).toBe("closed");
  });

  it("a verdict that never comes paints the mirror after the bound (fail-open), and the 402 still walls", async () => {
    access = () => new Promise<Response>(() => {});
    await shell.mountCloudShell();
    await shell.tick(2_500);
    expect(document.body.querySelector(".fr-root"), "painted before the bound").toBeNull();
    await shell.tick(1_000);
    // Past the bound the shell mounted, met the roster's 402, and the wall came through the sink.
    await shell.tick(2_000);
    expect(document.body.textContent).toContain(wallTitle);
  });

  it("the server's frame holds a Reload for a page whose script never runs; hydrated, it passes", async () => {
    /* Seen once on Cloud: a signed-in page stayed on the server's empty frame for minutes (its
       script never ran, on a network that kept changing). The frame now says so and offers a
       Reload, which needs no script; the stylesheet holds it back for the first seconds. */
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const { CloudShell } = await import("../app/(product)/mailbox/CloudShell");
    const { ToastHost } = await import("@ohmail/ui");
    localStorage.setItem(`ohmail.access.${OWNER}`, "open");
    walled = false;
    const tree = () => React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", now: new Date(shell.ISO),
      children: React.createElement(ThemeProvider, { storageKey: null,
        children: React.createElement(ToastHost, { children: React.createElement(CloudShell, { demo: false }) }) }),
    });
    const host = document.createElement("div");
    host.innerHTML = renderToString(tree());
    document.body.appendChild(host);
    const late = host.querySelector('[data-kind="web"] [data-late]');
    expect(late?.textContent, "the server's frame is empty").toContain(en.session.opening);
    expect(late?.querySelector("a")?.getAttribute("href")).toBe("/");
    expect(late?.querySelector("a")?.textContent).toBe(en.appError.reload);
    const recoverable: unknown[] = [];
    let root: Root | null = null;
    await shell.act(async () => {
      root = hydrateRoot(host, tree(), { onRecoverableError: (e) => { recoverable.push(e); } });
    });
    await shell.tick(500);
    expect(recoverable, "the frame did not hydrate as the server drew it").toEqual([]);
    expect(host.querySelector('[data-kind="web"] [data-late]'), "the line outlived hydration").toBeNull();
    await shell.act(async () => { root!.unmount(); });
    host.remove();
  });

  it("CONTROL: a stored `open` paints the mirror at once and asks nothing before it", async () => {
    localStorage.setItem(`ohmail.access.${OWNER}`, "open");
    access = () => jsonOf(OPEN);
    walled = false;
    await shell.mountCloudShell();
    await shell.tick(500);
    expect(document.body.querySelector(".fr-root"), "the mailbox never opened").not.toBeNull();
    expect(sawOpening, "the ordinary account was shown the verdict's waiting card").toBe(false);
  });

  it("the lift: an open answer on the return mounts the mail, says what was caught up, and a stale 402 does not re-raise the wall", async () => {
    await shell.mountCloudShell();
    await shell.tick(1_000);
    expect(document.body.textContent).toContain(wallTitle);
    await shell.tick(RETURN_DEBOUNCE_MS);
    // Paid elsewhere: the service now answers open, with the one-time catch-up.
    access = () => jsonOf({ ...OPEN, caughtUp: { since: CLOSED.lifecycle.closedAt } });
    walled = false;
    await shell.act(async () => { window.dispatchEvent(new Event("focus")); });
    await shell.tick(1_000);
    expect(wallStands(), "the wall stood over an open verdict").toBe(false);
    expect(document.body.querySelector(".fr-root")).not.toBeNull();
    const { liftedAt } = await import("@ohmail/app-logic/session/access-window");
    expect(liftedAt(OWNER)).not.toBeNull();
    expect(document.body.textContent).not.toContain("Catching up since");
    expect(localStorage.getItem(`ohmail.access.${OWNER}`)).toBe("open");
    // Another API instance still holds the old refusal for up to a minute: its 402 is disbelieved.
    walled = true;
    await shell.tick(35_000);
    expect(wallStands(), "a stale 402 re-raised the wall").toBe(false);
  });

  it("THE REOPENING IS RECORDED: an open answer over a stored refusal, the return from paying (mail 0135)", async () => {
    const { liftedAt } = await import("@ohmail/app-logic/session/access-window");
    localStorage.setItem(`ohmail.access.${OWNER}`, "closed");
    access = () => jsonOf(OPEN);
    walled = false;
    await shell.mountCloudShell();
    await shell.tick(1_000);
    expect(document.body.querySelector(".fr-root")).not.toBeNull();
    expect(liftedAt(OWNER), "the first open answer after the wall was not read as the reopening").not.toBeNull();
  });

  it("THE LIFT RE-ANNOUNCES THIS BROWSER'S PUSH REGISTRATION, ONCE (mail 0135)", async () => {
    // A live subscription and no stored id: the closure's registration is gone from the server.
    document.cookie = "tf_family=returning-session; Path=/";
    localStorage.setItem(`ohmail.notifications.channels.${OWNER}`, JSON.stringify({
      master: true, ohbox: true, screener: true, scheduled: true, pairing: true, showSenderAndSubject: false,
    }));
    const sub = {
      endpoint: "https://push.example/ep/lift",
      getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(5).buffer,
      unsubscribe: () => Promise.resolve(true),
    };
    // A browser that can deliver notices with the page closed also shares the worker's lock.
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: async (_name: string, work: () => Promise<void>) => work() },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(sub) } }) },
    });
    const cached = new Map<string, Response>();
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { open: async () => ({
        match: async (url: string) => cached.get(url)?.clone(),
        put: async (url: string, value: Response) => { cached.set(url, value.clone()); },
      }) },
    });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "granted" } });
    const posts: number[] = [];
    const wire = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/push/vapid-key")) return jsonOf({ publicKey: "BFAKEa-b_c0123456789" });
      if (url.includes("/push/subscriptions") && init?.method === "POST") {
        posts.push(Date.now());
        return jsonOf({ id: "row-lift" });
      }
      return wire(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      await shell.mountCloudShell();
      await shell.tick(1_000);
      expect(document.body.textContent).toContain(wallTitle);
      expect(posts, "a walled account announced a registration").toHaveLength(0);
      await shell.tick(RETURN_DEBOUNCE_MS);
      access = () => jsonOf(OPEN);
      walled = false;
      await shell.act(async () => { window.dispatchEvent(new Event("focus")); });
      await shell.tick(3_000);
      expect(document.body.querySelector(".fr-root")).not.toBeNull();
      expect(posts, "the lift did not re-announce, or announced twice").toHaveLength(1);
    } finally {
      document.cookie = "tf_family=; Path=/; Max-Age=0";
      Reflect.deleteProperty(navigator, "locks");
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
      Reflect.deleteProperty(globalThis, "caches");
      delete (globalThis as Record<string, unknown>).Notification;
    }
  });

  it("CONTROL: an open answer over a stored `open` is no reopening", async () => {
    const { liftedAt } = await import("@ohmail/app-logic/session/access-window");
    localStorage.setItem(`ohmail.access.${OWNER}`, "open");
    access = () => jsonOf(OPEN);
    walled = false;
    await shell.mountCloudShell();
    await shell.tick(1_000);
    expect(liftedAt(OWNER)).toBeNull();
  });

  it("the wall's own lift is the reopening even when another tab already stored `open`", async () => {
    const { liftedAt } = await import("@ohmail/app-logic/session/access-window");
    await shell.mountCloudShell();
    await shell.tick(1_000);
    expect(document.body.textContent).toContain(wallTitle);
    await shell.tick(RETURN_DEBOUNCE_MS);
    // Paid in another tab, which read open first and stored it.
    localStorage.setItem(`ohmail.access.${OWNER}`, "open");
    access = () => jsonOf(OPEN);
    walled = false;
    await shell.act(async () => { window.dispatchEvent(new Event("focus")); });
    await shell.tick(1_000);
    expect(wallStands()).toBe(false);
    expect(liftedAt(OWNER), "this window's lift left no reopening").not.toBeNull();
  });

  it("an older API that names no verdict decides nothing: the mirror paints and nothing is stored", async () => {
    access = () => jsonOf({ metered: true, canAddMailbox: true, mailboxes: 5, aiEnabled: true });
    walled = false;
    await shell.mountCloudShell();
    await shell.tick(1_000);
    expect(document.body.querySelector(".fr-root")).not.toBeNull();
    expect(wallStands()).toBe(false);
    expect(localStorage.getItem(`ohmail.access.${OWNER}`)).toBeNull();
  });
});
