/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import messages from "../messages/en.json";

/**
 * THE LOCK SCREEN — what a refused account sees, and the two doors it must leave open.
 *
 * `apps/webapp` typechecks its tests, so the props below are checked as well as the values.
 */

// React as a global and API_BASE before the module under test imports `api-client` — see
// `auto-suggest-toggle.test.tsx` for why.
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

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => {
    // `children` in the props object, not as a third argument: the provider's overload requires
    // it in the type, and `apps/webapp` typechecks its tests.
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, children: h(ThemeProvider, { children: node }),
    }));
  });
}

const text = (): string => host.textContent ?? "";
const links = (): HTMLAnchorElement[] => [...host.querySelectorAll("a")];
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];

describe("the lock screen says what is true", () => {
  it("names the state and promises nothing is gone", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: { reason: "payment_required" } }));

    expect(text()).toContain("This account is not active.");
    // The half a refusal screen gets wrong: it must not read as data loss.
    expect(text()).toContain("kept");
    expect(text()).toContain("Nothing has been deleted");
  });

  it("a suspension gets its own sentence, not the payment one", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: { reason: "suspended" } }));
    expect(text()).toContain("This account is suspended.");
    expect(text()).not.toContain("This account is not active.");
    // Still says the mail is kept — a suspension is not a deletion either.
    expect(text()).toContain("Nothing has been deleted");
  });
});

describe("the doors", () => {
  it("SIGN OUT is always reachable — this may be a shared machine", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    for (const facts of [
      { reason: "payment_required" as const },
      { reason: "suspended" as const },
      { reason: "payment_required" as const, manageUrl: "https://manage.example/t" },
    ]) {
      await mount(h(AccessLock, { facts }));
      const signOut = buttons().filter((b) => b.textContent === "Sign out");
      expect(signOut, JSON.stringify(facts)).toHaveLength(1);
      expect(signOut[0]!.disabled).toBe(false);
    }
  });

  it("the way back renders ONLY where the service operates a page, and it is a BUTTON", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");

    await mount(h(AccessLock, { facts: { reason: "payment_required" } }));
    // A button that goes nowhere is the one control a person on this screen will press.
    expect(text()).not.toContain("Manage subscription");

    await mount(h(AccessLock, {
      facts: { reason: "payment_required", manageUrl: "https://manage.example/t" },
    }));
    const manage = buttons().filter((b) => b.textContent === "Manage subscription");
    expect(manage).toHaveLength(1);
    // The address the 402 carried is never rendered: it is ten minutes old and good once.
    expect(host.innerHTML).not.toContain("manage.example");
  });

  /**
   * THE HARD STOP MOVED WITH THE OWNER'S RULING, AND IS NARROWED RATHER THAN DROPPED.
   *
   * This case used to read "the only button is Sign out", which was true of a lock that offered
   * no way out and false of the wall, where "Delete my account now" is one of the three actions
   * the product put on the screen (the lifecycle proposal, 2026-09-20). What the case was DEFENDING
   * is unchanged and is what it asserts now: no control on this screen destroys anything WHEN
   * PRESSED. The erasure control reveals Settings → Account's own ceremony — a typed confirmation,
   * a password and a second factor — and issues no write of its own; pressing it must leave every
   * request this screen has made a read.
   */
  it("no control on the wall destroys anything when it is pressed", async () => {
    const seen: Array<{ method: string; url: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        method: (init?.method ?? "GET").toUpperCase(),
        url: typeof input === "string" ? input : String(input),
      });
      // Answered rather than left pending: a hanging promise would make the assertions below
      // pass for a screen that had simply not got round to its write yet.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
      await mount(h(AccessLock, {
        facts: { reason: "suspended", manageUrl: "https://m.example/x" },
      }));
      // Before the press: no form, and nothing that takes a password.
      expect(host.querySelectorAll("form")).toHaveLength(0);
      expect(host.querySelectorAll("input[type=password]")).toHaveLength(0);

      const erase = buttons().find((b) => /delete my account now/i.test(b.textContent ?? ""));
      expect(erase, "the account holder's third action is on the wall").toBeDefined();
      await act(async () => { erase!.click(); });

      // The ceremony is what appeared — the pane, not a deletion.
      expect(text()).toMatch(/delete|erase/i);
      expect(seen.length, JSON.stringify(seen)).toBeGreaterThan(0);
      for (const call of seen) {
        expect(call.method, `${call.method} ${call.url}`).toBe("GET");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the sign-out and the manage link are the only two doors before the ceremony", async () => {
    /* The half of the old case that is still exactly true: whatever else the wall grows, the way
       out of this browser and the way back to paying are both on it, and neither is behind the
       other. */
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: { reason: "suspended", manageUrl: "https://m.example/x" } }));
    expect(links()).toEqual([]);
    expect(buttons().map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Manage subscription", "Sign out"]),
    );
  });
});

