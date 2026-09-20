/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * ═══ THE WINDOW'S LOCK, IN ITS TWO DISTRIBUTIONS ════════════════════════════════════════════
 *
 * The paired window renders its own lock (`DesktopAccessLock`) out of the shared `accessLock`
 * catalogue, so a date can never differ between this screen and the browser tab's. Two things
 * are asserted that nothing else can see:
 *
 *  1. THE DIRECT-DOWNLOAD FACE has one button, and it opens the service's own page in the
 *     browser. There is still no billing logic in this app — an anchor is the whole of it.
 *  2. THE STORE FACE has none. A copy distributed through an app store may not link out to a
 *     page where a subscription is bought (App Review 3.1.1), so the button goes and a sentence
 *     saying where to go instead takes its place. Every other sentence stays, and so does the
 *     sign-out: a lock with no way out is a trap, which is the thing this screen may never be.
 *
 * The distribution is a BUILD-TIME literal the bundler folds in, so each face is driven by
 * setting that literal and re-importing the module graph — never by a runtime switch, which is
 * the mechanism `src/distribution.ts` exists to refuse.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const LOCK = en.accessLock as unknown as Record<string, string>;
const LOCK_DE = de.accessLock as unknown as Record<string, string>;
const MANAGE_URL = "https://account.example/manage?t=abc";

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
  delete (globalThis as { __OHMAIL_DISTRIBUTION__?: string }).__OHMAIL_DISTRIBUTION__;
  vi.resetModules();
});

/** Build the window's lock for one distribution, and paint it with the given facts. */
async function paint(
  distribution: "direct" | "mas",
  facts: unknown,
  locale: "en" | "de" = "en",
): Promise<void> {
  // The literal the bundler would have folded in, set BEFORE the module graph is built: the
  // constant is read once at import, which is exactly the property under test.
  vi.resetModules();
  (globalThis as { __OHMAIL_DISTRIBUTION__?: string }).__OHMAIL_DISTRIBUTION__ = distribution;
  const { DesktopAccessLock } = await import("../src/DesktopAccessLock.js");
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale,
      messages: locale === "en" ? en : de,
      children: h(ThemeProvider, {
        children: h(DesktopAccessLock, { facts: facts as never, onSignedOut: () => {} }),
      }),
    }));
  });
}

const text = (): string => host.textContent ?? "";
const links = (): HTMLAnchorElement[] => [...host.querySelectorAll("a")];
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];

const CLOSED = {
  reason: "payment_required" as const,
  manageUrl: MANAGE_URL,
  lifecycle: {
    state: "closed" as const,
    closedReason: "canceled" as const,
    closedAt: "2026-08-24T09:00:00.000Z",
    erasureAt: "2026-11-22T09:00:00.000Z",
  },
};

describe("the distribution decides the button, and nothing else", () => {
  it("the flag defaults to the ordinary app where no bundler ran", async () => {
    const { DISTRIBUTION, linksOutToBilling } = await import("../src/distribution.js");
    expect(DISTRIBUTION).toBe("direct");
    expect(linksOutToBilling()).toBe(true);
    // An unknown word is the ordinary app too: a typo must not silently withhold a surface.
    expect(linksOutToBilling("nonsense" as never)).toBe(true);
    expect(linksOutToBilling("mas")).toBe(false);
  });

  it("DIRECT: one button, and it is the service's own page in the browser", async () => {
    await paint("direct", CLOSED);
    const out = links();
    expect(out).toHaveLength(1);
    expect(out[0]!.getAttribute("href")).toBe(MANAGE_URL);
    expect(out[0]!.textContent).toBe(LOCK.openAccount);
    // `_blank` with `noopener`: the window's interceptor hands it to the browser the person is
    // already signed in to, which is the whole of this app's billing behaviour.
    expect(out[0]!.getAttribute("target")).toBe("_blank");
    expect(out[0]!.getAttribute("rel")).toContain("noopener");
    expect(text()).not.toContain(LOCK.openInBrowser);
  });

  it("STORE: no link at all, and a sentence saying where to go instead", async () => {
    await paint("mas", CLOSED);
    expect(links()).toHaveLength(0);
    expect(text()).not.toContain(MANAGE_URL);
    expect(text()).toContain(LOCK.openInBrowser);
    // Every other sentence survives, and so does the one door that must never close.
    expect(text()).toContain(LOCK.mailboxUntouched);
    expect(buttons().map((b) => b.textContent)).toEqual([LOCK.signOut]);
  });

  it("STORE with no page to link to says nothing extra — there was never a button", async () => {
    await paint("mas", { ...CLOSED, manageUrl: undefined });
    expect(links()).toHaveLength(0);
    // The "open it in a browser" sentence replaces a BUTTON. With no page on offer there is
    // nothing to replace, and inventing an address here would be this app holding one.
    expect(text()).not.toContain(LOCK.openInBrowser);
    expect(text()).toContain(LOCK.mailboxUntouched);
  });

  it("THE STORE FACE'S OWN SENTENCE ASKS NOBODY TO SUBSCRIBE", () => {
    /* A store copy may not carry a call to action towards a purchase page (App Review 3.1.1),
       and "open the site to subscribe again" is one. The phone's deck already keeps this rule
       (its account-wall suite has the same arm); the desktop's store face reads THESE keys, so
       the shared catalogue keeps it too. The DIRECT face's button vocabulary is not bound. */
    const purchase = /\b(subscribe|subscription|abo|abos|abonnement\w*)\b/i;
    for (const [name, sentence] of [["en", LOCK.openInBrowser], ["de", LOCK_DE.openInBrowser]] as const) {
      expect(sentence, `the ${name} store sentence sends somebody to buy`).not.toMatch(purchase);
      expect(sentence, `the ${name} store sentence names no site`).toContain("ohmail.app");
    }
  });
});

