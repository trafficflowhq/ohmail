/** @vitest-environment jsdom */
import { setFormatWords } from "@ohmail/app-logic/text";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * THE ONE SUBSCRIPTION ROW — present only where there is somewhere to send the customer, and the
 * address minted only when somebody asks to go there.
 *
 * The open app holds no plan, no price and no credit balance. It asks whether this deployment
 * operates a subscription page for this account (`GET /account/access`, which mints nothing) and
 * renders one control, or renders nothing: a row whose control goes nowhere is the one control a
 * person on a settings pane will press.
 *
 * The MINT used to ride the mount, and the pane was offered only once a link had come back — so
 * every shell mount and every settings visit minted an address nobody had asked for. The zero
 * below is that defect's guard.
 *
 * The harness is the shell's own expression (`manageOffered ? <SubscriptionSection
 * onNowhere={withdrawManage} /> : undefined`), which `settings-section-parity.test.tsx` pins
 * against `CloudShell.tsx` as text — together they say what a mounted shell does without mounting
 * one.
 *
 * `apps/webapp` typechecks its tests, so the props below are checked as well as the values.
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

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

/* EACH CASE IS ITS OWN SESSION. `GET /account/access` is read once per session and held
   (`api-client.ts`), so without this every case after the first would be asserting the first
   one's stubbed door. Imported HERE and not at the top: this file sets `NEXT_PUBLIC_API_BASE`
   below its imports, and a static one would snapshot the client with no server behind it. */
beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
  setFormatWords(null);
});

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => {
    // `children` in the props object, not as a third argument: the provider's overload requires
    // it in the type, and the positional form typechecks nowhere in this suite.
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, children: h(ThemeProvider, { children: node }),
    }));
  });
  setFormatWords({ locale: () => "en", zone: () => DISPLAY_ZONE, translatorOf: () => null });
}

const text = (): string => host.textContent ?? "";
const links = (): HTMLAnchorElement[] => [...host.querySelectorAll("a")];
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];

const MANAGE = "https://account.example/manage?t=abc";
const DISPLAY_ZONE = "Europe/Zurich";
const PORTAL_URL = `${MANAGE}&timeZone=${encodeURIComponent(DISPLAY_ZONE)}`;
const REFUSAL = messages.settings.subscriptionManageFailed;

/** One door's answers, and the record of what was asked of it. */
interface Door {
  /** `GET /account/access`. */
  access?: { status: number; body?: unknown };
  /** `POST /account/manage-link`. */
  mint?: { status: number; body?: unknown };
  /** Every path asked for, in order. */
  asked: string[];
}

function stubDoor(door: Omit<Door, "asked">): Door {
  const state: Door = { ...door, asked: [] };
  const answer = (reply: { status: number; body?: unknown } | undefined): Response =>
    new Response(
      reply?.body === undefined ? null : JSON.stringify(reply.body),
      { status: reply?.status ?? 500, headers: { "content-type": "application/json" } },
    );
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    state.asked.push(url);
    if (url.includes("/account/manage-link")) return answer(state.mint);
    if (url.includes("/account/access")) return answer(state.access);
    return answer({ status: 200, body: {} });
  }));
  return state;
}

const mints = (door: Door): number =>
  door.asked.filter((u) => u.includes("/account/manage-link")).length;

/**
 * The shell's own wiring, and nothing else — see the header. `demo` rides in because it is the one
 * argument the hook takes.
 */
async function shell(demo = false): Promise<() => React.ReactNode> {
  const { SubscriptionSection, useManageOffer } =
    await import("../app/(product)/mailbox/SubscriptionSection");
  return function Shell(): React.ReactNode {
    const { manageOffered, withdrawManage } = useManageOffer(demo);
    return manageOffered ? h(SubscriptionSection, { onNowhere: withdrawManage }) : null;
  };
}

/** Press Manage and let the answer settle. */
async function pressManage(): Promise<void> {
  const [b] = buttons();
  expect(b, "there is no Manage control to press").toBeDefined();
  await act(async () => { b!.click(); });
}

/**
 * What a press would navigate to. The pane leaves through a real anchor click, so the address and
 * the `rel` it carries are read the way a browser would read them — cancelled here, because jsdom
 * implements no navigation and a real one would take the suite's document with it.
 */
function watchNavigation(): { to: string | null; rel: string | null; target: string | null; off: () => void } {
  const seen = { to: null as string | null, rel: null as string | null, target: null as string | null, off: () => {} };
  const onClick = (ev: Event): void => {
    const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    ev.preventDefault();
    seen.to = a.getAttribute("href");
    seen.rel = a.getAttribute("rel");
    seen.target = a.getAttribute("target");
  };
  document.addEventListener("click", onClick, true);
  seen.off = () => document.removeEventListener("click", onClick, true);
  return seen;
}

describe("the row itself", () => {
  const offered = { access: { status: 200, body: { metered: true } } };

  it("names the subject once and offers one control, which is a button", async () => {
    stubDoor(offered);
    await mount(h(await shell()));

    expect(text()).toContain(messages.settings.paymentInvoices);
    const [b] = buttons();
    expect(b, "the row rendered no control").toBeDefined();
    expect(b!.textContent).toBe("Manage");
    // NO ANCHOR BEFORE THE PRESS. There is no address yet, and an anchor with nowhere to point is
    // the control this pane exists to avoid.
    expect(links()).toHaveLength(0);
    expect(buttons()).toHaveLength(1);
    expect(host.querySelectorAll("form")).toHaveLength(0);
    expect(host.querySelectorAll("input")).toHaveLength(0);
  });

  it("says nothing about a plan, a price, a credit or a renewal", async () => {
    // The pane this replaces rendered all four. The row's whole content is asserted, not
    // sampled: a sentence added here is a claim about money the open app cannot make.
    stubDoor(offered);
    await mount(h(await shell()));
    expect(text()).not.toMatch(/credit|plan|solo|plus|renew|€|\$|trial/i);
  });
});

describe("the offer — read without minting anything", () => {
  it("NOTHING IS MINTED BY THE MOUNT, and the pane is offered from the access answer", async () => {
    const door = stubDoor({ access: { status: 200, body: { metered: true } } });
    await mount(h(await shell()));

    // THE ZERO. A mount that mints is a link nobody asked for, on every shell mount and every
    // settings visit — which is what this file's subject was measured doing in production.
    expect(mints(door), `minted at mount: ${JSON.stringify(door.asked)}`).toBe(0);
    expect(door.asked.some((u) => u.includes("/account/access"))).toBe(true);
    expect(buttons(), "the pane was not offered on a metered account").toHaveLength(1);
  });

  it("an unmetered deployment gets no pane — no program, nowhere to go", async () => {
    const door = stubDoor({ access: { status: 200, body: { metered: false } } });
    await mount(h(await shell()));
    expect(buttons(), "a self-hosted install grew a Subscription entry").toHaveLength(0);
    expect(mints(door)).toBe(0);
  });

  it("a refused or dead read is not evidence a page exists", async () => {
    for (const status of [401, 402, 403, 500, 503]) {
      const door = stubDoor({ access: { status, body: { error: { code: "refused" } } } });
      await mount(h(await shell()));
      expect(buttons(), `status ${status}`).toHaveLength(0);
      expect(mints(door), `status ${status}`).toBe(0);
      await act(async () => { root.unmount(); });
      root = createRoot(host);
    }
  });

  it("THE DEMO ASKS NOTHING — the landing page's mailbox reaches no server", async () => {
    const door = stubDoor({ access: { status: 200, body: { metered: true } } });
    await mount(h(await shell(true)));
    expect(buttons()).toHaveLength(0);
    expect(door.asked, JSON.stringify(door.asked)).toHaveLength(0);
  });
});

describe("the press — one mint, and an answer for every way it can end", () => {
  it("mints once and leaves for the given account page with the display zone", async () => {
    const door = stubDoor({
      access: { status: 200, body: { metered: true } },
      mint: { status: 200, body: { url: MANAGE } },
    });
    await mount(h(await shell()));
    const nav = watchNavigation();
    try {
      await pressManage();
      expect(mints(door), `mints: ${JSON.stringify(door.asked)}`).toBe(1);
      expect(nav.to, "the press went nowhere").toBe(PORTAL_URL);
      // `noreferrer`: the address is minted for this account, and the referrer would otherwise
      // carry this app's own URL to whoever serves that page.
      expect(nav.rel).toContain("noreferrer");
      // SAME TAB. A new tab after an awaited mint is what a popup blocker eats, silently.
      expect(nav.target).toBeNull();
    } finally {
      nav.off();
    }
  });

  it("a refused mint says so on the pane, and the pane stays pressable", async () => {
    const door = stubDoor({
      access: { status: 200, body: { metered: true } },
      mint: { status: 403, body: { error: { code: "email_unverified" } } },
    });
    await mount(h(await shell()));
    await pressManage();

    expect(text(), "a refused press said nothing at all").toContain(REFUSAL);
    expect(buttons(), "the control disappeared on a refusal").toHaveLength(1);
    expect(buttons()[0]!.disabled, "the control was left disabled after the answer").toBe(false);

    // A second press is a second ask — a refusal is about this attempt, not about the account.
    door.mint = { status: 200, body: { url: MANAGE } };
    const nav = watchNavigation();
    try {
      await pressManage();
      expect(mints(door)).toBe(2);
      expect(nav.to).toBe(PORTAL_URL);
      expect(text(), "the sentence outlived the attempt it was about").not.toContain(REFUSAL);
    } finally {
      nav.off();
    }
  });

  it("a 404 at the press takes the pane away — there is no page to send anyone to", async () => {
    const door = stubDoor({
      access: { status: 200, body: { metered: true } },
      mint: { status: 404, body: { error: { code: "no_manage_surface" } } },
    });
    await mount(h(await shell()));
    await pressManage();

    expect(mints(door)).toBe(1);
    expect(buttons(), "the pane stayed after the door said there is nowhere to go").toHaveLength(0);
    expect(text()).not.toContain("Subscription");
  });

  it("a 200 carrying no usable URL is not a URL", async () => {
    // Fails CLOSED on a shape it does not recognise: an empty string, a missing field and a
    // non-string all mean "we were not told", and a navigation built from any of them goes nowhere.
    for (const body of [{}, { url: "" }, { url: 7 }, { url: null }]) {
      stubDoor({ access: { status: 200, body: { metered: true } }, mint: { status: 200, body } });
      await mount(h(await shell()));
      const nav = watchNavigation();
      try {
        await pressManage();
        expect(nav.to, JSON.stringify(body)).toBeNull();
        expect(buttons(), JSON.stringify(body)).toHaveLength(0);
      } finally {
        nav.off();
      }
      await act(async () => { root.unmount(); });
      root = createRoot(host);
    }
  });
});

/* THE OFFER FOLLOWS THE ACCOUNT'S ANSWERS, not one mount's read: a read that failed at mount is
   healed by the next answer this tab receives, and the account strip asks on every return to the
   tab. The shell's own wiring again, with the real strip beside it for the return. */
describe("the offer follows every access answer", () => {
  const OPEN = { status: 200, body: { metered: true, access: "open", canAddMailbox: true, mailboxes: 1 } };
  const DEAD = { status: 503, body: { error: { code: "unavailable" } } };
  const reads = (door: Door): number => door.asked.filter((u) => u.includes("/account/access")).length;
  const paneShown = (): boolean => buttons().some((b) => b.textContent === "Manage");

  async function shellWithStrip(): Promise<() => React.ReactNode> {
    const Shell = await shell();
    const { LifecycleBanner } = await import("../app/(product)/mailbox/LifecycleBanner");
    return function WithStrip(): React.ReactNode {
      return h("div", null, h(LifecycleBanner), h(Shell));
    };
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
  }

  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it("another reader's later answer brings the pane in after a failed first read", async () => {
    const door = stubDoor({ access: DEAD });
    await mount(h(await shell()));
    await settle();
    expect(paneShown(), "premise: a failed read offers nothing").toBe(false);
    door.access = OPEN;
    const { account } = await import("../app/api-client");
    await act(async () => { await account.access({ fresh: true }); });
    await settle();
    expect(paneShown(), "the answer in the feed did not reach the pane").toBe(true);
  });

  it("a return to the tab after a failed first read asks once, and the pane comes in", async () => {
    const door = stubDoor({ access: DEAD });
    await mount(h(await shellWithStrip()));
    await settle();
    expect(paneShown(), "premise").toBe(false);
    const before = reads(door);
    door.access = OPEN;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(reads(door) - before, "the strip's return asked the door once").toBe(1);
    expect(paneShown(), "the answer on the return did not reach the pane").toBe(true);
    expect(mints(door), "the offer minted nothing").toBe(0);
  });

  it("an unmetered answer after a failed first read keeps the pane out", async () => {
    const door = stubDoor({ access: DEAD });
    await mount(h(await shell()));
    await settle();
    door.access = { status: 200, body: { metered: false } };
    const { account } = await import("../app/api-client");
    await act(async () => { await account.access({ fresh: true }); });
    await settle();
    expect(paneShown()).toBe(false);
  });

  it("a later FAILED read never takes an offered pane away", async () => {
    const door = stubDoor({ access: OPEN });
    await mount(h(await shell()));
    await settle();
    expect(paneShown()).toBe(true);
    door.access = DEAD;
    const { account } = await import("../app/api-client");
    await act(async () => { await account.access({ fresh: true }).catch(() => undefined); });
    await settle();
    expect(paneShown(), "one transient took the pane").toBe(true);
  });
});
