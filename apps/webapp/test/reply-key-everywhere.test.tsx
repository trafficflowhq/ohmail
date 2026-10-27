/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";

/**
 * CMP-F6 — `r` WORKS WHEREVER THE PILL THAT ADVERTISES IT IS ON SCREEN.
 *
 * The Reply pill prints its keycap from the live registry (`Key chord="r"`), and a DISABLED
 * binding still owns its chord — so every message pane outside the Ohbox advertised `r` over
 * a key gated on `route.view === "ohbox"`. Reported from a search-opened message view; the
 * same gate deadened the key over the reading streams and inside Triage.
 *
 * The rule now is `focused`'s own: a message verb acts on the message being read, wherever
 * that is. These cases press the real key over the real panes.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
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
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(): Promise<HTMLElement> {
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
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

describe("CMP-F6 — `r` opens the reply editor outside the Ohbox", () => {
  /**
   * REPLY IN PLACE (owner 2026-10-26): the letter becomes its conversation where its card stood,
   * with the dock in it — no reader sheet, and nothing on the page dims or fades.
   */
  const watchReading = (): { saw: () => boolean; stop: () => void } => {
    let saw = document.body.classList.contains("reading");
    const watch = new MutationObserver(() => { if (document.body.classList.contains("reading")) saw = true; });
    watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return { saw: () => saw, stop: () => watch.disconnect() };
  };
  const inPlaceEditor = (view: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.view-${view} .scast[data-sid].in-place .reply[data-reply-for]`);

  it("in the Reads stream: `r` on the cursor answers the letter in place, with no reader sheet", async () => {
    const container = await shell();
    await key("g");
    await key("r");
    await waitFor(() => container.querySelector(".view-reads") != null, "the Reads pile");
    await key("j"); // the cursor enters the stream
    const reading = watchReading();

    await key("r");
    await waitFor(() => inPlaceEditor("reads") != null, "the reply editor in the letter's own place");
    const sid = inPlaceEditor("reads")!.closest<HTMLElement>(".scast")!.dataset.sid;
    expect(inPlaceEditor("reads")!.closest(".conv[data-stream]")).not.toBeNull();
    expect(document.querySelector(".reader"), "the reader sheet").toBeNull();
    reading.stop();
    expect(reading.saw(), "the page took the reading mark").toBe(false);

    // Esc with nothing sent: the same element is a card again.
    const card = container.querySelector(`.scast[data-sid="${sid}"]`);
    await key("Escape");
    await waitFor(() => container.querySelector(".view-reads .conv") == null, "the card back");
    expect(container.querySelector(`.scast[data-sid="${sid}"]`)).toBe(card);
    expect(card!.querySelector(".sc-head")).not.toBeNull();
  }, 20000);

  it("typing in place changes nothing on the page outside the editor", async () => {
    const container = await shell();
    await key("g");
    await key("r");
    await waitFor(() => container.querySelector(".view-reads") != null, "the Reads pile");
    await key("j");
    await key("r");
    await waitFor(() => inPlaceEditor("reads")?.querySelector(".rte-surface") != null, "the editor in place");
    const reply = inPlaceEditor("reads")!;
    const surface = reply.querySelector<HTMLElement>(".rte-surface")!;
    // The page outside the editor, as it stands (a keycap's attribute set again to the same value is no change).
    const outside = (): string => document.body.innerHTML.replace(reply.outerHTML, "");
    // Let the open settle first: the step's own read mark lands on its own clock.
    let last = outside();
    for (let quiet = 0; quiet < 3;) {
      await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
      const now = outside();
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }
    for (const text of ["T", "Th", "Tha", "Than", "Thanks"]) {
      await act(async () => {
        typeInto(surface, text);
      });
    }
    expect(surface.textContent).toBe("Thanks");
    expect(outside() === last, "the page outside the editor changed while typing").toBe(true);
  }, 20000);

  it("at a phone's width Reply and Forward stay in place too", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
    const container = await shell();
    await key("g");
    await key("r");
    await waitFor(() => container.querySelector(".view-reads") != null, "the Reads pile");
    await key("j");
    await key("r");
    await waitFor(() => inPlaceEditor("reads") != null, "the reply in place");
    expect(document.querySelector(".reader")).toBeNull();
    await key("Escape");
    await waitFor(() => container.querySelector(".view-reads .conv") == null, "the card back");
    await key("F", { shiftKey: true });
    await waitFor(() => inPlaceEditor("reads") != null, "the forward in place");
    expect(document.querySelector(".reader")).toBeNull();
  }, 20000);

  it("in Receipts too", async () => {
    const container = await shell();
    await key("g");
    await key("e");
    await waitFor(() => container.querySelector(".view-receipts") != null, "the Receipts pile");
    await key("j");
    await key("r");
    await waitFor(() => inPlaceEditor("receipts") != null, "the reply in the receipt's place");
    expect(document.querySelector(".reader")).toBeNull();
  }, 20000);

  it("typing the reply in place in Reads never puts the reading mark on <body>", async () => {
    // Each keystroke re-renders the shell; a `reading` class set and dropped on <body> restarts the
    // rail's and the shell's opacity transitions, and the window flickers while typing.
    await shell();
    await key("g");
    await key("r");
    await waitFor(() => document.querySelector(".view-reads") != null, "the Reads pile");
    await key("j");
    const reading = watchReading();
    await key("r");
    const sel = ".view-reads .scast.in-place .reply .rte-surface";
    await waitFor(() => document.querySelector(sel) != null, "the editor in place");
    const surface = document.querySelector<HTMLElement>(sel)!;
    const churn: MutationRecord[] = [];
    const watch = new MutationObserver((records) => churn.push(...records));
    watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    for (const text of ["T", "Th", "Tha", "Than", "Thanks"]) {
      await act(async () => {
        typeInto(surface, text);
      });
    }
    churn.push(...watch.takeRecords());
    watch.disconnect();
    reading.stop();
    expect(surface.textContent).toBe("Thanks");
    expect(churn, "the body's class churned while typing").toHaveLength(0);
    expect(reading.saw(), "the page took the reading mark").toBe(false);
  }, 20000);

  it("inside Triage: `r` opens the editor in the reading column", async () => {
    const container = await shell();
    await key("g");
    await key("l");
    await waitFor(() => container.querySelector(".view-triage") != null, "triage view");

    await key("r");
    await waitFor(
      () => container.querySelector(".view-triage .reply[data-reply-for]") != null,
      "the reply editor in the triage pane",
    );
  }, 20000);

  it("`r` is a toggle there too — the second press closes the editor", async () => {
    const container = await shell();
    await key("g");
    await key("l");
    await waitFor(() => container.querySelector(".view-triage") != null, "triage view");

    await key("r");
    await waitFor(
      () => container.querySelector(".view-triage .reply[data-reply-for]") != null,
      "editor open",
    );
    await key("r");
    await waitFor(
      () => container.querySelector(".view-triage .reply[data-reply-for]") == null,
      "editor closed by the same key",
    );
  }, 20000);
});