/**
 * THE WAY BACK IS MINTED AT THE PRESS. The 402's `manageUrl` is a token good for ten minutes
 * and one use; a wall left open longer carried a dead link. The press asks `POST
 * /account/manage-link` with the screen's language and leaves for THAT answer, and nothing else.
 */
describe("the primary mints its link at the press", () => {
  const OLD = "https://plane.ohmail.app/manage?token=OLD";
  const FRESH = "https://plane.ohmail.app/manage?token=FRESH";
  const CLOSED = {
    reason: "payment_required" as const,
    manageUrl: OLD,
    lifecycle: {
      state: "closed" as const, closedReason: "trial_ended" as const,
      closedAt: "2026-08-25T00:00:00.000Z", erasureAt: "2026-10-23T00:00:00.000Z",
    },
  };
  let wire: Array<{ method: string; url: string; body: string | null }> = [];
  let left: string[] = [];
  let mint: () => Promise<Response> = async () => jsonRes({ url: FRESH }, 200);
  const realFetch = globalThis.fetch;
  const realClick = HTMLAnchorElement.prototype.click;
  const jsonRes = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    wire = [];
    left = [];
    mint = async () => jsonRes({ url: FRESH }, 200);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      wire.push({ method: (init?.method ?? "GET").toUpperCase(), url, body: typeof init?.body === "string" ? init.body : null });
      if (url.endsWith("/account/manage-link")) return mint();
      return jsonRes({}, 200);
    }) as typeof fetch;
    // `leaveForManagePage` leaves by clicking a detached anchor; the click is the navigation.
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { left.push(this.href); };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    HTMLAnchorElement.prototype.click = realClick;
  });

  const primary = (): HTMLButtonElement => buttons().find((b) => b.textContent === "Subscribe")!;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  };

  it("asks the mint once, with the screen's language, and leaves for its answer — never the 402's", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: CLOSED }));
    await act(async () => { primary().click(); });
    await settle();
    const mints = wire.filter((c) => c.url.endsWith("/account/manage-link"));
    expect(mints).toEqual([{ method: "POST", url: "/api/account/manage-link", body: JSON.stringify({ lang: "en" }) }]);
    expect(left).toEqual([FRESH]);
    expect(JSON.stringify(wire)).not.toContain("OLD");
  });

  it("wears the working band while the mint is in flight, and a second press asks nothing more", async () => {
    let answer: (r: Response) => void = () => {};
    mint = () => new Promise<Response>((resolve) => { answer = resolve; });
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: CLOSED }));
    await act(async () => { primary().click(); });
    expect(primary().getAttribute("data-run")).toBe("working");
    await act(async () => { primary().click(); });
    expect(wire.filter((c) => c.url.endsWith("/account/manage-link"))).toHaveLength(1);
    // The label does not change: the band is the working state.
    expect(primary().textContent).toBe("Subscribe");
    await act(async () => { answer(jsonRes({ url: FRESH }, 200)); });
    await settle();
    expect(primary().getAttribute("data-run")).toBeNull();
  });

  it("a mint that fails says so under the button, and the button presses again", async () => {
    mint = async () => jsonRes({ error: { code: "internal", message: "x" } }, 503);
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: CLOSED }));
    await act(async () => { primary().click(); });
    await settle();
    expect(left).toEqual([]);
    const alert = host.querySelector("[role=alert]");
    expect(alert?.textContent).toBe(messages.accessLock.mintFailed);
    expect(primary().disabled).toBe(false);
    mint = async () => jsonRes({ url: FRESH }, 200);
    await act(async () => { primary().click(); });
    await settle();
    expect(left).toEqual([FRESH]);
    expect(host.querySelector("[role=alert]")).toBeNull();
  });

  it("an unconfirmed address is told by name, never as a mint that failed", async () => {
    mint = async () => jsonRes({ error: { code: "email_unverified", message: "Confirm your email address first." } }, 403);
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: CLOSED }));
    await act(async () => { primary().click(); });
    await settle();
    expect(host.querySelector("[role=alert]")?.textContent).toBe(messages.accessLock.mintUnverified);
    expect(text()).not.toContain(messages.accessLock.mintFailed);
  });

  it("the hint says what the press opens, under the button it belongs to", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: CLOSED }));
    const hint = primary().nextElementSibling;
    expect(hint?.textContent).toBe(messages.accessLock.subscribeHint);
    expect(messages.accessLock.subscribeHint).not.toMatch(/stripe/i);
  });
});

