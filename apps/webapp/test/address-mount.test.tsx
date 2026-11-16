/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * ═══ `#/address/<addr>` PUTS THE ADDRESS VIEW ON THE STAGE ═════════════════════════════════
 *
 * The route parsed, the view existed and the controls linked to it for a whole slice before
 * anything mounted it: `effectiveView` had no `address` case, so following an address landed on
 * an EMPTY stage under a URL that named a person. Nothing failed — the router was right, the
 * view's own render suite was green over a hand-mounted `AddressView`, and the address bar said
 * exactly what the reader had asked for. That is the shape this file exists to refuse, so the
 * assertions are about the SHELL and not about the view: that the stage carries `.view-address`,
 * that the header names the address the hash named, and that the URL is not rewritten out from
 * under it.
 *
 * ── ESCAPE, AND WHY IT HAS TWO ARMS ────────────────────────────────────────────────────────
 *
 * `goAddress` is a hash ASSIGNMENT, so following an address stacks a history entry and stepping
 * back returns to the list it was clicked in (`routing.ts` says so at the function). Escape is
 * that same gesture, which is why it is spelled as the step back rather than as a hard-coded
 * destination: a reader who followed an address out of Reads is returned to Reads.
 *
 * The exception is a tab whose FIRST entry is the address itself — a pasted link, or a reload on
 * this hash. There is nothing behind it, so stepping back would leave the product altogether on
 * a keystroke that means "close this". The Ohbox is the floor there. Both arms are driven below,
 * and they are told apart by where they land, not by reading the branch.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The fixtures' own correspondent — demo mode holds mail from this address. */
const JONAS = "jonas@lichtgrat.example";
const HASH = `#/address/${encodeURIComponent(JONAS)}`;

let roots: Root[] = [];
let container: HTMLDivElement | null = null;

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
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "#");
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** Mount the whole shell in demo mode over whatever hash the case installed. */
async function mountShell(): Promise<void> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  container = document.createElement("div");
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
}

/** Give the shell's effects and the archive pass time to land, then read the DOM. */
async function settle(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !pred()) {
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
}

describe("the shell mounts the address view at its own hash", () => {
  it("Escape on a pasted link falls to the Ohbox rather than leaving the product", async () => {
    // ONE entry, installed with `replaceState` so nothing is stacked behind it — a pasted link
    // or a reload. Stepping back here would navigate away from the app on a keystroke that
    // means "close this".
    window.history.replaceState(null, "", HASH);
    await mountShell();
    await settle(() => container!.querySelector(".view-address") != null);
    // THE PRECONDITION, asserted rather than assumed: with anything stacked behind this entry
    // the case measures the other arm. jsdom's session history accumulates across the cases in
    // one file, which is why this one runs first.
    expect(window.history.length, "nothing may be stacked behind a pasted link").toBe(1);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle(() => window.location.hash === "#/ohbox");
    expect(window.location.hash).toBe("#/ohbox");
    await settle(() => container!.querySelector(".view-ohbox") != null);
    expect(container!.querySelector(".view-ohbox")).not.toBeNull();
    expect(container!.querySelector(".view-address")).toBeNull();
  }, 20000);

  it("renders `.view-address` with the address in its header, and leaves the URL alone", async () => {
    window.history.replaceState(null, "", HASH);
    await mountShell();
    await settle(() => container!.querySelector(".view-address") != null);

    const view = container!.querySelector(".view-address");
    expect(view, "the address hash must put the address view on the stage").not.toBeNull();
    // The header names the person the hash named — the name when the mirror knows one, with the
    // address beside it; the address alone otherwise. Either way the address is on screen.
    expect(view!.querySelector(".vhead")!.textContent).toContain(JONAS);
    // The direction toggle is the view's own control, so this is the address view and not a
    // pile that happens to carry the class.
    expect(view!.querySelector(".addr-bar .seg")).not.toBeNull();
    // AND the URL still says what is on screen: `normalizedHash` must not have trimmed the
    // fragment to a view it recognises, which is what an unmounted route would have produced.
    expect(window.location.hash).toBe(HASH);
    // No other view is on the stage beside it.
    expect(container!.querySelector(".view-ohbox")).toBeNull();
  }, 20000);

  it("Escape returns to the view the address was followed from", async () => {
    // Two entries: Reads, then the address. This is what a click on an address produces.
    window.history.replaceState(null, "", "#/reads");
    await mountShell();
    await settle(() => container!.querySelector(".view-reads") != null);
    await act(async () => { window.location.hash = HASH; });
    await settle(() => container!.querySelector(".view-address") != null);
    expect(container!.querySelector(".view-address")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle(() => window.location.hash === "#/reads");
    expect(window.location.hash, "back to the list the address was clicked in").toBe("#/reads");
    await settle(() => container!.querySelector(".view-reads") != null);
    expect(container!.querySelector(".view-reads")).not.toBeNull();
  }, 20000);

});
