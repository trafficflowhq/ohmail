/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { canonicalHash, normalizedHash, parseHash } from "../app/shell/routing";

/**
 * STA-F9 — AN UNKNOWN HASH DOES NOT SIT IN THE ADDRESS BAR OVER A RENDERED OHBOX.
 *
 * `parseHash` has always answered `#/bogus` with the Ohbox — the right screen — but the URL
 * kept the bogus fragment: a link that reproduces nothing, a reload that silently "works",
 * and an address bar contradicting the deck under it. `useHashRoute` now rewrites the
 * fragment in place (`replaceState` — no history entry, no `hashchange` needed, because the
 * rendered route is already the fallback being spelled out).
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("normalizedHash — the rewrite decision, as a pure function", () => {
  it("an unknown view falls to the Ohbox and says so in the URL", () => {
    expect(normalizedHash("#/bogus")).toBe("#/ohbox");
    expect(normalizedHash("#/tag/")).toBe("#/ohbox"); // a tag link with no tag in it
  });

  it("every canonical hash is left alone", () => {
    for (const hash of [
      "#/ohbox", "#/reads", "#/receipts", "#/screener", "#/screener/screened",
      "#/screener/spam", "#/triage", "#/triage/aside", "#/triage/resurface",
      "#/history", "#/search", "#/compose", "#/drafts", "#/settings", "#/tag/pottery",
    ]) {
      expect(normalizedHash(hash), `${hash} must not be rewritten`).toBeNull();
    }
  });

  it("a recognisable view with an unknown tail is trimmed to the view", () => {
    expect(normalizedHash("#/screener/bogus")).toBe("#/screener");
    expect(normalizedHash("#/triage/bogus")).toBe("#/triage");
    // The first pile's long form collapses to the bare route `goTriage` itself writes.
    expect(normalizedHash("#/triage/reply")).toBe("#/triage");
  });

  it("the empty hash is NOT rewritten — a bare `/` is how every session begins", () => {
    expect(normalizedHash("")).toBeNull();
    expect(normalizedHash("#")).toBeNull();
  });

  it("canonicalHash is parseHash's inverse over every route it can produce", () => {
    for (const hash of ["#/ohbox", "#/screener/spam", "#/triage/aside", "#/tag/pottery"]) {
      expect(canonicalHash(parseHash(hash))).toBe(hash);
    }
  });
});

describe("the Mailboxes pane names a mailbox — the strip's link opens that mailbox's block", () => {
  it("`?mailbox=` round-trips on the mailboxes pane", () => {
    expect(parseHash("#/settings/mailboxes?mailbox=mbx-2").settingsMailboxId).toBe("mbx-2");
    expect(normalizedHash("#/settings/mailboxes?mailbox=mbx-2")).toBeNull();
    expect(parseHash("#/settings/mailboxes?mailbox=a%2Fb").settingsMailboxId).toBe("a/b");
    expect(canonicalHash(parseHash("#/settings/mailboxes?mailbox=a%2Fb"))).toBe("#/settings/mailboxes?mailbox=a%2Fb");
    expect(parseHash("#/settings/mailboxes").settingsMailboxId).toBeNull();
    expect(normalizedHash("#/settings/mailboxes?mailbox=")).toBe("#/settings/mailboxes");
  });

  it("is dropped on every other pane and view", () => {
    for (const [hash, to] of [
      ["#/settings/devices?mailbox=mbx-2", "#/settings/devices"],
      ["#/settings?mailbox=mbx-2", "#/settings"],
      ["#/ohbox?mailbox=mbx-2", "#/ohbox"],
    ] as const) {
      expect(parseHash(hash).settingsMailboxId, hash).toBeNull();
      expect(normalizedHash(hash), hash).toBe(to);
    }
  });
});

describe("the shell corrects the address bar", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
    (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
    const el = Element.prototype as unknown as Record<string, () => void>;
    el.scrollIntoView = () => {};
    el.scrollTo = () => {};
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return [];
      }
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(() => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "#");
    delete (globalThis as Record<string, unknown>).IntersectionObserver;
    delete (globalThis as Record<string, unknown>).CSS;
    vi.restoreAllMocks();
  });

  it("mounting over #/bogus renders the Ohbox AND rewrites the fragment", async () => {
    window.location.hash = "#/bogus";
    const { AppShell } = await import("../app/shell/AppShell.js");
    const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "UTC",
          now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(ThemeProvider, {
            children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
          }),
        }),
      );
    });

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && window.location.hash !== "#/ohbox") {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
    }
    expect(container.querySelector(".view-ohbox"), "the fallback view").not.toBeNull();
    expect(window.location.hash, "the URL must say what is on screen").toBe("#/ohbox");
  }, 20000);
});

/**
 * ═══ THE FIRST-RUN ROUTE, ONCE AN INSTALL CAN HOLD MORE THAN ONE MAILBOX ═══════════════════
 *
 * `#/first-run` and `#/first-run/again` used to be the whole vocabulary, and both of them named
 * the run without naming its subject — which was unambiguous while there was one mailbox to be
 * about. Two things were added and each closes a way of getting the wrong mailbox:
 *
 *  · `?mailbox=<id>` — WHICH mailbox this run is about. `AppShell` resolved it as `facts[0]`;
 *    over two rows the flow for the second one would have shown the first one's consent stamp,
 *    holder and address on every screen, and the consent press addresses an id.
 *  · `#/first-run/add` — an INTENT, exactly like `/again` and for the same reason: an install
 *    that has been through setup carries the completion stamp for ever, so the derivation
 *    answers "nothing to do" and only the route can say otherwise.
 */