/**
 * THE WALL LIFTS ITSELF ON AN OPEN VERDICT, AND ONLY ON THAT. One fresh `GET /account/access`
 * on every return to the window, one a minute while shown, a bounded 2 s × 30 poll after a
 * hand-off press. Only `access: "open"` lifts: a door's 200, a refused answer and an older API's
 * silence all leave it standing. The session lapsing under the wall is renewed by the read.
 */
describe("the wall lifts on the service's fresh open word", () => {
  const CLOSED = {
    reason: "payment_required" as const,
    manageUrl: "https://plane.ohmail.app/manage?token=OLD",
    lifecycle: {
      state: "closed" as const, closedReason: "trial_ended" as const,
      closedAt: "2026-08-25T00:00:00.000Z", erasureAt: "2026-10-23T00:00:00.000Z",
    },
  };
  const jsonRes = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const REFUSED = { metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, aiEnabled: false };
  const OPEN = { metered: true, access: "open", canAddMailbox: true, mailboxes: 5, aiEnabled: true };
  let access: () => Response = () => jsonRes(REFUSED);
  let reads = 0;
  let refreshes = 0;
  let navigated: string[] = [];
  let lifted = 0;
  const realFetch = globalThis.fetch;
  const realClick = HTMLAnchorElement.prototype.click;
  const realLocation = window.location;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T08:00:00.000Z"));
    (await import("../app/api-client")).forgetAccess();
    sessionStorage.clear();
    access = () => jsonRes(REFUSED);
    reads = 0;
    refreshes = 0;
    navigated = [];
    lifted = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/account/access")) { reads += 1; return access(); }
      if (url.endsWith("/auth/refresh")) { refreshes += 1; return new Response(null, { status: 204 }); }
      if (url.endsWith("/account/manage-link")) return jsonRes({ url: "https://plane.ohmail.app/manage?token=NEW" });
      return jsonRes({ items: [] });
    }) as typeof fetch;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { navigated.push(this.href); };
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...realLocation, href: "https://ohmail.app/", search: "", hash: "", pathname: "/",
        assign: (u: string) => { navigated.push(`assign:${u}`); },
        replace: (u: string) => { navigated.push(`replace:${u}`); },
        reload: () => { navigated.push("reload"); },
      },
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    HTMLAnchorElement.prototype.click = realClick;
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    vi.useRealTimers();
  });

  async function wall(): Promise<void> {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    await mount(h(AccessLock, { facts: CLOSED, onLifted: () => { lifted += 1; } }));
  }
  async function pass(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 250) {
      await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(250, left)); });
    }
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  }
  const focus = async (): Promise<void> => {
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await pass(0);
  };

  it("another door's 200 lifts nothing", async () => {
    await wall();
    const { mailboxes } = await import("../app/api-client");
    await act(async () => { await mailboxes.list(); });
    await pass(1_000);
    expect(lifted).toBe(0);
  });

  it("a return to the window asks once, and an open answer lifts the wall", async () => {
    await wall();
    expect(reads, "the wall read at mount with no hand-off").toBe(0);
    access = () => jsonRes(OPEN);
    await focus();
    expect(reads).toBe(1);
    expect(lifted).toBe(1);
  });

  it("a refused answer and an older API's silence both leave the wall standing", async () => {
    await wall();
    await focus();
    access = () => jsonRes({ metered: true, canAddMailbox: true, mailboxes: 5, aiEnabled: true });
    await pass(2_000);
    await focus();
    expect(reads).toBe(2);
    expect(lifted).toBe(0);
  });

  it("while shown it asks once a minute, and nothing faster", async () => {
    await wall();
    await pass(59_000);
    expect(reads).toBe(0);
    await pass(1_500);
    expect(reads).toBe(1);
    access = () => jsonRes(OPEN);
    await pass(60_000);
    expect(lifted).toBe(1);
  });

  it("after a press, the return polls every 2 s — checking, then pending with one more — and stops at 30", async () => {
    await wall();
    const primary = buttons().find((b) => b.textContent === "Subscribe")!;
    await act(async () => { primary.click(); });
    await pass(0);
    expect(navigated).toEqual(["https://plane.ohmail.app/manage?token=NEW"]);
    await focus();
    expect(host.querySelector(".wall-check")?.textContent).toContain(messages.accessLock.checking);
    expect(buttons().map((b) => b.textContent)).toEqual(["Sign out"]);
    await pass(2_000 * 29 + 500);
    expect(reads).toBe(30);
    expect(text()).toContain(messages.accessLock.pending);
    const again = buttons().find((b) => b.textContent === messages.accessLock.checkAgain);
    expect(again).toBeDefined();
    expect(buttons().map((b) => b.textContent)).toContain("Subscribe");
    // The poll is spent: its 2 s cadence asks no 31st time…
    await pass(1_000);
    expect(reads).toBe(30);
    // …and the minute's read goes on, which is what "this continues on its own" rests on.
    await pass(1_000);
    expect(reads).toBe(31);
    // A press inside the access door's join window is answered by the read in hand; this one comes after it.
    const { RETURN_DEBOUNCE_MS } = await import("@ohmail/app-logic/doors/wall-lift");
    await pass(RETURN_DEBOUNCE_MS);
    expect(reads).toBe(31);
    access = () => jsonRes(OPEN);
    await act(async () => { again!.click(); });
    await pass(0);
    expect(reads).toBe(32);
    expect(lifted).toBe(1);
  });

  it("a hand-off pressed in this tab before a reload polls on the next mount", async () => {
    const { rememberHandoff } = await import("@ohmail/app-logic/doors/wall-lift");
    rememberHandoff(null);
    access = () => jsonRes(OPEN);
    await wall();
    await pass(0);
    expect(reads).toBe(1);
    expect(lifted).toBe(1);
  });

  it("a session that lapses under the wall is renewed by the read, and nobody is sent to /login", async () => {
    await wall();
    let expired = true;
    access = () => (expired
      ? jsonRes({ error: { code: "unauthorized", message: "expired" } }, 401)
      : jsonRes(REFUSED));
    const realAccess = access;
    access = () => { const r = realAccess(); if (refreshes > 0) expired = false; return r; };
    await pass(16 * 60_000);
    await focus();
    expect(refreshes).toBeGreaterThan(0);
    expect(navigated.filter((n) => n.includes("/login") || n.includes("resume"))).toEqual([]);
    expect(lifted).toBe(0);
  });
});

