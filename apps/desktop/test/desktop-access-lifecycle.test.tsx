/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * ═══ THE WINDOW'S LOCK, IN ITS TWO DISTRIBUTIONS ═══ out of the shared `accessLock` catalogue, so
 * a date never differs from the browser tab's. The DIRECT-DOWNLOAD face has one button, whose press
 * mints the service's page and hands it to the browser — no billing logic here, one route and one
 * anchor. The STORE face has none (App Review 3.1.1): a sentence says where to go instead, and every
 * other sentence and the sign-out stay. The distribution is a BUILD-TIME literal, so each face is
 * driven by setting it and re-importing the module graph, never by a runtime switch.
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
const primary = (): HTMLButtonElement | undefined => buttons().find((b) => b.classList.contains("primary"));

/** The window's bridge, answering the mint; every request it carried is recorded. */
type Carried = { method: string; url: string; body: string };
function fakeBridge(mint: () => { status: number; body: string }): Carried[] {
  const carried: Carried[] = [];
  const encode = (status: number, body: string): Uint8Array => {
    const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
    const payload = new TextEncoder().encode(body);
    const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
    new DataView(out.buffer).setUint32(0, meta.byteLength, false);
    out.set(meta, 4);
    out.set(payload, 4 + meta.byteLength);
    return out;
  };
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command: string, payload?: { method?: string; url?: string; body?: number[] }) => {
      if (command !== "engine_request") return null;
      carried.push({
        method: String(payload?.method), url: String(payload?.url),
        body: new TextDecoder().decode(new Uint8Array(payload?.body ?? [])),
      });
      const m = mint();
      return encode(m.status, m.body);
    },
  };
  return carried;
}

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

  it("DIRECT: one button, and its press mints the page and hands THAT to the browser", async () => {
    const FRESH = "https://plane.ohmail.app/manage?token=FRESH";
    const carried = fakeBridge(() => ({ status: 200, body: JSON.stringify({ url: FRESH }) }));
    const opened: Array<{ href: string; target: string; rel: string }> = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      opened.push({ href: this.href, target: this.target, rel: this.rel });
    };
    try {
      await paint("direct", CLOSED);
      expect(links()).toHaveLength(0);
      expect(host.innerHTML).not.toContain(MANAGE_URL);
      expect(primary()?.textContent).toBe(LOCK.openAccount);
      await act(async () => { primary()!.click(); });
      for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
      expect(carried).toEqual([{ method: "POST", url: "/account/manage-link", body: JSON.stringify({ lang: "en" }) }]);
      // `_blank` with `noopener`: the window's interceptor hands it to the browser the person is
      // already signed in to, which is the whole of this app's billing behaviour.
      expect(opened).toEqual([{ href: FRESH, target: "_blank", rel: "noopener noreferrer" }]);
      expect(text()).not.toContain(LOCK.openInBrowser);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it("DIRECT: a refused mint says so, and an unconfirmed address is told by name", async () => {
    let answer = { status: 503, body: JSON.stringify({ error: { code: "db_busy" } }) };
    fakeBridge(() => answer);
    try {
      await paint("direct", CLOSED);
      await act(async () => { primary()!.click(); });
      for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
      expect(host.querySelector("[role=alert]")?.textContent).toBe(LOCK.mintFailed);
      answer = { status: 403, body: JSON.stringify({ error: { code: "email_unverified" } }) };
      await act(async () => { primary()!.click(); });
      for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
      expect(host.querySelector("[role=alert]")?.textContent).toBe(LOCK.mintUnverified);
    } finally {
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
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
    expect(primary()?.textContent).toBe(LOCK.manage);
  });

  it("is the catalogue's screen in German too — nothing here is written in English by hand", async () => {
    await paint("direct", CLOSED, "de");
    expect(text()).toContain(LOCK_DE.mailboxUntouched);
    expect(primary()?.textContent).toBe(LOCK_DE.openAccount);
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

/**
 * THE WINDOW LIFTS ON THE ACCOUNT'S FRESH WORD, AND PAINTS NO MAIL BEFORE IT, on the Cloud door.
 * The lock reads `/account/access` through the bridge on window focus and comes down on
 * `access: "open"` alone; the first paint of a mailbox with no stored `open` waits for the read.
 */
describe("the window's lift and first paint", () => {
  const OPEN = { metered: true, access: "open", canAddMailbox: true, mailboxes: 5, aiEnabled: true };
  const REFUSED = { metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, aiEnabled: false };
  let accessBody: unknown = REFUSED;
  let accessReads = 0;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); });
  };
  beforeEach(() => {
    accessBody = REFUSED;
    accessReads = 0;
    localStorage.clear();
    sessionStorage.clear();
    const encode = (status: number, body: string): Uint8Array => {
      const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
      const payload = new TextEncoder().encode(body);
      const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
      new DataView(out.buffer).setUint32(0, meta.byteLength, false);
      out.set(meta, 4);
      out.set(payload, 4 + meta.byteLength);
      return out;
    };
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command: string, payload?: { url?: string }) => {
        if (command !== "engine_request") return null;
        if (payload?.url === "/account/access") { accessReads += 1; return encode(200, JSON.stringify(accessBody)); }
        return encode(200, "{}");
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.useRealTimers();
  });

  async function lock(onLifted: () => void): Promise<void> {
    vi.resetModules();
    (globalThis as { __OHMAIL_DISTRIBUTION__?: string }).__OHMAIL_DISTRIBUTION__ = "direct";
    const { DesktopAccessLock } = await import("../src/DesktopAccessLock.js");
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages: en,
        children: h(ThemeProvider, {
          children: h(DesktopAccessLock, { facts: CLOSED as never, onSignedOut: () => {}, onLifted }),
        }),
      }));
    });
  }

  it("a focus read answering open lifts the lock; refused and an older API's silence do not", async () => {
    // The return debounce reads the clock, so only `Date` is faked: past it by moving the clock,
    // never by sleeping 1.6 s; every timer the lock arms stays real.
    vi.useFakeTimers({ toFake: ["Date"] });
    let lifted = 0;
    await lock(() => { lifted += 1; });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(accessReads).toBe(1);
    expect(lifted).toBe(0);
    accessBody = { metered: true, canAddMailbox: true, mailboxes: 5 };
    vi.advanceTimersByTime(1_600);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(lifted).toBe(0);
    accessBody = OPEN;
    vi.advanceTimersByTime(1_600);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(accessReads).toBe(3);
    expect(lifted).toBe(1);
  });

  it("the first paint waits for a mailbox with no stored open, and a refused answer is the lock's facts", async () => {
    const { useDesktopFirstPaint } = await import("../src/desktop-first-paint.js");
    const seen: string[] = [];
    let refusedWith: unknown = null;
    function Probe({ k }: { k: string | null }): React.ReactElement {
      seen.push(useDesktopFirstPaint(k, (f) => { refusedWith = f; }));
      return h("i", null, "x");
    }
    await act(async () => { root.render(h(Probe, { k: "mbx_1" })); });
    expect(seen[0]).toBe("asking");
    await settle();
    expect(seen[seen.length - 1]).toBe("open");
    expect(refusedWith).toMatchObject({ reason: "payment_required" });
    // A stored `open` paints at once and asks nothing.
    localStorage.setItem("ohmail.access.mbx_2", "open");
    seen.length = 0;
    const before = accessReads;
    await act(async () => { root.render(h(Probe, { k: "mbx_2" })); });
    expect(seen[0]).toBe("open");
    expect(accessReads).toBe(before);
    // No hosted account behind the mailbox: nothing to ask.
    seen.length = 0;
    await act(async () => { root.render(h(Probe, { k: null })); });
    expect(seen[0]).toBe("open");
  });
});