describe("the window says what the browser tab says", () => {
  it("names the closure with its date, and when the rest goes", async () => {
    await paint("direct", CLOSED);
    expect(host.querySelector("h1")?.textContent).toMatch(/Your subscription ended on/);
    expect(text()).toContain("Aug");
    expect(text()).toMatch(/are erased on/);
    expect(text()).toContain("Nov");
  });

  it("a suspension has no erasure clock, and says who to ask", async () => {
    await paint("direct", {
      reason: "suspended" as const,
      manageUrl: MANAGE_URL,
      lifecycle: {
        state: "closed" as const, closedReason: "suspended" as const,
        closedAt: "2026-08-24T09:00:00.000Z", erasureAt: null,
      },
    });
    expect(host.querySelector("h1")?.textContent).toBe(LOCK.suspendedTitle);
    expect(text()).toContain(LOCK.erasureHeld);
    expect(text()).not.toMatch(/are erased on/);
  });

  it("ERASED shows no date — nobody can sign in to read one", async () => {
    await paint("direct", {
      reason: "payment_required" as const,
      manageUrl: MANAGE_URL,
      lifecycle: {
        state: "erased" as const, closedReason: "canceled" as const,
        closedAt: "2026-08-24T09:00:00.000Z", erasureAt: null,
      },
    });
    expect(host.querySelector("h1")?.textContent).toBe(LOCK.title);
    expect(text()).not.toMatch(/erased on/i);
  });

  it("AN OLDER SERVER STILL LOCKS, with the sentence this window has always shown", async () => {
    await paint("direct", { reason: "payment_required" as const, manageUrl: MANAGE_URL });
    expect(host.querySelector("h1")?.textContent).toBe(LOCK.title);
    expect(text()).toContain(LOCK.kept);
    // …and the old label, because there is no lifecycle to call it anything else.
    expect(links()[0]!.textContent).toBe(LOCK.manage);
  });

  it("is the catalogue's screen in German too — nothing here is written in English by hand", async () => {
    await paint("direct", CLOSED, "de");
    expect(text()).toContain(LOCK_DE.mailboxUntouched);
    expect(links()[0]!.textContent).toBe(LOCK_DE.openAccount);
    expect(text()).not.toContain("accessLock.");
  });
});

describe("the wire the window narrows", () => {
  it("drops a state it does not know rather than rendering one", async () => {
    const { lifecycleOf } = await import("../src/bridge-fetch.js");
    expect(lifecycleOf({ state: "hibernating" })).toBeUndefined();
    expect(lifecycleOf(undefined)).toBeUndefined();
    expect(lifecycleOf({ state: "closed", closedReason: "audited" })?.closedReason).toBeNull();
    expect(lifecycleOf({ state: "closed", closedAt: "2026-08-24T09:00:00.000Z" })?.closedAt)
      .toBe("2026-08-24T09:00:00.000Z");
  });

  it("says the same six states the browser client says — two copies, one list", async () => {
    /* The window cannot import the browser's client (this build aliases it away), so the type is
       mirrored. The two lists are compared here because a drift between them is a screen on one
       surface and a fallback on the other for the same account. */
    const desktop = await import("../src/bridge-fetch.js");
    const web = await import("../../webapp/app/api-client.js");
    for (const state of ["trialing", "grace", "past_due", "active", "closed", "erased"]) {
      expect(desktop.lifecycleOf({ state })?.state, state).toBe(state);
      expect(web.lifecycleOf({ state })?.state, state).toBe(state);
    }
    expect(desktop.lifecycleOf({ state: "paused" })).toBeUndefined();
    expect(web.lifecycleOf({ state: "paused" })).toBeUndefined();
  });
});
