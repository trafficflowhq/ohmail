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
  it("in the Reads stream: `r` on the cursor raises the reader with the editor inside", async () => {
    const container = await shell();
    await key("g");
    await key("r");
    await waitFor(() => container.querySelector(".view-reads") != null, "the Reads pile");
    await key("j"); // the cursor enters the stream

    await key("r");
    // The reader sheet is the pane the editor lands in — a stream card mounts none of its
    // own. Both halves must appear: the sheet, and the editor bound to a message.
    await waitFor(() => document.querySelector(".reader") != null, "the reader sheet");
    await waitFor(
      () => document.querySelector(".reader .reply[data-reply-for]") != null,
      "the reply editor inside the reader",
    );
  }, 20000);

  it("typing the reply in the Reads reader never takes the reading mark off <body>", async () => {
    // Each keystroke re-renders the shell; a dropped-and-re-added `reading` class restarted the
    // rail's and the shell's opacity transitions, and the window flickered while typing.
    await shell();
    await key("g");
    await key("r");
    await waitFor(() => document.querySelector(".view-reads") != null, "the Reads pile");
    await key("j");
    await key("r");
    await waitFor(() => document.querySelector(".reader .reply .rte-surface") != null, "the editor in the reader");
    const surface = document.querySelector<HTMLElement>(".reader .reply .rte-surface")!;
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
    expect(surface.textContent).toBe("Thanks");
    expect(churn, "the reading class churned while typing").toHaveLength(0);
    expect(document.body.classList.contains("reading")).toBe(true);
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