describe("both catalogues carry the copy", () => {
  /* A missing key renders the key itself, which reads as a broken screen on the one surface a
   * refused customer sees. Both languages, both title variants. */
  it("en and de have every key the screen reads", async () => {
    /* Narrowed to the ONE namespace this case is about. The whole catalogue is not
       `Record<string, Record<string, string>>` — `screener.empty` and `settings.folders` are
       nested a level deeper — so asserting that shape over the file is a type error, and the
       assertion never needed it. */
    type Group = Record<string, string>;
    const en = ((await import("../messages/en.json")).default as { accessLock: Group }).accessLock;
    const de = ((await import("../messages/de.json")).default as { accessLock: Group }).accessLock;
    const keys = ["title", "suspendedTitle", "kept", "manage", "signOut"];
    for (const k of keys) {
      expect(en[k], `en.accessLock.${k}`).toBeTruthy();
      expect(de[k], `de.accessLock.${k}`).toBeTruthy();
    }
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });
});

/**
 * ═══ THE BOX, NOT THE SENTENCES — no Tailwind in an app that ships none ═════════════════════
 *
 * This screen laid out in Tailwind utilities (`mx-auto flex min-h-screen max-w-xl …`) and the app
 * ships none, so every one resolved to nothing: the sentences above were right and the screen was
 * an unstyled column in the top-left corner. It stands in `.gate` / `.gate-card` / `.gate-actions`
 * now — `app.css`, the shell the resume splash, the engine's states and the desktop window's own
 * lock screen use. `btn primary` is NOT in the vocabulary below: it is this app's own class, worn
 * by fifteen files, and catching it would be the defect in reverse.
 */