/* THE LOCK SCREEN'S SIGN-OUT SAYS A REFUSAL (ACCESS-LOCK-REFUSED-SIGN-OUT-IS-SILENT, the window's
   half): the shell refusing gave the button back and changed nothing on the screen. The sentence
   is the window's own (`door-copy.ts`), with the shell's reason in it. Mutation watched red: the
   catch's sentence dropped. */
describe("a refused sign-out on the lock screen", () => {
  it("says so under the button, with the shell's reason, and the button presses again", async () => {
    fakeBridge(() => ({ status: 200, body: "{}" }));
    const internals = (globalThis as { __TAURI_INTERNALS__: { invoke: (c: string, p?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const inner = internals.invoke;
    internals.invoke = async (command, payload) => {
      if (command === "engine_logout") throw "the shell could not sign out";
      return inner(command, payload as never);
    };
    await paint("direct", CLOSED);
    const out = buttons().find((b) => b.textContent === LOCK.signOut)!;
    await act(async () => { out.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const { DOOR_COPY } = await import("../src/door-copy.js");
    const alerts = [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts, "the refused sign-out was silent").toEqual([
      DOOR_COPY.accessLockSignOutRefused("the shell could not sign out"),
    ]);
    expect(buttons().find((b) => b.textContent === LOCK.signOut)!.disabled).toBe(false);
  });
});
