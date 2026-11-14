/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Frame } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { listFrame } from "../../../packages/app/test/places/list-seat.js";
import messages from "../messages/en.json";
import german from "../messages/de.json";

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
  cleanup();
  vi.restoreAllMocks();
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
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
        children: node,
      }),
    );
  });
  return container;
}

async function shell(hash = "#/triage"): Promise<HTMLElement> {
  window.location.hash = hash;
  const { DemoShell } = await import("../app/(product)/demo/DemoShell");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  return mount(h(ThemeProvider, { children: h(ToastHost, { children: h(DemoShell, { serverDemo: true, says: { service: "managed", sendCeiling: "strict" } }) }) }));
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
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

const segment = (label: string) =>
  within(screen.getByRole("group", { name: "Piles" })).queryByRole("button", { name: label });
const laterRows = () => within(screen.getByRole("listbox", { name: "Answer Later" })).getAllByRole("option");
const reading = () => within(screen.getByRole("region", { name: "Reading" }));
const forwardEditor = () => screen.queryByRole("textbox", { name: "Forward body" });

async function openLater(): Promise<void> {
  await shell();
  await screen.findByRole("listbox", { name: "Answer Later" });
  await screen.findByRole("region", { name: "Reading" });
}

describe("⇧F inside Triage — the pill's keycap and the key are one claim", () => {
  /**
   * A review finding, and it is the same defect this whole file was written for, one verb later.
   *
   * The shell's global bindings act on `focused`, which has NO arm for this view: the message on
   * screen here is `TriageView`'s own `shown`. So a verb declared only at the shell is inert in
   * this view while the pill it mounts still prints the verb's keycap — read from the registry,
   * which owns the chord whether or not it is disabled. That is exactly the "advertises a key
   * that does nothing" failure the keycap-always law exists to prevent, and it is why `a`, `e`,
   * `b` and `r` are declared locally here. Forward joins them rather than becoming a fourth
   * silent chord.
   *
   * Asserted on the OUTCOME the key produces — the forward dock, in forward mode, over the shown
   * message — rather than on the binding table, because a registered-but-wrong binding would pass
   * a table check. Mutation: drop the `shift+f` entry from `TriageView`'s `verbs` and this reddens
   * while the keycap on the bar is unchanged.
   */
  it("`⇧F` on the shown message opens the forward dock — the key the pill advertises here", async () => {
    await openLater();

    // The bar in this view prints the keycap, which is the claim the key has to honour.
    const fwd = reading().getByRole("button", { name: /^Forward/ });
    expect(fwd.title).toBe("Forward · ⇧F");
    const shortcut = fwd.getAttribute("aria-keyshortcuts");
    await key("F", { shiftKey: true });
    await waitFor(
      () => forwardEditor() !== null,
      "the forward dock, opened by the key the bar advertises",
    );
    expect(shortcut, "the bar advertises the chord").toBe("Shift+F");
  }, 20000);
});

describe("the NARROW reader and the view's cursor are the same message", () => {
  /**
   * A second review finding — a WRONG-TARGET bug, and the worst kind: it acts, successfully, on
   * somebody else's mail.
   *
   * `shown` falls back to `openable[0]` when `selectedId` is null, and on the narrow layout
   * `openRow` used to raise the reader (`onOpen`) WITHOUT setting the cursor. So tapping the
   * second row of a pile put that row in the reader while `shown` still pointed at the first —
   * and every verb this view declares reads `shown`. `⇧F` would then have forwarded a different
   * person's message than the one filling the screen, silently and successfully. `r`, `a`, `e`
   * and `b` had the identical staleness; the fix is at the cursor, so it closes all five.
   *
   * There is no reader-aware binding underneath to save it: a view's binding OUTRANKS the
   * shell's global one, which is the whole reason these are declared here.
   *
   * Asserted on IDENTITY — the dock's `data-reply-for` against the id of the row that was
   * tapped — not on "a dock opened", because the bug's signature is a dock that opens over the
   * WRONG id. Mutation: put `if (readColumnHidden()) onOpen(m); else setSelectedId(m.id);` back
   * and this reddens naming both ids.
   */
  it("`⇧F` after tapping the SECOND row forwards that row — not the pile's first", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      await shell();
      await screen.findByRole("listbox", { name: "Answer Later" });
      const [first, second] = laterRows();
      expect(second, "the fixture pile needs a second row").toBeDefined();
      expect(second!.getAttribute("aria-label")).not.toBe(first!.getAttribute("aria-label"));

      await act(async () => { second!.click(); });
      const sheet = within(await screen.findByRole("dialog", { name: "Reading" }));
      const subject = sheet.getByRole("heading", { level: 2 }).textContent!;
      expect(second!.getAttribute("aria-label")).toContain(subject);
      expect(first!.getAttribute("aria-label")).not.toContain(subject);

      await key("F", { shiftKey: true });
      await waitFor(() => forwardEditor() !== null, "the forward editor");
      expect(sheet.getByRole("textbox", { name: "Forward body" })).toBeTruthy();
      expect(sheet.getByRole("heading", { level: 2 }).textContent).toBe(subject);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  }, 20000);
});

it.each([
  { locale: "en", catalogue: messages, empty: "Nothing parked" },
  { locale: "de", catalogue: german, empty: "Nichts geparkt" },
] as const)("shows the Parked empty sentence once in $locale", ({ locale, catalogue, empty }) => {
  const { host } = listFrame({ first: "#/triage/aside", letters: [] });
  const { container } = render(
    <TextProvider locale={locale} messages={catalogue} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );

  // The kit draws the sentence's full stop separately.
  expect(within(container).getAllByText((_, element) =>
    element?.tagName === "P" && element.textContent === empty,
  )).toHaveLength(1);
  expect(within(container).queryByText(catalogue.triage.hintAside)).toBeNull();
  expect(within(container).queryAllByRole("option")).toHaveLength(0);
});