/** The utility vocabulary, by SHAPE — the families the defect used and their neighbours. */
const UTILITY: readonly RegExp[] = [
  /^-?(?:m|mx|my|mt|mb|ml|mr|p|px|py|pt|pb|pl|pr|gap|gap-x|gap-y|space-x|space-y)-(?:auto|px|\d+(?:\.5)?)$/,
  /^(?:min-|max-)?(?:w|h)-(?:screen|full|auto|px|fit|min|max|\d+(?:\/\d+)?|xs|sm|md|lg|xl|[2-9]xl)$/,
  /^(?:flex|items|justify|content|self|place)-(?:row|col|wrap|nowrap|reverse|start|end|center|between|around|evenly|stretch|baseline|auto)$/,
  /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/,
  /^font-(?:thin|light|normal|medium|semibold|bold|extrabold|black)$/,
  /^leading-(?:none|tight|snug|normal|relaxed|loose|\d+)$/,
  /^(?:opacity|z|order|basis|grow|shrink)-\d+$/,
  /^(?:flex|grid|block|hidden|relative|absolute|border|rounded|shadow)$/,
];
const isUtility = (token: string): boolean => UTILITY.some((re) => re.test(token));

describe("the lock screen is laid out like the rest of the app", () => {
  it("catches every class this screen used to carry — the control that stops a blind census", () => {
    /* WITHOUT THIS THE CASE BELOW PASSES FOR A VOCABULARY THAT MATCHES NOTHING. These are the
       four `className` strings the screen shipped with, token for token. */
    const shipped = [
      "mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-16",
      "text-2xl font-semibold",
      "text-base leading-relaxed opacity-80",
      "flex flex-wrap items-center gap-3",
    ].flatMap((v) => v.split(" "));
    expect(shipped).toHaveLength(18);
    for (const token of shipped) expect(isUtility(token), token).toBe(true);
    /* …and the app's OWN vocabulary is left alone, `btn primary` first among them. */
    for (const token of ["btn", "primary", "gate", "gate-card", "gate-actions", "wordmark",
                         "sub", "join-actions", "l-btn-lg", "rail", "deck", "msg"]) {
      expect(isUtility(token), token).toBe(false);
    }
  });

  it("renders NO utility class, on either reason and with or without the manage link", async () => {
    const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
    for (const facts of [
      { reason: "payment_required" as const },
      { reason: "suspended" as const },
      { reason: "suspended" as const, manageUrl: "https://m.example/x" },
    ]) {
      await mount(h(AccessLock, { facts }));
      const worn = [...host.querySelectorAll<HTMLElement>("*")]
        .flatMap((el) => [...el.classList]);
      expect(worn.length, "the screen wears no classes at all").toBeGreaterThan(0);
      for (const token of worn) expect(isUtility(token), `${token} · ${facts.reason}`).toBe(false);
      /* And it is the app's own shell it stands in, not merely "not Tailwind". */
      expect(worn).toContain("gate");
      expect(worn).toContain("gate-card");
      expect(worn).toContain("gate-actions");
    }
  });

  it("and no other component under app/ carries one either — the census, by scanned root", () => {
    /* apps/webapp/app is the SCANNED root, so this case is what selection reaches when that tree
       moves. It reads `className="…"` literals; a computed class is out of its reach and named
       here rather than implied. */
    const root = `${process.cwd()}/apps/webapp/app`;
    const files: string[] = [];
    (function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(p); }
        else if (p.endsWith(".tsx") || p.endsWith(".ts")) files.push(p);
      }
    })(root);
    expect(files.length, "the walk found no files").toBeGreaterThan(200);
    const carriers = new Map<string, string[]>();
    for (const file of files) {
      const found = [...readFileSync(file, "utf8")
        .matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)]
        .flatMap((m) => (m[1] ?? m[2] ?? m[3] ?? "").split(/[\s${}?:()|&]+/))
        .filter((token) => /^[a-z0-9:-]+$/i.test(token) && isUtility(token));
      if (found.length > 0) carriers.set(file.slice(root.length + 1), [...new Set(found)]);
    }
    expect([...carriers.entries()].map(([f, t]) => `${f}: ${t.join(" ")}`)).toEqual([]);
  });
});