describe("the first-run route names its intent and its mailbox", () => {
  it("parses the three spellings, and only the three", () => {
    expect(parseHash("#/first-run").firstRun).toBe(true);
    expect(parseHash("#/first-run").firstRunRerun).toBe(false);
    expect(parseHash("#/first-run").firstRunAdd).toBe(false);

    expect(parseHash("#/first-run/again").firstRunRerun).toBe(true);
    expect(parseHash("#/first-run/again").firstRunAdd).toBe(false);

    expect(parseHash("#/first-run/add").firstRunAdd).toBe(true);
    expect(parseHash("#/first-run/add").firstRunRerun).toBe(false);

    // Anything else under the segment is not a first-run route at all — it falls to the Ohbox,
    // the router's own rule for an unknown tail.
    expect(parseHash("#/first-run/bogus").firstRun).toBe(false);
  });

  it("reads the mailbox out of the query, on every first-run spelling", () => {
    expect(parseHash("#/first-run?mailbox=mbx-2").firstRunMailboxId).toBe("mbx-2");
    expect(parseHash("#/first-run/again?mailbox=mbx-2").firstRunMailboxId).toBe("mbx-2");
    expect(parseHash("#/first-run/add?mailbox=mbx-2").firstRunMailboxId).toBe("mbx-2");
    // …and the rest of the route is unchanged by the query being there.
    expect(parseHash("#/first-run/again?mailbox=mbx-2").firstRunRerun).toBe(true);
  });

  it("a hash that names no mailbox says `null`, and so does one that names an empty one", () => {
    // `null` and not `""`: the hash either names a mailbox or it does not, and a third state
    // would be one both readers had to know about.
    expect(parseHash("#/first-run").firstRunMailboxId).toBeNull();
    expect(parseHash("#/first-run?mailbox=").firstRunMailboxId).toBeNull();
    expect(parseHash("#/first-run?mailbox=%20%20").firstRunMailboxId).toBeNull();
  });

  it("no other route reads the query, and none carries the two new fields set", () => {
    for (const hash of ["#/ohbox", "#/settings/devices", "#/screener/spam", "#/tag/pottery"]) {
      const route = parseHash(`${hash}?mailbox=mbx-2`);
      expect(route.firstRunMailboxId, hash).toBeNull();
      expect(route.firstRunAdd, hash).toBe(false);
    }
    // The query comes off ahead of the open-message tail, so the one route that can carry both
    // still reads its message id.
    expect(parseHash("#/ohbox/m/msg-1?mailbox=mbx-2").messageId).toBe("msg-1");
  });

  it("the named mailbox is part of the CANONICAL form, so the bar is not rewritten past it", () => {
    /* Without this `normalizedHash` would rewrite `#/first-run?mailbox=<id>` to the bare hash on
       the first render — dropping, from the address bar, the one fact that says which mailbox the
       flow in front of somebody is about, and re-pointing the run at the first row. */
    for (const hash of [
      "#/first-run", "#/first-run/again", "#/first-run/add",
      "#/first-run?mailbox=mbx-2", "#/first-run/again?mailbox=mbx-2",
      "#/first-run/add?mailbox=mbx-2",
    ]) {
      expect(normalizedHash(hash), `${hash} must not be rewritten`).toBeNull();
      expect(canonicalHash(parseHash(hash)), hash).toBe(hash);
    }
  });
});
